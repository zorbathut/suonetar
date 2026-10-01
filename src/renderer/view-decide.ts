import { type CommitIdentity, reselect } from "./reselect.ts";

// What the view logic needs to know about the session state.
export type StackSummary = {
	readonly commits: readonly CommitIdentity[];
	// Commits a waiting draft is keyed to (rebased, conflicting, or made on another branch): read-only until the user decides.
	readonly pending: ReadonlySet<string>;
	// Every stored draft, by the commit it was made on.
	readonly drafts: ReadonlySet<string>;
};

export type ViewShown =
	| { readonly kind: "none" }
	| { readonly kind: "blocked" }
	| { readonly kind: "resolve" }
	| { readonly kind: "hook" }
	| { readonly kind: "draft"; readonly against: string }
	| { readonly kind: "commit"; readonly oid: string; readonly readOnly: boolean };

export type ViewDecision =
	// The view stays; only its surroundings (stack, banners) are redrawn, so editors are never replaced under the user.
	{ readonly kind: "keep" } | { readonly kind: "commit"; readonly oid: string; readonly readOnly: boolean } | { readonly kind: "empty" };

function commitAt(summary: StackSummary, index: number | undefined): ViewDecision {
	const commit = index === undefined ? undefined : summary.commits[index];
	return commit === undefined ? { kind: "empty" } : { kind: "commit", oid: commit.oid, readOnly: summary.pending.has(commit.oid) };
}

// Decides what to show after the session state changed.
export function viewDecide(summary: StackSummary, shown: ViewShown, selected: (CommitIdentity & { readonly index: number }) | undefined): ViewDecision {
	const followed = () => commitAt(summary, selected === undefined ? 0 : reselect(selected, summary.commits));
	switch (shown.kind) {
		case "resolve":
		case "hook":
			return { kind: "keep" };
		case "draft":
			return summary.drafts.has(shown.against) ? { kind: "keep" } : followed();
		case "commit": {
			const index = summary.commits.findIndex((c) => c.oid === shown.oid);
			if (index === -1) {
				return followed();
			}
			return summary.pending.has(shown.oid) === shown.readOnly ? { kind: "keep" } : commitAt(summary, index);
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
