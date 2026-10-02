import { ErrorEditRefused } from "./errors.ts";
import { gitOk, type Oid, type Repo, splitNul } from "./git.ts";
import { mergeTrees } from "./merge.ts";
import { treeList } from "./objects.ts";
import type { Edit } from "./replay.ts";
import type { Stack, StackCommit } from "./stack.ts";
import type { DraftEntry, DraftMeta } from "./store.ts";
import { blobWrite, type TreeChange, treeWithChanges } from "./write.ts";

// What a draft needs to know about the commit it edits; any commit object will do, in the stack or not. `parentTree` is the tree of the commit's own parent.
export type CommitBasics = Pick<StackCommit, "oid" | "tree" | "authorLine" | "subject" | "message"> & { readonly parentTree: Oid };

// A new version of a commit's files: `tree`, made on top of a parent whose tree is `parentTree`.
export type Version = { readonly tree: Oid; readonly parentTree: Oid };

export type DraftStatus =
	// The draft's commit is in the stack as is.
	| { readonly kind: "current"; readonly draft: DraftEntry; readonly commit: StackCommit; readonly parentTree: Oid; readonly edit: Edit }
	// The commit was rewritten by someone else; the draft was rebased onto the matching commit and needs the user's confirmation.
	| { readonly kind: "rebased"; readonly draft: DraftEntry; readonly commit: StackCommit; readonly parentTree: Oid; readonly edit: Edit }
	// The draft cannot be carried onto the rewritten commit without the user's help.
	| { readonly kind: "conflict"; readonly draft: DraftEntry; readonly commit: StackCommit; readonly parentTree: Oid; readonly reason: string }
	// No commit in the stack matches; kept until the user discards it.
	| { readonly kind: "orphan"; readonly draft: DraftEntry }
	// Made on another branch; left alone unless the user adopts it here.
	| { readonly kind: "elsewhere"; readonly draft: DraftEntry };

export function draftMessage(draft: DraftEntry): Buffer | undefined {
	return draft.meta.message === undefined ? undefined : Buffer.from(draft.meta.message, "base64");
}

function editOf(draft: DraftEntry, tree: Oid | undefined, parentTree: Oid | undefined): Edit {
	return { tree, parentTree, message: draftMessage(draft) };
}

// Maps stored drafts onto the current stack. Pure: nothing is written, so a preview never re-keys a draft behind the user's back.
export async function draftsResolve(repo: Repo, stack: Stack, baseTree: Oid, drafts: ReadonlyMap<Oid, DraftEntry>): Promise<DraftStatus[]> {
	const byOid = new Map(stack.commits.map((c) => [c.oid, c]));
	const parentTrees = new Map(stack.commits.map((c, i) => [c.oid, stack.commits[i - 1]?.tree ?? baseTree]));
	const parentOf = (commit: StackCommit): Oid => {
		const tree = parentTrees.get(commit.oid);
		if (tree === undefined) {
			throw new Error(`commit ${commit.oid} is not in the stack`);
		}
		return tree;
	};
	const statuses: DraftStatus[] = [];
	const claimed = new Set<Oid>();
	const here = [...drafts.values()].filter((d) => d.meta.branch === stack.branch);
	for (const draft of drafts.values()) {
		if (draft.meta.branch !== stack.branch) {
			statuses.push({ kind: "elsewhere", draft });
		}
	}
	for (const draft of here) {
		const commit = byOid.get(draft.meta.against);
		if (commit !== undefined) {
			statuses.push({ kind: "current", draft, commit, parentTree: parentOf(commit), edit: editOf(draft, draft.tree, draft.parentTree) });
			claimed.add(commit.oid);
		}
	}
	for (const draft of here) {
		if (byOid.has(draft.meta.against)) {
			continue;
		}
		// Author lines identify a commit across amend, rebase, and cherry-pick; commits made within the same second share one, so the subject breaks ties.
		let matches = stack.commits.filter((c) => c.authorLine === draft.meta.authorLine);
		if (matches.length > 1) {
			matches = matches.filter((c) => c.subject === draft.meta.subject);
		}
		const commit = matches[0];
		if (commit === undefined || matches.length > 1) {
			statuses.push({ kind: "orphan", draft });
			continue;
		}
		const parentTree = parentOf(commit);
		if (claimed.has(commit.oid)) {
			statuses.push({ kind: "conflict", draft, commit, parentTree, reason: "another draft already edits this commit" });
			continue;
		}
		claimed.add(commit.oid);
		if (draft.meta.message !== undefined && draft.meta.baseMessage !== commit.message.toString("base64")) {
			statuses.push({ kind: "conflict", draft, commit, parentTree, reason: "the commit message was changed since this draft was made" });
			continue;
		}
		if (draft.tree === undefined) {
			statuses.push({ kind: "rebased", draft, commit, parentTree, edit: editOf(draft, undefined, undefined) });
			continue;
		}
		const merged = await mergeTrees(repo, draft.base, commit.tree, draft.tree);
		if (merged.kind === "conflict") {
			statuses.push({
				kind: "conflict",
				draft,
				commit,
				parentTree,
				reason: `the draft conflicts with the rewritten commit in ${merged.conflicts.flatMap((c) => c.paths).join(", ")}`,
			});
			continue;
		}
		// The parent the draft was made on moves the way the commit's own parent moved.
		let draftParent: Oid | undefined;
		if (draft.parentTree !== undefined && draft.baseParent !== undefined) {
			const parentMerged = draft.baseParent === parentTree ? undefined : await mergeTrees(repo, draft.baseParent, parentTree, draft.parentTree);
			if (parentMerged?.kind === "conflict") {
				statuses.push({
					kind: "conflict",
					draft,
					commit,
					parentTree,
					reason: `the edits below this draft conflict with the rewritten commit's parent in ${parentMerged.conflicts.flatMap((c) => c.paths).join(", ")}`,
				});
				continue;
			}
			draftParent = parentMerged === undefined ? draft.parentTree : parentMerged.tree;
		}
		statuses.push({ kind: "rebased", draft, commit, parentTree, edit: editOf(draft, merged.tree, draftParent) });
	}
	return statuses;
}

// The draft for `commit` with files `version` (undefined: the commit's own) and `message` (undefined: the commit's own), or undefined when neither differs. Callers pass no version when its tree is what the commit would have on that parent anyway.
export function draftFor(commit: CommitBasics, branch: string, version: Version | undefined, message: Buffer | undefined): DraftEntry | undefined {
	const messageChanged = message !== undefined && !message.equals(commit.message);
	if (version === undefined && !messageChanged) {
		return undefined;
	}
	const meta: DraftMeta = {
		against: commit.oid,
		authorLine: commit.authorLine,
		subject: commit.subject,
		branch,
		baseMessage: messageChanged ? commit.message.toString("base64") : undefined,
		message: messageChanged ? message.toString("base64") : undefined,
	};
	return {
		meta,
		tree: version?.tree,
		parentTree: version?.parentTree,
		base: commit.tree,
		baseParent: version === undefined ? undefined : commit.parentTree,
		entryOid: undefined,
	};
}

// Why each path cannot be edited as text, or undefined when it can: symlinks, submodules, and paths with a clean/smudge filter (LFS, git-crypt), whose repository form is not what the user should edit.
export async function editability(repo: Repo, tree: Oid, paths: readonly string[]): Promise<Map<string, string | undefined>> {
	const result = new Map<string, string | undefined>(paths.map((p) => [p, undefined]));
	if (paths.length === 0) {
		return result;
	}
	const entries = await treeList(repo, tree, { recursive: true, paths: paths.map((p) => `:(literal)${p}`) });
	for (const entry of entries) {
		if (entry.mode === "120000") {
			result.set(entry.path, "it is a symbolic link");
		} else if (entry.type === "commit") {
			result.set(entry.path, "it is a submodule");
		}
	}
	const attrs = splitNul(await gitOk(repo, [`--attr-source=${tree}`, "check-attr", "-z", "--stdin", "filter"], { input: `${paths.join("\0")}\0` }));
	for (let i = 0; i + 2 < attrs.length; i += 3) {
		const [path, , value] = [attrs[i] as string, attrs[i + 1], attrs[i + 2] as string];
		if (value !== "unspecified" && value !== "unset" && result.get(path) === undefined) {
			result.set(path, `it has a filter attribute (${value})`);
		}
	}
	return result;
}

// `current` with one file set (null deletes it). A file `current` lacks comes back with the mode it has in `modes`, else as a plain file.
export async function treeWithFile(repo: Repo, current: Oid, modes: Oid, path: string, content: Buffer | null): Promise<Oid> {
	const refusal = (await editability(repo, current, [path])).get(path);
	if (refusal !== undefined) {
		throw new ErrorEditRefused(path, refusal);
	}
	await pathCheck(repo, current, path);
	if (content === null) {
		return treeWithChanges(repo, current, [{ path, delete: "file" }]);
	}
	const entry = (await entryAt(repo, current, path)) ?? (await entryAt(repo, modes, path));
	const mode = entry?.type === "blob" ? entry.mode : "100644";
	return treeWithChanges(repo, current, [{ path, mode, oid: await blobWrite(repo, content) }]);
}

export async function entryAt(repo: Repo, tree: Oid, path: string) {
	const [entry] = await treeList(repo, tree, { recursive: false, paths: [`:(literal)${path}`] });
	return entry !== undefined && entry.path === path ? entry : undefined;
}

// Refuses a file write that git's index would carry out by silently deleting other entries: a file where the tree has a directory, or under a path the tree has as a file.
async function pathCheck(repo: Repo, tree: Oid, path: string): Promise<void> {
	const parts = path.split("/");
	for (let i = 1; i < parts.length; i++) {
		const entry = await entryAt(repo, tree, parts.slice(0, i).join("/"));
		if (entry !== undefined && entry.type !== "tree") {
			throw new ErrorEditRefused(path, `${entry.path} is a file, not a directory`);
		}
	}
	if ((await entryAt(repo, tree, path))?.type === "tree") {
		throw new ErrorEditRefused(path, "it is a directory here");
	}
}

// `current` with one path set to exactly the entry it has in `source` (mode included), or deleted when `source` lacks it, so a symlink or an executable keeps its mode.
export async function treeWithEntry(repo: Repo, current: Oid, path: string, source: Oid): Promise<Oid> {
	const entry = await entryAt(repo, source, path);
	if (entry?.type === "tree") {
		throw new ErrorEditRefused(path, "it is a directory");
	}
	await pathCheck(repo, current, path);
	const change: TreeChange = entry !== undefined ? { path, mode: entry.mode, oid: entry.oid } : { path, delete: "file" };
	return treeWithChanges(repo, current, [change]);
}

// The version of a stored draft's files, if it has any: drafts from before parent trees were recorded were made on the commit's original parent.
export function draftVersion(draft: DraftEntry, commit: CommitBasics): Version | undefined {
	return draft.tree === undefined ? undefined : { tree: draft.tree, parentTree: draft.parentTree ?? commit.parentTree };
}

// The confirmed version of a rebased draft, keyed to the commit it was rebased onto.
export function draftConfirmed(status: Extract<DraftStatus, { kind: "rebased" }>): DraftEntry | undefined {
	const commit: CommitBasics = { ...status.commit, parentTree: status.parentTree };
	const tree = status.edit.tree;
	const parentTree = status.edit.parentTree ?? status.parentTree;
	const version = tree === undefined || (tree === commit.tree && parentTree === commit.parentTree) ? undefined : { tree, parentTree };
	return draftFor(commit, status.draft.meta.branch, version, status.edit.message);
}
