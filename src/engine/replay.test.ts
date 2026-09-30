import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Oid } from "./git.ts";
import { CatFile, commitRead } from "./objects.ts";
import { type Edit, replayCommit, replayTrees } from "./replay.ts";
import { type Stack, stackRead } from "./stack.ts";
import { type Fixture, lineSet, lines, repoFixture } from "./test-support/repo.ts";
import { blobWrite, type TreeChange, treeWithChanges } from "./write.ts";

describe("replay", () => {
	let fx: Fixture;
	let cat: CatFile;

	beforeEach(async () => {
		fx = await repoFixture();
		cat = new CatFile(fx.repo);
		fx.commit("base", { "a.txt": lines("a"), "b.txt": lines("b") });
		fx.git("switch", "-q", "-c", "feature");
	});

	afterEach(() => {
		cat.close();
		fx.cleanup();
	});

	async function fileEdit(commit: Oid, path: string, content: string | null): Promise<Oid> {
		const info = await commitRead(cat, commit);
		if (content === null) {
			return treeWithChanges(fx.repo, info.tree, [{ path, delete: "file" }]);
		}
		return treeWithChanges(fx.repo, info.tree, [{ path, mode: "100644", oid: await blobWrite(fx.repo, Buffer.from(content)) }]);
	}

	async function replay(stack: Stack, edits: Map<Oid, Edit>, resolutions = new Map<string, readonly TreeChange[]>()) {
		const baseTree = (await commitRead(cat, stack.baseOid)).tree;
		return replayTrees(fx.repo, stack.commits, baseTree, edits, resolutions);
	}

	async function show(tree: Oid, path: string): Promise<string> {
		return fx.git("cat-file", "blob", `${tree}:${path}`);
	}

	test("an edit to the bottom commit restacks the commits above it", async () => {
		const c1 = fx.commit("c1", { "a.txt": lineSet(lines("a"), 2, "c1") });
		fx.commit("c2", { "a.txt": lineSet(lineSet(lines("a"), 2, "c1"), 8, "c2") });
		const stack = await stackRead(fx.repo, cat);
		const edited = await fileEdit(c1, "a.txt", lineSet(lineSet(lines("a"), 2, "c1"), 5, "edit"));
		const result = await replay(stack, new Map([[c1, { tree: edited, message: undefined }]]));
		expect(result.kind).toBe("clean");
		if (result.kind !== "clean") {
			return;
		}
		expect(result.steps.map((s) => s.rewrite)).toEqual([true, true]);
		const tip = await show(result.steps[1]?.tree as Oid, "a.txt");
		expect(tip).toContain("c1");
		expect(tip).toContain("edit");
		expect(tip).toContain("c2");
	});

	test("commits below the first edit are kept unchanged", async () => {
		fx.commit("c1", { "a.txt": lineSet(lines("a"), 2, "c1") });
		const c2 = fx.commit("c2", { "b.txt": lineSet(lines("b"), 2, "c2") });
		const stack = await stackRead(fx.repo, cat);
		const result = await replay(stack, new Map([[c2, { tree: await fileEdit(c2, "b.txt", "new\n"), message: undefined }]]));
		expect(result.kind === "clean" && result.steps.map((s) => s.rewrite)).toEqual([false, true]);
	});

	test("an edit equal to the original commit is not a rewrite", async () => {
		const c1 = fx.commit("c1", { "a.txt": "x\n" });
		fx.commit("c2", { "b.txt": "y\n" });
		const stack = await stackRead(fx.repo, cat);
		const same = (await commitRead(cat, c1)).tree;
		const result = await replay(stack, new Map([[c1, { tree: same, message: undefined }]]));
		expect(result.kind === "clean" && result.steps.every((s) => !s.rewrite)).toBe(true);
	});

	test("a message-only edit rewrites the chain with unchanged trees", async () => {
		const c1 = fx.commit("c1", { "a.txt": "x\n" });
		fx.commit("c2", { "b.txt": "y\n" });
		const stack = await stackRead(fx.repo, cat);
		const result = await replay(stack, new Map([[c1, { tree: undefined, message: Buffer.from("reworded\n") }]]));
		if (result.kind !== "clean") {
			throw new Error("expected clean");
		}
		expect(result.steps.map((s) => s.rewrite)).toEqual([true, true]);
		expect(result.steps.map((s) => s.tree)).toEqual(stack.commits.map((c) => c.tree));
		expect(result.steps[0]?.message.toString()).toBe("reworded\n");
	});

	test("a content conflict stops at the conflicting commit, and a resolution for that conflict lets it continue", async () => {
		const c1 = fx.commit("c1", { "a.txt": lineSet(lines("a"), 5, "c1") });
		const c2 = fx.commit("c2", { "a.txt": lineSet(lines("a"), 5, "c2") });
		fx.commit("c3", { "b.txt": "c3\n" });
		const stack = await stackRead(fx.repo, cat);
		const edits = new Map([[c1, { tree: await fileEdit(c1, "a.txt", lineSet(lines("a"), 5, "edited")), message: undefined }]]);
		const conflicted = await replay(stack, edits);
		if (conflicted.kind !== "conflict") {
			throw new Error("expected conflict");
		}
		expect(conflicted.commit.oid).toBe(c2);
		expect(conflicted.conflicts).toHaveLength(1);
		const [conflict] = conflicted.conflicts as [(typeof conflicted.conflicts)[0]];
		expect(conflict.kind).toBe("content");
		expect(conflict.resolved).toBe(false);
		expect(conflict.paths).toEqual(["a.txt"]);
		expect(conflict.stages["a.txt"]?.map((s) => s.stage)).toEqual([1, 2, 3]);
		expect(await show(conflicted.markerTree, "a.txt")).toContain("<<<<<<<");

		const resolved = await blobWrite(fx.repo, Buffer.from(lineSet(lines("a"), 5, "resolved")));
		const resolutions = new Map([[conflict.key, [{ path: "a.txt", mode: "100644", oid: resolved }]]]);
		const resumed = await replay(stack, edits, resolutions);
		if (resumed.kind !== "clean") {
			throw new Error("expected clean after resolution");
		}
		expect(await show(resumed.steps[2]?.tree as Oid, "a.txt")).toContain("resolved");
		expect(await show(resumed.steps[2]?.tree as Oid, "b.txt")).toBe("c3");
	});

	test("a resolution survives unrelated changes but not a change to the conflicting file", async () => {
		const c1 = fx.commit("c1", { "a.txt": lineSet(lines("a"), 5, "c1") });
		const c2 = fx.commit("c2", { "a.txt": lineSet(lines("a"), 5, "c2") });
		const stack = await stackRead(fx.repo, cat);
		const edits = new Map<Oid, Edit>([[c1, { tree: await fileEdit(c1, "a.txt", lineSet(lines("a"), 5, "edited")), message: undefined }]]);
		const first = await replay(stack, edits);
		if (first.kind !== "conflict") {
			throw new Error("expected conflict");
		}
		const resolutions = new Map([[first.conflicts[0]?.key as string, [{ path: "a.txt", mode: "100644", oid: await blobWrite(fx.repo, Buffer.from("resolved\n")) }]]]);
		edits.set(c2, { tree: await fileEdit(c2, "b.txt", "unrelated draft on c2\n"), message: undefined });
		expect((await replay(stack, edits, resolutions)).kind).toBe("clean");
		edits.set(c2, { tree: await fileEdit(c2, "a.txt", lineSet(lines("a"), 5, "c2 edited again")), message: undefined });
		expect((await replay(stack, edits, resolutions)).kind).toBe("conflict");
	});

	test("modify/delete and binary conflicts are structural", async () => {
		fx.commit("add bin", { "bin.dat": "\0one" });
		const c1 = fx.commit("c1", { "b.txt": lineSet(lines("b"), 1, "c1"), "bin.dat": "\0two" });
		fx.commit("c2", { "b.txt": null, "bin.dat": "\0three" });
		const stack = await stackRead(fx.repo, cat);
		let tree = await fileEdit(c1, "b.txt", lineSet(lines("b"), 1, "edited"));
		tree = await treeWithChanges(fx.repo, tree, [{ path: "bin.dat", mode: "100644", oid: await blobWrite(fx.repo, Buffer.from("\0edited")) }]);
		const result = await replay(stack, new Map([[c1, { tree, message: undefined }]]));
		if (result.kind !== "conflict") {
			throw new Error("expected conflict");
		}
		const byPath = Object.fromEntries(result.conflicts.flatMap((c) => c.paths.map((p) => [p, c])));
		expect(byPath["b.txt"]?.kind).toBe("structural");
		expect(byPath["b.txt"]?.type).toBe("CONFLICT (modify/delete)");
		expect(byPath["bin.dat"]?.kind).toBe("structural");
	});

	test("a commit whose change is already below becomes empty and is kept", async () => {
		const c1 = fx.commit("c1", { "a.txt": "one\n" });
		fx.commit("c2", { "b.txt": "two\n" });
		const stack = await stackRead(fx.repo, cat);
		const tree = await treeWithChanges(fx.repo, (await commitRead(cat, c1)).tree, [{ path: "b.txt", mode: "100644", oid: await blobWrite(fx.repo, Buffer.from("two\n")) }]);
		const result = await replay(stack, new Map([[c1, { tree, message: undefined }]]));
		expect(result.kind === "clean" && result.steps.map((s) => s.empty)).toEqual([false, true]);
	});

	test("edits on two commits touching the same file merge when they touch different lines", async () => {
		const c1 = fx.commit("c1", { "a.txt": lineSet(lines("a"), 2, "c1") });
		const c2 = fx.commit("c2", { "a.txt": lineSet(lineSet(lines("a"), 2, "c1"), 8, "c2") });
		const stack = await stackRead(fx.repo, cat);
		const edits = new Map([
			[c1, { tree: await fileEdit(c1, "a.txt", lineSet(lineSet(lines("a"), 2, "c1"), 4, "edit1")), message: undefined }],
			[c2, { tree: await fileEdit(c2, "a.txt", lineSet(lineSet(lineSet(lines("a"), 2, "c1"), 8, "c2"), 10, "edit2")), message: undefined }],
		]);
		const result = await replay(stack, edits);
		if (result.kind !== "clean") {
			throw new Error("expected clean");
		}
		const tip = await show(result.steps[1]?.tree as Oid, "a.txt");
		for (const expected of ["c1", "edit1", "c2", "edit2"]) {
			expect(tip).toContain(expected);
		}
		expect(await show(result.steps[0]?.tree as Oid, "a.txt")).not.toContain("edit2");
	});

	test("the replayed commit's own .gitattributes merge driver applies", async () => {
		fx.commit("attrs", { ".gitattributes": "list.txt merge=union\n", "list.txt": "one\n" });
		const c1 = fx.commit("c1", { "list.txt": "one\nc1\n" });
		const c2 = fx.commit("c2", { "list.txt": "one\nc1\nc2\n" });
		// Without the checked-out copy, only --attr-source can supply the merge driver.
		fx.git("rm", "-q", "--cached", ".gitattributes");
		rmSync(join(fx.dir, ".gitattributes"));
		const stack = await stackRead(fx.repo, cat);
		const edited = await fileEdit(c1, "list.txt", "one\nedited\n");
		const result = await replay(stack, new Map([[c1, { tree: edited, message: undefined }]]));
		expect(result.kind).toBe("clean");
		const plain = await fx.repo.run(["merge-tree", "--write-tree", `--merge-base=${fx.git("rev-parse", `${c1}^{tree}`)}`, edited, fx.git("rev-parse", `${c2}^{tree}`)], {
			cwd: fx.dir,
		});
		expect(plain.code).toBe(1);
	});

	test("replaying above a merge keeps the merge and everything below it", async () => {
		fx.commit("early", { "early.txt": "e\n" });
		fx.git("switch", "-q", "main");
		fx.commit("main advances", { "m.txt": "m\n" });
		fx.git("switch", "-q", "feature");
		fx.git("merge", "-q", "--no-edit", "main");
		const merge = fx.git("rev-parse", "HEAD");
		const c1 = fx.commit("after", { "a.txt": "after\n" });
		fx.commit("after2", { "b.txt": "after2\n" });
		const stack = await stackRead(fx.repo, cat);
		const result = await replay(stack, new Map([[c1, { tree: await fileEdit(c1, "a.txt", "edited\n"), message: undefined }]]));
		if (result.kind !== "clean") {
			throw new Error("expected clean");
		}
		const { tip } = await replayCommit(fx.repo, stack.baseOid, result.steps, false);
		expect(fx.git("rev-parse", `${tip}~2`)).toBe(merge);
		expect(fx.git("cat-file", "blob", `${tip}:early.txt`)).toBe("e");
		expect(fx.git("cat-file", "blob", `${tip}:a.txt`)).toBe("edited");
	});

	test("replayCommit preserves author lines and messages and chains parents", async () => {
		const c1 = fx.commit("c1\n\nbody\n", { "a.txt": "x\n" });
		fx.commit("c2", { "b.txt": "y\n" });
		const stack = await stackRead(fx.repo, cat);
		const result = await replay(stack, new Map([[c1, { tree: await fileEdit(c1, "a.txt", "z\n"), message: undefined }]]));
		if (result.kind !== "clean") {
			throw new Error("expected clean");
		}
		const { tip, rewritten } = await replayCommit(fx.repo, stack.baseOid, result.steps, false);
		expect(rewritten.map((r) => r.old)).toEqual(stack.commits.map((c) => c.oid));
		const [n1, n2] = [await commitRead(cat, rewritten[0]?.new as Oid), await commitRead(cat, tip)];
		expect(n1.authorLine).toBe(stack.commits[0]?.authorLine);
		expect(n1.message.equals(stack.commits[0]?.message as Buffer)).toBe(true);
		expect(n1.parents).toEqual([stack.baseOid]);
		expect(n2.parents).toEqual([rewritten[0]?.new]);
		expect(n2.authorLine).toBe(stack.commits[1]?.authorLine);
	});
});
