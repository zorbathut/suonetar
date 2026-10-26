import { Chunk } from "@codemirror/merge";
import { type EditorState, type Extension, type Range, type RangeCursor, RangeSet, StateEffect, StateField, Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, GutterMarker, gutter, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import type { Indentation } from "../engine/editorconfig.ts";
import type { Layout, Wire } from "../shared/api.ts";
import { diffByLine } from "./diff.ts";
import { el } from "./dom.ts";
import { editorCreate, editorDiffSet, REVERT_CHUNK_TITLE } from "./editor.ts";
import { changeKind, type OverviewChange } from "./overview.ts";
import {
	chunkLines,
	type LinesPair,
	panesChanges,
	panesFolds,
	panesFoldsKeep,
	panesLineToRight,
	panesRegions,
	panesRevert,
	panesStops,
	type RegionThree,
} from "./panes-regions.ts";

// The spacer, fold and chunk machinery here follows MergeView in @codemirror/merge (MIT, Marijn Haverbeke and others), widened to three editors.

const CONF = { override: diffByLine };
const FOLD_MARGIN = 3;
const FOLD_MIN = 6;
// Height differences below this are rounding, not misalignment.
const EPSILON = 0.01;
// An unchanged run longer than this many characters also lines up at the top of the visible area, since heights further into it may still be estimates.
const SYNC_RUN_MIN = 1000;

// The panes beside the edited version: in two, the parent or (showing only the edits) the commit's own version; in three, both. Each text is undefined where the file is absent; the commit's is restacked.
export type PanesShape =
	| { readonly kind: "two"; readonly leftIs: "parent" | "commit"; readonly left: string | undefined }
	| { readonly kind: "three"; readonly parent: string | undefined; readonly commit: string | undefined };

export type PanesKind = PanesShape["kind"];

// The panes a file shows in under the toolbar's layout, or undefined for inline: only a commit's files have panes, and three only where the commit's own version is known.
export function panesKindFor(layout: Layout, view: "commit" | "draft" | "worktree", mineUnknown: boolean): PanesKind | undefined {
	if (view !== "commit" || layout === "inline" || (layout === "three" && mineUnknown)) {
		return undefined;
	}
	return layout;
}

export type PanesSpec = {
	readonly path: string;
	readonly shape: PanesShape;
	// Offer Revert; false where the right pane's text is not saved.
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

// The right pane's chunks against the middle document, which it is lined up with and reverted to (the commit's version in three panes, the left pane's text in two), and in three panes also against the parent (the whole change the commit will make), kept current as it is typed in.
export type RightChunks = { readonly middle: readonly Chunk[]; readonly whole: readonly Chunk[] | undefined };

export function rightChunksField(middle: Text, parent: Text | undefined): StateField<RightChunks> {
	return StateField.define<RightChunks>({
		create: (state) => ({ middle: Chunk.build(middle, state.doc, CONF), whole: parent === undefined ? undefined : Chunk.build(parent, state.doc, CONF) }),
		update: (chunks, tr) =>
			tr.docChanged
				? {
						middle: Chunk.updateB(chunks.middle, middle, tr.newDoc, tr.changes, CONF),
						whole: parent === undefined || chunks.whole === undefined ? undefined : Chunk.updateB(chunks.whole, parent, tr.newDoc, tr.changes, CONF),
					}
				: chunks,
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

// A folded run, known by its first line in the middle document, which never changes.
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
	readonly title: string;
	constructor(title: string) {
		super();
		this.title = title;
	}
	override toDOM(): Node {
		return el("span", { class: "cm-pane-revertMarker", text: "⟲", title: this.title });
	}
}
// Putting a chunk back as the commit's version has it, or as the parent's.
const REVERT_EDIT = new MarkerRevert("Revert my edit: put this chunk back as the commit has it");
const REVERT_CHUNK = new MarkerRevert(REVERT_CHUNK_TITLE);

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

// A shown pane, and which of the three documents it holds; `marks` gives its marks anew as the right pane's chunks change, and is undefined where they never do.
type Pane = { readonly view: EditorView; readonly doc: "a" | "b" | "c"; readonly marks: ((chunks: readonly Chunk[]) => readonly Marks[]) | undefined };

function regionLines(r: RegionThree, doc: Pane["doc"]): readonly [number, number] {
	return doc === "a" ? [r.a0, r.a1] : doc === "b" ? [r.b0, r.b1] : [r.c0, r.c1];
}

// One pane during an alignment pass: where a region starts in it, its page offset, the part of that offset only counted (leveling past the drawn viewport, which places no spacer), and the spacers it had and is getting.
type PaneAlign = {
	readonly view: EditorView;
	readonly start: (r: RegionThree) => number;
	readonly top: number;
	readonly old: RangeCursor<Decoration>;
	offset: number;
	counted: number;
	readonly spacers: Range<Decoration>[];
};

// A file's versions side by side, the edited one on the right, with unchanged lines kept level. The right pane is the section's own editor, taken over while the panes exist; after `destroy` the caller gives it a diff of its own.
//
// Both shapes line their panes up through three documents: the left pane's (a), the middle one (b), which the right pane's (c) is diffed against. In three panes the middle document is the commit's version, shown between; in two it is the left pane's text again, unshown, so every region holds the same lines in a and b.
export class Panes {
	readonly root: HTMLElement;
	readonly kind: PanesKind;
	readonly #right: EditorView;
	// Left to right, the right pane last.
	readonly #panes: readonly Pane[];
	readonly #leftText: Text;
	readonly #middleText: Text;
	readonly #ab: readonly LinesPair[];
	readonly #abChunks: readonly Chunk[];
	readonly #rightChunks: StateField<RightChunks>;
	#folds: readonly RegionThree[];
	#regionsFor: readonly Chunk[] | undefined;
	#regions: readonly RegionThree[] = [];
	#synced: readonly Chunk[] | undefined;
	#frame = -1;
	#destroyed = false;

	// Takes `right` into the panes' right-hand cell; the caller puts `root` in the page.
	constructor(right: EditorView, spec: PanesSpec) {
		const shape = spec.shape;
		this.kind = shape.kind;
		this.#right = right;
		const leftDoc = shape.kind === "two" ? shape.left : shape.parent;
		this.#leftText = Text.of((leftDoc ?? "").split("\n"));
		this.#middleText = shape.kind === "two" ? this.#leftText : Text.of((shape.commit ?? "").split("\n"));
		this.#abChunks = shape.kind === "two" ? [] : Chunk.build(this.#leftText, this.#middleText, CONF);
		this.#ab = this.#abChunks.map((k) => chunkLines(k, this.#leftText, this.#middleText));
		const field = rightChunksField(this.#middleText, shape.kind === "two" ? undefined : this.#leftText);
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
		const rightMarks = (s: EditorState): readonly Marks[] => {
			const chunks = s.field(field);
			return chunks.whole === undefined
				? [{ chunks: chunks.middle, side: "b", line: "cm-pane-addedLine", text: "cm-pane-addedText" }]
				: [
						{ chunks: chunks.whole, side: "b", line: "cm-pane-addedLine", text: "cm-pane-addedText" },
						{ chunks: chunks.middle, side: "b", line: "cm-pane-mineLine", text: "cm-pane-mineText" },
					];
		};
		const marker = shape.kind === "two" && shape.leftIs === "parent" ? REVERT_CHUNK : REVERT_EDIT;
		// Asked for on every gutter update, so kept per set of chunks.
		const markersByChunks = new WeakMap<readonly Chunk[], RangeSet<GutterMarker>>();
		const revertMarkers = (s: EditorState): RangeSet<GutterMarker> => {
			const chunks = s.field(field).middle;
			let markers = markersByChunks.get(chunks);
			if (markers === undefined) {
				const doc = s.doc;
				const starts = new Set(chunks.map((k) => doc.lineAt(Math.min(k.fromB, doc.length)).from));
				markers = RangeSet.of(
					[...starts].map((from) => marker.range(from)),
					true,
				);
				markersByChunks.set(chunks, markers);
			}
			return markers;
		};
		editorDiffSet(right, [
			field,
			marksPlugin(rightMarks),
			spec.revertable ? revertGutter(revertMarkers, (view, from) => this.#revert(view, from)) : revertGutter(undefined, undefined),
			shared,
		]);
		const chunks = right.state.field(field).middle;
		const cell = (view: EditorView | undefined, caption: string, absent: boolean): HTMLElement =>
			el("div", { class: "pane" }, el("div", { class: "pane-caption", text: absent ? `${caption} (no file)` : caption }), ...(view === undefined ? [] : [view.dom]));
		const cells: HTMLElement[] = [];
		const others: Pane[] = [];
		const paneAdd = (pane: Pane, doc: string | undefined, caption: string): void => {
			others.push(pane);
			cells.push(cell(pane.view, caption, doc === undefined));
		};
		const removed = (k: readonly Chunk[]): readonly Marks[] => [{ chunks: k, side: "a", line: "cm-pane-removedLine", text: "cm-pane-removedText" }];
		if (shape.kind === "two") {
			// The right pane is diffed against this pane's text, so its marks follow the right pane's chunks.
			paneAdd({ view: paneMake(leftDoc, removed(chunks)), doc: "a", marks: removed }, leftDoc, shape.leftIs === "commit" ? "This commit" : "Before this commit");
		} else {
			const middleMarks = (k: readonly Chunk[]): readonly Marks[] => [
				{ chunks: this.#abChunks, side: "b", line: "cm-pane-addedLine", text: "cm-pane-addedText" },
				{ chunks: k, side: "a", line: "cm-pane-mineLine", text: "cm-pane-mineText" },
			];
			paneAdd({ view: paneMake(leftDoc, removed(this.#abChunks)), doc: "a", marks: undefined }, leftDoc, "Before this commit");
			paneAdd({ view: paneMake(shape.commit, middleMarks(chunks)), doc: "b", marks: middleMarks }, shape.commit, "This commit");
		}
		this.#panes = [...others, { view: right, doc: "c", marks: undefined }];
		const rightCell = cell(undefined, "With your edits", false);
		this.root = el("div", { class: "panes" }, ...cells, rightCell);
		rightCell.append(right.dom);
		// Folded from the start, so the panes are never briefly their full length.
		this.#synced = chunks;
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
		for (const p of this.#panes) {
			if (p.view !== this.#right) {
				p.view.destroy();
			}
		}
	}

	// The right pane's positions where each changed region starts.
	stops(): number[] {
		const doc = this.#right.state.doc;
		return panesStops(this.#regionsNow()).map((line) => lineStart(doc, line));
	}

	// Each changed region where the right pane differs from the left: its extent in viewport pixels, and the right pane's position where it starts. The panes are level where every unchanged region starts, so a region runs from its top in any pane to the next unchanged region's top in the tallest (the others pad up to it there with spacers, inside that line's block).
	changes(): OverviewChange[] {
		const at = (p: Pane, r: RegionThree | undefined): number => {
			const view = p.view;
			const doc = view.state.doc;
			return view.documentTop + (r === undefined ? view.lineBlockAt(doc.length).bottom : view.lineBlockAt(lineStart(doc, regionLines(r, p.doc)[0])).top);
		};
		return panesChanges(this.#regionsNow()).flatMap(({ region, next }) => {
			const kind = changeKind(region.a0 === region.a1, region.c0 === region.c1);
			if (kind === undefined) {
				return [];
			}
			return [
				{
					top: Math.min(...this.#panes.map((p) => at(p, region))),
					bottom: Math.max(...this.#panes.map((p) => at(p, next))),
					pos: lineStart(this.#right.state.doc, region.c0),
					kind,
				},
			];
		});
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
		const pane = this.#panes.find((p) => p.view.dom.contains(active));
		if (pane === undefined) {
			return undefined;
		}
		const view = pane.view;
		return lineStart(this.#right.state.doc, panesLineToRight(this.#regionsNow(), pane.doc, view.state.doc.lineAt(view.state.selection.main.head).number - 1));
	}

	#regionsNow(): readonly RegionThree[] {
		const chunks = this.#right.state.field(this.#rightChunks).middle;
		if (this.#regionsFor !== chunks) {
			const right = this.#right.state.doc;
			const bc = chunks.map((k) => chunkLines(k, this.#middleText, right));
			this.#regions = panesRegions(this.#ab, bc, { a: this.#leftText.lines, b: this.#middleText.lines, c: right.lines });
			this.#regionsFor = chunks;
		}
		return this.#regions;
	}

	#revert(view: EditorView, lineFrom: number): void {
		const doc = view.state.doc;
		const chunk = view.state.field(this.#rightChunks).middle.find((k) => doc.lineAt(Math.min(k.fromB, doc.length)).from === lineFrom);
		if (chunk !== undefined) {
			view.dispatch({ changes: panesRevert(chunk, this.#middleText, doc), userEvent: "revert" });
		}
	}

	// Any update but the alignment's own may move lines: opening the search panel changes none of the height or geometry flags, yet pushes its pane's text down.
	#updated(u: ViewUpdate): void {
		if (!u.transactions.some((tr) => tr.effects.some((e) => e.is(spacersSet)))) {
			this.#schedule();
		}
	}

	// Alignment runs in its own animation frame, outside any editor's update, since it dispatches to every pane.
	#schedule(): void {
		if (this.#frame < 0 && !this.#destroyed) {
			this.#frame = requestAnimationFrame(() => {
				this.#frame = -1;
				this.#sync();
			});
		}
	}

	// Brings the other panes' marks and every pane's folds up to date with the right pane's text, then lines the panes up.
	#sync(): void {
		const chunks = this.#right.state.field(this.#rightChunks).middle;
		if (this.#synced !== chunks) {
			this.#synced = chunks;
			for (const p of this.#panes) {
				if (p.marks !== undefined) {
					p.view.dispatch({ effects: marksSet.of(p.marks(chunks)) });
				}
			}
			this.#folds = panesFoldsKeep(this.#folds, this.#regionsNow(), FOLD_MARGIN);
			this.#foldsShow();
			this.#digitsUpdate();
		}
		this.#align();
	}

	// Line numbers as wide in every pane as the longest file needs, so the text columns match.
	#digitsUpdate(): void {
		const lines = Math.max(this.#leftText.lines, this.#middleText.lines, this.#right.state.doc.lines);
		this.root.style.setProperty("--panes-digits", String(String(lines).length));
	}

	#foldsShow(): void {
		const unfold = (b0: number): void => {
			this.#folds = this.#folds.filter((f) => f.b0 !== b0);
			this.#foldsShow();
			this.#schedule();
		};
		for (const { view, doc: which } of this.#panes) {
			const doc = view.state.doc;
			const ranges = this.#folds.map((f) => {
				const [from, to] = regionLines(f, which);
				return Decoration.replace({ widget: new Fold(f.b1 - f.b0, f.b0, unfold), block: true }).range(lineStart(doc, from), doc.line(to).to);
			});
			view.dispatch({ effects: foldsSet.of(Decoration.set(ranges)) });
		}
	}

	// Lines the panes up at the start of every unchanged region (and at the top of the visible area inside a long one), in page coordinates so that a search panel open in one pane counts, then pads the shorter panes to the longest. As MergeView's updateSpacers, except that below the drawn viewport the leveling is only counted, its spacers' height going into the end padding: a spacer placed among undrawn lines makes CodeMirror estimate them anew, so the next pass would place its spacers elsewhere and the panes would never settle. Regions get their spacers as they come into the viewport, which reaches past the visible area.
	#align(): void {
		const panes = this.#panes.map(
			({ view, doc }): PaneAlign => ({
				view,
				start: (r) => lineStart(view.state.doc, regionLines(r, doc)[0]),
				top: view.documentTop,
				old: view.state.field(spacersField).iter(),
				offset: 0,
				counted: 0,
				spacers: [],
			}),
		);
		// The height a spacer already there adds counts until the pass reaches it.
		const passOld = (p: PaneAlign, pos: number): void => {
			for (; p.old.value !== null && p.old.from < pos; p.old.next()) {
				p.offset -= spacerHeight(p.old.value);
			}
		};
		const level = (posOf: (p: PaneAlign) => number, place: boolean): void => {
			const heights = panes.map((p) => {
				const pos = posOf(p);
				passOld(p, pos);
				return { p, pos, height: p.top + p.view.lineBlockAt(pos).top + p.offset };
			});
			const max = Math.max(...heights.map((h) => h.height));
			for (const { p, pos, height } of heights) {
				if (max - height > EPSILON) {
					p.offset += max - height;
					if (place) {
						p.spacers.push(spacerAt(pos, max - height, -1));
					} else {
						p.counted += max - height;
					}
				}
			}
		};
		const folds = this.#right.state.field(foldsField);
		const regions = this.#regionsNow();
		for (const [i, r] of regions.entries()) {
			if (r.ab || r.bc) {
				continue;
			}
			if (panes.some((p) => p.start(r) > p.view.viewport.to)) {
				level((p) => p.start(r), false);
				continue;
			}
			level((p) => p.start(r), true);
			// The run holds the same text in every pane, so the same offset into it is the same line in each.
			const next = regions[i + 1];
			const length = (p: PaneAlign): number => (next === undefined ? p.view.state.doc.length : p.start(next)) - p.start(r);
			const into = Math.min(...panes.map((p) => p.view.viewport.from - p.start(r)));
			const right = panes.at(-1);
			if (right === undefined || into <= 0 || panes.some((p) => into >= length(p)) || length(right) <= SYNC_RUN_MIN) {
				continue;
			}
			const at = right.start(r) + into;
			let folded = false;
			folds.between(at, at, () => {
				folded = true;
			});
			if (!folded && right.view.state.doc.lineAt(at).from === at) {
				level((p) => p.start(r) + into, true);
			}
		}
		const ends = panes.map((p) => {
			passOld(p, p.view.state.doc.length + 1);
			return { p, bottom: p.top + p.view.contentHeight + p.offset };
		});
		// The padding at the end makes up what leveling past the viewport only counted, so the panes are as tall as when fully lined up, and stay that tall as more of them gets drawn.
		const max = Math.max(...ends.map((e) => e.bottom));
		for (const { p, bottom } of ends) {
			if (max - bottom + p.counted > EPSILON) {
				p.spacers.push(spacerAt(p.view.state.doc.length, max - bottom + p.counted, 1));
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
