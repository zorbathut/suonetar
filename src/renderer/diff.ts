import { Change, diff } from "@codemirror/merge";

// Lines [a0, a1) of the original text against [b0, b1) of the new one: lines that differ, or a run a search found shared.
export type Region = { a0: number; a1: number; b0: number; b1: number };

// Which alignment a search is for: the first, over lines exactly as they are, or the second, within a changed region, over lines stripped of whitespace.
type Stage = "exact" | "loose";

// What git's histogram search found in a region: a run of shared lines, only lines too frequent to anchor on, or nothing shared at all.
type Lcs = { readonly kind: "match"; readonly match: Region; readonly work: number } | { readonly kind: "frequent" | "none"; readonly work: number };

// One side of the diff: its text, its lines (each with its line break), where each line starts (and one past the end), and each line as a number.
type Side = {
	readonly text: string;
	readonly lines: readonly string[];
	readonly offsets: Int32Array;
	readonly ids: Int32Array;
};

// What is left of one diff's budgets, which bound its work however many regions it has.
type Budget = { histogram: number; pairing: number };

// A diff in progress: its two sides, the numbering their lines share, which numbers are content-free lines, and its budget.
type Diffing = { readonly A: Side; readonly B: Side; readonly intern: (line: string) => number; readonly junk: (id: number) => boolean; readonly budget: Budget };

// A line as pairing compares it: its non-blank text, and that text's adjacent character pairs, sorted.
type LineKey = { readonly text: string; readonly bigrams: Uint32Array };

// How often a line may occur and still anchor a match, as in git.
const OCCURRENCES_MAX = 64;

// Steps (lines indexed, B lines scanned, matches extended) the histogram search may take in one diff before what is left is aligned with Myers instead. It rescans what remains after each match, which edits on every few lines of a long file make quadratic.
const HISTOGRAM_WORK_MAX = 500_000;

// Edits a Myers search takes at a time. Its time grows with edits times lines, and its record of the search with edits squared, so a longer one is done in steps of this many.
const MYERS_EDITS_STEP = 200;

// CodeMirror's own bound on how hard its diff tries before settling for a cruder answer.
const CHARS_SCAN_LIMIT = 500;

// Changes this close together are one: what lies between is a coincidence, not something kept.
const CHARS_GAP_MIN = 3;

// How alike two changed ranges must be, as the share of their non-blank characters they keep, to be shown character by character.
const CHARS_SIMILARITY_MIN = 0.5;

// How alike two lines in a changed region must be, as the share of their non-blank character pairs they have in common, to be paired up and compared character by character.
const LINES_SIMILARITY_MIN = 0.5;

// Lines either side of a change joined across content-free lines may grow to: past this, a rewrite is shown as several chunks, so that Revert chunk keeps some granularity and typing in it re-diffs a bounded window.
const ABSORBED_LINES_MAX = 200;

// Characters that pairing lines by likeness may compare in one diff, every line of a region against every line, across all its regions. Past this, a region's lines pair from each end for as long as they stay alike.
const PAIRING_WORK_MAX = 4_000_000;

// Element `i` of `xs`, which the caller keeps in bounds.
function at(xs: ArrayLike<number>, i: number): number {
	const x = xs[i];
	if (x === undefined) {
		throw new Error(`index ${i} is out of bounds`);
	}
	return x;
}

// The text's lines, each with its line break; the last has none when the text does not end in one.
export function linesSplit(text: string): string[] {
	const lines: string[] = [];
	for (let start = 0; ; ) {
		const end = text.indexOf("\n", start);
		if (end < 0) {
			if (start < text.length) {
				lines.push(text.slice(start));
			}
			return lines;
		}
		lines.push(text.slice(start, end + 1));
		start = end + 1;
	}
}

function nonBlank(text: string): string {
	return text.replace(/\s/g, "");
}

// A line with no letter or digit, such as a brace, a blank line or `});`: it says nothing about which code it belongs to, so it never anchors an alignment by itself, and rewritten lines on either side of it read as one block.
function lineJunk(line: string): boolean {
	return !/[\p{L}\p{N}]/u.test(line);
}

// The longest run of lines both sides of the region share, preferring runs of rarer lines: git's histogram search (find_lcs and try_lcs in xdiff/xhistogram.c), on half-open ranges. Unlike git's, a run of content-free lines alone is no match, and their counts don't make a run rarer. In the exact stage they are not shared lines at all, so a region only they hold together comes back as having none; in the loose stage they are, so such a region goes to Myers.
function lcsFind(A: Int32Array, B: Int32Array, r: Region, junk: (id: number) => boolean, stage: Stage): Lcs {
	// Each line's occurrences in A's side: how many, the first, and from each the next.
	const records = new Map<number, { first: number; count: number }>();
	const next = new Int32Array(r.a1 - r.a0).fill(-1);
	for (let i = r.a1 - 1; i >= r.a0; i--) {
		const id = at(A, i);
		const record = records.get(id);
		if (record === undefined) {
			records.set(id, { first: i, count: 1 });
		} else {
			next[i - r.a0] = record.first;
			record.first = i;
			record.count++;
		}
	}
	const countOf = (id: number): number => {
		const record = records.get(id);
		if (record === undefined) {
			throw new Error(`line ${id} is not in the region`);
		}
		return record.count;
	};
	const rarityOf = (id: number): number => (junk(id) ? Number.POSITIVE_INFINITY : countOf(id));

	let work = r.a1 - r.a0;
	let best: Region | undefined;
	let bestCount = OCCURRENCES_MAX + 1;
	let common = false;
	for (let j = r.b0; j < r.b1; ) {
		let jNext = j + 1;
		work++;
		const record = records.get(at(B, j));
		if (record !== undefined && (stage === "loose" || !junk(at(B, j)))) {
			common = true;
		}
		// As git does, lines more frequent than the best match so far are not tried.
		for (let i = record !== undefined && record.count <= bestCount ? record.first : -1; i !== -1; ) {
			let as = i;
			let bs = j;
			let ae = i + 1;
			let be = j + 1;
			let rarity = rarityOf(at(A, i));
			let content = !junk(at(A, i));
			while (as > r.a0 && bs > r.b0 && A[as - 1] === B[bs - 1]) {
				as--;
				bs--;
				work++;
				content ||= !junk(at(A, as));
				if (rarity > 1) {
					rarity = Math.min(rarity, rarityOf(at(A, as)));
				}
			}
			while (ae < r.a1 && be < r.b1 && A[ae] === B[be]) {
				content ||= !junk(at(A, ae));
				if (rarity > 1) {
					rarity = Math.min(rarity, rarityOf(at(A, ae)));
				}
				ae++;
				be++;
				work++;
			}
			// B's lines inside this match need no search of their own.
			if (jNext < be) {
				jNext = be;
			}
			// git starts from an empty match, which a single line beats only by occurring at most OCCURRENCES_MAX times.
			const bestLength = best === undefined ? 1 : best.a1 - best.a0;
			if (content && (bestLength < ae - as || rarity < bestCount)) {
				best = { a0: as, a1: ae, b0: bs, b1: be };
				bestCount = rarity;
			}
			// The next occurrence past this match.
			let k = at(next, i - r.a0);
			while (k !== -1 && k < ae) {
				k = at(next, k - r.a0);
				work++;
			}
			i = k;
		}
		j = jNext;
	}
	// A match whose rarest line is still too frequent anchors nothing, and git falls back to Myers.
	if (best !== undefined && bestCount <= OCCURRENCES_MAX) {
		return { kind: "match", match: best, work };
	}
	return { kind: common ? "frequent" : "none", work };
}

// The edits of a Myers search, walked back along its trace from the point it reached to the start, in order.
function editsFromTrace(trace: readonly Int32Array[], r: Region, end: { readonly x: number; readonly y: number }): Region[] {
	const edits: Region[] = [];
	let x = end.x;
	let y = end.y;
	for (let d = trace.length - 1; d > 0 && x + y > 0; d--) {
		const prev = trace[d - 1];
		if (prev === undefined) {
			throw new Error(`no trace for ${d - 1} edits`);
		}
		const prevAt = (k: number) => at(prev, k + d - 1);
		const k = x - y;
		const down = k === -d || (k !== d && prevAt(k - 1) < prevAt(k + 1));
		const xPrev = prevAt(down ? k + 1 : k - 1);
		const yPrev = xPrev - (down ? k + 1 : k - 1);
		// One line inserted (down) or deleted, then shared lines up to (x, y).
		edits.push({ a0: r.a0 + xPrev, a1: r.a0 + (down ? xPrev : xPrev + 1), b0: r.b0 + yPrev, b1: r.b0 + (down ? yPrev + 1 : yPrev) });
		x = xPrev;
		y = yPrev;
	}
	return edits.reverse();
}

// Myers' diff over a region's lines: where git falls back to it, no shared line being rare enough for histogram to anchor on, and for whatever is left once the histogram search has spent its budget. Done MYERS_EDITS_STEP edits at a time: when a step runs out, the edits up to the furthest point it reached stand, and the search starts again from there. The result is then no longer minimal, so its regions may share lines. It lines content-free lines up like any other, so where it takes over from histogram, braces anchor again.
function regionsMyers(A: Int32Array, B: Int32Array, whole: Region): Region[] {
	const found: Region[] = [];
	for (let r = whole; r.a0 < r.a1 || r.b0 < r.b1; ) {
		const n = r.a1 - r.a0;
		const m = r.b1 - r.b0;
		const max = Math.min(n + m, MYERS_EDITS_STEP);
		// v[offset + k]: the furthest x reached on diagonal k = x - y; trace[d] keeps diagonals -d..d of it after d edits.
		const offset = max + 1;
		const v = new Int32Array(2 * max + 3);
		const trace: Int32Array[] = [];
		let end: { x: number; y: number } | undefined;
		for (let d = 0; d <= max && end === undefined; d++) {
			for (let k = -d; k <= d; k += 2) {
				const down = k === -d || (k !== d && at(v, offset + k - 1) < at(v, offset + k + 1));
				let x = down ? at(v, offset + k + 1) : at(v, offset + k - 1) + 1;
				let y = x - k;
				while (x < n && y < m && A[r.a0 + x] === B[r.b0 + y]) {
					x++;
					y++;
				}
				v[offset + k] = x;
				if (x >= n && y >= m) {
					end = { x, y };
					break;
				}
			}
			trace.push(v.slice(offset - d, offset + d + 1));
		}
		// Out of edits: stop at the furthest point any diagonal reached after the last of them.
		if (end === undefined) {
			const last = trace[trace.length - 1];
			if (last === undefined) {
				throw new Error("a Myers step made no trace");
			}
			end = { x: 0, y: 0 };
			for (let k = -max; k <= max; k += 2) {
				const x = at(last, k + max);
				if (x - k >= 0 && x <= n && x - k <= m && 2 * x - k > end.x + end.y) {
					end = { x, y: x - k };
				}
			}
			// Every edit moves a step from the start, so some diagonal is that many steps along.
			if (end.x + end.y === 0) {
				throw new Error(`a Myers step of ${max} edits got nowhere`);
			}
		}
		for (const edit of editsFromTrace(trace, r, end)) {
			const last = found[found.length - 1];
			if (last !== undefined && last.a1 === edit.a0 && last.b1 === edit.b0) {
				last.a1 = edit.a1;
				last.b1 = edit.b1;
			} else {
				found.push(edit);
			}
		}
		r = { a0: r.a0 + end.x, a1: r.a1, b0: r.b0 + end.y, b1: r.b1 };
	}
	return found;
}

// The regions of `whole` whose lines differ, in order, by git's histogram diff (histogram_diff in xdiff/xhistogram.c), driven by a stack rather than recursion.
function regionsFind(A: Int32Array, B: Int32Array, whole: Region, budget: Budget, junk: (id: number) => boolean, stage: Stage): Region[] {
	const found: Region[] = [];
	const add = (regions: readonly Region[]) => {
		for (const region of regions) {
			found.push(region);
		}
	};
	const stack = [whole];
	for (let r = stack.pop(); r !== undefined; r = stack.pop()) {
		if (r.a0 === r.a1 || r.b0 === r.b1) {
			if (r.a0 < r.a1 || r.b0 < r.b1) {
				found.push(r);
			}
			continue;
		}
		if (budget.histogram <= 0) {
			add(regionsMyers(A, B, r));
			continue;
		}
		const lcs = lcsFind(A, B, r, junk, stage);
		budget.histogram -= lcs.work;
		switch (lcs.kind) {
			case "match": {
				const m = lcs.match;
				stack.push({ a0: m.a1, a1: r.a1, b0: m.b1, b1: r.b1 }, { a0: r.a0, a1: m.a0, b0: r.b0, b1: m.b0 });
				break;
			}
			case "frequent":
				add(regionsMyers(A, B, r));
				break;
			case "none":
				found.push(r);
				break;
			default: {
				const never: never = lcs;
				throw new Error(`unknown search result ${String(never)}`);
			}
		}
	}
	return found;
}

// Slides each pure insertion or deletion down past lines it could equally well end with, as far as the next region: the downward half of git's xdl_change_compact (without its sliding up to join a neighbour, or its indent heuristic), so that most blocks land where git puts them.
function regionsSlide(A: Int32Array, B: Int32Array, regions: readonly Region[]): Region[] {
	return regions.map((region, k) => {
		const r = { ...region };
		const next = regions[k + 1];
		const nextA = next === undefined ? A.length : next.a0;
		const nextB = next === undefined ? B.length : next.b0;
		if (r.a0 === r.a1) {
			while (r.b1 < nextB && r.a0 < nextA && B[r.b1] === B[r.b0]) {
				r.a0++;
				r.a1++;
				r.b0++;
				r.b1++;
			}
		} else if (r.b0 === r.b1) {
			while (r.a1 < nextA && r.b0 < nextB && A[r.a1] === A[r.a0]) {
				r.a0++;
				r.a1++;
				r.b0++;
				r.b1++;
			}
		}
		return r;
	});
}

// The characters that differ between two ranges, by CodeMirror's own diff, with changes closer than CHARS_GAP_MIN joined and the empty changes it can leave dropped. Ranges that keep too little are one change: lines rewritten outright would otherwise show as a scatter of the letters and words they happen to share.
function charsDiff(a: string, fromA: number, toA: number, b: string, fromB: number, toB: number): Change[] {
	const textA = a.slice(fromA, toA);
	const textB = b.slice(fromB, toB);
	const joined: Change[] = [];
	for (const c of diff(textA, textB, { scanLimit: CHARS_SCAN_LIMIT })) {
		if (c.fromA === c.toA && c.fromB === c.toB) {
			continue;
		}
		const last = joined[joined.length - 1];
		if (last !== undefined && c.fromA - last.toA < CHARS_GAP_MIN) {
			joined[joined.length - 1] = new Change(last.fromA, c.toA, last.fromB, c.toB);
		} else {
			joined.push(c);
		}
	}
	let kept = 0;
	let pos = 0;
	for (const c of joined) {
		kept += nonBlank(textA.slice(pos, c.fromA)).length;
		pos = c.toA;
	}
	kept += nonBlank(textA.slice(pos)).length;
	// Their similarity (Dice's coefficient) over non-blank characters.
	if (2 * kept < (nonBlank(textA).length + nonBlank(textB).length) * CHARS_SIMILARITY_MIN) {
		return [new Change(fromA, toA, fromB, toB)];
	}
	return joined.map((c) => new Change(fromA + c.fromA, fromA + c.toA, fromB + c.fromB, fromB + c.toB));
}

function lineKey(line: string): LineKey {
	const text = nonBlank(line);
	const bigrams = new Uint32Array(Math.max(0, text.length - 1));
	for (let i = 0; i + 1 < text.length; i++) {
		bigrams[i] = ((text.charCodeAt(i) << 16) | text.charCodeAt(i + 1)) >>> 0;
	}
	return { text, bigrams: bigrams.sort() };
}

// How alike two lines are, from 0 to 1: Dice's coefficient over their character pairs. Blank lines are like nothing, so they never pair.
function likeness(x: LineKey, y: LineKey): number {
	if (x.text === "" || y.text === "") {
		return 0;
	}
	if (x.text === y.text) {
		return 1;
	}
	const total = x.bigrams.length + y.bigrams.length;
	// Their counts alone bound it from above, which saves comparing lines of very different lengths.
	if (2 * Math.min(x.bigrams.length, y.bigrams.length) <= total * LINES_SIMILARITY_MIN) {
		return 0;
	}
	let shared = 0;
	for (let i = 0, j = 0; i < x.bigrams.length && j < y.bigrams.length; ) {
		const p = at(x.bigrams, i);
		const q = at(y.bigrams, j);
		if (p === q) {
			shared++;
			i++;
			j++;
		} else if (p < q) {
			i++;
		} else {
			j++;
		}
	}
	return (2 * shared) / total;
}

// Pairs the lines of a changed region in order, making the most of how alike the paired lines are, by dynamic programming over every pair: a pair more alike than LINES_SIMILARITY_MIN gains by how much more, weighted by the lines' length so that long lines outweigh braces. Indices are within the region.
function linesPair(keysA: readonly LineKey[], keysB: readonly LineKey[]): { readonly i: number; readonly j: number }[] {
	const n = keysA.length;
	const m = keysB.length;
	const width = m + 1;
	const score = new Float64Array((n + 1) * width);
	// How each cell's score was reached: 1 by pairing lines i - 1 and j - 1, 2 by leaving line i - 1 of A unpaired, 3 by leaving line j - 1 of B unpaired.
	const move = new Uint8Array((n + 1) * width);
	let row = 0;
	for (const keyA of keysA) {
		row += width;
		let cell = row;
		for (const keyB of keysB) {
			cell++;
			let best = at(score, cell - width);
			let how = 2;
			const left = at(score, cell - 1);
			if (left > best) {
				best = left;
				how = 3;
			}
			const gain = (likeness(keyA, keyB) - LINES_SIMILARITY_MIN) * (keyA.text.length + keyB.text.length);
			const diagonal = at(score, cell - width - 1) + gain;
			if (gain > 0 && diagonal > best) {
				best = diagonal;
				how = 1;
			}
			score[cell] = best;
			move[cell] = how;
		}
	}
	const pairs: { i: number; j: number }[] = [];
	for (let i = n, j = m; i > 0 && j > 0; ) {
		const how = at(move, i * width + j);
		if (how === 1) {
			pairs.push({ i: i - 1, j: j - 1 });
			i--;
			j--;
		} else if (how === 2) {
			i--;
		} else {
			j--;
		}
	}
	return pairs.reverse();
}

// Pairs a region's lines from each end inward for as long as they stay alike, for a region too big to weigh every pair: a block renamed throughout, say, with lines added somewhere in it. Indices are within the region.
function linesPairEnds(linesA: readonly string[], linesB: readonly string[]): { readonly i: number; readonly j: number }[] {
	const keyOf = (lines: readonly string[], i: number) => {
		const line = lines[i];
		if (line === undefined) {
			throw new Error(`line ${i} is out of bounds`);
		}
		return lineKey(line);
	};
	const alike = (i: number, j: number) => likeness(keyOf(linesA, i), keyOf(linesB, j)) > LINES_SIMILARITY_MIN;
	const n = linesA.length;
	const m = linesB.length;
	let top = 0;
	while (top < n && top < m && alike(top, top)) {
		top++;
	}
	let bottom = 0;
	while (bottom < n - top && bottom < m - top && alike(n - 1 - bottom, m - 1 - bottom)) {
		bottom++;
	}
	return [...Array.from({ length: top }, (_, k) => ({ i: k, j: k })), ...Array.from({ length: bottom }, (_, k) => ({ i: n - bottom + k, j: m - bottom + k }))];
}

// The changes within lines that differ even ignoring whitespace: paired by likeness (or from each end, when there are too many to weigh), each pair narrowed to characters, and lines that pair with none shown whole, except a single line left on each side, which can only be one changed into the other and is narrowed too.
function changesUnlike(diffing: Diffing, r: Region, out: Change[]): void {
	const { A, B, budget } = diffing;
	const charsOf = (i: number, j: number) => {
		for (const c of charsDiff(A.text, at(A.offsets, i), at(A.offsets, i + 1), B.text, at(B.offsets, j), at(B.offsets, j + 1))) {
			out.push(c);
		}
	};
	if (r.a0 === r.a1 || r.b0 === r.b1) {
		out.push(new Change(at(A.offsets, r.a0), at(A.offsets, r.a1), at(B.offsets, r.b0), at(B.offsets, r.b1)));
		return;
	}
	if (r.a1 - r.a0 === 1 && r.b1 - r.b0 === 1) {
		charsOf(r.a0, r.b0);
		return;
	}
	const linesA = A.lines.slice(r.a0, r.a1);
	const linesB = B.lines.slice(r.b0, r.b1);
	// Every line against every line, each comparison costing at most the lines' length.
	const weight = (lines: readonly string[]) => lines.reduce((sum, line) => sum + line.length + 1, 0);
	const cost = weight(linesA) * linesB.length + weight(linesB) * linesA.length;
	let local: { readonly i: number; readonly j: number }[];
	if (cost <= budget.pairing) {
		budget.pairing -= cost;
		local = linesPair(linesA.map(lineKey), linesB.map(lineKey));
	} else {
		local = linesPairEnds(linesA, linesB);
	}
	let i = r.a0;
	let j = r.b0;
	for (const p of [...local.map((q) => ({ i: r.a0 + q.i, j: r.b0 + q.j })), { i: r.a1, j: r.b1 }]) {
		if (p.i - i === 1 && p.j - j === 1) {
			charsOf(i, j);
		} else if (i < p.i || j < p.j) {
			out.push(new Change(at(A.offsets, i), at(A.offsets, p.i), at(B.offsets, j), at(B.offsets, p.j)));
		}
		if (p.i < r.a1) {
			charsOf(p.i, p.j);
		}
		i = p.i + 1;
		j = p.j + 1;
	}
}

// The changes within a changed region. Its lines are lined up again ignoring whitespace, so that re-indented lines pair exactly at any size; those are narrowed to what changed on them, and the rest go to pairing by likeness, which a single line on either side goes to directly.
function changesWithin(diffing: Diffing, r: Region, out: Change[]): void {
	const { A, B, intern, junk, budget } = diffing;
	if (r.a1 - r.a0 <= 1 || r.b1 - r.b0 <= 1) {
		changesUnlike(diffing, r, out);
		return;
	}
	// Lines stripped of whitespace are numbered with a leading space, which no stripped line has, so they never share a number with a line as it is. Content-free lines keep their whitespace: a brace's indentation is all that says which block it closes.
	const loose = (side: Side, from: number, to: number) => Int32Array.from(side.lines.slice(from, to), (line) => (lineJunk(line) ? intern(line) : intern(` ${nonBlank(line)}`)));
	const unlike = regionsFind(loose(A, r.a0, r.a1), loose(B, r.b0, r.b1), { a0: 0, a1: r.a1 - r.a0, b0: 0, b1: r.b1 - r.b0 }, budget, junk, "loose");
	let i = r.a0;
	let j = r.b0;
	for (const local of [...unlike, { a0: r.a1 - r.a0, a1: r.a1 - r.a0, b0: r.b1 - r.b0, b1: r.b1 - r.b0 }]) {
		const s = { a0: r.a0 + local.a0, a1: r.a0 + local.a1, b0: r.b0 + local.b0, b1: r.b0 + local.b1 };
		// Lines equal but for whitespace, up to the next lines that differ.
		for (; i < s.a0; i++, j++) {
			if (A.ids[i] !== B.ids[j]) {
				for (const c of charsDiff(A.text, at(A.offsets, i), at(A.offsets, i + 1), B.text, at(B.offsets, j), at(B.offsets, j + 1))) {
					out.push(c);
				}
			}
		}
		if (s.a0 < s.a1 || s.b0 < s.b1) {
			changesUnlike(diffing, s, out);
		}
		i = s.a1;
		j = s.b1;
	}
}

function linesCount(text: string): number {
	let count = 0;
	for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) {
		count++;
	}
	return text === "" || text.endsWith("\n") ? count : count + 1;
}

// Joins two changes that each replace, add or remove whole lines when only content-free lines lie between them, weighing (non-blank characters plus lines) no more than either change, and the joined change spans at most ABSORBED_LINES_MAX lines: braces kept between rewritten statements are where the rewrite happens to match, not code that stayed. Changes narrowed to characters within lines are never joined, so that a rename on lines either side of a brace stays two small edits.
function changesAbsorbed(a: string, b: string, changes: readonly Change[]): Change[] {
	const lineStart = (text: string, pos: number) => pos === 0 || text[pos - 1] === "\n";
	const whole = (c: Change) => lineStart(a, c.fromA) && lineStart(b, c.fromB) && (lineStart(a, c.toA) || c.toA === a.length) && (lineStart(b, c.toB) || c.toB === b.length);
	const weight = (text: string) => nonBlank(text).length + linesCount(text);
	const absorbed: Change[] = [];
	// The last change kept, if whole, with what it holds on each side so far.
	let last: { change: Change; weightA: number; weightB: number; linesA: number; linesB: number } | undefined;
	for (const c of changes) {
		const textA = a.slice(c.fromA, c.toA);
		const textB = b.slice(c.fromB, c.toB);
		const own = { weightA: weight(textA), weightB: weight(textB), linesA: linesCount(textA), linesB: linesCount(textB) };
		if (last !== undefined && c.fromA > last.change.toA && whole(c)) {
			const kept = a.slice(last.change.toA, c.fromA);
			const keptWeight = weight(kept);
			const keptLines = linesCount(kept);
			const fits = last.linesA + keptLines + own.linesA <= ABSORBED_LINES_MAX && last.linesB + keptLines + own.linesB <= ABSORBED_LINES_MAX;
			if (fits && keptWeight <= Math.min(Math.max(last.weightA, last.weightB), Math.max(own.weightA, own.weightB)) && lineJunk(kept)) {
				const change = new Change(last.change.fromA, c.toA, last.change.fromB, c.toB);
				absorbed[absorbed.length - 1] = change;
				last = {
					change,
					weightA: last.weightA + keptWeight + own.weightA,
					weightB: last.weightB + keptWeight + own.weightB,
					linesA: last.linesA + keptLines + own.linesA,
					linesB: last.linesB + keptLines + own.linesB,
				};
				continue;
			}
		}
		absorbed.push(c);
		last = whole(c) ? { change: c, ...own } : undefined;
	}
	return absorbed;
}

// Starts each change that would start at an empty line on both sides at the line break before it instead, which makes the same edit. CodeMirror takes a change starting at an empty line on both sides to start on the next line, which would put its chunk a line out of step and have Revert chunk revert the wrong text; one starting at the end of a line, it reads right. A change straight after the one before it shares that one's chunk, and is left as it is.
function changesAnchored(a: string, b: string, changes: readonly Change[]): Change[] {
	const blankAt = (text: string, pos: number) => pos > 0 && pos < text.length && text[pos] === "\n" && text[pos - 1] === "\n";
	return changes.map((c, k) => {
		const prev = changes[k - 1];
		if (blankAt(a, c.fromA) && blankAt(b, c.fromB) && (prev === undefined || (prev.toA < c.fromA && prev.toB < c.fromB))) {
			return new Change(c.fromA - 1, c.toA, c.fromB - 1, c.toB);
		}
		return c;
	});
}

function sideOf(text: string, intern: (line: string) => number): Side {
	const lines = linesSplit(text);
	const offsets = new Int32Array(lines.length + 1);
	lines.forEach((line, i) => {
		offsets[i + 1] = at(offsets, i) + line.length;
	});
	return { text, lines, offsets, ids: Int32Array.from(lines, intern) };
}

// The lines of `a` and `b`, each with its line break, and the ranges of them that differ, as git's histogram diff finds them (with content-free lines anchoring like any other) and slides them: hunks for merging, which should line up as git's would rather than read well.
export function diffLines(a: string, b: string): { readonly a: readonly string[]; readonly b: readonly string[]; readonly regions: readonly Region[] } {
	const ids = new Map<string, number>();
	const intern = (line: string): number => {
		let id = ids.get(line);
		if (id === undefined) {
			id = ids.size;
			ids.set(line, id);
		}
		return id;
	};
	const A = sideOf(a, intern);
	const B = sideOf(b, intern);
	const budget: Budget = { histogram: HISTOGRAM_WORK_MAX, pairing: PAIRING_WORK_MAX };
	const regions = regionsSlide(
		A.ids,
		B.ids,
		regionsFind(A.ids, B.ids, { a0: 0, a1: A.ids.length, b0: 0, b1: B.ids.length }, budget, () => false, "exact"),
	);
	return { a: A.lines, b: B.lines, regions };
}

// The changes from `a` to `b`: lines lined up by git's histogram algorithm (except that lines without content never anchor it), then again ignoring whitespace within each changed region, then paired up and narrowed to the characters that differ, with rewritten lines that only content-free lines separate joined into one change. CodeMirror's own diff works on characters throughout, and on a large rewrite it gives up and marks everything from the first change to the last.
export function diffByLine(a: string, b: string): readonly Change[] {
	if (a === b) {
		return [];
	}
	// A file added or deleted is one change, whatever its size.
	if (a === "" || b === "") {
		return [new Change(0, a.length, 0, b.length)];
	}
	const ids = new Map<string, number>();
	const junkIds: boolean[] = [];
	const intern = (line: string): number => {
		let id = ids.get(line);
		if (id === undefined) {
			id = ids.size;
			ids.set(line, id);
			junkIds[id] = lineJunk(line);
		}
		return id;
	};
	const junk = (id: number) => junkIds[id] === true;
	const A = sideOf(a, intern);
	const B = sideOf(b, intern);

	// Shared lines at either end need no search. git's histogram does not trim them, so on repetitive text it can line up the rest differently.
	let prefix = 0;
	while (prefix < A.ids.length && prefix < B.ids.length && A.ids[prefix] === B.ids[prefix]) {
		prefix++;
	}
	let suffix = 0;
	while (suffix < A.ids.length - prefix && suffix < B.ids.length - prefix && A.ids[A.ids.length - 1 - suffix] === B.ids[B.ids.length - 1 - suffix]) {
		suffix++;
	}
	const budget: Budget = { histogram: HISTOGRAM_WORK_MAX, pairing: PAIRING_WORK_MAX };
	const regions = regionsSlide(A.ids, B.ids, regionsFind(A.ids, B.ids, { a0: prefix, a1: A.ids.length - suffix, b0: prefix, b1: B.ids.length - suffix }, budget, junk, "exact"));
	const diffing: Diffing = { A, B, intern, junk, budget };
	const changes: Change[] = [];
	for (const r of regions) {
		changesWithin(diffing, r, changes);
	}
	return changesAnchored(a, b, changesAbsorbed(a, b, changes));
}
