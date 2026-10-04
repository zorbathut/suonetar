import { Chunk } from "@codemirror/merge";
import { ChangeSet, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { diffByLine } from "./diff.ts";
import {
	chunkLines,
	type LinesPair,
	panesChanges,
	panesFolds,
	panesFoldsKeep,
	panesLineToRight,
	panesRegions,
	panesRevert,
	panesStops,
	type RegionThree,
} from "./panes-regions.ts";

const CONF = { override: diffByLine };

function text(s: string): Text {
	return Text.of(s.split("\n"));
}

function pairs(a: Text, b: Text): LinesPair[] {
	return Chunk.build(a, b, CONF).map((c) => chunkLines(c, a, b));
}

// A repeatable stream of whole numbers below `n`.
function seeded(seed: number): (n: number) => number {
	let state = seed;
	return (n) => {
		state = (state * 1103515245 + 12345) % 2 ** 31;
		return state % n;
	};
}

function lines(doc: Text, from: number, to: number): string[] {
	const out: string[] = [];
	for (let n = from; n < to; n++) {
		out.push(doc.line(n + 1).text);
	}
	return out;
}

// The invariants every alignment keeps: the regions tile all three documents in order, unchanged ones are non-empty and hold the same lines in all three, and every chunk of either pair lies inside a region flagged for it.
function invariantsCheck(a: Text, b: Text, c: Text, ab: readonly LinesPair[], bc: readonly LinesPair[], regions: readonly RegionThree[]): void {
	let [pa, pb, pc] = [0, 0, 0];
	for (const r of regions) {
		expect([r.a0, r.b0, r.c0]).toEqual([pa, pb, pc]);
		expect(r.a1).toBeGreaterThanOrEqual(r.a0);
		expect(r.b1).toBeGreaterThanOrEqual(r.b0);
		expect(r.c1).toBeGreaterThanOrEqual(r.c0);
		if (!r.ab && !r.bc) {
			expect(r.b1).toBeGreaterThan(r.b0);
			expect(lines(a, r.a0, r.a1)).toEqual(lines(b, r.b0, r.b1));
			expect(lines(c, r.c0, r.c1)).toEqual(lines(b, r.b0, r.b1));
		}
		[pa, pb, pc] = [r.a1, r.b1, r.c1];
	}
	expect([pa, pb, pc]).toEqual([a.lines, b.lines, c.lines]);
	for (const k of ab) {
		expect(regions.some((r) => r.ab && r.a0 <= k.a0 && k.a1 <= r.a1 && r.b0 <= k.b0 && k.b1 <= r.b1)).toBe(true);
	}
	for (const k of bc) {
		expect(regions.some((r) => r.bc && r.b0 <= k.a0 && k.a1 <= r.b1 && r.c0 <= k.b0 && k.b1 <= r.c1)).toBe(true);
	}
}

function check(left: string, middle: string, right: string): RegionThree[] {
	const [a, b, c] = [text(left), text(middle), text(right)];
	const ab = pairs(a, b);
	const bc = pairs(b, c);
	const regions = panesRegions(ab, bc, { a: a.lines, b: b.lines, c: c.lines });
	invariantsCheck(a, b, c, ab, bc, regions);
	return regions;
}

describe("chunkLines", () => {
	it("gives the changed lines of each side, the end exclusive", () => {
		const a = text("x\ny\nz\n");
		const b = text("x\nY\nY2\nz\n");
		expect(pairs(a, b)).toEqual([{ a0: 1, a1: 2, b0: 1, b1: 3 }]);
	});

	it("counts a chunk running past the end as ending at the last line", () => {
		const a = text("x\ny");
		const b = text("x\nz");
		expect(pairs(a, b)).toEqual([{ a0: 1, a1: 2, b0: 1, b1: 2 }]);
	});

	it("gives an insertion an empty range on the side without it", () => {
		const a = text("x\nz\n");
		const b = text("x\ny\nz\n");
		expect(pairs(a, b)).toEqual([{ a0: 1, a1: 1, b0: 1, b1: 2 }]);
	});
});

describe("panesRegions", () => {
	it("makes identical documents one unchanged region", () => {
		expect(check("a\nb\n", "a\nb\n", "a\nb\n")).toEqual([{ a0: 0, a1: 3, b0: 0, b1: 3, c0: 0, c1: 3, ab: false, bc: false }]);
	});

	it("flags a change in one pair only", () => {
		const commitOnly = check("a\nb\nc\n", "a\nB\nc\n", "a\nB\nc\n");
		expect(commitOnly.map((r) => [r.ab, r.bc])).toEqual([
			[false, false],
			[true, false],
			[false, false],
		]);
		const editOnly = check("a\nb\nc\n", "a\nb\nc\n", "a\nE\nc\n");
		expect(editOnly.map((r) => [r.ab, r.bc])).toEqual([
			[false, false],
			[false, true],
			[false, false],
		]);
	});

	it("makes lines both pairs change one region", () => {
		const regions = check("a\nb\nc\n", "a\nB\nc\n", "a\nBB\nc\n");
		expect(regions[1]).toEqual({ a0: 1, a1: 2, b0: 1, b1: 2, c0: 1, c1: 2, ab: true, bc: true });
	});

	it("joins a deletion by the commit and an insertion by the edit at the same middle line", () => {
		// The commit removes `gone` before `k`; the edit adds `new` there.
		const regions = check("a\ngone\nk\nz\n", "a\nk\nz\n", "a\nnew\nk\nz\n");
		expect(regions).toEqual([
			{ a0: 0, a1: 1, b0: 0, b1: 1, c0: 0, c1: 1, ab: false, bc: false },
			{ a0: 1, a1: 2, b0: 1, b1: 1, c0: 1, c1: 2, ab: true, bc: true },
			{ a0: 2, a1: 5, b0: 1, b1: 4, c0: 2, c1: 5, ab: false, bc: false },
		]);
	});

	it("joins chunks that touch in the middle document", () => {
		const regions = check("a\nb\nc\nd\n", "a\nB\nc\nd\n", "a\nB\nC\nd\n");
		expect(regions.map((r) => [r.b0, r.b1, r.ab, r.bc])).toEqual([
			[0, 1, false, false],
			[1, 3, true, true],
			[3, 5, false, false],
		]);
	});

	it("handles changes at the start and the end, with and without a final newline", () => {
		check("x\na\nb\n", "a\nb\n", "a\nb\ny\n");
		check("a\nb", "a\nB", "a\nB\n");
		check("a\nb\n", "a\nb", "a\nb");
		check("", "a\n", "a\nb");
		const regions = check("a\nb", "a\nb", "a\nc");
		expect(regions.at(-1)?.bc).toBe(true);
	});

	it("handles an empty middle or left document", () => {
		check("a\nb\n", "", "");
		check("", "a\nb\n", "a\nb\nc\n");
		check("a\n", "", "new\n");
	});

	it("keeps its invariants over random edits, and after updating chunks as the right side changes", () => {
		const random = seeded(7);
		const words = ["a", "b", "c", "{", "}", "", "foo", "bar"];
		const mutate = (lines: readonly string[]): string[] => {
			const out = [...lines];
			for (let k = random(4); k >= 0; k--) {
				const at = random(out.length + 1);
				const op = random(3);
				if (op === 0) {
					out.splice(at, 0, words[random(words.length)] ?? "w");
				} else if (op === 1) {
					out.splice(at, 1);
				} else {
					out.splice(at, 1, `${words[random(words.length)] ?? "w"}x`);
				}
			}
			return out;
		};
		for (let round = 0; round < 300; round++) {
			const base = Array.from({ length: random(12) }, () => words[random(words.length)] ?? "w");
			const left = base.join("\n");
			const middle = mutate(base).join("\n");
			const right = mutate(middle.split("\n")).join("\n");
			const [a, b] = [text(left), text(middle)];
			let c = text(right);
			const ab = pairs(a, b);
			let chunks = Chunk.build(b, c, CONF);
			invariantsCheck(a, b, c, ab, pairs(b, c), panesRegions(ab, pairs(b, c), { a: a.lines, b: b.lines, c: c.lines }));
			// Typing in the right pane updates the chunks incrementally, as the panes do.
			const at = random(c.length + 1);
			const insert = random(2) === 0 ? "\nnew" : "q";
			const change = { from: at, to: Math.min(c.length, at + random(3)), insert };
			const next = c.replace(change.from, change.to, text(change.insert));
			chunks = Chunk.updateB(chunks, b, next, ChangeSet.of([change], c.length), CONF);
			c = next;
			const bc = chunks.map((k) => chunkLines(k, b, c));
			invariantsCheck(a, b, c, ab, bc, panesRegions(ab, bc, { a: a.lines, b: b.lines, c: c.lines }));
		}
	});
});

describe("panesRegions in two panes", () => {
	it("tiles the left pane against the right with the left as the middle document, keeping folds on the left's lines as the right changes", () => {
		const random = seeded(11);
		const many = Array.from({ length: 60 }, (_, i) => `l${i}`);
		for (let round = 0; round < 200; round++) {
			const left = text([...many.slice(0, random(30)), "old", ...many.slice(30)].join("\n"));
			let right = text(left.toString().replace("old", random(2) === 0 ? "new" : "new\nmore"));
			let chunks = Chunk.build(left, right, CONF);
			const tiling = (): RegionThree[] => {
				const bc = chunks.map((k) => chunkLines(k, left, right));
				const regions = panesRegions([], bc, { a: left.lines, b: left.lines, c: right.lines });
				invariantsCheck(left, left, right, [], bc, regions);
				expect(regions.every((r) => r.a0 === r.b0 && r.a1 === r.b1 && !r.ab)).toBe(true);
				expect(panesStops(regions)).toHaveLength(regions.filter((r) => r.bc).length);
				return regions;
			};
			const folds = panesFolds(tiling(), 3, 6);
			const at = right.line(1 + random(right.lines)).from;
			const change = { from: at, to: at, insert: random(2) === 0 ? "typed\n" : "x" };
			const next = right.replace(change.from, change.to, text(change.insert));
			chunks = Chunk.updateB(chunks, left, next, ChangeSet.of([change], right.length), CONF);
			right = next;
			for (const f of panesFoldsKeep(folds, tiling(), 3)) {
				expect(folds.some((g) => g.b0 === f.b0 && g.b1 === f.b1)).toBe(true);
				expect(lines(right, f.c0, f.c1)).toEqual(lines(left, f.a0, f.a1));
			}
		}
	});
});

describe("panesLineToRight", () => {
	it("maps a line of any pane to the right pane's line beside it", () => {
		const regions = check("a\ngone\nk\nz\n", "a\nk\nz\n", "a\nnew\nk\nz\n");
		expect(panesLineToRight(regions, "a", 0)).toBe(0);
		expect(panesLineToRight(regions, "a", 1)).toBe(1);
		expect(panesLineToRight(regions, "a", 2)).toBe(2);
		expect(panesLineToRight(regions, "b", 1)).toBe(2);
		expect(panesLineToRight(regions, "b", 2)).toBe(3);
		expect(panesLineToRight(regions, "c", 3)).toBe(3);
	});

	it("maps a line beside lines the edit removed to where they were", () => {
		// The edit removes `b` and `c`: the right pane has nothing beside them.
		const regions = check("a\nb\nc\nd\n", "a\nb\nc\nd\n", "a\nd\n");
		expect(panesLineToRight(regions, "b", 1)).toBe(1);
		expect(panesLineToRight(regions, "b", 2)).toBe(1);
		expect(panesLineToRight(regions, "b", 3)).toBe(1);
	});
});

describe("panesStops", () => {
	it("lists the changed regions' first lines in the right pane", () => {
		expect(panesStops(check("a\nb\nc\nd\ne\n", "a\nB\nc\nd\ne\n", "a\nB\nc\nd\nE\n"))).toEqual([1, 4]);
		expect(panesStops(check("a\n", "a\n", "a\n"))).toEqual([]);
	});
});

describe("panesChanges", () => {
	it("lists the changed regions, each with the unchanged region after it", () => {
		// Three panes: the commit changes b, the edit removes d and adds x after h.
		const three = panesChanges(check("a\nb\nc\nd\ne\nf\ng\nh\n", "a\nB\nc\nd\ne\nf\ng\nh\n", "a\nB\nc\ne\nf\ng\nh\nx\n"));
		expect(three.map((c) => [c.region.a0, c.region.a1, c.region.c0, c.region.c1, c.next?.c0])).toEqual([
			[1, 2, 1, 2, 2],
			[3, 4, 3, 3, 3],
			[8, 8, 7, 8, 8],
		]);
		// Two panes, with a change running to the end of the file.
		const left = "a\nb\nc\nd\ne\nf\n";
		const two = panesChanges(check(left, left, "a\nc\nd\ne\nf"));
		expect(two.map((c) => [c.region.c0, c.region.c1, c.next === undefined])).toEqual([
			[1, 1, false],
			[4, 5, true],
		]);
	});

	it("keeps a region where the edit takes out lines the commit added, empty in both outer panes", () => {
		const [region] = panesChanges(check("a\nc\nd\n", "a\nb\nc\nd\n", "a\nc\nd\n")).map((c) => c.region);
		expect(region === undefined ? undefined : [region.a0 === region.a1, region.c0 === region.c1]).toEqual([true, true]);
	});
});

describe("panesFolds", () => {
	const many = (n: number, prefix: string): string => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join("\n");

	it("folds long unchanged runs, keeping a margin by changes but not at the file's edges", () => {
		const body = many(30, "l");
		const middle = `${body}\nchanged\n${body}\n`;
		const regions = check(`${body}\nold\n${body}\n`, middle, middle);
		const folds = panesFolds(regions, 3, 6);
		expect(folds.map((f) => [f.b0, f.b1])).toEqual([
			[0, 27],
			[34, 62],
		]);
		expect(folds.every((f) => f.a1 - f.a0 === f.b1 - f.b0 && f.c1 - f.c0 === f.b1 - f.b0)).toBe(true);
	});

	it("leaves short runs open", () => {
		const regions = check("a\nb\nc\n", "a\nB\nc\n", "a\nB\nc\n");
		expect(panesFolds(regions, 3, 6)).toEqual([]);
		const body = many(30, "l");
		expect(panesFolds(check(`${body}\nold\n`, `${body}\nnew\n`, `${body}\nnew\n`), 3, 6)).toHaveLength(1);
	});

	it("folds a run reaching the end of the file to its last line", () => {
		const body = many(30, "l");
		const regions = check(`old\n${body}`, `new\n${body}`, `new\n${body}`);
		expect(panesFolds(regions, 3, 6).map((f) => [f.b0, f.b1])).toEqual([[4, 31]]);
	});
});

describe("panesFoldsKeep", () => {
	const body = (from: number, n: number): string[] => Array.from({ length: n }, (_, i) => `l${from + i}`);
	const lines = (...parts: string[][]): string => parts.flat().join("\n");

	it("never adds a fold: text just put back as the commit has it stays in view", () => {
		const middle = lines(["new"], body(0, 40), ["mid"], body(40, 40));
		const parent = lines(["old"], body(0, 40), ["mid"], body(40, 40));
		const edited = lines(["new"], body(0, 40), ["MINE"], body(40, 40));
		const folds = panesFolds(check(parent, middle, edited), 3, 6);
		expect(folds.map((f) => [f.b0, f.b1])).toEqual([
			[4, 38],
			[45, 82],
		]);
		// Reverting the edit makes one unchanged run from line 1 to the end; the folds stay as they were, with the line between them still shown.
		const kept = panesFoldsKeep(folds, check(parent, middle, middle), 3);
		expect(kept).toEqual(folds);
	});

	it("drops a fold an edit comes within the margin of, and moves the rest in the right pane", () => {
		const parent = lines(["old"], body(0, 40), ["tail"], body(40, 40));
		const middle = lines(["new"], body(0, 40), ["tail"], body(40, 40));
		const folds = panesFolds(check(parent, middle, middle), 3, 6);
		expect(folds.map((f) => [f.b0, f.b1])).toEqual([[4, 82]]);
		const near = lines(["new"], body(0, 40), ["tail", "added"], body(40, 40));
		expect(panesFoldsKeep(folds, check(parent, middle, near), 3)).toEqual([]);
		// An edit above a fold shifts where it is in the right pane only.
		const above = lines(["new", "added", "added2"], body(0, 40), ["tail"], body(40, 40));
		const short = panesFolds(check(parent, middle, middle), 3, 6).map((f) => ({ ...f, b0: 50, b1: 60, a0: 50, a1: 60, c0: 50, c1: 60 }));
		expect(panesFoldsKeep(short, check(parent, middle, above), 3)).toEqual([{ a0: 50, a1: 60, b0: 50, b1: 60, c0: 52, c1: 62, ab: false, bc: false }]);
	});
});

describe("panesRevert", () => {
	function reverted(middle: string, right: string): string {
		const [b, c] = [text(middle), text(right)];
		let doc = c;
		// Last chunk first, so earlier positions stay valid.
		for (const chunk of [...Chunk.build(b, c, CONF)].reverse()) {
			const change = panesRevert(chunk, b, doc);
			doc = doc.replace(change.from, change.to, text(change.insert));
		}
		return doc.toString();
	}

	it("puts each chunk back to the middle's text", () => {
		expect(reverted("a\nb\nc\n", "a\nB\nc\n")).toBe("a\nb\nc\n");
		expect(reverted("a\nc\n", "a\nb\nc\n")).toBe("a\nc\n");
		expect(reverted("a\nb\nc\n", "a\nc\n")).toBe("a\nb\nc\n");
		expect(reverted("a\nb", "a\nB")).toBe("a\nb");
		expect(reverted("a\nb", "a\nb\nc")).toBe("a\nb");
		expect(reverted("a\nb\nc", "a\nc")).toBe("a\nb\nc");
		expect(reverted("", "a\n")).toBe("");
		expect(reverted("a\n", "")).toBe("a\n");
	});
});
