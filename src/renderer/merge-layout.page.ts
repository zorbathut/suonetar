// The page merge-layout.test.ts runs in Electron (src/main/test-support/layout-harness.ts): editors as the app builds them, in its stylesheet and layout, and scenarios measuring how the inline diff lays out deletions. Never part of the app.
import "./style.css";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { editorCreate } from "./editor.ts";
import { deletionMetrics, deletionMetricsSet } from "./vendor/codemirror-merge/deletion-layout.ts";
import { wrapIndentAttributes } from "./wrap-indent.ts";

const LOREM = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(10);

// Lines that wrap, of varied length.
function lineWrapped(i: number): string {
	return `old ${i} ${LOREM.slice(0, 100 + ((i * 37) % 400))}`;
}

// Lines that don't.
function lineShort(i: number): string {
	return `    int old${i} = compute(${i});`;
}

const INDENTS = ["", "  ", "    ", "\t", "\t\t", "      ", "\t  "];

function lineIndented(i: number): string {
	return `${INDENTS[i % INDENTS.length]}value${i} = call(${i}, "${LOREM.slice(0, (i * 13) % 60)}");`;
}

function lines(count: number, line: (i: number) => string, prefix: string): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix}${line(i)}`);
}

function frames(n: number): Promise<void> {
	return new Promise((resolve) => {
		const step = (left: number): void => {
			if (left === 0) {
				resolve();
			} else {
				requestAnimationFrame(() => step(left - 1));
			}
		};
		step(n);
	});
}

// Long enough for an editor's first measures, the metrics' dispatch, and the groups re-estimated after it.
function settle(): Promise<void> {
	return frames(20);
}

// The app's layout: the scroller (#doc) holding the view and a section per file.
function pageDoc(): { readonly scroller: HTMLElement; readonly view: HTMLElement } {
	const body = document.createElement("div");
	body.id = "body";
	const scroller = document.createElement("main");
	scroller.id = "doc";
	const view = document.createElement("div");
	view.className = "commit-view";
	scroller.append(view);
	body.append(scroller);
	document.body.append(body);
	return { scroller, view };
}

function editorSection(parent: HTMLElement, path: string, original: string, doc: string, extensions: Extension = []): EditorView {
	const section = document.createElement("section");
	section.className = "file";
	const body = document.createElement("div");
	body.className = "section-body";
	section.append(body);
	parent.append(section);
	return editorCreate(body, {
		path,
		doc,
		original,
		editable: true,
		onChange: undefined,
		extensions,
		indentation: { style: undefined, size: undefined, tabWidth: undefined },
	});
}

// The deletion widget showing lines, not an insertion's empty one.
function deletionChunk(view: EditorView): HTMLElement | null {
	return view.contentDOM.querySelector<HTMLElement>(".cm-deletedChunk:has(.cm-deletedLine)");
}

// Scrolls down from `from` to the bottom and back up, 400px (half a screen) every two frames, recording every change of the scroller's height.
async function pass(scroller: HTMLElement, from: number): Promise<number[]> {
	const changes: number[] = [];
	let height = scroller.scrollHeight;
	const step = async (): Promise<void> => {
		await frames(2);
		if (Math.abs(scroller.scrollHeight - height) > 2) {
			changes.push(scroller.scrollHeight - height);
			height = scroller.scrollHeight;
		}
	};
	scroller.scrollTop = from;
	await step();
	while (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1) {
		scroller.scrollTop += 400;
		await step();
	}
	while (scroller.scrollTop > from) {
		scroller.scrollTop -= 400;
		await step();
	}
	return changes;
}

// The far deletion's widget, from the end of the document, which it ends: where a pass leaves the scroller depends on the platform's metrics, and CodeMirror draws only so far past the viewport.
async function deletionAtEnd(scroller: HTMLElement, editor: EditorView): Promise<HTMLElement | null> {
	scroller.scrollTop = scroller.scrollHeight;
	await settle();
	return deletionChunk(editor);
}

// A deletion far down its file: 3000 inserted lines, then 1200 deleted below 10 kept ones. Gives where in the scroller the deletion starts, by CodeMirror's estimate, less a screen.
function deletionFar(line: (i: number) => string): { readonly scroller: HTMLElement; readonly editor: EditorView; readonly passFrom: () => number } {
	const { scroller, view } = pageDoc();
	const kept = lines(10, (i) => `${i}`, "keep ");
	const original = [...kept, ...lines(1200, line, "")].join("\n");
	const doc = [...lines(3000, (i) => `${i}`, "new "), ...kept].join("\n");
	const editor = editorSection(view, "far.md", original, doc);
	const passFrom = (): number =>
		editor.documentTop - scroller.getBoundingClientRect().top + scroller.scrollTop + editor.lineBlockAt(editor.state.doc.line(3001).from).top - scroller.clientHeight;
	return { scroller, editor, passFrom };
}

async function groups(): Promise<unknown> {
	const { view } = pageDoc();
	// The app loads a file's language once its editor exists; here it is loaded first, so that the deletions are highlighted as they are first drawn.
	const description = LanguageDescription.matchFilename(languages, "x.ts");
	if (description === null) {
		throw new Error("no language for .ts");
	}
	const support = await description.load();
	const keep = (from: number, count: number): string[] => lines(count, (i) => `${from + i}`, "keep ");
	// Two small enough to highlight, then one big enough to group (and too big to highlight); the big one last, so that CodeMirror draws all three.
	const original = [
		...keep(0, 5),
		...lines(3, lineIndented, "c"),
		...keep(5, 10),
		...lines(40, lineIndented, "b"),
		...keep(15, 10),
		...lines(450, lineIndented, ""),
		...keep(25, 5),
	].join("\n");
	const doc = [...keep(0, 5), ...keep(5, 10), ...keep(15, 10), ...keep(25, 5)].join("\n");
	const editor = editorSection(view, "x.ts", original, doc, support);
	await settle();
	const chunks = [...editor.contentDOM.querySelectorAll<HTMLElement>(".cm-deletedChunk:has(.cm-deletedLine)")];
	const groupsOf = chunks.map((chunk) =>
		[...chunk.querySelectorAll<HTMLElement>(".cm-deletedGroup")].map((g) => ({
			lines: g.childElementCount,
			lazy: g.style.contentVisibility === "auto",
			sized: g.style.containIntrinsicSize !== "",
			// Whether the browser lays out its lines: a lazy group far from the viewport is skipped.
			laidOut: g.firstElementChild?.checkVisibility({ contentVisibilityAuto: true }) ?? false,
		})),
	);
	const deletedLines = [...editor.contentDOM.querySelectorAll<HTMLElement>(".cm-deletedLine")];
	const hangsWrong = deletedLines.filter((line) => line.getAttribute("style") !== wrapIndentAttributes(line.textContent, editor.state).style).length;
	// Spans from the syntax highlighter, not only the changed-text marks every deleted line gets.
	const highlighted = [...editor.contentDOM.querySelectorAll(".cm-deletedLine span")].filter((span) => [...span.classList].some((c) => c !== "cm-deletedText")).length;
	return { chunks: groupsOf, deletedLines: deletedLines.length, hangsWrong, highlighted };
}

// How far off the page's height was before a deletion far down was drawn, against the deletion's own height once drawn.
async function estimate(line: (i: number) => string): Promise<unknown> {
	const { scroller, editor, passFrom } = deletionFar(line);
	await settle();
	const initial = scroller.scrollHeight;
	await pass(scroller, passFrom());
	const chunk = await deletionAtEnd(scroller, editor);
	if (chunk === null) {
		throw new Error("the deletion is not drawn at the end of the document");
	}
	return { initial, final: scroller.scrollHeight, deletion: chunk.getBoundingClientRect().height };
}

// An editor built below the window draws the deletion near its top before CodeMirror measures anything in it.
async function outOfView(): Promise<unknown> {
	const { scroller, view } = pageDoc();
	editorSection(view, "a.md", ["a", "b", "c"].join("\n"), ["a", "x", "c"].join("\n"));
	const spacer = document.createElement("div");
	spacer.style.height = "3000px";
	view.append(spacer);
	const kept = lines(400, (i) => `${i}`, "keep ");
	const original = [...kept.slice(0, 5), ...lines(1200, lineWrapped, ""), ...kept.slice(5)].join("\n");
	const doc = [...kept.slice(0, 390), "inserted", ...kept.slice(390)].join("\n");
	const editor = editorSection(view, "b.md", original, doc);
	// As first drawn, before the metrics arrive and re-estimate it.
	const chunkFirst = deletionChunk(editor);
	await settle();
	const measured = { inView: editor.inView, contentHeight: editor.contentHeight, domHeight: editor.contentDOM.getBoundingClientRect().height };
	const chunkSettled = deletionChunk(editor);
	editor.dom.scrollIntoView();
	scroller.scrollTop += 1;
	await settle();
	return {
		...measured,
		drawnFirst: chunkFirst !== null,
		sameAfterEstimate: chunkFirst !== null && chunkFirst === chunkSettled,
		sameInView: chunkFirst !== null && chunkFirst === deletionChunk(editor),
	};
}

async function stability(): Promise<unknown> {
	const { scroller, editor, passFrom } = deletionFar(lineWrapped);
	await settle();
	const from = passFrom();
	const first = await pass(scroller, from);
	const second = await pass(scroller, from);
	const chunk = await deletionAtEnd(scroller, editor);
	scroller.scrollTop = 0;
	await settle();
	const leftDom = chunk !== null && !chunk.isConnected;
	const third = await pass(scroller, from);
	return { first, second, drawn: chunk !== null, leftDom, third };
}

// A deletion drawn and measured, then out of the DOM again: CodeMirror's height map holds what it measured, which a new estimate would replace.
async function metricsChange(): Promise<unknown> {
	const { scroller, editor, passFrom } = deletionFar(lineWrapped);
	await settle();
	await pass(scroller, passFrom());
	const chunk = await deletionAtEnd(scroller, editor);
	scroller.scrollTop = 0;
	await settle();
	// With the deletion out of the DOM, the editor's height is what the height map holds.
	const before = editor.contentHeight;
	const metrics = editor.state.field(deletionMetrics);
	if (metrics === undefined) {
		throw new Error("the editor was never measured");
	}
	editor.dispatch({ effects: deletionMetricsSet.of({ ...metrics, lineLength: metrics.lineLength + 3 }) });
	await settle();
	return { drawn: chunk !== null, leftDom: chunk !== null && !chunk.isConnected, before, after: editor.contentHeight };
}

// What the harness runs, by name; assigned rather than declared on Window, which would give every renderer file the property.
Object.assign(window, {
	layoutScenarios: {
		groups,
		estimateWrapped: () => estimate(lineWrapped),
		estimateShort: () => estimate(lineShort),
		outOfView,
		stability,
		metricsChange,
	},
});
