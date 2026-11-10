import { getIndentUnit } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
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

// The attributes giving a line its hang, for lines no line decoration reaches as well as the editor's own: the CSS (`text-indent: … hanging`, in style.css) reads the column count from `--wrap-indent`.
export function wrapIndentAttributes(line: string, state: EditorState): { readonly style: string } {
	return { style: `--wrap-indent: ${wrapIndent(line, getIndentUnit(state), state.tabSize)}ch` };
}

const decorations = new Map<string, Decoration>();

// One decoration per hang, so unchanged lines compare equal and are not redrawn.
function lineDecoration(line: string, state: EditorState): Decoration {
	const attributes = wrapIndentAttributes(line, state);
	let decoration = decorations.get(attributes.style);
	if (decoration === undefined) {
		decoration = Decoration.line({ attributes });
		decorations.set(attributes.style, decoration);
	}
	return decoration;
}

// Soft-wraps long lines, each continuation row starting two indent units past the line's own indentation; the unit is the editor's own (`indentUnit`), so the hang matches what Enter inserts.
export function wrapIndented(): Extension {
	const plugin = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;

			constructor(view: EditorView) {
				this.decorations = this.#build(view);
			}

			update(update: ViewUpdate): void {
				if (update.docChanged || update.viewportChanged) {
					this.decorations = this.#build(update.view);
				}
			}

			#build(view: EditorView): DecorationSet {
				const ranges = [];
				for (const { from, to } of view.visibleRanges) {
					for (let pos = from; pos <= to; ) {
						const line = view.state.doc.lineAt(pos);
						ranges.push(lineDecoration(line.text, view.state).range(line.from));
						pos = line.to + 1;
					}
				}
				return Decoration.set(ranges);
			}
		},
		{ decorations: (v) => v.decorations },
	);
	return [EditorView.lineWrapping, plugin];
}
