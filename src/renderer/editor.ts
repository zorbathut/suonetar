import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, indentOnInput, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Chunk, getChunks, unifiedMergeView } from "@codemirror/merge";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension, StateField, Text } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import {
	BlockType,
	drawSelection,
	EditorView,
	highlightActiveLine,
	highlightActiveLineGutter,
	highlightSpecialChars,
	keymap,
	lineNumbers,
	rectangularSelection,
} from "@codemirror/view";
import type { Indentation } from "../engine/editorconfig.ts";
import type { Wire } from "../shared/api.ts";
import { diffByLine } from "./diff.ts";
import { editorIndentExtension } from "./indentation.ts";
import { changeKind, type OverviewChange } from "./overview.ts";
import { wrapIndented } from "./wrap-indent.ts";

export type EditorSpec = {
	readonly path: string;
	readonly doc: string;
	// The text the document is diffed against; undefined for a plain editor.
	readonly original: string | undefined;
	readonly editable: boolean;
	readonly onChange: (() => void) | undefined;
	readonly extensions: Extension;
	// The file's EditorConfig indentation.
	readonly indentation: Wire<Indentation>;
};

export function darkMode(): boolean {
	return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export const REVERT_CHUNK_TITLE = "Take this chunk out of the commit and every commit above it";

function mergeControl(type: "reject" | "accept", action: (e: MouseEvent) => void): HTMLElement {
	// Only Reject: Accept would edit the original side, which is never saved, and just hide the change.
	const node = document.createElement("button");
	node.type = "button";
	if (type === "accept") {
		node.hidden = true;
		return node;
	}
	node.name = "reject";
	node.textContent = "Revert chunk";
	node.title = REVERT_CHUNK_TITLE;
	node.addEventListener("mousedown", action);
	return node;
}

// Holds how an editor shows its diff, so that it can change without the editor being replaced.
const diffCompartment = new Compartment();

// The diff shown inline against `original`.
export function editorDiffInline(original: string, editable: boolean): Extension {
	return unifiedMergeView({
		original: Text.of(original.split("\n")),
		mergeControls: editable ? mergeControl : false,
		collapseUnchanged: { margin: 3, minSize: 6 },
		syntaxHighlightDeletions: true,
		allowInlineDiffs: true,
		// CodeMirror's own diff works on characters and gives up on a large rewrite, making one change of it.
		diffConfig: { override: diffByLine },
	});
}

// The viewport extent of lines [fromB, toB) of the editor's text; with none, of the deleted lines shown above `fromB`, which share its line block. A chunk's `toB` is one past the end of the text when it runs to the end.
export function editorSpan(view: EditorView, fromB: number, toB: number): { readonly top: number; readonly bottom: number } {
	const doc = view.state.doc;
	const block = view.lineBlockAt(Math.min(fromB, doc.length));
	const top = view.documentTop + block.top;
	if (toB > fromB) {
		return { top, bottom: view.documentTop + view.lineBlockAt(Math.min(toB - 1, doc.length)).bottom };
	}
	let above = 0;
	if (Array.isArray(block.type)) {
		for (const part of block.type) {
			if (part.type === BlockType.Text) {
				break;
			}
			above += part.height;
		}
	}
	return { top, bottom: top + above };
}

// The changes the inline diff shows; none without one.
export function editorDiffChanges(view: EditorView): OverviewChange[] {
	return (getChunks(view.state)?.chunks ?? []).flatMap((c) => {
		const kind = changeKind(c.fromA === c.toA, c.fromB === c.toB);
		return kind === undefined ? [] : [{ ...editorSpan(view, c.fromB, c.toB), pos: c.fromB, kind }];
	});
}

// The editor text's chunks against `against`, kept current as it is typed in.
export function editorChunksField(against: Text): StateField<readonly Chunk[]> {
	const conf = { override: diffByLine };
	return StateField.define<readonly Chunk[]>({
		create: (state) => Chunk.build(against, state.doc, conf),
		update: (chunks, tr) => (tr.docChanged ? Chunk.updateB(chunks, against, tr.newDoc, tr.changes, conf) : chunks),
	});
}

export function editorDiffSet(view: EditorView, diff: Extension): void {
	view.dispatch({ effects: diffCompartment.reconfigure(diff) });
}

export function editorCreate(parent: HTMLElement, spec: EditorSpec): EditorView {
	const language = new Compartment();
	const extensions: Extension[] = [
		lineNumbers(),
		highlightActiveLineGutter(),
		highlightSpecialChars(),
		history(),
		drawSelection(),
		indentOnInput(),
		syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
		bracketMatching(),
		rectangularSelection(),
		highlightActiveLine(),
		editorIndentExtension(spec.indentation),
		wrapIndented(),
		highlightSelectionMatches(),
		search({ top: true }),
		keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
		language.of([]),
		// Read-only editors stay focusable, so the cursor and change navigation still work in them.
		EditorState.readOnly.of(!spec.editable),
		darkMode() ? oneDark : [],
		spec.extensions,
	];
	extensions.push(diffCompartment.of(spec.original === undefined ? [] : editorDiffInline(spec.original, spec.editable)));
	const onChange = spec.onChange;
	if (onChange !== undefined) {
		extensions.push(
			EditorView.updateListener.of((update) => {
				if (update.docChanged) {
					onChange();
				}
			}),
		);
	}
	const view = new EditorView({ parent, state: EditorState.create({ doc: spec.doc, extensions }) });
	const description = LanguageDescription.matchFilename(languages, spec.path);
	if (description !== null) {
		description.load().then(
			(support) => {
				if (view.dom.isConnected) {
					view.dispatch({ effects: language.reconfigure(support) });
				}
			},
			(err: unknown) => console.error(`suonetar: loading the language for ${spec.path} failed:`, err),
		);
	}
	return view;
}
