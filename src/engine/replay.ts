import type { Oid, Repo } from "./git.ts";
import { type Conflict, mergeTrees } from "./merge.ts";
import type { StackCommit } from "./stack.ts";
import { commitWrite, type TreeChange, treeWithChanges } from "./write.ts";

// The desired new version of one stack commit.
export type Edit = { readonly tree: Oid | undefined; readonly message: Buffer | undefined };

export type ReplayStep = {
	readonly commit: StackCommit;
	readonly tree: Oid;
	readonly message: Buffer;
	// False means the original commit is kept as is: nothing below it or in it changed.
	readonly rewrite: boolean;
	readonly empty: boolean;
};

export type MergeInputs = { readonly base: Oid; readonly ours: Oid; readonly theirs: Oid };

export type ReplayResult =
	| { readonly kind: "clean"; readonly steps: readonly ReplayStep[] }
	| {
			readonly kind: "conflict";
			readonly commit: StackCommit;
			readonly inputs: MergeInputs;
			readonly markerTree: Oid;
			// Every conflict in the commit, each flagged with whether a stored resolution already covers it.
			readonly conflicts: readonly (Conflict & { readonly resolved: boolean })[];
	  };

// Computes the restacked trees without writing any commit, ref, index, or file.
export async function replayTrees(
	repo: Repo,
	commits: readonly StackCommit[],
	baseTree: Oid,
	edits: ReadonlyMap<Oid, Edit>,
	resolutions: ReadonlyMap<string, readonly TreeChange[]>,
): Promise<ReplayResult> {
	const steps: ReplayStep[] = [];
	let oldParentTree = baseTree;
	let newParentTree = baseTree;
	let parentRewritten = false;
	for (const commit of commits) {
		const edit = edits.get(commit.oid);
		const theirs = edit?.tree ?? commit.tree;
		let tree: Oid;
		if (newParentTree === oldParentTree) {
			tree = theirs;
		} else {
			const inputs = { base: oldParentTree, ours: newParentTree, theirs };
			const merged = await mergeTrees(repo, inputs.base, inputs.ours, inputs.theirs);
			if (merged.kind === "clean") {
				tree = merged.tree;
			} else {
				const conflicts = merged.conflicts.map((conflict) => ({ ...conflict, resolved: resolutions.has(conflict.key) }));
				if (!conflicts.every((c) => c.resolved)) {
					return { kind: "conflict", commit, inputs, markerTree: merged.markerTree, conflicts };
				}
				tree = await treeWithChanges(
					repo,
					merged.markerTree,
					merged.conflicts.flatMap((c) => resolutions.get(c.key) ?? []),
				);
			}
		}
		const message = edit?.message ?? commit.message;
		const rewrite: boolean = parentRewritten || tree !== commit.tree || !message.equals(commit.message);
		steps.push({ commit, tree, message, rewrite, empty: tree === newParentTree });
		parentRewritten = rewrite;
		oldParentTree = commit.tree;
		newParentTree = tree;
	}
	return { kind: "clean", steps };
}

export type Rewritten = { readonly old: Oid; readonly new: Oid };

// Writes the commits for a clean replay. Called only when publishing, since signing may prompt for every commit.
export async function replayCommit(repo: Repo, baseOid: Oid, steps: readonly ReplayStep[], sign: boolean): Promise<{ tip: Oid; rewritten: Rewritten[] }> {
	let parent = baseOid;
	const rewritten: Rewritten[] = [];
	for (const step of steps) {
		if (!step.rewrite) {
			parent = step.commit.oid;
			continue;
		}
		const oid = await commitWrite(repo, { tree: step.tree, parent, authorLine: step.commit.authorLine, message: step.message, encoding: step.commit.encoding }, sign);
		rewritten.push({ old: step.commit.oid, new: oid });
		parent = oid;
	}
	return { tip: parent, rewritten };
}
