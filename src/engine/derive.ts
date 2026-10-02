import type { Oid, Repo } from "./git.ts";
import { type Conflict, type MergeResult, mergeTrees } from "./merge.ts";
import { treeList } from "./objects.ts";
import { type ReplayStep, stepsReflag } from "./replay.ts";
import type { StackCommit } from "./stack.ts";
import { type TreeChange, treeWithChanges } from "./write.ts";

// The desired new version of one stack commit: `tree` on top of a parent whose tree is `parentTree` (undefined: the commit's original parent), or the commit's own tree when `tree` is undefined. `fallback` is the version a resolution replaced, used should the resolution itself stop merging.
export type Edit = {
	readonly tree: Oid | undefined;
	readonly parentTree: Oid | undefined;
	readonly message: Buffer | undefined;
	readonly fallback: { readonly parentTree: Oid; readonly tree: Oid } | undefined;
};

export type MergeInputs = { readonly base: Oid; readonly ours: Oid; readonly theirs: Oid };

// How a derivation makes its trees: three-way merges (as `mergeTrees`), and the stand-in for a conflicted commit (as `treeTakingPaths`). Callers may remember the results.
export type DeriveTrees = {
	readonly repo: Repo;
	readonly merge: (base: Oid, ours: Oid, theirs: Oid) => Promise<MergeResult>;
	readonly standIn: (markerTree: Oid, theirs: Oid, paths: readonly string[]) => Promise<Oid>;
};

// Trees made afresh every time.
export function deriveTreesPlain(repo: Repo): DeriveTrees {
	return { repo, merge: (base, ours, theirs) => mergeTrees(repo, base, ours, theirs), standIn: (markerTree, theirs, paths) => treeTakingPaths(repo, markerTree, theirs, paths) };
}

export type ConflictFound = {
	readonly inputs: MergeInputs;
	readonly markerTree: Oid;
	// Every conflict in the commit, each flagged with whether a stored resolution already covers it.
	readonly conflicts: readonly (Conflict & { readonly resolved: boolean })[];
};

// One stack commit as it will be after Apply.
export type DerivedCommit = {
	readonly commit: StackCommit;
	readonly parentTree: Oid;
	// For a commit with an unresolved conflict, a stand-in: the merge with every conflicted path as the commit's own side has it, so the commits above still derive.
	readonly tree: Oid;
	readonly message: Buffer;
	readonly conflict: ConflictFound | undefined;
	// Set when every conflict was covered by rows of the resolutions table. Resolving folds a commit's rows into its draft once the last one is saved, so this covers stores written before that, and rows saved for one merge from two windows.
	readonly resolvedByTable: boolean;
	// The edit's own tree no longer merges onto the parent, and the version it replaced did.
	readonly fallback: boolean;
	// Paths left without the edits below them because a conflict below is unresolved.
	readonly provisional: readonly string[];
};

// `tree` with every one of `paths` (files or directories) as `source` has it, or gone where `source` lacks it.
export async function treeTakingPaths(repo: Repo, tree: Oid, source: Oid, paths: readonly string[]): Promise<Oid> {
	if (paths.length === 0) {
		return tree;
	}
	const literal = paths.map((p) => `:(literal)${p}`);
	const changes: TreeChange[] = paths.map((path) => ({ path, delete: "directory" }));
	for (const entry of await treeList(repo, source, { recursive: true, paths: literal })) {
		changes.push({ path: entry.path, mode: entry.mode, oid: entry.oid });
	}
	return treeWithChanges(repo, tree, changes);
}

// The commit's tree restacked onto `parentTree` from `fromParent`: `tree` as is when the parent is unchanged, else the merge, with each conflicted path left as `tree` has it.
export async function treeRestacked(repo: Repo, fromParent: Oid, parentTree: Oid, tree: Oid): Promise<{ readonly tree: Oid; readonly conflicted: readonly string[] }> {
	if (fromParent === parentTree) {
		return { tree, conflicted: [] };
	}
	const merged = await mergeTrees(repo, fromParent, parentTree, tree);
	if (merged.kind === "clean") {
		return { tree: merged.tree, conflicted: [] };
	}
	const conflicted = [...new Set(merged.conflicts.flatMap((c) => c.paths))];
	return { tree: await treeTakingPaths(repo, merged.markerTree, tree, conflicted), conflicted };
}

// Computes every stack commit as Apply would write it, without writing any commit, ref, index, or file. Each commit's edit (or the commit itself) is merged onto its parent as derived; a conflict does not stop the walk, and the commits above it build on the stand-in tree.
export async function stackDerive(
	trees: DeriveTrees,
	commits: readonly StackCommit[],
	baseTree: Oid,
	edits: ReadonlyMap<Oid, Edit>,
	resolutions: ReadonlyMap<string, readonly TreeChange[]>,
): Promise<DerivedCommit[]> {
	const derived: DerivedCommit[] = [];
	let originalParent = baseTree;
	let parentTree = baseTree;
	let provisional: string[] = [];
	for (const commit of commits) {
		const edit = edits.get(commit.oid);
		const base = edit?.tree === undefined ? originalParent : (edit.parentTree ?? originalParent);
		const theirs = edit?.tree ?? commit.tree;
		let tree = theirs;
		let conflict: ConflictFound | undefined;
		let resolvedByTable = false;
		let fallback = false;
		if (parentTree !== base) {
			const merged = await trees.merge(base, parentTree, theirs);
			if (merged.kind === "clean") {
				tree = merged.tree;
			} else {
				const conflicts = merged.conflicts.map((c) => ({ ...c, resolved: resolutions.has(c.key) }));
				const older = edit?.fallback;
				const replaced = older === undefined ? undefined : older.parentTree === parentTree ? older.tree : await trees.merge(older.parentTree, parentTree, older.tree);
				if (conflicts.every((c) => c.resolved)) {
					tree = await treeWithChanges(
						trees.repo,
						merged.markerTree,
						merged.conflicts.flatMap((c) => resolutions.get(c.key) ?? []),
					);
					resolvedByTable = true;
				} else if (typeof replaced === "string" || replaced?.kind === "clean") {
					tree = typeof replaced === "string" ? replaced : replaced.tree;
					fallback = true;
				} else {
					conflict = { inputs: { base, ours: parentTree, theirs }, markerTree: merged.markerTree, conflicts };
					tree = await trees.standIn(merged.markerTree, theirs, [...new Set(merged.conflicts.flatMap((c) => c.paths))]);
				}
			}
		}
		derived.push({ commit, parentTree, tree, message: edit?.message ?? commit.message, conflict, resolvedByTable, fallback, provisional });
		if (conflict !== undefined) {
			provisional = [...new Set([...provisional, ...conflict.conflicts.flatMap((c) => c.paths)])];
		}
		originalParent = commit.tree;
		parentTree = tree;
	}
	return derived;
}

// The derived stack as the steps Apply writes, flagged with which commits it rewrites.
export function derivedSteps(baseTree: Oid, derived: readonly DerivedCommit[]): ReplayStep[] {
	return stepsReflag(
		baseTree,
		derived.map((d) => ({ commit: d.commit, tree: d.tree, message: d.message, rewrite: false, empty: false })),
	);
}
