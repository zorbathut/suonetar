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
		steps.push({ commit, tree, message: edit?.message ?? commit.message, rewrite: false, empty: false });
		oldParentTree = commit.tree;
		newParentTree = tree;
	}
	return { kind: "clean", steps: stepsReflag(baseTree, steps) };
}

// Sets `rewrite` and `empty` from the trees and messages: after the replay, and again after the pre-commit pass changed trees.
export function stepsReflag(baseTree: Oid, steps: readonly ReplayStep[]): ReplayStep[] {
	let parentTree = baseTree;
	let parentRewritten = false;
	return steps.map((step) => {
		const rewrite = parentRewritten || step.tree !== step.commit.tree || !step.message.equals(step.commit.message);
		const flagged = { ...step, rewrite, empty: step.tree === parentTree };
		parentRewritten = rewrite;
		parentTree = step.tree;
		return flagged;
	});
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
