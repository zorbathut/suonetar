import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// The stylesheet and wrap-indent.ts rely on the patched merge view grouping its deleted lines; without the patch they silently stop applying, and a large deletion lays out all at once again.
describe("@codemirror/merge patch", () => {
	const require = createRequire(import.meta.url);
	const cjs = require.resolve("@codemirror/merge");

	it("groups deleted lines in both builds", () => {
		for (const file of [cjs, cjs.replace(/index\.cjs$/, "index.js")]) {
			expect(readFileSync(file, "utf8")).toContain('"cm-deletedGroup"');
		}
	});
});
