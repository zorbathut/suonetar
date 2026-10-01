import { getIndentUnit } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

// How many indent units past its own indentation a wrapped line's continuation rows start.
const HANG_UNITS = 2;

// The width of a line's leading whitespace in columns, tabs reaching the next tab stop.
export function indentColumns(line: string, tabSize: number): number {
	let columns = 0;
	for (const ch of line) {
		if (ch === " ") {
			columns += 1;
		} else if (ch === "\t") {
			columns += tabSize - (columns % tabSize);
		} else {
			break;
		}
	}
	return columns;
}

// Where a line's wrapped continuation rows start, in columns.
export function wrapIndent(line: string, unit: number, tabSize: number): number {
	return indentColumns(line, tabSize) + HANG_UNITS * unit;
}

const decorations = new Map<number, Decoration>();

// The CSS (`text-indent: … hanging`, in style.css) reads the column count from `--wrap-indent`; one decoration per count, so unchanged lines compare equal and are not redrawn.
function lineDecoration(columns: number): Decoration {
	let decoration = decorations.get(columns);
	if (decoration === undefined) {
		decoration = Decoration.line({ attributes: { style: `--wrap-indent: ${columns}ch` } });
		decorations.set(columns, decoration);
	}
	return decoration;
}

const DELETED_PENDING = ".cm-deletedChunk > .cm-deletedLine:not([data-wrap-indent])";

// Soft-wraps long lines, each continuation row starting two indent units past the line's own indentation; the unit is the editor's own (`indentUnit`), so the hang matches what Enter inserts.
export function wrapIndented(): Extension {
	const plugin = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			readonly #measureKey = {};

			constructor(view: EditorView) {
				this.decorations = this.#build(view);
				this.#deletedLines(view);
			}

			update(update: ViewUpdate): void {
				if (update.docChanged || update.viewportChanged) {
					this.decorations = this.#build(update.view);
					this.#deletedLines(update.view);
				}
			}

			#build(view: EditorView): DecorationSet {
				const ranges = [];
				const tabSize = view.state.tabSize;
				for (const { from, to } of view.visibleRanges) {
					for (let pos = from; pos <= to; ) {
						const line = view.state.doc.lineAt(pos);
						ranges.push(lineDecoration(wrapIndent(line.text, getIndentUnit(view.state), tabSize)).range(line.from));
						pos = line.to + 1;
					}
				}
				return Decoration.set(ranges);
			}

			// The merge view draws deleted lines itself, inside a widget no line decoration reaches; once its DOM exists, they get the same hang.
			#deletedLines(view: EditorView): void {
				view.requestMeasure({
					key: this.#measureKey,
					read: () => undefined,
					write: () => {
						for (const line of view.contentDOM.querySelectorAll<HTMLElement>(DELETED_PENDING)) {
							line.style.setProperty("--wrap-indent", `${wrapIndent(line.textContent ?? "", getIndentUnit(view.state), view.state.tabSize)}ch`);
							line.dataset.wrapIndent = "";
						}
					},
				});
			}
		},
		{ decorations: (v) => v.decorations },
	);
	return [EditorView.lineWrapping, plugin];
}
