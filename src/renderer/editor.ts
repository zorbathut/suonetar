import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, indentOnInput, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { unifiedMergeView } from "@codemirror/merge";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension, Text } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection } from "@codemirror/view";

export type EditorSpec = {
	readonly path: string;
	readonly doc: string;
	// The text the document is diffed against; undefined for a plain editor.
	readonly original: string | undefined;
	readonly editable: boolean;
	readonly onChange: (() => void) | undefined;
	readonly extensions: Extension;
};

export function darkMode(): boolean {
	return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

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
	node.title = "Take this chunk out of the commit (it moves to the commit above)";
	node.addEventListener("mousedown", action);
	return node;
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
		highlightSelectionMatches(),
		search({ top: true }),
		keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
		language.of([]),
		// Read-only editors stay focusable, so the cursor and change navigation still work in them.
		EditorState.readOnly.of(!spec.editable),
		darkMode() ? oneDark : [],
		spec.extensions,
	];
	if (spec.original !== undefined) {
		extensions.push(
			unifiedMergeView({
				original: Text.of(spec.original.split("\n")),
				mergeControls: spec.editable ? mergeControl : false,
				collapseUnchanged: { margin: 3, minSize: 6 },
				syntaxHighlightDeletions: true,
			}),
		);
	}
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
