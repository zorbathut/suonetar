import type { Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

// How many indent units past its own indentation a wrapped line's continuation rows start.
const HANG_UNITS = 2;
// Indentation steps wider than this are alignment, not nesting.
const UNIT_MAX = 8;

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

// The file's indent unit in columns: the most common step in indentation from one non-blank line to the next, the smaller on a tie. A one-column step onto a `*` line is a block comment's ` * ` continuation, not nesting, and is skipped.
export function indentUnitGuess(lines: Iterable<string>, tabSize: number): number {
	const steps = new Map<number, number>();
	let previous: number | undefined;
	for (const line of lines) {
		const trimmed = line.trimStart();
		if (trimmed === "") {
			continue;
		}
		const columns = indentColumns(line, tabSize);
		const step = previous === undefined ? 0 : columns - previous;
		if (step > 0 && step <= UNIT_MAX && !(step === 1 && trimmed.startsWith("*"))) {
			steps.set(step, (steps.get(step) ?? 0) + 1);
		}
		previous = columns;
	}
	let best: [number, number] | undefined;
	for (const [step, count] of steps) {
		if (best === undefined || count > best[1] || (count === best[1] && step < best[0])) {
			best = [step, count];
		}
	}
	return best?.[0] ?? tabSize;
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

// Soft-wraps long lines, each continuation row starting two indent units past the line's own indentation; `unit` is the file's indent unit in columns (`indentUnitGuess`).
export function wrapIndented(unit: number): Extension {
	const plugin = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			readonly #unit = unit;
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
						ranges.push(lineDecoration(wrapIndent(line.text, this.#unit, tabSize)).range(line.from));
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
							line.style.setProperty("--wrap-indent", `${wrapIndent(line.textContent ?? "", this.#unit, view.state.tabSize)}ch`);
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
