import { describe, expect, it } from "vitest";
import { conflictBlocks, conflictChoose, conflictRelabel, conflictRelabelMarkers, conflictsCombine } from "./conflicts.ts";

const MERGE = "a\n<<<<<<< ours\nB1\n=======\nB2\n>>>>>>> theirs\nc\n";
const DIFF3 = "a\n<<<<<<< ours\nB1\n||||||| base\nb\n=======\nB2\nB3\n>>>>>>> theirs\nc\n";

function applyChoice(text: string, index: number, choice: "ours" | "theirs" | "both"): string {
	const block = conflictBlocks(text)[index];
	if (block === undefined) {
		throw new Error("no such block");
	}
	return text.slice(0, block.from) + conflictChoose(block, choice) + text.slice(block.to);
}

describe("conflictBlocks", () => {
	it("parses merge-style blocks", () => {
		const [block, ...rest] = conflictBlocks(MERGE);
		expect(rest).toEqual([]);
		expect(block).toMatchObject({ ours: "B1\n", base: undefined, theirs: "B2\n" });
		expect(MERGE.slice(block?.from, block?.to)).toBe("<<<<<<< ours\nB1\n=======\nB2\n>>>>>>> theirs\n");
	});

	it("parses diff3 and zdiff3 blocks with their base", () => {
		expect(conflictBlocks(DIFF3)[0]).toMatchObject({ ours: "B1\n", base: "b\n", theirs: "B2\nB3\n" });
	});

	it("finds several blocks, and empty sides", () => {
		const text = `${MERGE}<<<<<<< x\n=======\nonly theirs\n>>>>>>> y\n`;
		const blocks = conflictBlocks(text);
		expect(blocks).toHaveLength(2);
		expect(blocks[1]).toMatchObject({ ours: "", theirs: "only theirs\n" });
	});

	it("handles a block at the end without a trailing newline", () => {
		const text = "<<<<<<< a\nx\n=======\ny\n>>>>>>> b";
		const block = conflictBlocks(text)[0];
		expect(block?.to).toBe(text.length);
		expect(block?.theirs).toBe("y\n");
	});

	it("ignores incomplete blocks and stray separators", () => {
		expect(conflictBlocks("<<<<<<< a\nx\n=======\ny\n")).toEqual([]);
		expect(conflictBlocks("title\n=======\ntext\n")).toEqual([]);
		expect(conflictBlocks("<<<<<<<< longer markers (conflict-marker-size) count too\n========\n>>>>>>>>\n")).toHaveLength(1);
	});

	it("does not take a Markdown underline inside a block for the separator", () => {
		const text = "<<<<<<< below\nTitle\n==========\nx\n=======\ny\n>>>>>>> this commit\n";
		expect(conflictBlocks(text)[0]).toMatchObject({ ours: "Title\n==========\nx\n", theirs: "y\n" });
		expect(applyChoice(text, 0, "theirs")).toBe("y\n");
	});

	it("requires the markers of one block to have the same length", () => {
		expect(conflictBlocks("<<<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n")).toEqual([]);
	});
});

describe("conflictChoose", () => {
	it.each([
		["ours", "a\nB1\nc\n"],
		["theirs", "a\nB2\nB3\nc\n"],
		["both", "a\nB1\nB2\nB3\nc\n"],
	] as const)("keeps %s", (choice, expected) => {
		const result = applyChoice(DIFF3, 0, choice);
		expect(result).toBe(expected);
		expect(conflictBlocks(result)).toEqual([]);
	});
});

describe("conflictRelabel", () => {
	it("replaces object ids wherever they appear", () => {
		const ours = "787558af46a74e2a52f18d49487b61593283e9ba";
		const theirs = "3928b38de073dc6d449467e939ab576e3c3be437";
		const text = `<<<<<<< ${ours}\nx\n=======\ny\n>>>>>>> ${theirs}:path\n`;
		const labels = new Map([
			[ours, "below"],
			[theirs, "this commit"],
		]);
		const relabelled = conflictRelabel(text, labels);
		expect(relabelled).not.toContain(ours);
		expect(relabelled).not.toContain(theirs);
		expect(conflictBlocks(relabelled)).toHaveLength(1);
	});

	it("touches only marker lines in file content", () => {
		const oid = "787558af46a74e2a52f18d49487b61593283e9ba";
		const text = `<<<<<<< ${oid}\nsee ${oid}\n=======\ny\n>>>>>>> other\n`;
		expect(conflictRelabelMarkers(text, new Map([[oid, "below"]]))).toBe(`<<<<<<< below\nsee ${oid}\n=======\ny\n>>>>>>> other\n`);
	});
});

describe("conflictsCombine", () => {
	const base = "## Fixed\n* one\n* two\n\n## Older\n";

	it("makes a reworded line and a line added right after it together, as git will not", () => {
		const ours = "## Fixed\n* one\n* two, reworded\n\n## Older\n";
		const theirs = "## Fixed\n* one\n* two\n* three\n\n## Older\n";
		expect(conflictsCombine(base, ours, theirs)).toBe("## Fixed\n* one\n* two, reworded\n* three\n\n## Older\n");
		expect(conflictsCombine(base, theirs, ours)).toBe("## Fixed\n* one\n* two, reworded\n* three\n\n## Older\n");
	});

	it("puts a line added just before a reworded line before it", () => {
		const ours = "## Fixed\n* one\n* two, reworded\n\n## Older\n";
		const theirs = "## Fixed\n* one\n* new\n* two\n\n## Older\n";
		expect(conflictsCombine(base, ours, theirs)).toBe("## Fixed\n* one\n* new\n* two, reworded\n\n## Older\n");
	});

	it("refuses changes to the same line, and two additions in the same place", () => {
		expect(conflictsCombine(base, "## Fixed\n* one\n* two A\n\n## Older\n", "## Fixed\n* one\n* two B\n\n## Older\n")).toBeUndefined();
		expect(conflictsCombine(base, "## Fixed\n* one\n* two\n* A\n\n## Older\n", "## Fixed\n* one\n* two\n* B\n\n## Older\n")).toBeUndefined();
	});

	it("refuses an addition inside lines the other side replaces", () => {
		const ours = "## Fixed\n* ONE AND TWO\n\n## Older\n";
		const theirs = "## Fixed\n* one\n* between\n* two\n\n## Older\n";
		expect(conflictsCombine(base, ours, theirs)).toBeUndefined();
	});

	it("makes a change both sides made once", () => {
		const both = "## Fixed\n* one\n* two, reworded\n\n## Older\n";
		expect(conflictsCombine(base, both, "## Fixed\n* zero\n* one\n* two, reworded\n\n## Older\n")).toBe("## Fixed\n* zero\n* one\n* two, reworded\n\n## Older\n");
	});

	it("keeps line endings, and a last line without one", () => {
		const crlf = "a\r\nb\r\nc";
		expect(conflictsCombine(crlf, "A\r\nb\r\nc", "a\r\nb\r\nC")).toBe("A\r\nb\r\nC");
	});

	it("lines repeated in the file still line up with the change around them", () => {
		const repeated = "x\n}\n}\ny\n}\n";
		expect(conflictsCombine(repeated, "x2\n}\n}\ny\n}\n", "x\n}\n}\ny2\n}\n")).toBe("x2\n}\n}\ny2\n}\n");
	});
});
