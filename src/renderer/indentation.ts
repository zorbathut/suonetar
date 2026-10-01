import { indentUnit } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import type { Indentation } from "../engine/editorconfig.ts";
import type { Wire } from "../shared/api.ts";

// Where EditorConfig says nothing: the most common convention, rather than CodeMirror's two spaces.
const SIZE_DEFAULT = 4;

// What CodeMirror inserts for one level of indentation, and how wide it shows a tab.
export function editorIndent(indentation: Wire<Indentation>): { readonly unit: string; readonly tabSize: number } {
	const tabSize = indentation.tabWidth ?? indentation.size ?? SIZE_DEFAULT;
	return { unit: indentation.style === "tab" ? "\t" : " ".repeat(indentation.size ?? SIZE_DEFAULT), tabSize };
}

export function editorIndentExtension(indentation: Wire<Indentation>): Extension {
	const { unit, tabSize } = editorIndent(indentation);
	return [indentUnit.of(unit), EditorState.tabSize.of(tabSize)];
}
