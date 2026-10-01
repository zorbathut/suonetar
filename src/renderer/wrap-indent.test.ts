import { describe, expect, it } from "vitest";
import { indentColumns, wrapIndent } from "./wrap-indent.ts";

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
