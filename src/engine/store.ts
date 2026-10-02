import { ErrorGit, ErrorStoreChanged } from "./errors.ts";
import { gitText, type Oid, type Repo } from "./git.ts";
import { type CatFile, treeRead } from "./objects.ts";
import type { TreeChange } from "./write.ts";

// Drafts and resolutions live under one ref that points at a tree: reachable, so `git gc --prune=now` keeps every object, and invisible to `git log --all`. The ref has a reflog, so discarded drafts stay recoverable for the reflog's lifetime.
export const STORE_REF = "refs/suonetar/drafts";

export type DraftMeta = {
	// The commit this draft is a new version of.
	readonly against: Oid;
	readonly authorLine: string;
	readonly subject: string;
	readonly branch: string;
	// Base64 of the original and edited message bytes; both absent when only files are edited.
	readonly baseMessage: string | undefined;
	readonly message: string | undefined;
};

export type DraftEntry = {
	readonly meta: DraftMeta;
	// The edited tree; undefined for a message-only draft.
	readonly tree: Oid | undefined;
	// The parent tree `tree` was made on top of; undefined for a message-only draft, and for drafts written before parent trees were recorded, which were all made on the commit's original parent.
	readonly parentTree: Oid | undefined;
	// The `against` commit's tree and its parent's, kept so the draft can be rebased and shown even after that commit is gone; `baseParent` is undefined where `parentTree` is.
	readonly base: Oid;
	readonly baseParent: Oid | undefined;
	// The entry's own tree in the store, compared to detect concurrent changes; undefined until written.
	readonly entryOid: Oid | undefined;
};

// One tree change of a resolution: a file entry, a file deletion, or the deletion of a whole directory.
export type ResolutionChange = TreeChange;

export type ResolutionEntry = { readonly changes: readonly ResolutionChange[]; readonly entryOid: Oid | undefined };

export type Store = {
	readonly refOid: Oid | undefined;
	readonly drafts: ReadonlyMap<Oid, DraftEntry>;
	// Keyed by the conflict record's identity (see `conflictKey`).
	readonly resolutions: ReadonlyMap<string, ResolutionEntry>;
};

type Entry = { readonly mode: string; readonly type: "blob" | "tree"; readonly oid: Oid; readonly name: string };

const EMPTY: Store = { refOid: undefined, drafts: new Map(), resolutions: new Map() };

// The parsed store for the last ref value read, per repository: the store only changes through its ref, so an unchanged ref means an unchanged store.
const cache = new Map<string, Store>();

async function treeMake(repo: Repo, entries: readonly Entry[]): Promise<Oid> {
	const input = entries.map((e) => `${e.mode} ${e.type} ${e.oid}\t${e.name}\0`).join("");
	return gitText(repo, ["mktree", "-z"], { input });
}

async function blobJson(repo: Repo, value: unknown): Promise<Oid> {
	return gitText(repo, ["hash-object", "-w", "--stdin"], { input: JSON.stringify(value) });
}

async function readJson(cat: CatFile, oid: Oid): Promise<unknown> {
	return JSON.parse((await cat.readType(oid, "blob")).toString("utf8"));
}

export async function storeRefOid(repo: Repo): Promise<Oid | undefined> {
	const result = await repo.run(["rev-parse", "--verify", "--quiet", STORE_REF], { cwd: repo.worktree });
	if (result.code === 0) {
		return result.stdout.toString("utf8").trim();
	}
	if (result.code === 1) {
		return undefined;
	}
	throw new ErrorGit(["rev-parse", STORE_REF], result.code, result.stderr);
}

export async function storeRead(repo: Repo, cat: CatFile): Promise<Store> {
	const refOid = await storeRefOid(repo);
	if (refOid === undefined) {
		return EMPTY;
	}
	const cached = cache.get(repo.commonDir);
	if (cached?.refOid === refOid) {
		return cached;
	}
	const root = await treeRead(cat, refOid);
	const drafts = new Map<Oid, DraftEntry>();
	const draftsDir = root.find((e) => e.name === "drafts");
	for (const dir of draftsDir ? await treeRead(cat, draftsDir.oid) : []) {
		const entries = await treeRead(cat, dir.oid);
		const meta = entries.find((e) => e.name === "meta");
		const base = entries.find((e) => e.name === "base");
		if (meta === undefined || base === undefined) {
			throw new Error(`malformed draft entry ${dir.name} in ${STORE_REF}`);
		}
		const parsed = (await readJson(cat, meta.oid)) as DraftMeta;
		const named = (name: string) => entries.find((e) => e.name === name)?.oid;
		drafts.set(parsed.against, { meta: parsed, tree: named("tree"), parentTree: named("parent"), base: base.oid, baseParent: named("baseParent"), entryOid: dir.oid });
	}
	const resolutions = new Map<string, ResolutionEntry>();
	const resolutionsDir = root.find((e) => e.name === "resolutions");
	for (const dir of resolutionsDir ? await treeRead(cat, resolutionsDir.oid) : []) {
		const meta = (await treeRead(cat, dir.oid)).find((e) => e.name === "meta");
		if (meta === undefined) {
			throw new Error(`malformed resolution entry ${dir.name} in ${STORE_REF}`);
		}
		const parsed = (await readJson(cat, meta.oid)) as { changes: ResolutionChange[] };
		resolutions.set(dir.name, { changes: parsed.changes, entryOid: dir.oid });
	}
	const store = { refOid, drafts, resolutions };
	cache.set(repo.commonDir, store);
	return store;
}

// Writes the store with a compare-and-swap against the version it was read from.
export async function storeWrite(repo: Repo, previous: Store, drafts: ReadonlyMap<Oid, DraftEntry>, resolutions: ReadonlyMap<string, ResolutionEntry>): Promise<void> {
	const draftDirs: Entry[] = [];
	for (const [against, draft] of drafts) {
		const entries: Entry[] = [
			{ mode: "100644", type: "blob", oid: await blobJson(repo, draft.meta), name: "meta" },
			{ mode: "040000", type: "tree", oid: draft.base, name: "base" },
		];
		const trees: [string, Oid | undefined][] = [
			["tree", draft.tree],
			["parent", draft.parentTree],
			["baseParent", draft.baseParent],
		];
		for (const [name, oid] of trees) {
			if (oid !== undefined) {
				entries.push({ mode: "040000", type: "tree", oid, name });
			}
		}
		draftDirs.push({ mode: "040000", type: "tree", oid: await treeMake(repo, entries), name: against });
	}
	const resolutionDirs: Entry[] = [];
	for (const [key, resolution] of resolutions) {
		const entries: Entry[] = [{ mode: "100644", type: "blob", oid: await blobJson(repo, { changes: resolution.changes }), name: "meta" }];
		// The resolution's blobs, listed so they are reachable; their names are only indices.
		resolution.changes.forEach((change, index) => {
			if ("oid" in change && change.mode !== "160000") {
				entries.push({ mode: "100644", type: "blob", oid: change.oid, name: `blob${index}` });
			}
		});
		resolutionDirs.push({ mode: "040000", type: "tree", oid: await treeMake(repo, entries), name: key });
	}
	const root = await treeMake(repo, [
		{ mode: "040000", type: "tree", oid: await treeMake(repo, draftDirs), name: "drafts" },
		{ mode: "040000", type: "tree", oid: await treeMake(repo, resolutionDirs), name: "resolutions" },
	]);
	// An empty old value asserts that the ref does not exist yet.
	const args = ["update-ref", "--create-reflog", "-m", "suonetar: drafts", STORE_REF, root, previous.refOid ?? ""];
	const result = await repo.run(args, { cwd: repo.worktree });
	if (result.code !== 0) {
		if (/cannot lock ref|but expected|reference already exists/.test(result.stderr)) {
			throw new ErrorStoreChanged();
		}
		throw new ErrorGit(args, result.code, result.stderr);
	}
}
