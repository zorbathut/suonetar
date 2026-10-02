import { diffLines, linesSplit } from "./diff.ts";

// Conflict-marker blocks in merge output: `merge` style (ours/theirs) and `diff3`/`zdiff3` style (with the base section).
export type ConflictBlock = {
	// Character range of the whole block, marker lines included, through the newline ending the closing marker.
	readonly from: number;
	readonly to: number;
	readonly ours: string;
	readonly base: string | undefined;
	readonly theirs: string;
};

export type BlockChoice = "ours" | "theirs" | "both";

const OPEN = /^(<{7,})( |$)/;

// The other markers of a block have exactly the opening marker's length, so a line of `=` in the content (a Markdown underline) is not taken for the separator.
function markers(size: number): { base: RegExp; sep: RegExp; close: RegExp } {
	return { base: new RegExp(`^\\|{${size}}( |$)`), sep: new RegExp(`^={${size}}$`), close: new RegExp(`^>{${size}}( |$)`) };
}

type Line = { readonly text: string; readonly from: number; readonly to: number };

function lines(text: string): Line[] {
	const result: Line[] = [];
	let from = 0;
	while (from < text.length) {
		const nl = text.indexOf("\n", from);
		const end = nl === -1 ? text.length : nl;
		result.push({ text: text.slice(from, end), from, to: nl === -1 ? end : nl + 1 });
		from = nl === -1 ? text.length : nl + 1;
	}
	return result;
}

function joined(section: readonly Line[]): string {
	return section.map((l) => (l.to > l.from + l.text.length ? `${l.text}\n` : l.text)).join("");
}

// Complete blocks only: an opening marker without its separator and closing marker is ordinary text.
export function conflictBlocks(text: string): ConflictBlock[] {
	const all = lines(text);
	const blocks: ConflictBlock[] = [];
	for (let i = 0; i < all.length; i++) {
		const open = all[i];
		const size = open === undefined ? undefined : OPEN.exec(open.text)?.[1]?.length;
		if (open === undefined || size === undefined) {
			continue;
		}
		const marker = markers(size);
		let base: number | undefined;
		let sep: number | undefined;
		let close: number | undefined;
		for (let j = i + 1; j < all.length; j++) {
			const line = all[j]?.text ?? "";
			if (OPEN.test(line)) {
				break;
			}
			if (sep === undefined && base === undefined && marker.base.test(line)) {
				base = j;
			} else if (sep === undefined && marker.sep.test(line)) {
				sep = j;
			} else if (sep !== undefined && marker.close.test(line)) {
				close = j;
				break;
			}
		}
		const last = close === undefined ? undefined : all[close];
		if (sep === undefined || close === undefined || last === undefined) {
			continue;
		}
		blocks.push({
			from: open.from,
			to: last.to,
			ours: joined(all.slice(i + 1, base ?? sep)),
			base: base === undefined ? undefined : joined(all.slice(base + 1, sep)),
			theirs: joined(all.slice(sep + 1, close)),
		});
		i = close;
	}
	return blocks;
}

// The text replacing a block when one side is chosen.
export function conflictChoose(block: ConflictBlock, choice: BlockChoice): string {
	switch (choice) {
		case "ours":
			return block.ours;
		case "theirs":
			return block.theirs;
		case "both":
			return block.ours + block.theirs;
		default: {
			const never: never = choice;
			throw new Error(`unknown choice ${String(never)}`);
		}
	}
}

// Replaces raw object ids (merge-tree labels its sides with tree ids) by names that mean something to the user.
export function conflictRelabel(text: string, labels: ReadonlyMap<string, string>): string {
	let result = text;
	for (const [oid, label] of labels) {
		result = result.replaceAll(oid, label);
	}
	return result;
}

// The same, for file content: only marker lines are touched, never the file's own text.
export function conflictRelabelMarkers(text: string, labels: ReadonlyMap<string, string>): string {
	return text.replace(/^(<{7,}|\|{7,}|>{7,}) .*$/gm, (line) => conflictRelabel(line, labels));
}

// One side's change to a range of base lines [a0, a1): the lines it puts there.
type Hunk = { readonly a0: number; readonly a1: number; readonly lines: readonly string[] };

function hunksOf(base: string, side: string): Hunk[] {
	const { b, regions } = diffLines(base, side);
	const hunks: Hunk[] = [];
	for (const r of regions) {
		const last = hunks.at(-1);
		const lines = b.slice(r.b0, r.b1);
		// Regions the search found next to each other are one change.
		if (last !== undefined && last.a1 === r.a0) {
			hunks[hunks.length - 1] = { a0: last.a0, a1: r.a1, lines: [...last.lines, ...lines] };
		} else {
			hunks.push({ a0: r.a0, a1: r.a1, lines });
		}
	}
	return hunks;
}

function hunksEqual(x: Hunk, y: Hunk): boolean {
	return x.a0 === y.a0 && x.a1 === y.a1 && x.lines.length === y.lines.length && x.lines.every((line, i) => line === y.lines[i]);
}

// Whether two changes cannot both be made: they replace some of the same lines, insert at the same place (which first is anyone's guess), or one inserts inside lines the other replaces.
function hunksClash(x: Hunk, y: Hunk): boolean {
	const inside = (insert: Hunk, range: Hunk) => insert.a0 === insert.a1 && range.a0 < insert.a0 && insert.a0 < range.a1;
	const overlap = Math.max(x.a0, y.a0) < Math.min(x.a1, y.a1);
	const sameInsert = x.a0 === x.a1 && y.a0 === y.a1 && x.a0 === y.a0;
	return overlap || sameInsert || inside(x, y) || inside(y, x);
}

// Both sides' changes to `base` made together, when none of them clash: git calls changes that merely touch (a line reworded, and a line added right after it) a conflict, though there is only one way to make both. Undefined when some do clash.
export function conflictsCombine(base: string, ours: string, theirs: string): string | undefined {
	const mine = hunksOf(base, ours);
	const others = hunksOf(base, theirs).filter((y) => !mine.some((x) => hunksEqual(x, y)));
	if (mine.some((x) => others.some((y) => hunksClash(x, y)))) {
		return undefined;
	}
	// In base order; an insertion goes before a replacement starting at the same line.
	const hunks = [...mine, ...others].sort((x, y) => x.a0 - y.a0 || x.a1 - x.a0 - (y.a1 - y.a0));
	const lines = linesSplit(base);
	const out: string[] = [];
	let at = 0;
	for (const h of hunks) {
		out.push(...lines.slice(at, h.a0), ...h.lines);
		at = h.a1;
	}
	out.push(...lines.slice(at));
	return out.join("");
}
