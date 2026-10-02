import { type Change, Chunk, presentableDiff } from "@codemirror/merge";
import { ChangeSet, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { TIMEOUT_SCALE } from "../engine/test-support/timeout.ts";
import { diffByLine } from "./diff.ts";

const CONFIG = { override: diffByLine };

// A seeded generator, so a failure reproduces.
function random(seed: number): () => number {
	let s = seed;
	return () => {
		s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
		return s / 0x7fffffff;
	};
}

function pick<T>(rnd: () => number, items: readonly T[]): T {
	const item = items[Math.floor(rnd() * items.length)];
	if (item === undefined) {
		throw new Error("pick from an empty list");
	}
	return item;
}

// Lines as code has them: mostly braces, blanks and a few repeated statements, among unique lines.
const FREQUENT = ["", "", "{", "}", "    {", "    }", "        return;", "foo();", "x = 1;", "// c"];

function lineRandom(rnd: () => number, long: boolean): string {
	if (rnd() < 0.5) {
		return pick(rnd, FREQUENT);
	}
	const n = Math.floor(rnd() * 1e6);
	return long ? `    var u${n} = Make(${n}, "${"z".repeat(Math.floor(rnd() * 20))}");` : `u${n}`;
}

// A random pair: some lines, then a few block insertions, deletions, replacements and re-indents.
function pairRandom(rnd: () => number, long: boolean): { a: string[]; b: string[] } {
	const a = Array.from({ length: long ? 150 + Math.floor(rnd() * 250) : 1 + Math.floor(rnd() * 60) }, () => lineRandom(rnd, long));
	const b = [...a];
	const edits = 1 + Math.floor(rnd() * 5);
	for (let e = 0; e < edits; e++) {
		const at = Math.floor(rnd() * (b.length + 1));
		const block = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => lineRandom(rnd, long));
		const op = rnd();
		if (op < 0.3) {
			b.splice(at, Math.floor(rnd() * 4), ...block);
		} else if (op < 0.6) {
			b.splice(at, 1 + Math.floor(rnd() * 4));
		} else if (op < 0.9) {
			b.splice(at, 0, ...block);
		} else if (at < b.length) {
			b[at] = `    ${b[at]}`;
		}
	}
	// A document always has a line, if an empty one.
	if (b.length === 0) {
		b.push("");
	}
	return { a, b };
}

// The first way the changes fail to be a diff from `a` to `b`, or undefined.
function changesFault(a: string, b: string, changes: readonly Change[]): string | undefined {
	let out = "";
	let posA = 0;
	let posB = 0;
	for (const c of changes) {
		if (c.fromA < posA || c.fromB < posB || c.toA < c.fromA || c.toB < c.fromB) {
			return `unsorted or overlapping at ${JSON.stringify(c)}`;
		}
		if (c.fromA === c.toA && c.fromB === c.toB) {
			return `empty change at ${JSON.stringify(c)}`;
		}
		if (a.slice(posA, c.fromA) !== b.slice(posB, c.fromB)) {
			return `unchanged text differs before ${JSON.stringify(c)}`;
		}
		out += a.slice(posA, c.fromA) + b.slice(c.fromB, c.toB);
		posA = c.toA;
		posB = c.toB;
	}
	out += a.slice(posA);
	return out === b ? undefined : "applying the changes does not give b";
}

// The first way the chunks break what the merge view relies on, or undefined: the text outside the chunks must be the same on both sides, and reverting every chunk the way Revert chunk does must give back `a`.
function chunksFault(a: Text, b: Text, chunks: readonly Chunk[]): string | undefined {
	let posA = 0;
	let posB = 0;
	for (const c of chunks) {
		if (c.fromA < posA || c.fromB < posB) {
			return `overlapping chunk at A${c.fromA} B${c.fromB}`;
		}
		if (a.sliceString(posA, c.fromA) !== b.sliceString(posB, c.fromB)) {
			return `text before the chunk at A${c.fromA} B${c.fromB} differs`;
		}
		posA = c.toA;
		posB = c.toB;
	}
	if (a.sliceString(Math.min(posA, a.length)) !== b.sliceString(Math.min(posB, b.length))) {
		return "text after the last chunk differs";
	}
	let doc = b.toString();
	for (const c of [...chunks].reverse()) {
		let insert = a.sliceString(c.fromA, Math.max(c.fromA, c.toA - 1));
		if (c.fromA !== c.toA && c.toB <= b.length) {
			insert += "\n";
		}
		doc = doc.slice(0, c.fromB) + insert + doc.slice(Math.min(b.length, c.toB));
	}
	return doc === a.toString() ? undefined : "reverting every chunk does not give back a";
}

// The 1-based line numbers the changes touch on each side, as `git diff -U0` counts them.
function linesChanged(a: string, b: string, changes: readonly Change[]): { a: number[]; b: number[] } {
	const lineOf = (text: string, pos: number) => text.slice(0, pos).split("\n").length;
	const touched = (text: string, from: number, to: number) =>
		to > from ? Array.from({ length: lineOf(text, to - 1) - lineOf(text, from) + 1 }, (_, k) => lineOf(text, from) + k) : [];
	return { a: [...new Set(changes.flatMap((c) => touched(a, c.fromA, c.toA)))], b: [...new Set(changes.flatMap((c) => touched(b, c.fromB, c.toB)))] };
}

// The first change that starts at an empty line on both sides apart from the change before it, or undefined. CodeMirror would take such a change to start a line later than it does.
function blankStartFault(a: string, b: string, changes: readonly Change[]): Change | undefined {
	const blankAt = (text: string, pos: number) => pos > 0 && pos < text.length && text[pos] === "\n" && text[pos - 1] === "\n";
	return changes.find((c, k) => {
		const prev = changes[k - 1];
		return blankAt(a, c.fromA) && blankAt(b, c.fromB) && (prev === undefined || (prev.toA < c.fromA && prev.toB < c.fromB));
	});
}

function changedLength(changes: readonly Change[]): { a: number; b: number } {
	return { a: changes.reduce((n, c) => n + c.toA - c.fromA, 0), b: changes.reduce((n, c) => n + c.toB - c.fromB, 0) };
}

describe("diffByLine", () => {
	it("keeps scattered edits in a long file as separate chunks", () => {
		const a = Array.from({ length: 1000 }, (_, i) => `    var item${i} = Make(${i});`);
		const b = a.map((line, i) => (i % 100 === 50 ? line.replace("Make", "Build") : line));
		const chunks = Chunk.build(Text.of(a), Text.of(b), CONFIG);
		expect(chunks).toHaveLength(10);
		for (const c of chunks) {
			expect(Text.of(a).lineAt(c.fromA).number).toBe(Text.of(a).lineAt(c.endA).number);
		}
	});

	it("finds the lines git's histogram diff finds, where its Myers or patience diff would find others", () => {
		// From `git diff --no-index --no-indent-heuristic --diff-algorithm=histogram -U0`.
		const cases = [
			{
				a: ["", "if (x)", "{", "else", "", "{", "{", "}", "f3();", "else", "", "}", "", "return;", "{", "f7();", "f3();"],
				b: ["", "if (x)", "{", "else", "", "{", "{", "}", "f3();", "else", "", "{", "return;", "f7();", "f3();"],
				histogram: { a: [12, 13, 14], b: [13] },
			},
			{
				a: ["else", "else", "else", "return;", "", "f2();", "}", "f6();", "f5();", "}", "}", "b();", "return;", "{", "else", "else", "f7();", "if (x)", "}"],
				b: ["{", "return;", "else", "else", "else", "return;", "", "f2();", "}", "}", "f6();", "if (x)", "}", "b();", "return;", "{", "else", "else", "}"],
				histogram: { a: [8, 9, 17, 18], b: [1, 2, 11, 12] },
			},
			{
				a: ["return;", "return;", "else", "f5();", "f4();", "f2();", "", "if (x)", "", "else", "}", "f0();"],
				b: ["return;", "return;", "else", "f5();", "f4();", "f3();", "if (x)", "if (x)", "if (x)", "f4();", "", "else", "}", "{"],
				histogram: { a: [6, 7, 12], b: [6, 8, 9, 10, 14] },
			},
			{
				a: ["return;", "f0();", "b();", "f8();", "", "f0();", "return;", "}", "}", "{", "{", "return;", "b();", "return;", "return;", "{", "f4();", "a();", "", "return;", "f2();"],
				b: ["return;", "f0();", "b();", "f8();", "b();", "if (x)", "", "f0();", "return;", "}", "{", "if (x)", "b();", "return;", "return;", "", "return;", "f2();"],
				histogram: { a: [9, 11, 12, 16, 17, 18], b: [5, 6, 12] },
			},
			// Here the rarer of two equally long matches has to win.
			{
				a: [
					"f8();",
					"}",
					"else",
					"f3();",
					"b();",
					"return;",
					"f7();",
					"{",
					"{",
					"f0();",
					"f1();",
					"b();",
					"b();",
					"{",
					"b();",
					"f3();",
					"a();",
					"",
					"else",
					"}",
					"return;",
					"return;",
					"return;",
				],
				b: [
					"f8();",
					"}",
					"else",
					"f3();",
					"b();",
					"return;",
					"f7();",
					"{",
					"{",
					"f0();",
					"f1();",
					"b();",
					"b();",
					"{",
					"b();",
					"f3();",
					"a();",
					"",
					"b();",
					"",
					"return;",
					"}",
					"else",
					"f2();",
					"return;",
				],
				histogram: { a: [19, 21, 22], b: [19, 20, 21, 23, 24] },
			},
		];
		for (const { a, b, histogram } of cases) {
			const [as, bs] = [`${a.join("\n")}\n`, `${b.join("\n")}\n`];
			expect(linesChanged(as, bs, diffByLine(as, bs)), JSON.stringify({ a, b })).toEqual(histogram);
		}
	});

	it("gives a diff from a to b, for random pairs", () => {
		const rnd = random(1);
		for (let i = 0; i < 2000; i++) {
			const { a, b } = pairRandom(rnd, rnd() < 0.1);
			const [as, bs] = [a.join("\n"), b.join("\n")];
			expect(changesFault(as, bs, diffByLine(as, bs)), JSON.stringify({ a, b })).toBeUndefined();
			expect(blankStartFault(as, bs, diffByLine(as, bs)), JSON.stringify({ a, b })).toBeUndefined();
			// Without the last line break too.
			expect(changesFault(`${as}\n`, bs, diffByLine(`${as}\n`, bs)), JSON.stringify({ a, b })).toBeUndefined();
		}
	});

	it("gives chunks the merge view can show and revert, built whole and updated while typing", () => {
		const rnd = random(2);
		for (let i = 0; i < 2500; i++) {
			// Some over 2 KB, so the windows an update re-diffs start and end mid-line.
			const { a: al, b: bl } = pairRandom(rnd, i % 5 === 0);
			const a = Text.of(al);
			let b = Text.of(bl);
			let chunks = Chunk.build(a, b, CONFIG);
			expect(chunksFault(a, b, chunks), JSON.stringify({ al, bl })).toBeUndefined();
			for (let k = 0; k < 5; k++) {
				const from = Math.floor(rnd() * (b.length + 1));
				const to = Math.min(b.length, from + Math.floor(rnd() * 3));
				const changes = ChangeSet.of({ from, to, insert: pick(rnd, ["\n", "x", "\n\n", "}\n", ""]) }, b.length);
				b = changes.apply(b);
				chunks = Chunk.updateB(chunks, a, b, changes, CONFIG);
				expect(chunksFault(a, b, chunks), JSON.stringify({ al, bl, edit: k })).toBeUndefined();
			}
		}
	});

	it("keeps a block that starts with a blank line, next to a blank line, in one exact chunk", () => {
		const cases = [
			{ a: ["x", "", "y"], b: ["x", "", "new", "", "y"] },
			{ a: ["", "y"], b: ["", "new", "", "y"] },
			{ a: ["x", "", "", "y"], b: ["x", "", "", "", "y"] },
		];
		for (const { a, b } of [...cases, ...cases.map(({ a, b }) => ({ a: b, b: a }))]) {
			const [ta, tb] = [Text.of(a), Text.of(b)];
			const chunks = Chunk.build(ta, tb, CONFIG);
			expect(chunks, JSON.stringify({ a, b })).toHaveLength(1);
			expect(chunksFault(ta, tb, chunks), JSON.stringify({ a, b })).toBeUndefined();
			const [chunk] = chunks;
			const lines = (doc: Text, from: number, to: number) => (to > from ? doc.sliceString(from, to).split("\n").length - 1 : 0);
			expect(chunk && lines(tb, chunk.fromB, chunk.toB) - lines(ta, chunk.fromA, chunk.toA), JSON.stringify({ a, b })).toBe(b.length - a.length);
		}
	});

	it("reverts a deletion exactly when it could start at either of two blank lines", () => {
		const [a, b] = [Text.of(["x", "x", "", "", "", ""]), Text.of(["", "x", "x", "", ""])];
		expect(chunksFault(a, b, Chunk.build(a, b, CONFIG))).toBeUndefined();
		expect(chunksFault(b, a, Chunk.build(b, a, CONFIG))).toBeUndefined();
	});

	it("narrows a renamed run of lines to what changed on each line, even with a line added among them", () => {
		const a = Array.from({ length: 100 }, (_, i) => `        case ${i}: return Godot.MouseButton.Left;`);
		const b = a.map((line) => line.replace("Godot.MouseButton", "MouseButton"));
		expect(changedLength(diffByLine(a.join("\n"), b.join("\n")))).toEqual({ a: 600, b: 0 });
		const comment = "        // The right button too.";
		b.splice(50, 0, comment);
		expect(changedLength(diffByLine(a.join("\n"), b.join("\n")))).toEqual({ a: 600, b: comment.length + 1 });
	});

	it("pairs changed lines by likeness, not by position", () => {
		const first = "        case 0: return Godot.MouseButton.Left;";
		const last = "        default: return MouseButton.None;";
		const a = [first, ...Array.from({ length: 5 }, (_, i) => `        case ${i + 1}: return Godot.MouseButton.Left;`)];
		const b = [...a.slice(1).map((line) => line.replace("Godot.MouseButton", "MouseButton")), last];
		const [as, bs] = [`${a.join("\n")}\n`, `${b.join("\n")}\n`];
		// The first case goes, the rest lose `Godot.`, and the default arrives whole.
		expect(changedLength(diffByLine(as, bs))).toEqual({ a: first.length + 1 + 5 * 6, b: last.length + 1 });
	});

	it("narrows a changed word to the word", () => {
		const a = "class X\n{\n    int count = 3;\n}\n";
		const b = "class X\n{\n    int amount = 3;\n}\n";
		const changes = presentableDiff(a, b, CONFIG);
		expect(changes).toHaveLength(1);
		const [c] = changes;
		expect(c && [a.slice(c.fromA, c.toA), b.slice(c.fromB, c.toB)]).toEqual(["count", "amount"]);
	});

	it("shows rewritten lines as replaced whole, not as a scatter of letters they happen to share", () => {
		const cases = [
			{
				a: ["{", "    // Turns a slot's mouse input into gestures: clicks, drags, and the held item's placements.", "    var slotId = slot.slotId;", "}"],
				b: [
					"{",
					"    // What's under a viewport position, by the hit test Godot routes a mouse press by.",
					"    var control = viewport.GuiFindControl(position);",
					"    if (control == null)",
					"}",
				],
			},
			// A short replacement for a longer block, sharing only the commonest tokens with it.
			{
				a: [
					"{",
					"    var slotId = slot.slotId;",
					"    var mb = eve as Godot.InputEventMouseButton;",
					"    var mm = eve as Godot.InputEventMouseMotion;",
					"",
					"    if (GetState() == State.Nothing && !slot.determiningPickUpOrDrag)",
					"}",
				],
				b: ["{", "    var control = viewport.GuiFindControl(position);", "    if (control == null)", "}"],
			},
		];
		const lineEnds = (text: string, from: number, to: number) => (from === 0 || text[from - 1] === "\n") && text[to - 1] === "\n";
		for (const { a, b } of cases) {
			const [as, bs] = [`${a.join("\n")}\n`, `${b.join("\n")}\n`];
			const changes = diffByLine(as, bs);
			expect(changes, JSON.stringify(changes)).toHaveLength(1);
			const [c] = changes;
			expect(c && lineEnds(as, c.fromA, c.toA) && lineEnds(bs, c.fromB, c.toB)).toBe(true);
		}
	});

	it("still lines up a region whose only shared lines are very frequent", () => {
		// The shared line is too common for histogram to anchor on, so Myers lines it up; the region is too big to pair by likeness, and CodeMirror's diff would give up on it.
		const common = `    // ${"=".repeat(100)}`;
		const a = ["a", ...Array.from({ length: 300 }, (_, i) => (i % 100 === 50 ? [`x${i}`, common] : [common])).flat(), "b"];
		const b = ["c", ...Array.from({ length: 300 }, () => common), "d"];
		const chunks = Chunk.build(Text.of(a), Text.of(b), CONFIG);
		expect(chunks).toHaveLength(5);
		expect(chunksFault(Text.of(a), Text.of(b), chunks)).toBeUndefined();
	});

	it("lines up a large region of frequent lines, with sides of different lengths, past one step of Myers", () => {
		const a = Array.from({ length: 6000 }, (_, i) => (i % 4 === 3 ? "" : `    x = ${i % 5};`));
		const b = a.map((line, i) => (i % 2 === 0 && line !== "" ? line.replace("x", "y") : line));
		b.splice(3000, 0, "    z = 0;");
		const [as, bs] = [a.join("\n"), b.join("\n")];
		const changes = diffByLine(as, bs);
		expect(changesFault(as, bs, changes)).toBeUndefined();
		const renamed = a.filter((line, i) => i % 2 === 0 && line !== "").length;
		expect(changedLength(changes)).toEqual({ a: renamed, b: renamed + "    z = 0;".length + 1 });
	});

	it("pairs re-indented lines exactly however many there are", () => {
		const a = Array.from({ length: 2000 }, (_, i) => `    call${i}(${i % 7});`);
		const b = ["    if (ready)", "    {", ...a.map((line) => `    ${line}`), "    }"];
		const [as, bs] = [a.join("\n"), b.join("\n")];
		const changes = diffByLine(as, bs);
		expect(changesFault(as, bs, changes)).toBeUndefined();
		const added = "    if (ready)\n    {\n".length + "\n    }".length;
		expect(changedLength(changes)).toEqual({ a: 0, b: 4 * 2000 + added });
	});

	it("shows paired lines that share their letters but not their order as replaced whole", () => {
		const [a, b] = ["{\n    alpha_beta_gamma(delta);\n}\n", "{\n    delta(gamma_beta_alpha);\n}\n"];
		const changes = diffByLine(a, b);
		expect(changes).toHaveLength(1);
		const [c] = changes;
		expect(c && [a.slice(c.fromA, c.toA), b.slice(c.fromB, c.toB)]).toEqual(["    alpha_beta_gamma(delta);\n", "    delta(gamma_beta_alpha);\n"]);
	});

	it("keeps a pure change at the end of a region off a blank line on both sides", () => {
		const rnd = random(3);
		const a = [
			"top",
			...Array.from({ length: 320 }, () => `a${Math.floor(rnd() * 1e9)}`),
			"        return;",
			"",
			...Array.from({ length: 69 }, () => "        return;"),
			"q",
			"",
			"end",
		];
		const b = ["top", ...Array.from({ length: 623 }, () => `b${Math.floor(rnd() * 1e9)}`), "        return;", "", "end"];
		const [ta, tb] = [Text.of(a), Text.of(b)];
		expect(chunksFault(ta, tb, Chunk.build(ta, tb, CONFIG))).toBeUndefined();
		expect(chunksFault(tb, ta, Chunk.build(tb, ta, CONFIG))).toBeUndefined();
	});

	it("stays quick on a large region of long, unrelated lines", { timeout: 2000 * TIMEOUT_SCALE }, () => {
		const rnd = random(4);
		const line = (tag: string) =>
			`- ${tag}: ${Array.from({ length: 40 }, () => Math.floor(rnd() * 1e6).toString(36)).join(" ")} ([GH-${Math.floor(rnd() * 1e5)}](https://example.com/pull/))`;
		const a = Array.from({ length: 1000 }, () => line("Fixed"));
		const b = Array.from({ length: 900 }, () => line("Added"));
		const [ta, tb] = [Text.of(["# Changes", ...a, "end"]), Text.of(["# Changes", ...b, "end"])];
		expect(chunksFault(ta, tb, Chunk.build(ta, tb, CONFIG))).toBeUndefined();
	});

	it("keeps every chunk in step on a long, heavily edited file, lined up by Myers in steps", () => {
		// Long enough to spend the histogram search's budget, and edited enough that Myers runs in several steps.
		const rnd = random(2002);
		const frequent = ["", "", "", "{", "}", "    {", "    }", "        {", "        }", "        return;", "        break;", "    // ---"];
		const n = 5000 + Math.floor(rnd() * 20000);
		const line = () => (rnd() < 0.55 ? pick(rnd, frequent) : `        call${Math.floor(rnd() * 100000)}(x);`);
		const a = Array.from({ length: n }, line);
		const b = [...a];
		const edits = Math.floor(n / (5 + rnd() * 40));
		for (let e = 0; e < edits; e++) {
			const at = Math.floor(rnd() * (b.length + 1));
			const op = rnd();
			const block = Array.from({ length: 1 + Math.floor(rnd() * 3) }, line);
			if (op < 0.35) {
				b.splice(at, 0, ...block);
			} else if (op < 0.6) {
				b.splice(at, 1 + Math.floor(rnd() * 3));
			} else if (op < 0.9) {
				b.splice(at, Math.floor(rnd() * 3), ...block);
			} else if (at < b.length) {
				b[at] = `    ${b[at]}`;
			}
		}
		const [ta, tb] = [Text.of(a), Text.of(b)];
		expect(chunksFault(ta, tb, Chunk.build(ta, tb, CONFIG))).toBeUndefined();
		expect(chunksFault(tb, ta, Chunk.build(tb, ta, CONFIG))).toBeUndefined();
	});

	it("narrows a renamed block too big to pair by likeness, with a line added in it", () => {
		const a = Array.from({ length: 1500 }, (_, i) => `        result${i} = Godot.Input.IsKeyPressed(${i});`);
		const b = a.map((line) => line.replace("Godot.Input", "Input"));
		const comment = "        // Keys, not buttons.";
		b.splice(700, 0, comment);
		expect(changedLength(diffByLine(a.join("\n"), b.join("\n")))).toEqual({ a: 6 * 1500, b: comment.length + 1 });
	});

	it("survives a change to every one of a great many lines", { timeout: 10000 * TIMEOUT_SCALE }, () => {
		const a = Array.from({ length: 150000 }, (_, i) => `${i},alpha,${i % 10}`);
		const b = a.map((line) => line.replace("alpha", "beta"));
		const [as, bs] = [a.join("\n"), b.join("\n")];
		expect(changesFault(as, bs, diffByLine(as, bs))).toBeUndefined();
	});

	it("stays quick and exact on a long file with edits on every third line", { timeout: 5000 * TIMEOUT_SCALE }, () => {
		// Past the histogram search's budget, so the end of it is lined up by its fallback; the line added there throws out any pairing by position.
		const a = Array.from({ length: 30000 }, (_, i) => `    var item${i} = Make(${i});`);
		const b = a.map((line, i) => (i % 3 === 0 ? line.replace("Make", "Build") : line));
		const added = "    // Built, not made.";
		b.splice(b.length - 5, 0, added);
		const [as, bs] = [a.join("\n"), b.join("\n")];
		const changes = diffByLine(as, bs);
		expect(changesFault(as, bs, changes)).toBeUndefined();
		expect(changedLength(changes)).toEqual({ a: 4 * 10000, b: 5 * 10000 + added.length + 1 });
	});
});
