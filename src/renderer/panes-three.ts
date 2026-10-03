import { Chunk } from "@codemirror/merge";
import { type EditorState, type Extension, type Range, type RangeCursor, RangeSet, StateEffect, StateField, Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, GutterMarker, gutter, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import type { Indentation } from "../engine/editorconfig.ts";
import type { Wire } from "../shared/api.ts";
import { diffByLine } from "./diff.ts";
import { el } from "./dom.ts";
import { editorCreate, editorDiffSet } from "./editor.ts";
import { chunkLines, type LinesPair, panesFolds, panesFoldsKeep, panesLineToRight, panesRegions, panesRevert, panesStops, type RegionThree } from "./panes-regions.ts";

// The spacer, fold and chunk machinery here follows MergeView in @codemirror/merge (MIT, Marijn Haverbeke and others), widened from two editors to three.

const CONF = { override: diffByLine };
const FOLD_MARGIN = 3;
const FOLD_MIN = 6;
// Height differences below this are rounding, not misalignment.
const EPSILON = 0.01;
// An unchanged run longer than this many characters also lines up at the top of the visible area, since heights further into it may still be estimates.
const SYNC_RUN_MIN = 1000;

export type PanesThreeSpec = {
	readonly path: string;
	// The parent's version and the commit's own, restacked; undefined where the file is absent.
	readonly parent: string | undefined;
	readonly commit: string | undefined;
	// Offer Revert my edit; false where the right pane's text is not saved.
	readonly revertable: boolean;
	readonly indentation: Wire<Indentation>;
};

// Chunks a pane highlights: which side of them is this pane, and the classes its changed lines and text get.
type Marks = { readonly chunks: readonly Chunk[]; readonly side: "a" | "b"; readonly line: string; readonly text: string };

const marksSet = StateEffect.define<readonly Marks[]>();
const marksField = StateField.define<readonly Marks[]>({
	create: () => [],
	update: (marks, tr) => tr.effects.findLast((e) => e.is(marksSet))?.value ?? marks,
});

// The right pane's chunks against the commit (what the edit changed) and against the parent (the whole change the commit will make), kept current as it is typed in.
export type RightChunks = { readonly mine: readonly Chunk[]; readonly whole: readonly Chunk[] };

export function rightChunksField(commit: Text, parent: Text): StateField<RightChunks> {
	return StateField.define<RightChunks>({
		create: (state) => ({ mine: Chunk.build(commit, state.doc, CONF), whole: Chunk.build(parent, state.doc, CONF) }),
		update: (chunks, tr) =>
			tr.docChanged ? { mine: Chunk.updateB(chunks.mine, commit, tr.newDoc, tr.changes, CONF), whole: Chunk.updateB(chunks.whole, parent, tr.newDoc, tr.changes, CONF) } : chunks,
	});
}

// The visible chunks' line classes and changed-text marks.
function marksDecorations(view: EditorView, marks: readonly Marks[]): DecorationSet {
	const ranges: Range<Decoration>[] = [];
	const doc = view.state.doc;
	const { from: vpFrom, to: vpTo } = view.viewport;
	for (const m of marks) {
		const lineDeco = Decoration.line({ class: m.line });
		const textDeco = Decoration.mark({ class: m.text });
		for (const chunk of m.chunks) {
			const [from, to] = m.side === "a" ? [chunk.fromA, chunk.toA] : [chunk.fromB, chunk.toB];
			if (from >= vpTo) {
				break;
			}
			if (from === to || to <= vpFrom) {
				continue;
			}
			// Only the lines in view: a file added outright is one chunk, however long.
			for (let pos = Math.max(from, doc.lineAt(vpFrom).from); pos <= Math.min(doc.length, to - 1, vpTo); ) {
				const line = doc.lineAt(pos);
				ranges.push(lineDeco.range(line.from));
				pos = line.to + 1;
			}
			for (const change of chunk.changes) {
				const [cFrom, cTo] = m.side === "a" ? [from + change.fromA, from + change.toA] : [from + change.fromB, from + change.toB];
				const [markFrom, markTo] = [Math.max(cFrom, vpFrom), Math.min(cTo, doc.length, vpTo)];
				if (markFrom < markTo) {
					ranges.push(textDeco.range(markFrom, markTo));
				}
			}
		}
	}
	return Decoration.set(ranges, true);
}

function marksPlugin(marksOf: (state: EditorState) => readonly Marks[]): Extension {
	return ViewPlugin.define(
		(view) => ({
			decorations: marksDecorations(view, marksOf(view.state)),
			update(u: ViewUpdate) {
				const before = marksOf(u.startState);
				const after = marksOf(u.state);
				const same = before.length === after.length && before.every((m, i) => m.chunks === after[i]?.chunks);
				if (u.docChanged || u.viewportChanged || !same) {
					this.decorations = marksDecorations(u.view, after);
				}
			},
		}),
		{ decorations: (p) => p.decorations },
	);
}

class Spacer extends WidgetType {
	readonly height: number;
	constructor(height: number) {
		super();
		this.height = height;
	}
	override eq(other: Spacer): boolean {
		return this.height === other.height;
	}
	toDOM(): HTMLElement {
		const node = el("div", { class: "cm-pane-spacer" });
		node.style.height = `${this.height}px`;
		return node;
	}
	override updateDOM(dom: HTMLElement): boolean {
		dom.style.height = `${this.height}px`;
		return true;
	}
	override get estimatedHeight(): number {
		return this.height;
	}
	override ignoreEvent(): boolean {
		return false;
	}
}

function spacerHeight(deco: Decoration): number {
	const widget: unknown = deco.spec.widget;
	if (!(widget instanceof Spacer)) {
		throw new Error("the spacer field holds something other than a spacer");
	}
	return widget.height;
}

function spacerAt(pos: number, height: number, side: -1 | 1): Range<Decoration> {
	return Decoration.widget({ widget: new Spacer(height), block: true, side }).range(pos);
}

const spacersSet = StateEffect.define<DecorationSet>();
const spacersField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update: (spacers, tr) => tr.effects.findLast((e) => e.is(spacersSet))?.value ?? spacers.map(tr.changes),
	provide: (f) => EditorView.decorations.from(f),
});

function spacersSame(a: DecorationSet, b: DecorationSet): boolean {
	if (a.size !== b.size) {
		return false;
	}
	const ia = a.iter();
	const ib = b.iter();
	for (; ia.value !== null; ia.next(), ib.next()) {
		if (ib.value === null || ia.from !== ib.from || Math.abs(spacerHeight(ia.value) - spacerHeight(ib.value)) > 1) {
			return false;
		}
	}
	return true;
}

// A folded run, known by its first line in the middle pane, which never changes.
class Fold extends WidgetType {
	readonly lines: number;
	readonly b0: number;
	readonly unfold: (b0: number) => void;
	constructor(lines: number, b0: number, unfold: (b0: number) => void) {
		super();
		this.lines = lines;
		this.b0 = b0;
		this.unfold = unfold;
	}
	override eq(other: Fold): boolean {
		return this.lines === other.lines && this.b0 === other.b0;
	}
	toDOM(): HTMLElement {
		return el("div", { class: "cm-pane-fold", text: `${this.lines} unchanged lines`, onclick: () => this.unfold(this.b0) });
	}
	override get estimatedHeight(): number {
		return 24;
	}
	override ignoreEvent(e: Event): boolean {
		return e instanceof MouseEvent;
	}
}

const foldsSet = StateEffect.define<DecorationSet>();
const foldsField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update: (folds, tr) => tr.effects.findLast((e) => e.is(foldsSet))?.value ?? folds.map(tr.changes),
	provide: (f) => EditorView.decorations.from(f),
});

class MarkerRevert extends GutterMarker {
	override toDOM(): Node {
		return el("span", { class: "cm-pane-revertMarker", text: "⟲", title: "Revert my edit: put this chunk back as the commit has it" });
	}
}
const REVERT = new MarkerRevert();

// Every pane has this gutter, so that their text is equally wide and unchanged lines wrap alike; only an editable right pane has markers in it.
function revertGutter(markers: ((state: EditorState) => RangeSet<GutterMarker>) | undefined, click: ((view: EditorView, lineFrom: number) => void) | undefined): Extension {
	return gutter({
		class: "cm-pane-revert",
		markers: (view) => markers?.(view.state) ?? RangeSet.empty,
		domEventHandlers:
			click === undefined
				? {}
				: {
						// Only on the marker itself: a spacer above the chunk's first line shares its gutter block.
						mousedown: (view, line, event) => {
							if (!(event.target instanceof Element && event.target.closest(".cm-pane-revertMarker") !== null)) {
								return false;
							}
							click(view, line.from);
							event.preventDefault();
							return true;
						},
					},
	});
}

function lineStart(doc: Text, line: number): number {
	return line >= doc.lines ? doc.length : doc.line(line + 1).from;
}

// One pane during an alignment pass: where a region starts in it, its page offset, and the spacers it had and is getting.
type PaneAlign = {
	readonly view: EditorView;
	readonly start: (r: RegionThree) => number;
	readonly top: number;
	readonly old: RangeCursor<Decoration>;
	offset: number;
	readonly spacers: Range<Decoration>[];
};

// A file's parent, the commit's own version and the edited version side by side, with unchanged lines kept level. The right pane is the section's own editor, taken over while the panes exist and handed back by `release`.
export class PanesThree {
	readonly root: HTMLElement;
	readonly #right: EditorView;
	readonly #left: EditorView;
	readonly #middle: EditorView;
	readonly #parent: Text;
	readonly #commit: Text;
	readonly #ab: readonly LinesPair[];
	readonly #abChunks: readonly Chunk[];
	readonly #rightChunks: StateField<RightChunks>;
	#folds: readonly RegionThree[];
	#regionsFor: readonly Chunk[] | undefined;
	#regions: readonly RegionThree[] = [];
	#syncedMine: readonly Chunk[] | undefined;
	#frame = -1;
	#destroyed = false;

	// Takes `right` into the panes' right-hand cell; the caller puts `root` in the page.
	constructor(right: EditorView, spec: PanesThreeSpec) {
		this.#right = right;
		this.#parent = Text.of((spec.parent ?? "").split("\n"));
		this.#commit = Text.of((spec.commit ?? "").split("\n"));
		this.#abChunks = Chunk.build(this.#parent, this.#commit, CONF);
		this.#ab = this.#abChunks.map((k) => chunkLines(k, this.#parent, this.#commit));
		const field = rightChunksField(this.#commit, this.#parent);
		this.#rightChunks = field;
		const shared = [spacersField, foldsField, EditorView.updateListener.of((u) => this.#updated(u))];
		const paneMake = (doc: string | undefined, marks: readonly Marks[]): EditorView =>
			editorCreate(el("div", {}), {
				path: spec.path,
				doc: doc ?? "",
				original: undefined,
				editable: false,
				onChange: undefined,
				extensions: [marksField.init(() => marks), marksPlugin((s) => s.field(marksField)), revertGutter(undefined, undefined), shared],
				indentation: spec.indentation,
			});
		this.#left = paneMake(spec.parent, [{ chunks: this.#abChunks, side: "a", line: "cm-pane-removedLine", text: "cm-pane-removedText" }]);
		const rightMarks = (s: EditorState): readonly Marks[] => {
			const chunks = s.field(field);
			return [
				{ chunks: chunks.whole, side: "b", line: "cm-pane-addedLine", text: "cm-pane-addedText" },
				{ chunks: chunks.mine, side: "b", line: "cm-pane-mineLine", text: "cm-pane-mineText" },
			];
		};
		// Asked for on every gutter update, so kept per set of chunks.
		const markersByChunks = new WeakMap<readonly Chunk[], RangeSet<GutterMarker>>();
		const revertMarkers = (s: EditorState): RangeSet<GutterMarker> => {
			const mine = s.field(field).mine;
			let markers = markersByChunks.get(mine);
			if (markers === undefined) {
				const doc = s.doc;
				const starts = new Set(mine.map((k) => doc.lineAt(Math.min(k.fromB, doc.length)).from));
				markers = RangeSet.of(
					[...starts].map((from) => REVERT.range(from)),
					true,
				);
				markersByChunks.set(mine, markers);
			}
			return markers;
		};
		editorDiffSet(right, [
			field,
			marksPlugin(rightMarks),
			spec.revertable ? revertGutter(revertMarkers, (view, from) => this.#revert(view, from)) : revertGutter(undefined, undefined),
			shared,
		]);
		const mine = right.state.field(field).mine;
		this.#middle = paneMake(spec.commit, this.#middleMarks(mine));
		const cell = (view: EditorView | undefined, caption: string, absent: boolean): HTMLElement =>
			el("div", { class: "pane" }, el("div", { class: "pane-caption", text: absent ? `${caption} (no file)` : caption }), ...(view === undefined ? [] : [view.dom]));
		const rightCell = cell(undefined, "With your edits", false);
		this.root = el(
			"div",
			{ class: "panes-three" },
			cell(this.#left, "Before this commit", spec.parent === undefined),
			cell(this.#middle, "This commit", spec.commit === undefined),
			rightCell,
		);
		rightCell.append(right.dom);
		// Folded from the start, so the panes are never briefly their full length.
		this.#syncedMine = mine;
		this.#folds = panesFolds(this.#regionsNow(), FOLD_MARGIN, FOLD_MIN);
		this.#foldsShow();
		this.#digitsUpdate();
		this.#schedule();
	}

	// Destroys the left and middle editors; the right one is the caller's, to put back in the page and give a diff of its own.
	destroy(): void {
		this.#destroyed = true;
		if (this.#frame >= 0) {
			cancelAnimationFrame(this.#frame);
			this.#frame = -1;
		}
		this.#left.destroy();
		this.#middle.destroy();
	}

	// The right pane's positions where each changed region starts.
	stops(): number[] {
		const doc = this.#right.state.doc;
		return panesStops(this.#regionsNow()).map((line) => lineStart(doc, line));
	}

	// The focused pane's cursor, as the position beside it in the right pane; undefined when no pane has focus.
	head(): number | undefined {
		const active = document.activeElement;
		if (active === null) {
			return undefined;
		}
		if (this.#right.dom.contains(active)) {
			return this.#right.state.selection.main.head;
		}
		for (const [view, pane] of [
			[this.#left, "a"],
			[this.#middle, "b"],
		] as const) {
			if (view.dom.contains(active)) {
				const line = panesLineToRight(this.#regionsNow(), pane, view.state.doc.lineAt(view.state.selection.main.head).number - 1);
				return lineStart(this.#right.state.doc, line);
			}
		}
		return undefined;
	}

	#regionsNow(): readonly RegionThree[] {
		const mine = this.#right.state.field(this.#rightChunks).mine;
		if (this.#regionsFor !== mine) {
			const right = this.#right.state.doc;
			const bc = mine.map((k) => chunkLines(k, this.#commit, right));
			this.#regions = panesRegions(this.#ab, bc, { a: this.#parent.lines, b: this.#commit.lines, c: right.lines });
			this.#regionsFor = mine;
		}
		return this.#regions;
	}

	#middleMarks(mine: readonly Chunk[]): readonly Marks[] {
		return [
			{ chunks: this.#abChunks, side: "b", line: "cm-pane-addedLine", text: "cm-pane-addedText" },
			{ chunks: mine, side: "a", line: "cm-pane-mineLine", text: "cm-pane-mineText" },
		];
	}

	#revert(view: EditorView, lineFrom: number): void {
		const doc = view.state.doc;
		const chunk = view.state.field(this.#rightChunks).mine.find((k) => doc.lineAt(Math.min(k.fromB, doc.length)).from === lineFrom);
		if (chunk !== undefined) {
			view.dispatch({ changes: panesRevert(chunk, this.#commit, doc), userEvent: "revert" });
		}
	}

	// Any update but the alignment's own may move lines: opening the search panel changes none of the height or geometry flags, yet pushes its pane's text down.
	#updated(u: ViewUpdate): void {
		if (!u.transactions.some((tr) => tr.effects.some((e) => e.is(spacersSet)))) {
			this.#schedule();
		}
	}

	// Alignment runs in its own animation frame, outside any editor's update, since it dispatches to all three.
	#schedule(): void {
		if (this.#frame < 0 && !this.#destroyed) {
			this.#frame = requestAnimationFrame(() => {
				this.#frame = -1;
				this.#sync();
			});
		}
	}

	// Brings the middle pane's marks and every pane's folds up to date with the right pane's text, then lines the panes up.
	#sync(): void {
		const mine = this.#right.state.field(this.#rightChunks).mine;
		if (this.#syncedMine !== mine) {
			this.#syncedMine = mine;
			this.#middle.dispatch({ effects: marksSet.of(this.#middleMarks(mine)) });
			this.#folds = panesFoldsKeep(this.#folds, this.#regionsNow(), FOLD_MARGIN);
			this.#foldsShow();
			this.#digitsUpdate();
		}
		this.#align();
	}

	// Line numbers as wide in every pane as the longest file needs, so the text columns match.
	#digitsUpdate(): void {
		const lines = Math.max(this.#parent.lines, this.#commit.lines, this.#right.state.doc.lines);
		this.root.style.setProperty("--panes-digits", String(String(lines).length));
	}

	#foldsShow(): void {
		const unfold = (b0: number): void => {
			this.#folds = this.#folds.filter((f) => f.b0 !== b0);
			this.#foldsShow();
			this.#schedule();
		};
		const panes: [EditorView, (f: RegionThree) => readonly [number, number]][] = [
			[this.#left, (f) => [f.a0, f.a1]],
			[this.#middle, (f) => [f.b0, f.b1]],
			[this.#right, (f) => [f.c0, f.c1]],
		];
		for (const [view, lines] of panes) {
			const doc = view.state.doc;
			const ranges = this.#folds.map((f) => {
				const [from, to] = lines(f);
				return Decoration.replace({ widget: new Fold(f.b1 - f.b0, f.b0, unfold), block: true }).range(lineStart(doc, from), doc.line(to).to);
			});
			view.dispatch({ effects: foldsSet.of(Decoration.set(ranges)) });
		}
	}

	// Lines the panes up at the start of every unchanged region (and at the top of the visible area inside a long one), in page coordinates so that a search panel open in one pane counts, then pads the shorter panes to the longest. As MergeView's updateSpacers.
	#align(): void {
		const pane = (view: EditorView, start: (r: RegionThree) => number): PaneAlign => ({
			view,
			start,
			top: view.documentTop,
			old: view.state.field(spacersField).iter(),
			offset: 0,
			spacers: [],
		});
		const panes = [
			pane(this.#left, (r) => lineStart(this.#left.state.doc, r.a0)),
			pane(this.#middle, (r) => lineStart(this.#middle.state.doc, r.b0)),
			pane(this.#right, (r) => lineStart(this.#right.state.doc, r.c0)),
		];
		// The height a spacer already there adds counts until the pass reaches it.
		const passOld = (p: PaneAlign, pos: number): void => {
			for (; p.old.value !== null && p.old.from < pos; p.old.next()) {
				p.offset -= spacerHeight(p.old.value);
			}
		};
		const level = (posOf: (p: PaneAlign) => number): void => {
			const heights = panes.map((p) => {
				const pos = posOf(p);
				passOld(p, pos);
				return { p, pos, height: p.top + p.view.lineBlockAt(pos).top + p.offset };
			});
			const max = Math.max(...heights.map((h) => h.height));
			for (const { p, pos, height } of heights) {
				if (max - height > EPSILON) {
					p.offset += max - height;
					p.spacers.push(spacerAt(pos, max - height, -1));
				}
			}
		};
		const folds = this.#right.state.field(foldsField);
		const regions = this.#regionsNow();
		for (const [i, r] of regions.entries()) {
			if (r.ab || r.bc) {
				continue;
			}
			level((p) => p.start(r));
			// The run holds the same text in every pane, so the same offset into it is the same line in each.
			const next = regions[i + 1];
			const length = (p: PaneAlign): number => (next === undefined ? p.view.state.doc.length : p.start(next)) - p.start(r);
			const into = Math.min(...panes.map((p) => p.view.viewport.from - p.start(r)));
			const right = panes[2];
			if (right === undefined || into <= 0 || panes.some((p) => into >= length(p)) || length(right) <= SYNC_RUN_MIN) {
				continue;
			}
			const at = right.start(r) + into;
			let folded = false;
			folds.between(at, at, () => {
				folded = true;
			});
			if (!folded && right.view.state.doc.lineAt(at).from === at) {
				level((p) => p.start(r) + into);
			}
		}
		const ends = panes.map((p) => {
			passOld(p, p.view.state.doc.length + 1);
			return { p, bottom: p.top + p.view.contentHeight + p.offset };
		});
		const max = Math.max(...ends.map((e) => e.bottom));
		for (const { p, bottom } of ends) {
			if (max - bottom > EPSILON) {
				p.spacers.push(spacerAt(p.view.state.doc.length, max - bottom, 1));
			}
		}
		for (const p of panes) {
			const next = Decoration.set(p.spacers);
			if (!spacersSame(next, p.view.state.field(spacersField))) {
				p.view.dispatch({ effects: spacersSet.of(next) });
			}
		}
	}
}
