import type { WorktreeSide } from "../engine/worktree-changes.ts";
import { type CommitIdentity, reselect } from "./reselect.ts";

// What the view logic needs to know about the session state.
export type StackSummary = {
	readonly commits: readonly CommitIdentity[];
	// Commits a waiting draft is keyed to (rebased, conflicting, or made on another branch): read-only until the user decides.
	readonly pending: ReadonlySet<string>;
	// Every stored draft, by the commit it was made on.
	readonly drafts: ReadonlySet<string>;
	// Commits whose restacking onto the edits below conflicts: shown as the conflict to resolve.
	readonly conflicted: ReadonlySet<string>;
	// How many files each side of the uncommitted changes has.
	readonly worktree: { readonly staged: number; readonly unstaged: number };
};

export type ViewShown =
	| { readonly kind: "none" }
	| { readonly kind: "blocked" }
	| { readonly kind: "resolve"; readonly oid: string }
	| { readonly kind: "hook" }
	| { readonly kind: "draft"; readonly against: string }
	| { readonly kind: "worktree"; readonly side: WorktreeSide }
	| { readonly kind: "commit"; readonly oid: string; readonly readOnly: boolean };

export type ViewDecision =
	// The view stays; only its surroundings (stack, banners) are redrawn, so editors are never replaced under the user.
	| { readonly kind: "keep" }
	| { readonly kind: "commit"; readonly oid: string; readonly readOnly: boolean }
	| { readonly kind: "resolve"; readonly oid: string }
	| { readonly kind: "worktree"; readonly side: WorktreeSide }
	| { readonly kind: "empty" };

// How a stack commit is shown: read-only while a draft waits on it, else its conflict when restacking it conflicts, else its document.
export function commitShow(summary: StackSummary, oid: string): Exclude<ViewDecision, { kind: "keep" | "worktree" | "empty" }> {
	// A draft waiting for confirmation comes first: resolving would store a second version of the commit beside it.
	if (summary.pending.has(oid)) {
		return { kind: "commit", oid, readOnly: true };
	}
	return summary.conflicted.has(oid) ? { kind: "resolve", oid } : { kind: "commit", oid, readOnly: false };
}

function commitAt(summary: StackSummary, index: number | undefined): ViewDecision {
	const commit = index === undefined ? undefined : summary.commits[index];
	return commit === undefined ? { kind: "empty" } : commitShow(summary, commit.oid);
}

// Decides what to show after the session state changed.
export function viewDecide(summary: StackSummary, shown: ViewShown, selected: (CommitIdentity & { readonly index: number }) | undefined): ViewDecision {
	// With nothing selected yet, the newest commit: usually the work just done.
	const followed = () => commitAt(summary, selected === undefined ? summary.commits.length - 1 : reselect(selected, summary.commits));
	switch (shown.kind) {
		case "hook":
			return { kind: "keep" };
		case "resolve": {
			// Kept while the conflict stands, its unsaved work with it; once it is gone (resolved elsewhere, or the edit causing it undone) the commit is shown as it is.
			if (!summary.commits.some((c) => c.oid === shown.oid)) {
				return followed();
			}
			const wanted = commitShow(summary, shown.oid);
			return wanted.kind === "resolve" ? { kind: "keep" } : wanted;
		}
		case "draft":
			return summary.drafts.has(shown.against) ? { kind: "keep" } : followed();
		case "commit": {
			const index = summary.commits.findIndex((c) => c.oid === shown.oid);
			if (index === -1) {
				return followed();
			}
			const wanted = commitShow(summary, shown.oid);
			return wanted.kind === "commit" && wanted.readOnly === shown.readOnly ? { kind: "keep" } : wanted;
		}
		case "worktree": {
			const other: WorktreeSide = shown.side === "staged" ? "unstaged" : "staged";
			if (summary.worktree[shown.side] > 0) {
				return { kind: "keep" };
			}
			// The changes were staged or committed: follow them.
			return summary.worktree[other] > 0 ? { kind: "worktree", side: other } : commitAt(summary, summary.commits.length - 1);
		}
		case "none":
		case "blocked":
			return followed();
		default: {
			const never: never = shown;
			throw new Error(`unknown view ${String(never)}`);
		}
	}
}

// What a poll that found the working tree's status does: nothing; redraw the stack's rows (counts changed); decide the view again (the shown side emptied); or rebuild the shown side's view (its contents changed, it was last rebuilt `sinceRebuildMs` ago, and the reader is not mid-selection).
export type WorktreePoll = "none" | "redraw" | "redecide" | "rebuild";

export const WORKTREE_REBUILD_MS = 2000;

export function worktreePollAction(
	countsChanged: boolean,
	after: StackSummary["worktree"],
	shown: ViewShown,
	printStale: boolean,
	sinceRebuildMs: number,
	holding: boolean,
): WorktreePoll {
	if (shown.kind === "worktree") {
		if (after[shown.side] === 0) {
			return "redecide";
		}
		if (printStale && !holding && sinceRebuildMs >= WORKTREE_REBUILD_MS) {
			return "rebuild";
		}
	}
	return countsChanged ? "redraw" : "none";
}
