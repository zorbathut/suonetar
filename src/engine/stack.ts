import { ErrorNoBase, ErrorNotOnBranch } from "./errors.ts";
import { gitText, type Oid, type Repo } from "./git.ts";
import { type CatFile, commitRead, commitSubject } from "./objects.ts";

export type StackCommit = {
	readonly oid: Oid;
	readonly parent: Oid;
	readonly tree: Oid;
	readonly authorLine: string;
	readonly subject: string;
	readonly message: Buffer;
	readonly encoding: string | undefined;
	readonly signed: boolean;
	readonly published: boolean;
};

export type Stack = {
	readonly branch: string;
	readonly tipOid: Oid;
	readonly baseRef: string;
	// The parent of the first stack commit: the merge-base with the base ref, or the merge commit the stack was cut at.
	readonly baseOid: Oid;
	// Oldest first.
	readonly commits: readonly StackCommit[];
	// When set, the stack was cut at this merge commit: it and everything below it are not editable.
	readonly frozenBelow: Oid | undefined;
	// Other local branches containing stack commits: they are not rewritten, so they keep the old versions.
	readonly leftBehind: readonly string[];
	// Changes whenever the branch or its base moves; lets a UI detect that the OIDs it holds are stale.
	readonly generation: string;
};

const BASE_FALLBACKS = ["refs/heads/main", "refs/heads/master", "refs/remotes/origin/main", "refs/remotes/origin/master"];

async function revParse(repo: Repo, rev: string): Promise<Oid | undefined> {
	const result = await repo.run(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { cwd: repo.worktree });
	return result.code === 0 ? result.stdout.toString("utf8").trim() : undefined;
}

export async function configGet(repo: Repo, key: string): Promise<string | undefined> {
	const result = await repo.run(["config", "--get", key], { cwd: repo.worktree });
	if (result.code === 1) {
		return undefined;
	}
	if (result.code !== 0) {
		throw new Error(`git config --get ${key} failed: ${result.stderr}`);
	}
	return result.stdout.toString("utf8").trim();
}

// A boolean setting as git reads one (`yes`, `on`, `1`...), or `absent` when it is not set.
export async function configBool(repo: Repo, key: string, absent: boolean): Promise<boolean> {
	const result = await repo.run(["config", "--type=bool", "--get", key], { cwd: repo.worktree });
	if (result.code === 1) {
		return absent;
	}
	if (result.code !== 0) {
		throw new Error(`git config --type=bool --get ${key} failed: ${result.stderr}`);
	}
	return result.stdout.toString("utf8").trim() === "true";
}

async function isAncestor(repo: Repo, ancestor: Oid, descendant: Oid): Promise<boolean> {
	const result = await repo.run(["merge-base", "--is-ancestor", ancestor, descendant], { cwd: repo.worktree });
	if (result.code > 1) {
		throw new Error(`merge-base --is-ancestor failed: ${result.stderr}`);
	}
	return result.code === 0;
}

export async function branchCurrent(repo: Repo): Promise<string> {
	const result = await repo.run(["symbolic-ref", "-q", "HEAD"], { cwd: repo.worktree });
	if (result.code !== 0) {
		throw new ErrorNotOnBranch();
	}
	return result.stdout.toString("utf8").trim();
}

// The conventional names for the hosting remote, whose default branch can be a base and where a branch's same-named copy is looked for. Any other remote's HEAD (a laptop, a backup repository) may be a feature branch that already contains the tip, which would hide unmerged commits.
const BASE_REMOTES = ["origin", "upstream"];

// A ref that may be the base, with the object the listing found it naming (undefined when absent).
type Candidate = { readonly ref: string; readonly oid: Oid | undefined };

// One ref as `for-each-ref` lists it: the object it names, where `git push` sends it (branches only; empty when nowhere), and its target if symbolic.
type RefListed = { readonly oid: Oid; readonly push: string; readonly symref: string };

// HEAD and every local and remote branch, in one process: base detection looks up what it needs here instead of running git once per ref. Nothing in the format reads the refs' objects (their type, or `*` peeling), which would cost time on a repository with many refs and fail the whole listing over one ref to a missing object; the few candidates are typed through the open `cat-file` instead.
async function refsList(repo: Repo): Promise<{ readonly head: RefListed | undefined; readonly refs: ReadonlyMap<string, RefListed> }> {
	const listed = await gitText(repo, ["for-each-ref", "--include-root-refs", "--format=%(refname)%00%(objectname)%00%(push)%00%(symref)", "HEAD", "refs/heads", "refs/remotes"]);
	const refs = new Map<string, RefListed>();
	let head: RefListed | undefined;
	for (const row of listed.split("\n")) {
		if (row === "") {
			continue;
		}
		const [name, oid, push, symref, ...rest] = row.split("\0");
		if (name === undefined || oid === undefined || push === undefined || symref === undefined || rest.length > 0) {
			throw new Error(`git for-each-ref listed a row it was not asked for: ${JSON.stringify(row)}`);
		}
		if (name === "HEAD") {
			head = { oid, push, symref };
		} else {
			refs.set(name, { oid, push, symref });
		}
	}
	return { head, refs };
}

// The commit an object is, or that an annotated tag (or a tag of one) names, as `rev-parse <ref>^{commit}` resolves it; undefined for anything else or a missing object. Only a remote ref can name a tag: git refuses to put one on a branch.
async function commitPeeled(cat: CatFile, oid: Oid): Promise<Oid | undefined> {
	let current = oid;
	for (let depth = 0; depth < 16; depth++) {
		const obj = await cat.read(current);
		if (obj?.type === "commit") {
			return current;
		}
		const target = obj?.type === "tag" ? /^object ([0-9a-f]+)$/m.exec(obj.data.toString("utf8"))?.[1] : undefined;
		if (target === undefined) {
			return undefined;
		}
		current = target;
	}
	return undefined;
}

// `suonetar.base` and `init.defaultBranch` in one read, each as `git config --get` gives it: the last value of several, and "" for a key set with no value.
async function configBases(repo: Repo): Promise<{ readonly base: string | undefined; readonly defaultBranch: string | undefined }> {
	const result = await repo.run(["config", "-z", "--get-regexp", "^(suonetar\\.base|init\\.defaultbranch)$"], { cwd: repo.worktree });
	if (result.code === 1) {
		return { base: undefined, defaultBranch: undefined };
	}
	if (result.code !== 0) {
		throw new Error(`git config --get-regexp failed: ${result.stderr}`);
	}
	const values = new Map<string, string>();
	for (const record of result.stdout.toString("utf8").split("\0")) {
		const split = record.indexOf("\n");
		if (record !== "") {
			values.set(split < 0 ? record : record.slice(0, split), split < 0 ? "" : record.slice(split + 1));
		}
	}
	return { base: values.get("suonetar.base"), defaultBranch: values.get("init.defaultbranch") };
}

// The default branch of origin and upstream (`refs/remotes/<remote>/HEAD`, set by clone and fetch) and its local counterpart, then `init.defaultBranch` for repositories without a remote, then main and master. A remote HEAD left dangling by a pruned default is not listed; base detection then falls back rather than failing.
function baseCandidates(refs: ReadonlyMap<string, RefListed>, branch: string, defaultBranch: string | undefined): Candidate[] {
	const remoteDefaults = BASE_REMOTES.flatMap((remote) => {
		const head = refs.get(`refs/remotes/${remote}/HEAD`);
		if (head === undefined || head.symref === "") {
			return [];
		}
		const local = head.symref.replace(/^refs\/remotes\/[^/]+\//, "refs/heads/");
		// The HEAD's own row gives the commit of a target outside the listing (a tag, say).
		return [
			{ ref: head.symref, oid: refs.get(head.symref)?.oid ?? head.oid },
			{ ref: local, oid: refs.get(local)?.oid },
		];
	});
	const named = [...(defaultBranch === undefined ? [] : [`refs/heads/${defaultBranch}`]), ...BASE_FALLBACKS].map((ref) => ({ ref, oid: refs.get(ref)?.oid }));
	const seen = new Set<string>();
	return [...remoteDefaults, ...named].filter((c) => c.ref !== branch && !seen.has(c.ref) && seen.add(c.ref));
}

// The branch's own copies on the server: where `git push` sends it, and a same-named branch on the hosting remotes, which `git push origin <name>` without `-u` leaves. Not its upstream as such: a branch cut from `origin/dev` tracks `origin/dev`, a parent rather than its copy, and `push.default=simple` gives no push destination for it.
function branchCopies(refs: ReadonlyMap<string, RefListed>, branch: string): Candidate[] {
	const push = refs.get(branch)?.push ?? "";
	const name = branch.replace(/^refs\/heads\//, "");
	const pushes = push.startsWith("refs/remotes/") ? [push] : [];
	return [...new Set([...pushes, ...BASE_REMOTES.map((remote) => `refs/remotes/${remote}/${name}`)])].map((ref) => ({ ref, oid: refs.get(ref)?.oid }));
}

// The base whose merge-base with the tip is newest, competing the branch's own copies on the server, while it has commits they lack, against the default branch's; on a tie the copy wins. So a branch with unpushed work stacks just that work, and a fully pushed one shows everything since it left the default branch. After `git fetch && git rebase origin/main` with a stale local main or a stale copy, origin/main is the right base; on the default branch itself, its remote copy is, so the stack is the unpushed commits.
// An explicit base, from the caller or else `suonetar.base`, replaces detection. Candidates are compared by the commits the listing found, so a ref moving meanwhile cannot mix two states, and each distinct commit costs one merge-base.
async function baseFind(
	repo: Repo,
	cat: CatFile,
	refs: ReadonlyMap<string, RefListed>,
	branch: string,
	tipOid: Oid,
	base: string | undefined,
): Promise<{ ref: string; mergeBase: Oid }> {
	const config = base === undefined ? await configBases(repo) : { base: undefined, defaultBranch: undefined };
	const configuredRef = base ?? config.base;
	const configured = configuredRef === undefined ? undefined : { ref: configuredRef, by: base !== undefined ? ("caller" as const) : ("config" as const) };
	const candidates =
		configured !== undefined
			? [{ ref: configured.ref, copy: false, oid: await revParse(repo, configured.ref) }]
			: [...branchCopies(refs, branch).map((c) => ({ ...c, copy: true })), ...baseCandidates(refs, branch, config.defaultBranch).map((c) => ({ ...c, copy: false }))];
	const mergeBases = new Map<Oid, Oid | undefined>();
	// The merge-base of the commit a candidate names with the tip; undefined for a candidate that names no commit, or shares no history with the branch.
	const mergeBaseOf = async (named: Oid): Promise<Oid | undefined> => {
		if (!mergeBases.has(named)) {
			const oid = await commitPeeled(cat, named);
			if (oid === undefined) {
				mergeBases.set(named, undefined);
				return undefined;
			}
			const result = await repo.run(["merge-base", oid, tipOid], { cwd: repo.worktree });
			// Exit 1: no history in common with the branch, so no base. Anything else is git failing.
			if (result.code > 1) {
				throw new Error(`git merge-base ${oid} ${tipOid} failed: ${result.stderr}`);
			}
			mergeBases.set(named, result.code === 0 ? result.stdout.toString("utf8").trim() : undefined);
		}
		return mergeBases.get(named);
	};
	const ancestry = new Map<string, boolean>();
	const ancestorIs = async (ancestor: Oid, descendant: Oid): Promise<boolean> => {
		const key = `${ancestor} ${descendant}`;
		let known = ancestry.get(key);
		if (known === undefined) {
			known = await isAncestor(repo, ancestor, descendant);
			ancestry.set(key, known);
		}
		return known;
	};
	let best: { ref: string; mergeBase: Oid } | undefined;
	for (const { ref, copy, oid } of candidates) {
		const mergeBase = oid === undefined ? undefined : await mergeBaseOf(oid);
		// A copy that already has every commit of the branch leaves nothing unpushed, so the default branch decides.
		if (mergeBase === undefined || (copy && mergeBase === tipOid)) {
			continue;
		}
		if (best === undefined || (mergeBase !== best.mergeBase && (await ancestorIs(best.mergeBase, mergeBase)))) {
			best = { ref, mergeBase };
		}
	}
	if (best === undefined) {
		throw new ErrorNoBase(branch.replace(/^refs\/heads\//, ""), configured === undefined ? { kind: "undetected" } : { kind: "chosen", ...configured });
	}
	return best;
}

// `base`, when given, is the ref the user chose to start the stack at.
export async function stackRead(repo: Repo, cat: CatFile, base: string | undefined): Promise<Stack> {
	const { head, refs } = await refsList(repo);
	// No HEAD row: HEAD names a branch with no commits yet, or is broken, which `symbolic-ref` tells apart.
	const branch = head === undefined ? await branchCurrent(repo) : head.symref;
	if (branch === "") {
		throw new ErrorNotOnBranch();
	}
	// HEAD's own row gives the commit of a branch outside the listing.
	const listedTip = refs.get(branch)?.oid ?? head?.oid;
	const tipOid = listedTip === undefined ? undefined : await commitPeeled(cat, listedTip);
	if (tipOid === undefined) {
		throw new ErrorNoBase(branch.replace(/^refs\/heads\//, ""), { kind: "unborn" });
	}
	const found = await baseFind(repo, cat, refs, branch, tipOid, base);

	const rows = (await gitText(repo, ["rev-list", "--first-parent", "--reverse", "--parents", `${found.mergeBase}..${tipOid}`])).split("\n").filter((row) => row !== "");
	let frozenBelow: Oid | undefined;
	let start = 0;
	rows.forEach((row, index) => {
		const [oid, ...parents] = row.split(" ");
		if (oid !== undefined && parents.length > 1) {
			frozenBelow = oid;
			start = index + 1;
		}
	});
	const oids = rows.slice(start).map((row) => row.split(" ")[0] as string);

	const unpublished = new Set((await gitText(repo, ["rev-list", tipOid, "--not", found.mergeBase, "--remotes"])).split("\n"));
	const commits: StackCommit[] = [];
	for (const oid of oids) {
		const info = await commitRead(cat, oid);
		const parent = info.parents[0];
		if (parent === undefined) {
			throw new Error(`stack commit ${oid} has no parent`);
		}
		commits.push({
			oid,
			parent,
			tree: info.tree,
			authorLine: info.authorLine,
			subject: commitSubject(info),
			message: info.message,
			encoding: info.encoding,
			signed: info.signed,
			published: !unpublished.has(oid),
		});
	}
	const baseOid = commits[0]?.parent ?? frozenBelow ?? found.mergeBase;
	// Other local branches can only be left behind if there are any.
	const others = [...refs.keys()].some((ref) => ref.startsWith("refs/heads/") && ref !== branch);
	const leftBehind = commits[0] === undefined || !others ? [] : await branchesContaining(repo, commits[0].oid, branch);
	return { branch, tipOid, baseRef: found.ref, baseOid, commits, frozenBelow, leftBehind, generation: `${tipOid}:${baseOid}` };
}

async function branchesContaining(repo: Repo, oid: Oid, except: string): Promise<string[]> {
	const listed = await gitText(repo, ["for-each-ref", "--format=%(refname)", "--contains", oid, "refs/heads"]);
	return listed
		.split("\n")
		.filter((ref) => ref !== "" && ref !== except)
		.map((ref) => ref.replace(/^refs\/heads\//, ""));
}
