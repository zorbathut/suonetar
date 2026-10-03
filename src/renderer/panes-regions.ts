import type { Chunk } from "@codemirror/merge";
import type { Text } from "@codemirror/state";

// A chunk as line ranges, each end exclusive and counted from 0: lines [a0, a1) of the older document against [b0, b1) of the newer.
export type LinesPair = { readonly a0: number; readonly a1: number; readonly b0: number; readonly b1: number };

// Lines of the three panes that sit side by side: the parent's [a0, a1), the commit's [b0, b1), and the edited [c0, c1). A region flagged neither `ab` nor `bc` is unchanged in all three, and holds the same lines in each.
export type RegionThree = {
	readonly a0: number;
	readonly a1: number;
	readonly b0: number;
	readonly b1: number;
	readonly c0: number;
	readonly c1: number;
	readonly ab: boolean;
	readonly bc: boolean;
};

export type LinesThree = { readonly a: number; readonly b: number; readonly c: number };

// The line a chunk position falls on. A chunk's `to` is the start of the line after it, or one past the document's end when it runs to the end.
function lineIndex(doc: Text, pos: number): number {
	return pos > doc.length ? doc.lines : doc.lineAt(pos).number - 1;
}

export function chunkLines(chunk: Chunk, a: Text, b: Text): LinesPair {
	return { a0: lineIndex(a, chunk.fromA), a1: lineIndex(a, chunk.toA), b0: lineIndex(b, chunk.fromB), b1: lineIndex(b, chunk.toB) };
}

// Lines up the parent (a), the commit (b) and the edited version (c), from the chunks of a against b and of b against c. Chunks of either pair whose ranges in b overlap or touch make one changed region; an unchanged region between two is never empty.
export function panesRegions(ab: readonly LinesPair[], bc: readonly LinesPair[], lines: LinesThree): RegionThree[] {
	// Each chunk by its range in b, with how many lines the other document gains across it.
	const spans = [
		...ab.map((k) => ({ m0: k.b0, m1: k.b1, da: k.a1 - k.a0 - (k.b1 - k.b0), dc: 0, ab: true })),
		...bc.map((k) => ({ m0: k.a0, m1: k.a1, da: 0, dc: k.b1 - k.b0 - (k.a1 - k.a0), ab: false })),
	].sort((x, y) => x.m0 - y.m0);
	const regions: RegionThree[] = [];
	let [a, b, c] = [0, 0, 0];
	const unchangedTo = (b1: number): void => {
		if (b1 > b) {
			const n = b1 - b;
			regions.push({ a0: a, a1: a + n, b0: b, b1, c0: c, c1: c + n, ab: false, bc: false });
			[a, b, c] = [a + n, b1, c + n];
		}
	};
	let i = 0;
	while (i < spans.length) {
		const first = spans[i];
		if (first === undefined) {
			break;
		}
		unchangedTo(first.m0);
		let m1 = first.m1;
		let [da, dc] = [0, 0];
		let [flagAb, flagBc] = [false, false];
		for (let span = spans[i]; span !== undefined && span.m0 <= m1; span = spans[++i]) {
			m1 = Math.max(m1, span.m1);
			da += span.da;
			dc += span.dc;
			flagAb ||= span.ab;
			flagBc ||= !span.ab;
		}
		const n = m1 - b;
		regions.push({ a0: a, a1: a + n + da, b0: b, b1: m1, c0: c, c1: c + n + dc, ab: flagAb, bc: flagBc });
		[a, b, c] = [a + n + da, m1, c + n + dc];
	}
	unchangedTo(lines.b);
	return regions;
}

// The line of the right pane beside line `line` of pane `pane`: the same line of an unchanged region, or the line as far into a changed one, kept within it.
export function panesLineToRight(regions: readonly RegionThree[], pane: "a" | "b" | "c", line: number): number {
	for (const r of regions) {
		const [x0, x1] = pane === "a" ? [r.a0, r.a1] : pane === "b" ? [r.b0, r.b1] : [r.c0, r.c1];
		if (x0 <= line && line < x1) {
			return r.c0 + Math.min(line - x0, Math.max(0, r.c1 - r.c0 - 1));
		}
	}
	return Math.max(0, (regions.at(-1)?.c1 ?? 0) - 1);
}

// The right pane's first line of each changed region, for stepping through the changes.
export function panesStops(regions: readonly RegionThree[]): number[] {
	return regions.filter((r) => r.ab || r.bc).map((r) => r.c0);
}

// The lines of an unchanged region that may fold: all but `margin` lines next to each change, with none kept at the file's start or end.
function foldable(r: RegionThree, end: number, margin: number): { readonly from: number; readonly to: number } {
	return { from: r.b0 + (r.b0 === 0 ? 0 : margin), to: r.b1 - (r.b1 === end ? 0 : margin) };
}

// Middle lines [b0, b1) of unchanged region `r` as a fold, placed in all three panes.
function foldIn(r: RegionThree, b0: number, b1: number): RegionThree {
	const skip = b0 - r.b0;
	return { a0: r.a0 + skip, a1: r.a0 + skip + b1 - b0, b0, b1, c0: r.c0 + skip, c1: r.c0 + skip + b1 - b0, ab: false, bc: false };
}

// The runs to fold when the panes are made: unchanged regions with more than `minSize` foldable lines.
export function panesFolds(regions: readonly RegionThree[], margin: number, minSize: number): RegionThree[] {
	const end = regions.at(-1)?.b1 ?? 0;
	const folds: RegionThree[] = [];
	for (const r of regions) {
		if (r.ab || r.bc) {
			continue;
		}
		const { from, to } = foldable(r, end, margin);
		if (to - from >= minSize) {
			folds.push(foldIn(r, from, to));
		}
	}
	return folds;
}

// The folds that still lie in the foldable lines of an unchanged region, placed anew in each pane. Folds are only ever dropped, as edits come near them, never added: a line just put back as the commit had it stays in view, as in CodeMirror's own merge views.
export function panesFoldsKeep(folds: readonly RegionThree[], regions: readonly RegionThree[], margin: number): RegionThree[] {
	const end = regions.at(-1)?.b1 ?? 0;
	const kept: RegionThree[] = [];
	for (const f of folds) {
		const r = regions.find((x) => !x.ab && !x.bc && x.b0 <= f.b0 && f.b1 <= x.b1);
		if (r === undefined) {
			continue;
		}
		const { from, to } = foldable(r, end, margin);
		if (from <= f.b0 && f.b1 <= to) {
			kept.push(foldIn(r, f.b0, f.b1));
		}
	}
	return kept;
}

// The change that puts a chunk of the commit (a side) against the edited version (b side) back as the commit has it. Adapted from MergeView.revertClicked in @codemirror/merge (MIT, Marijn Haverbeke and others).
export function panesRevert(chunk: Chunk, middle: Text, right: Text): { readonly from: number; readonly to: number; readonly insert: string } {
	let insert = middle.sliceString(chunk.fromA, Math.max(chunk.fromA, chunk.toA - 1));
	if (chunk.fromA !== chunk.toA && chunk.toB <= right.length) {
		insert += "\n";
	}
	return { from: chunk.fromB, to: Math.min(right.length, chunk.toB), insert };
}
