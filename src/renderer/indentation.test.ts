import { insertNewlineAndIndent } from "@codemirror/commands";
import { getIndentUnit, LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { editorIndent, editorIndentExtension } from "./indentation.ts";

const none = { style: undefined, size: undefined, tabWidth: undefined };

describe("editorIndent", () => {
	it("maps EditorConfig onto an indent unit and a tab size", () => {
		expect(editorIndent({ style: "space", size: 2, tabWidth: 2 })).toEqual({ unit: "  ", tabSize: 2 });
		expect(editorIndent({ style: "tab", size: 8, tabWidth: 8 })).toEqual({ unit: "\t", tabSize: 8 });
		expect(editorIndent({ style: undefined, size: 3, tabWidth: 3 })).toEqual({ unit: "   ", tabSize: 3 });
		// `indent_size = tab` with no width: tabs as wide as the default.
		expect(editorIndent({ style: "tab", size: undefined, tabWidth: undefined })).toEqual({ unit: "\t", tabSize: 4 });
	});

	it("uses four spaces without any EditorConfig", () => {
		expect(editorIndent(none)).toEqual({ unit: "    ", tabSize: 4 });
	});
});

describe("Enter in a C# method body", () => {
	async function enterAfter(doc: string, indentation: Parameters<typeof editorIndent>[0]): Promise<string> {
		const language = LanguageDescription.matchFilename(languages, "Foo.cs");
		if (language === null) {
			throw new Error("no C# language");
		}
		const state = EditorState.create({ doc, selection: EditorSelection.cursor(doc.length), extensions: [await language.load(), editorIndentExtension(indentation)] });
		let next = state;
		insertNewlineAndIndent({ state, dispatch: (tr: Transaction) => (next = tr.state) });
		expect(getIndentUnit(state)).toBe(indentation.style === "tab" ? state.tabSize : (indentation.size ?? 4));
		return next.doc.line(next.doc.lines).text;
	}

	it("indents one configured unit past the brace", async () => {
		const body = "class A\n{\n    void F()\n    {";
		expect(await enterAfter(body, { style: "space", size: 4, tabWidth: 4 })).toBe("        ");
		expect(await enterAfter(body, none)).toBe("        ");
		expect(await enterAfter("class A\n{\n\tvoid F()\n\t{", { style: "tab", size: 4, tabWidth: 4 })).toBe("\t\t");
	});
});
