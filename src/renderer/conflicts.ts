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
