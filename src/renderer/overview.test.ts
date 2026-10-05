import { describe, expect, it } from "vitest";
import { changeKind, type OverviewMark, overviewTicks } from "./overview.ts";

const mark = (top: number, bottom: number, kind: OverviewMark<string>["kind"], target: string): OverviewMark<string> => ({ top, bottom, kind, target });

describe("overviewTicks", () => {
	it("places marks in proportion to the content, at least the minimum tall", () => {
		const ticks = overviewTicks([mark(100, 300, "added", "x"), mark(500, 501, "removed", "y")], 0, 1000, 100, 3);
		expect(ticks).toEqual([
			{ y: 10, height: 20, kind: "added", target: "x" },
			{ y: 50, height: 3, kind: "removed", target: "y" },
		]);
	});

	it("merges overlapping marks of one kind, keeping the first one's target, but not marks of different kinds", () => {
		const ticks = overviewTicks([mark(100, 120, "added", "a"), mark(110, 200, "added", "b"), mark(105, 115, "edit", "c"), mark(205, 210, "added", "d")], 0, 1000, 1000, 2);
		expect(ticks).toEqual([
			{ y: 100, height: 100, kind: "added", target: "a" },
			{ y: 105, height: 10, kind: "edit", target: "c" },
			{ y: 205, height: 5, kind: "added", target: "d" },
		]);
	});

	it("merges marks that only overlap once raised to the minimum height", () => {
		const ticks = overviewTicks([mark(0, 1, "modified", "a"), mark(20, 21, "modified", "b")], 0, 1000, 100, 3);
		expect(ticks).toEqual([{ y: 0, height: 5, kind: "modified", target: "a" }]);
	});

	it("keeps ticks within the track", () => {
		const ticks = overviewTicks([mark(999, 1000, "removed", "end"), mark(0, 5000, "added", "all")], 0, 1000, 100, 4);
		expect(ticks).toEqual([
			{ y: 0, height: 100, kind: "added", target: "all" },
			{ y: 96, height: 4, kind: "removed", target: "end" },
		]);
	});

	it("measures marks from the content's top, given in the same viewport pixels as the marks", () => {
		// The content starts 40px above the viewport's top: scrolled down 140px in a scroller placed 100px down.
		expect(overviewTicks([mark(160, 260, "edit", "x")], -40, 1000, 100, 3)).toEqual([{ y: 20, height: 10, kind: "edit", target: "x" }]);
	});

	it("gives no ticks for an empty or zero-height document or track", () => {
		expect(overviewTicks([], 0, 1000, 100, 3)).toEqual([]);
		expect(overviewTicks([mark(0, 10, "added", "x")], 0, 0, 100, 3)).toEqual([]);
		expect(overviewTicks([mark(0, 10, "added", "x")], 0, 1000, 0, 3)).toEqual([]);
	});
});

describe("changeKind", () => {
	it("names a change by which of its sides are empty, and gives none where both are", () => {
		expect(changeKind(true, false)).toBe("added");
		expect(changeKind(false, true)).toBe("removed");
		expect(changeKind(false, false)).toBe("modified");
		expect(changeKind(true, true)).toBeUndefined();
	});
});
