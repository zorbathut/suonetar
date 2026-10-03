import { EditorState, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { panesKindFor, rightChunksField } from "./panes.ts";
import { panesRevert } from "./panes-regions.ts";

describe("panesKindFor", () => {
	it("gives a commit's files the layout's panes, and three only where the commit's own version is known", () => {
		expect(panesKindFor("inline", "commit", false)).toBeUndefined();
		expect(panesKindFor("two", "commit", false)).toBe("two");
		expect(panesKindFor("two", "commit", true)).toBe("two");
		expect(panesKindFor("three", "commit", false)).toBe("three");
		expect(panesKindFor("three", "commit", true)).toBeUndefined();
		for (const view of ["draft", "worktree"] as const) {
			expect(panesKindFor("two", view, false)).toBeUndefined();
			expect(panesKindFor("three", view, false)).toBeUndefined();
		}
	});
});

describe("rightChunksField", () => {
	const lines = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", ""];
	const parent = Text.of(lines);
	const commit = Text.of(lines.map((l) => (l === "two" ? "TWO" : l)));

	it("keeps the edit's chunks current as the right pane is typed in, so Revert my edit finds and undoes each", () => {
		const field = rightChunksField(commit, parent);
		let state = EditorState.create({ doc: commit.toString(), extensions: [field] });
		expect(state.field(field).middle).toEqual([]);
		expect(state.field(field).whole).toHaveLength(1);
		state = state.update({ changes: { from: state.doc.line(4).from, to: state.doc.line(4).to, insert: "mine" } }).state;
		state = state.update({ changes: { from: state.doc.line(9).from, insert: "added\n" } }).state;
		const mine = state.field(field).middle;
		expect(mine).toHaveLength(2);
		// Last first, as clicks would leave the earlier positions valid either way.
		for (const chunk of [...mine].reverse()) {
			state = state.update({ changes: panesRevert(chunk, commit, state.doc) }).state;
		}
		expect(state.doc.toString()).toBe(commit.toString());
		expect(state.field(field).middle).toEqual([]);
	});

	it("in two panes, keeps only the chunks against the left pane, so Revert puts each back as the left pane has it", () => {
		const field = rightChunksField(parent, undefined);
		let state = EditorState.create({ doc: commit.toString(), extensions: [field] });
		expect(state.field(field).whole).toBeUndefined();
		expect(state.field(field).middle).toHaveLength(1);
		state = state.update({ changes: { from: state.doc.line(6).from, insert: "added\n" } }).state;
		expect(state.field(field).whole).toBeUndefined();
		const chunks = state.field(field).middle;
		expect(chunks).toHaveLength(2);
		for (const chunk of [...chunks].reverse()) {
			state = state.update({ changes: panesRevert(chunk, parent, state.doc) }).state;
		}
		expect(state.doc.toString()).toBe(parent.toString());
		expect(state.field(field).middle).toEqual([]);
	});
});
