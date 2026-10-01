import { describe, expect, it } from "vitest";
import { type StackSummary, viewDecide } from "./view-decide.ts";

const c = (oid: string, authorLine: string, subject: string) => ({ oid, authorLine, subject });
const commits = [c("o1", "A 1", "one"), c("o2", "A 2", "two"), c("o3", "A 3", "three")];
const summary = (over: Partial<StackSummary> = {}): StackSummary => ({ commits, pending: new Set(), drafts: new Set(), ...over });
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

	it("never replaces the resolve or hook view", () => {
		expect(viewDecide(summary({ commits: [] }), { kind: "resolve" }, sel(0))).toEqual({ kind: "keep" });
		expect(viewDecide(summary({ commits: [] }), { kind: "hook" }, sel(0))).toEqual({ kind: "keep" });
	});

	it("starts at the newest commit, and reports an empty stack", () => {
		expect(viewDecide(summary(), { kind: "none" }, undefined)).toEqual({ kind: "commit", oid: "o3", readOnly: false });
		expect(viewDecide(summary({ commits: [] }), { kind: "none" }, undefined)).toEqual({ kind: "empty" });
		expect(viewDecide(summary({ commits: [] }), { kind: "blocked" }, sel(1))).toEqual({ kind: "empty" });
		expect(viewDecide(summary({ commits: [] }), { kind: "commit", oid: "o2", readOnly: false }, sel(1))).toEqual({ kind: "empty" });
	});
});
