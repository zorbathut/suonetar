// Suonetar's own, not upstream's (see VENDOR.md): how the unified merge view lays out a deletion's lines, in groups laid out only near the viewport, and how tall it estimates a deletion it has not drawn, which CodeMirror would otherwise count as one line.

import { StateEffect, StateField, type Text } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Chunk } from "./chunk";
import type { Change } from "./diff";

// Deleted lines per `.cm-deletedGroup`.
export const DELETED_GROUP_LINES = 200;

// What a deleted line's height is estimated from: the editor's line height, how many characters fit on a row, and whether lines wrap.
export type DeletionMetrics = { readonly lineHeight: number; readonly lineLength: number; readonly wrapping: boolean };

export const deletionMetricsSet = StateEffect.define<DeletionMetrics>();

// The editor's metrics, once measured.
export const deletionMetrics = StateField.define<DeletionMetrics | undefined>({
	create: () => undefined,
	update: (metrics, tr) => tr.effects.findLast((e) => e.is(deletionMetricsSet))?.value ?? metrics,
});

// Small changes are measuring noise, and each change re-estimates every deletion not yet drawn.
function metricsClose(a: DeletionMetrics, b: DeletionMetrics): boolean {
	return a.wrapping === b.wrapping && Math.abs(a.lineLength - b.lineLength) < 1 && Math.abs(a.lineHeight - b.lineHeight) <= 0.5;
}

// CodeMirror measures an editor's text only once it is in view, and till then its line height and character width are defaults (14px and 7px). Editors on one page share their fonts, so another editor's are the better guess: the last measured in view, for the editors that have not been.
let fontInView: { readonly lineHeight: number; readonly charWidth: number } | undefined;
const viewsMeasured = new WeakSet<EditorView>();

function metricsRead(view: EditorView): DeletionMetrics | undefined {
	const width = view.contentDOM.getBoundingClientRect().width;
	// A hidden or collapsed editor has nothing to measure.
	if (width === 0) {
		return undefined;
	}
	if (view.inView) {
		viewsMeasured.add(view);
		fontInView = { lineHeight: view.defaultLineHeight, charWidth: view.defaultCharacterWidth };
	}
	const font = viewsMeasured.has(view) || fontInView === undefined ? { lineHeight: view.defaultLineHeight, charWidth: view.defaultCharacterWidth } : fontInView;
	return { lineHeight: font.lineHeight, lineLength: Math.max(5, width / font.charWidth), wrapping: view.lineWrapping };
}

// Measures as CodeMirror's height oracle does, and puts the result in the state, since a widget's estimate is read without a view. The dispatch waits for a microtask: a view can't be updated while it measures.
const deletionMetricsMeasure = ViewPlugin.fromClass(
	class {
		readonly view: EditorView;

		constructor(view: EditorView) {
			this.view = view;
			this.measure();
		}

		update(update: ViewUpdate): void {
			if (update.geometryChanged) {
				this.measure();
			}
		}

		measure(): void {
			this.view.requestMeasure({
				key: this,
				read: metricsRead,
				write: (metrics, view) => {
					if (metrics !== undefined) {
						queueMicrotask(() => metricsSet(view, metrics));
					}
				},
			});
		}
	},
);

function metricsSet(view: EditorView, metrics: DeletionMetrics): void {
	// The merge view may have been reconfigured away since.
	if (view.plugin(deletionMetricsMeasure) === null) {
		return;
	}
	const current = view.state.field(deletionMetrics);
	if (current !== undefined && metricsClose(current, metrics)) {
		return;
	}
	view.dispatch({ effects: deletionMetricsSet.of(metrics) });
	groupsPendingSize(view, metrics);
}

export const deletionLayout = [deletionMetrics, deletionMetricsMeasure];

const lineLengthsCache = new WeakMap<readonly Change[], Int32Array>();

// The lengths of the lines a chunk deletes from `original`, as the deletion widget shows them.
export function deletedLineLengths(original: Text, chunk: Chunk): Int32Array {
	const known = lineLengthsCache.get(chunk.changes);
	if (known !== undefined) {
		return known;
	}
	let lengths = new Int32Array(0);
	if (chunk.fromA < chunk.toA) {
		const first = original.lineAt(chunk.fromA).number;
		const last = original.lineAt(chunk.endA).number;
		lengths = new Int32Array(last - first + 1);
		for (let n = first; n <= last; n++) {
			lengths[n - first] = original.line(n).length;
		}
	}
	lineLengthsCache.set(chunk.changes, lengths);
	return lengths;
}

// How many rows lines `from` to `to` of `lengths` take, by the estimate CodeMirror's height oracle makes for a line of text (`HeightOracle.heightForLine`).
export function deletedRows(lengths: Int32Array, from: number, to: number, metrics: DeletionMetrics): number {
	if (!metrics.wrapping) {
		return to - from;
	}
	const length = metrics.lineLength;
	let rows = 0;
	for (const lineLength of lengths.subarray(from, to)) {
		rows += 1 + Math.max(0, Math.ceil((lineLength - length) / Math.max(1, length - 5)));
	}
	return rows;
}

// A deletion widget's estimated height, in px: -1 (CodeMirror's one line) until the editor has been measured, and 0 for one showing no lines, which is only its absolutely positioned buttons.
export function deletionEstimate(lengths: Int32Array, metrics: DeletionMetrics | undefined): number {
	if (lengths.length === 0) {
		return 0;
	}
	return metrics === undefined ? -1 : deletedRows(lengths, 0, lengths.length, metrics) * metrics.lineHeight;
}

function groupSize(lengths: Int32Array, from: number, metrics: DeletionMetrics): string {
	return `none auto ${deletedRows(lengths, from, from + DELETED_GROUP_LINES, metrics) * metrics.lineHeight}px`;
}

type GroupPending = { readonly group: HTMLElement; readonly lengths: Int32Array; readonly from: number; readonly fallback: string };

// Groups drawn before their editor was measured, as a deletion near the top of an editor usually is.
const groupsPending = new WeakMap<EditorView, GroupPending[]>();

function groupsPendingSize(view: EditorView, metrics: DeletionMetrics): void {
	const pending = groupsPending.get(view);
	if (pending === undefined) {
		return;
	}
	groupsPending.delete(view);
	for (const p of pending) {
		if (p.group.style.containIntrinsicSize === p.fallback) {
			p.group.style.containIntrinsicSize = groupSize(p.lengths, p.from, metrics);
		}
	}
}

// A full group of deleted lines, from line `from` of `lengths`, is laid out only near the viewport (content-visibility), so a deletion of many thousands of lines lays out like one screenful. Only full groups: the last, however short, is always laid out, since a full group's estimate for a deletion of a few lines would swing the page's height each time CodeMirror drew it near the viewport. Its size is its lines' estimate, or until the editor is measured as many unwrapped lines, estimated again then unless the group has its own height by then. The estimate gives a height only; a width would hold the content open past the editor and stop lines wrapping.
export function deletedGroupLazy(view: EditorView, group: HTMLElement, lengths: Int32Array, from: number): void {
	group.style.contentVisibility = "auto";
	const metrics = view.state.field(deletionMetrics);
	if (metrics !== undefined) {
		group.style.containIntrinsicSize = groupSize(lengths, from, metrics);
		return;
	}
	group.style.containIntrinsicSize = `none auto calc(${DELETED_GROUP_LINES} * 1lh)`;
	let pending = groupsPending.get(view);
	if (pending === undefined) {
		pending = [];
		groupsPending.set(view, pending);
	}
	// As the browser gives it back, so that a height kept since tells by being different.
	pending.push({ group, lengths, from, fallback: group.style.containIntrinsicSize });
}

// Once CodeMirror has taken a deletion's widget out of the page, the browser forgets its groups' laid-out heights, and drawing it again would bring back the estimate and swing the page's height. So a group's height as it scrolls out of the browser's reach goes into its own style, which the widget's DOM keeps; a group still on screen when a jump drops the whole widget is estimated once more. Only groups that have been laid out: every offscreen group reports being skipped as its widget is first drawn, and reading its height then would force a layout per group for an estimate already known.
export function deletedGroupHeightsKeep(dom: HTMLElement): void {
	const shown = new WeakSet<HTMLElement>();
	dom.addEventListener("contentvisibilityautostatechange", (e) => {
		const group = e.target;
		if (!(e instanceof ContentVisibilityAutoStateChangeEvent && group instanceof HTMLElement && group.classList.contains("cm-deletedGroup"))) {
			return;
		}
		if (!e.skipped) {
			shown.add(group);
		} else if (shown.has(group)) {
			group.style.containIntrinsicSize = `none auto ${group.getBoundingClientRect().height}px`;
		}
	});
}
