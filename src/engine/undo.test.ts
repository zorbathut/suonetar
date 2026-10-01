import { describe, expect, test } from "vitest";
import { reflogMessage, reflogParse } from "./undo.ts";

describe("reflog messages", () => {
	test("round-trip, so an entry's old tip is read from its own message", () => {
		const old = "a".repeat(40);
		expect(reflogParse(reflogMessage("apply", 3, old))).toEqual({ verb: "apply", count: 3, old });
		expect(reflogParse(reflogMessage("redo", 1, old))).toEqual({ verb: "redo", count: 1, old });
		expect(reflogParse(`${reflogMessage("undo", 2, old)} (rolled back)`)).toBeUndefined();
		expect(reflogParse("commit: suonetar: apply 2 commits from x")).toBeUndefined();
	});
});
