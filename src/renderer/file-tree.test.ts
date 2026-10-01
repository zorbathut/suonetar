import { describe, expect, it } from "vitest";
import { fileTree, fileTreeOrder, sectionCurrentForView, type TreeNode, treeHighlightTarget } from "./file-tree.ts";

// The tree as indented lines: directories end in "/", files carry their status.
function show(nodes: readonly TreeNode[], depth = 0): string[] {
	return nodes.flatMap((n) =>
		n.kind === "dir" ? [`${"  ".repeat(depth)}${n.name}/ [${n.path}]`, ...show(n.children, depth + 1)] : [`${"  ".repeat(depth)}${n.name} ${n.status}`],
	);
}

const f = (path: string, status: "A" | "M" | "D" | "T" | "=" = "M") => ({ path, status });

describe("fileTree", () => {
	it("nests by directory, directories first, each level in code-unit order", () => {
		expect(show(fileTree([f("b.txt"), f("src/z.ts"), f("README.md", "A"), f("src/a.ts"), f("a.txt"), f("a/x.ts"), f("src/lib/q.ts", "=")]))).toEqual([
			"a/ [a]",
			"  x.ts M",
			"src/ [src]",
			"  lib/ [src/lib]",
			"    q.ts =",
			"  a.ts M",
			"  z.ts M",
			"README.md A",
			"a.txt M",
			"b.txt M",
		]);
	});

	it("merges chains of single-directory directories into one row keyed by the deepest path", () => {
		expect(show(fileTree([f("src/renderer/main.ts"), f("src/renderer/style.css")]))).toEqual(["src/renderer/ [src/renderer]", "  main.ts M", "  style.css M"]);
		expect(show(fileTree([f("a/b/c/d.ts")]))).toEqual(["a/b/c/ [a/b/c]", "  d.ts M"]);
	});

	it("does not merge a directory holding files, or one with a file beside a subdirectory", () => {
		expect(show(fileTree([f("src/main.ts"), f("src/lib/x.ts")]))).toEqual(["src/ [src]", "  lib/ [src/lib]", "    x.ts M", "  main.ts M"]);
		expect(show(fileTree([f("a/b/only.ts")]))).toEqual(["a/b/ [a/b]", "  only.ts M"]);
	});

	it("lists its files top to bottom, which is the order the document shows them in", () => {
		const order = fileTreeOrder(fileTree([f("b.txt"), f("src/z.ts"), f("README.md"), f("src/lib/q.ts"), f("src/a.ts")]));
		expect(order).toEqual(["src/lib/q.ts", "src/a.ts", "src/z.ts", "README.md", "b.txt"]);
	});

	it("handles root files and nothing at all", () => {
		expect(show(fileTree([f("x")]))).toEqual(["x M"]);
		expect(fileTree([])).toEqual([]);
	});
});

describe("sectionCurrentForView", () => {
	const rects = [
		{ top: -500, bottom: -100 },
		{ top: -100, bottom: 300 },
		{ top: 300, bottom: 700 },
		{ top: 700, bottom: 1500 },
	];

	it("takes the focused section while it is in view, else the first one reaching into view", () => {
		expect(sectionCurrentForView(rects, 2, 0, 1000)).toBe(2);
		expect(sectionCurrentForView(rects, 0, 0, 1000)).toBe(1);
		expect(sectionCurrentForView(rects, -1, 0, 1000)).toBe(1);
		expect(sectionCurrentForView(rects, -1, 800, 1000)).toBe(3);
	});

	it("takes the first section while the message above them fills the view", () => {
		expect(
			sectionCurrentForView(
				[
					{ top: 1200, bottom: 1600 },
					{ top: 1600, bottom: 2000 },
				],
				-1,
				0,
				1000,
			),
		).toBe(0);
	});

	it("has nothing to point at without sections", () => {
		expect(sectionCurrentForView([], -1, 0, 1000)).toBe(-1);
	});
});

describe("treeHighlightTarget", () => {
	const rows = [
		{ kind: "dir" as const, path: "a" },
		{ kind: "dir" as const, path: "a/b" },
		{ kind: "file" as const, path: "a/b/x.ts" },
		{ kind: "file" as const, path: "a" },
	];

	it("marks the file's own row when it is shown", () => {
		expect(treeHighlightTarget(rows, "a/b/x.ts")).toBe(2);
		// A file named like a directory (one deleted, the other added) is still the file.
		expect(treeHighlightTarget(rows, "a")).toBe(3);
	});

	it("marks the deepest shown directory holding a file hidden by collapsing", () => {
		expect(treeHighlightTarget(rows.slice(0, 2), "a/b/x.ts")).toBe(1);
		expect(treeHighlightTarget(rows.slice(0, 1), "a/b/x.ts")).toBe(0);
		expect(treeHighlightTarget(rows, "elsewhere.ts")).toBe(-1);
	});
});
