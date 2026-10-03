import { EditorState, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { panesRevert } from "./panes-regions.ts";
import { rightChunksField } from "./panes-three.ts";

describe("rightChunksField", () => {
	const lines = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", ""];
	const parent = Text.of(lines);
	const commit = Text.of(lines.map((l) => (l === "two" ? "TWO" : l)));

	it("keeps the edit's chunks current as the right pane is typed in, so Revert my edit finds and undoes each", () => {
		const field = rightChunksField(commit, parent);
		let state = EditorState.create({ doc: commit.toString(), extensions: [field] });
		expect(state.field(field).mine).toEqual([]);
		expect(state.field(field).whole).toHaveLength(1);
		state = state.update({ changes: { from: state.doc.line(4).from, to: state.doc.line(4).to, insert: "mine" } }).state;
		state = state.update({ changes: { from: state.doc.line(9).from, insert: "added\n" } }).state;
		const mine = state.field(field).mine;
		expect(mine).toHaveLength(2);
		// Last first, as clicks would leave the earlier positions valid either way.
		for (const chunk of [...mine].reverse()) {
			state = state.update({ changes: panesRevert(chunk, commit, state.doc) }).state;
		}
		expect(state.doc.toString()).toBe(commit.toString());
		expect(state.field(field).mine).toEqual([]);
	});
});
