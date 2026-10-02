import type { Oid, Repo } from "./git.ts";
import type { StackCommit } from "./stack.ts";
import { commitWrite } from "./write.ts";

export type ReplayStep = {
	readonly commit: StackCommit;
	readonly tree: Oid;
	readonly message: Buffer;
	// False means the original commit is kept as is: nothing below it or in it changed.
	readonly rewrite: boolean;
	readonly empty: boolean;
};

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
