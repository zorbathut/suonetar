import { describe, expect, it } from "vitest";
import { indentColumns, indentUnitGuess, wrapIndent } from "./wrap-indent.ts";

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

describe("indentUnitGuess", () => {
	const nest = (unit: string) => ["a {", `${unit}b {`, `${unit}${unit}c;`, `${unit}}`, "}", "d {", `${unit}e;`, "}"];

	it("finds two- and four-space and tab indentation", () => {
		expect(indentUnitGuess(nest("  "), 4)).toBe(2);
		expect(indentUnitGuess(nest("    "), 4)).toBe(4);
		expect(indentUnitGuess(nest("\t"), 4)).toBe(4);
		expect(indentUnitGuess(nest("\t"), 8)).toBe(8);
	});

	it("is not fooled by block-comment continuations, even when they outnumber real indentation", () => {
		// One real step in, then two steps into comment continuations: counted naively, 1 would win.
		const documented = ["class A {", "    /**", "     * Does a thing.", "     */", "    f() { g(); }", "    /**", "     * Another.", "     */", "    h() { i(); }", "}"];
		expect(indentUnitGuess(documented, 4)).toBe(4);
	});

	it("still counts Markdown bullets and other lines starting with a star", () => {
		expect(indentUnitGuess(["* a", "  * b", "    * c", "* d", "  * e"], 4)).toBe(2);
	});

	it("skips blank lines, and falls back to the tab size with nothing to go on", () => {
		expect(indentUnitGuess(["a {", "", "  b;", "}"], 4)).toBe(2);
		expect(indentUnitGuess(["one line"], 4)).toBe(4);
		expect(indentUnitGuess([], 4)).toBe(4);
	});

	it("prefers the smaller unit on a tie", () => {
		expect(indentUnitGuess(["a", "  b", "c", "    d"], 4)).toBe(2);
	});
});

describe("wrapIndent", () => {
	it("hangs two indent units past the line's own indentation", () => {
		expect(wrapIndent("x", 4, 4)).toBe(8);
		expect(wrapIndent("\t\tx", 4, 4)).toBe(16);
		expect(wrapIndent("  x", 2, 4)).toBe(6);
	});
});
