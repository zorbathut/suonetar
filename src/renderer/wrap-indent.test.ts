import { indentUnit } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { indentColumns, wrapIndent, wrapIndentAttributes } from "./wrap-indent.ts";

describe("indentColumns", () => {
	it("counts leading whitespace in columns, with tabs reaching the next tab stop", () => {
		expect(indentColumns("    x", 4)).toBe(4);
		expect(indentColumns("\t\tx", 4)).toBe(8);
		expect(indentColumns("  \tx", 4)).toBe(4);
		expect(indentColumns("\t  x", 4)).toBe(6);
		expect(indentColumns("x  y", 4)).toBe(0);
		expect(indentColumns("", 4)).toBe(0);
	});
});

describe("wrapIndent", () => {
	it("hangs two indent units past the line's own indentation", () => {
		expect(wrapIndent("x", 4, 4)).toBe(8);
		expect(wrapIndent("\t\tx", 4, 4)).toBe(16);
		expect(wrapIndent("  x", 2, 4)).toBe(6);
	});
});

describe("wrapIndentAttributes", () => {
	it("gives the hang in the --wrap-indent property the stylesheet reads, by the editor's indent unit and tab size", () => {
		const state = EditorState.create({ extensions: [indentUnit.of("  "), EditorState.tabSize.of(4)] });
		expect(wrapIndentAttributes("\tx", state)).toEqual({ style: "--wrap-indent: 8ch" });
		expect(wrapIndentAttributes("x", state)).toEqual({ style: "--wrap-indent: 4ch" });
	});
});
