import { EditorState, Text } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { type DeletionMetrics, deletedLineLengths, deletedRows, deletionMetricsSet } from "./deletion-layout";
import { Chunk, unifiedMergeView } from "./index";

const METRICS: DeletionMetrics = { lineHeight: 20, lineLength: 80, wrapping: true };

function chunkOnly(a: string, b: string): Chunk {
	const chunks = Chunk.build(Text.of(a.split("\n")), Text.of(b.split("\n")));
	const chunk = chunks[0];
	if (chunks.length !== 1 || chunk === undefined) {
		throw new Error(`expected one chunk, got ${chunks.length}`);
	}
	return chunk;
}

// The block widgets in the editor's decorations, in document order.
function blockWidgets(state: EditorState): WidgetType[] {
	const widgets: WidgetType[] = [];
	for (const set of state.facet(EditorView.decorations)) {
		if (typeof set === "function") {
			continue;
		}
		for (const cursor = set.iter(); cursor.value !== null; cursor.next()) {
			const widget: unknown = cursor.value.spec.widget;
			if (cursor.value.spec.block === true && widget instanceof WidgetType) {
				widgets.push(widget);
			}
		}
	}
	return widgets;
}

describe("deletedRows", () => {
	it("counts one row a line without wrapping", () => {
		expect(deletedRows(Int32Array.of(0, 500, 3), 0, 3, { ...METRICS, wrapping: false })).toBe(3);
	});

	it("estimates rows of a wrapped line as CodeMirror's height oracle does", () => {
		expect(deletedRows(Int32Array.of(0), 0, 1, METRICS)).toBe(1);
		expect(deletedRows(Int32Array.of(80), 0, 1, METRICS)).toBe(1);
		expect(deletedRows(Int32Array.of(81), 0, 1, METRICS)).toBe(2);
		expect(deletedRows(Int32Array.of(155), 0, 1, METRICS)).toBe(2);
		expect(deletedRows(Int32Array.of(156), 0, 1, METRICS)).toBe(3);
	});

	it("counts only the range asked for", () => {
		expect(deletedRows(Int32Array.of(1000, 10, 156, 1000), 1, 3, METRICS)).toBe(4);
	});
});

describe("deletedLineLengths", () => {
	it("gives the deleted lines' lengths, empty ones included", () => {
		expect([...deletedLineLengths(Text.of(["a", "", "ccc", "dd"]), chunkOnly("a\n\nccc\ndd", "a\ndd"))]).toEqual([0, 3]);
	});

	it("matches the lines the widget shows, at a document's end with or without a newline too", () => {
		for (const [a, b] of [
			["a\nbb\nccc", "a"],
			["a\nbb\nccc\n", "a\n"],
			["a\nbb\nccc", "a\nccc"],
			["x\nbb", "y\nbb"],
		] as const) {
			const original = Text.of(a.split("\n"));
			const chunk = chunkOnly(a, b);
			const shown = original.sliceString(chunk.fromA, chunk.endA).split("\n");
			expect([...deletedLineLengths(original, chunk)]).toEqual(shown.map((line) => line.length));
		}
	});

	it("is empty for a chunk that only inserts", () => {
		expect(deletedLineLengths(Text.of(["a", "b"]), chunkOnly("a\nb", "a\nx\nb"))).toHaveLength(0);
	});
});

describe("deletion widget estimates", () => {
	// A chunk deleting a 200-character line and a short one, and one that only inserts.
	const original = ["keep", "x".repeat(200), "short", "keep", "keep", "keep", "keep", "keep", "keep", "keep", "keep"].join("\n");
	const doc = ["keep", "keep", "keep", "keep", "keep", "keep", "keep", "added", "keep", "keep"].join("\n");
	const create = (): EditorState => EditorState.create({ doc, extensions: unifiedMergeView({ original, mergeControls: false }) });

	it("counts one line for a deletion before the editor is measured, and nothing for a chunk that only inserts", () => {
		expect(blockWidgets(create()).map((w) => w.estimatedHeight)).toEqual([-1, 0]);
	});

	it("estimates a deletion from its lines once the editor is measured", () => {
		const state = create().update({ effects: deletionMetricsSet.of(METRICS) }).state;
		// 200 characters at 80 a row: 1 + ceil(120 / 75) = 3 rows, and 1 for the short line.
		expect(blockWidgets(state).map((w) => w.estimatedHeight)).toEqual([4 * METRICS.lineHeight, 0]);
	});

	it("keeps the widgets through a transaction that changes neither the chunks nor the metrics", () => {
		const state = create().update({ effects: deletionMetricsSet.of(METRICS) }).state;
		const after = state.update({ selection: { anchor: 3 } }).state;
		expect(blockWidgets(after)[0]).toBe(blockWidgets(state)[0]);
	});

	it("estimates anew, for widgets not yet drawn, when the metrics change", () => {
		const state = create().update({ effects: deletionMetricsSet.of(METRICS) }).state;
		const after = state.update({ effects: deletionMetricsSet.of({ ...METRICS, lineLength: 200 }) }).state;
		const [before, now] = [blockWidgets(state)[0], blockWidgets(after)[0]];
		if (before === undefined || now === undefined) {
			throw new Error("no deletion widget");
		}
		// CodeMirror re-estimates only a widget that is not `eq` to the one it replaces.
		expect(now.eq(before)).toBe(false);
		expect(blockWidgets(after).map((w) => w.estimatedHeight)).toEqual([2 * METRICS.lineHeight, 0]);
	});
});
