import { describe, expect, it } from "vitest";
import { type StackSummary, viewDecide, WORKTREE_REBUILD_MS, worktreePollAction } from "./view-decide.ts";

const c = (oid: string, authorLine: string, subject: string) => ({ oid, authorLine, subject });
const commits = [c("o1", "A 1", "one"), c("o2", "A 2", "two"), c("o3", "A 3", "three")];
const summary = (over: Partial<StackSummary> = {}): StackSummary => ({
	commits,
	pending: new Set(),
	drafts: new Set(),
	conflicted: new Set(),
	worktree: { staged: 0, unstaged: 0 },
	...over,
});
const sel = (index: number) => ({ ...(commits[index] ?? c("x", "x", "x")), index });

describe("viewDecide", () => {
	it("keeps a commit view whose commit is unchanged, whatever else moved", () => {
		expect(viewDecide(summary({ drafts: new Set(["o1"]) }), { kind: "commit", oid: "o2", readOnly: false }, sel(1))).toEqual({ kind: "keep" });
	});

	it("follows a commit rewritten while it was shown", () => {
		const rewritten = [c("n1", "A 1", "one"), c("n2", "A 2", "two"), c("n3", "A 3", "three")];
		expect(viewDecide(summary({ commits: rewritten }), { kind: "commit", oid: "o2", readOnly: false }, sel(1))).toEqual({ kind: "commit", oid: "n2", readOnly: false });
	});

	it("opens the rewritten commit read-only when a draft waits on it", () => {
		const rewritten = [c("n1", "A 1", "one"), c("n2", "A 2", "two")];
		expect(viewDecide(summary({ commits: rewritten, pending: new Set(["n2"]) }), { kind: "commit", oid: "o2", readOnly: false }, sel(1))).toEqual({
			kind: "commit",
			oid: "n2",
			readOnly: true,
		});
	});

	it("rebuilds the same commit when a waiting draft appears or is settled", () => {
		expect(viewDecide(summary({ pending: new Set(["o2"]) }), { kind: "commit", oid: "o2", readOnly: false }, sel(1))).toEqual({ kind: "commit", oid: "o2", readOnly: true });
		expect(viewDecide(summary(), { kind: "commit", oid: "o2", readOnly: true }, sel(1))).toEqual({ kind: "commit", oid: "o2", readOnly: false });
	});

	it("keeps a draft view while its draft exists, and returns to the stack when it is gone", () => {
		expect(viewDecide(summary({ drafts: new Set(["gone"]) }), { kind: "draft", against: "gone" }, sel(2))).toEqual({ kind: "keep" });
		expect(viewDecide(summary(), { kind: "draft", against: "gone" }, sel(2))).toEqual({ kind: "commit", oid: "o3", readOnly: false });
	});

	it("shows a conflicted commit's conflict, from the start, on following it, and when its open view starts conflicting", () => {
		const conflicted = new Set(["o3"]);
		expect(viewDecide(summary({ conflicted }), { kind: "none" }, undefined)).toEqual({ kind: "resolve", oid: "o3" });
		const rewritten = [c("n1", "A 1", "one"), c("n2", "A 2", "two"), c("n3", "A 3", "three")];
		expect(viewDecide(summary({ commits: rewritten, conflicted: new Set(["n3"]) }), { kind: "commit", oid: "o3", readOnly: false }, sel(2))).toEqual({
			kind: "resolve",
			oid: "n3",
		});
		expect(viewDecide(summary({ conflicted }), { kind: "commit", oid: "o3", readOnly: false }, sel(2))).toEqual({ kind: "resolve", oid: "o3" });
	});

	it("keeps a conflict while it stands, and shows the commit once it is gone", () => {
		expect(viewDecide(summary({ conflicted: new Set(["o2"]) }), { kind: "resolve", oid: "o2" }, sel(1))).toEqual({ kind: "keep" });
		expect(viewDecide(summary(), { kind: "resolve", oid: "o2" }, sel(1))).toEqual({ kind: "commit", oid: "o2", readOnly: false });
		const rewritten = [c("n1", "A 1", "one"), c("n2", "A 2", "two"), c("n3", "A 3", "three")];
		expect(viewDecide(summary({ commits: rewritten }), { kind: "resolve", oid: "o2" }, sel(1))).toEqual({ kind: "commit", oid: "n2", readOnly: false });
	});

	it("shows a commit whose draft waits for confirmation read-only, though it conflicts", () => {
		expect(viewDecide(summary({ conflicted: new Set(["o3"]), pending: new Set(["o3"]) }), { kind: "none" }, undefined)).toEqual({ kind: "commit", oid: "o3", readOnly: true });
	});

	it("never replaces the hook view", () => {
		expect(viewDecide(summary({ commits: [] }), { kind: "hook" }, sel(0))).toEqual({ kind: "keep" });
	});

	it("starts at the newest commit, and reports an empty stack", () => {
		expect(viewDecide(summary(), { kind: "none" }, undefined)).toEqual({ kind: "commit", oid: "o3", readOnly: false });
		expect(viewDecide(summary({ commits: [] }), { kind: "none" }, undefined)).toEqual({ kind: "empty" });
		expect(viewDecide(summary({ commits: [] }), { kind: "blocked" }, sel(1))).toEqual({ kind: "empty" });
		expect(viewDecide(summary({ commits: [] }), { kind: "commit", oid: "o2", readOnly: false }, sel(1))).toEqual({ kind: "empty" });
	});

	it("keeps an uncommitted-changes view while its side has changes, else moves to the other side, else to the newest commit", () => {
		const both = { staged: 2, unstaged: 1 };
		expect(viewDecide(summary({ worktree: both }), { kind: "worktree", side: "unstaged" }, sel(0))).toEqual({ kind: "keep" });
		expect(viewDecide(summary({ worktree: { staged: 2, unstaged: 0 } }), { kind: "worktree", side: "unstaged" }, sel(0))).toEqual({ kind: "worktree", side: "staged" });
		expect(viewDecide(summary({ worktree: { staged: 0, unstaged: 3 } }), { kind: "worktree", side: "staged" }, sel(0))).toEqual({ kind: "worktree", side: "unstaged" });
		expect(viewDecide(summary(), { kind: "worktree", side: "staged" }, sel(0))).toEqual({ kind: "commit", oid: "o3", readOnly: false });
		expect(viewDecide(summary({ commits: [] }), { kind: "worktree", side: "staged" }, sel(0))).toEqual({ kind: "empty" });
	});
});

describe("worktreePollAction", () => {
	const unstaged = { kind: "worktree", side: "unstaged" } as const;
	const counts = { staged: 1, unstaged: 2 };
	const late = WORKTREE_REBUILD_MS;

	it("rebuilds a shown side whose contents changed, at most so often and not while the reader holds a selection", () => {
		expect(worktreePollAction(false, counts, unstaged, true, late, false)).toBe("rebuild");
		expect(worktreePollAction(false, counts, unstaged, true, late - 1, false)).toBe("none");
		expect(worktreePollAction(true, counts, unstaged, true, late - 1, false)).toBe("redraw");
		expect(worktreePollAction(false, counts, unstaged, true, late, true)).toBe("none");
		expect(worktreePollAction(false, counts, unstaged, false, late, false)).toBe("none");
	});

	it("decides again when the shown side empties, and otherwise only redraws the rows for new counts", () => {
		expect(worktreePollAction(true, { staged: 1, unstaged: 0 }, unstaged, false, 0, false)).toBe("redecide");
		expect(worktreePollAction(true, counts, { kind: "commit", oid: "o1", readOnly: false }, false, 0, false)).toBe("redraw");
		expect(worktreePollAction(false, counts, { kind: "commit", oid: "o1", readOnly: false }, false, 0, false)).toBe("none");
	});
});
