import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LAYOUT_TEST_TIMEOUT, type LayoutPage, layoutPage, layoutPageRemove, layoutRun } from "../main/test-support/layout-harness.ts";

// The inline diff's deletions under real layout, in Electron (merge-layout.page.ts): lazy groups of deleted lines, height estimates against CodeMirror's height map, and the page's height staying put once the reader has scrolled through.

type Result = { readonly [key: string]: unknown };

function record(value: unknown): Result {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`expected an object, got ${JSON.stringify(value)}`);
	}
	return Object.fromEntries(Object.entries(value));
}

function num(r: Result, key: string): number {
	const value = r[key];
	if (typeof value !== "number") {
		throw new Error(`expected a number at ${key}, got ${JSON.stringify(value)}`);
	}
	return value;
}

function list(r: Result, key: string): readonly unknown[] {
	const value = r[key];
	if (!Array.isArray(value)) {
		throw new Error(`expected an array at ${key}, got ${JSON.stringify(value)}`);
	}
	return value;
}

let page: LayoutPage | undefined;

async function run(scenario: string): Promise<Result> {
	if (page === undefined) {
		throw new Error("the page was not built");
	}
	return record(await layoutRun(page, scenario));
}

beforeAll(async () => {
	page = await layoutPage(join(import.meta.dirname, "merge-layout.page.ts"));
}, LAYOUT_TEST_TIMEOUT);

afterAll(async () => {
	if (page !== undefined) {
		await layoutPageRemove(page);
	}
});

// The error in a deletion's estimate: how far the page's height moved once it was drawn, against its drawn height.
function estimateError(r: Result): number {
	return Math.abs(num(r, "initial") - num(r, "final")) / num(r, "deletion");
}

describe("merge view deletion layout", () => {
	it.concurrent(
		"skips laying out full groups of deleted lines far from the viewport, never the last, and gives each deleted line the hang for its own text",
		async () => {
			const r = await run("groups");
			const groups = list(r, "chunks").map((chunk) => {
				if (!Array.isArray(chunk)) {
					throw new Error("expected a chunk's groups");
				}
				return chunk.map((g) => record(g));
			});
			expect(groups.map((chunk) => chunk.map((g) => g.lines))).toEqual([[3], [40], [200, 200, 50]]);
			for (const chunk of groups) {
				expect(chunk.map((g) => [g.lazy, g.sized])).toEqual(chunk.map((_, i) => (i < chunk.length - 1 ? [true, true] : [false, false])));
			}
			// The big deletion's second group is far below the viewport; its last, as far, is laid out all the same.
			expect(groups[2]?.map((g) => g.laidOut)).toEqual([expect.any(Boolean), false, true]);
			expect(num(r, "deletedLines")).toBe(493);
			// The small deletions are syntax-highlighted, which splits their lines into spans differently.
			expect(num(r, "highlighted")).toBeGreaterThan(0);
			expect(num(r, "hangsWrong")).toBe(0);
		},
		LAYOUT_TEST_TIMEOUT,
	);

	it.concurrent(
		"estimates a deletion of wrapped lines it has not drawn from its lines",
		async () => {
			// Wrapped rows are estimated as CodeMirror estimates its own text, without the hang that narrows them; a few percent short.
			expect(estimateError(await run("estimateWrapped"))).toBeLessThan(0.08);
		},
		LAYOUT_TEST_TIMEOUT,
	);

	it.concurrent(
		"estimates a deletion of lines that don't wrap almost exactly",
		async () => {
			expect(estimateError(await run("estimateShort"))).toBeLessThan(0.01);
		},
		LAYOUT_TEST_TIMEOUT,
	);

	it.concurrent(
		"estimates a deletion drawn in an editor built out of view, keeping the DOM it was drawn with",
		async () => {
			const r = await run("outOfView");
			expect(r.inView).toBe(false);
			expect(r.drawnFirst).toBe(true);
			expect(Math.abs(num(r, "contentHeight") / num(r, "domHeight") - 1)).toBeLessThan(0.03);
			expect(r.sameAfterEstimate).toBe(true);
			expect(r.sameInView).toBe(true);
		},
		LAYOUT_TEST_TIMEOUT,
	);

	it.concurrent(
		"keeps the page's height once scrolled through, also after CodeMirror drops the deletion and draws it again",
		async () => {
			const r = await run("stability");
			expect(r.drawn).toBe(true);
			expect(r.leftDom).toBe(true);
			expect(list(r, "second")).toEqual([]);
			expect(list(r, "third")).toEqual([]);
		},
		LAYOUT_TEST_TIMEOUT,
	);

	it.concurrent(
		"keeps the height CodeMirror measured for a deletion drawn before, when the editor's metrics change",
		async () => {
			const r = await run("metricsChange");
			expect(r.drawn).toBe(true);
			expect(r.leftDom).toBe(true);
			expect(num(r, "after")).toBe(num(r, "before"));
		},
		LAYOUT_TEST_TIMEOUT,
	);
});
