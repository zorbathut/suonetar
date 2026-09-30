import { describe, expect, it } from "vitest";
import { reselect } from "./reselect.ts";

const c = (oid: string, authorLine: string, subject: string) => ({ oid, authorLine, subject });
const stack = [c("o1", "A 1", "one"), c("o2", "A 2", "two"), c("o3", "A 3", "three")];

describe("reselect", () => {
	it("keeps the same commit when it is still there", () => {
		expect(reselect({ ...c("o2", "A 2", "two"), index: 0 }, stack)).toBe(1);
	});

	it("follows a rewritten commit by its author line", () => {
		const rewritten = [c("n1", "A 1", "one"), c("n2", "A 2", "two, reworded"), c("n3", "A 3", "three")];
		expect(reselect({ ...c("o2", "A 2", "two"), index: 1 }, rewritten)).toBe(1);
	});

	it("breaks author-line ties by subject", () => {
		const twins = [c("n1", "A 1", "one"), c("n2", "A 1", "two")];
		expect(reselect({ ...c("o2", "A 1", "two"), index: 0 }, twins)).toBe(1);
	});

	it("falls back to the same position, clamped", () => {
		expect(reselect({ ...c("gone", "B", "x"), index: 1 }, stack)).toBe(1);
		expect(reselect({ ...c("gone", "B", "x"), index: 7 }, stack)).toBe(2);
		expect(reselect({ ...c("gone", "B", "x"), index: 0 }, [])).toBeUndefined();
	});
});
