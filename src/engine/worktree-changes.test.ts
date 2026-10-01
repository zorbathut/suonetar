import { readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CatFile } from "./objects.ts";
import { Session } from "./session.ts";
import { repoInterleaved } from "./test-support/interleave.ts";
import { type Fixture, repoFixture, symlinksWork } from "./test-support/repo.ts";
import { worktreeFiles, worktreeStatus } from "./worktree-changes.ts";

describe("worktree changes", () => {
	let fx: Fixture;
	let cat: CatFile;
	const MAX = 100;
	const LIMIT = 1024;

	beforeEach(async () => {
		fx = await repoFixture();
		fx.commit("base", { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n", "gone.txt": "gone\n", ".gitignore": "*.log\n" });
		cat = new CatFile(fx.repo);
	});

	afterEach(async () => {
		cat.close();
		await fx.cleanup();
	});

	const text = (b: Buffer | undefined) => b?.toString();

	async function documents() {
		const staged = await worktreeFiles(fx.repo, cat, "staged", MAX, LIMIT);
		const unstaged = await worktreeFiles(fx.repo, cat, "unstaged", MAX, LIMIT);
		const show = (doc: typeof staged) => Object.fromEntries(doc.files.map((f) => [f.path, [f.status, text(f.parent), text(f.commit)]]));
		return { staged: show(staged), unstaged: show(unstaged), raw: { staged, unstaged } };
	}

	test("separates staged from unstaged, untracked files included and ignored ones left out", async () => {
		fx.write("a.txt", "a staged\n");
		fx.git("add", "a.txt");
		fx.write("b.txt", "b unstaged\n");
		fx.write("c.txt", "c staged\n");
		fx.git("add", "c.txt");
		fx.write("c.txt", "c staged, then more\n");
		unlinkSync(join(fx.dir, "gone.txt"));
		fx.write("new/dir/x.txt", "x\n");
		fx.write("debug.log", "ignored\n");
		const status = await worktreeStatus(fx.repo, MAX);
		const docs = await documents();
		expect(docs.staged).toEqual({ "a.txt": ["M", "a\n", "a staged\n"], "c.txt": ["M", "c\n", "c staged\n"] });
		expect(docs.unstaged).toEqual({
			"b.txt": ["M", "b\n", "b unstaged\n"],
			"c.txt": ["M", "c staged\n", "c staged, then more\n"],
			"gone.txt": ["D", "gone\n", undefined],
			"new/dir/x.txt": ["A", undefined, "x\n"],
		});
		// The counts are what the documents list.
		expect([status.staged, status.unstaged]).toEqual([2, 4]);
		expect(status.conflicted).toBe(false);
	});

	test("changes the unstaged print when a modified or new file is edited again, though git's status reads the same", async () => {
		fx.write("b.txt", "b once\n");
		fx.write("new/dir/x.txt", "x\n");
		const first = await worktreeStatus(fx.repo, MAX);
		fx.write("b.txt", "b twice, longer\n");
		const second = await worktreeStatus(fx.repo, MAX);
		fx.write("new/dir/x.txt", "x again\n");
		const third = await worktreeStatus(fx.repo, MAX);
		expect(new Set([first.unstagedPrint, second.unstagedPrint, third.unstagedPrint]).size).toBe(3);
		expect(new Set([first.stagedPrint, second.stagedPrint, third.stagedPrint]).size).toBe(1);
	});

	test("lists every untracked file whatever status.showUntrackedFiles says", async () => {
		fx.git("config", "status.showUntrackedFiles", "no");
		fx.write("new/one.txt", "1\n");
		fx.write("new/two.txt", "2\n");
		expect((await worktreeStatus(fx.repo, MAX)).unstaged).toBe(2);
	});

	test.skipIf(!symlinksWork)("reads symlinks as their target, with git's slashes, and shows a file turned into one as a type change", async () => {
		symlinkSync("dir/a.txt", join(fx.dir, "link"));
		fx.git("rm", "-q", "--cached", "c.txt");
		unlinkSync(join(fx.dir, "c.txt"));
		symlinkSync("a.txt", join(fx.dir, "c.txt"));
		fx.git("add", "c.txt");
		const docs = await documents();
		expect(docs.unstaged.link?.[2]).toBe("dir/a.txt");
		expect(docs.staged["c.txt"]).toEqual(["T", "c\n", "a.txt"]);
	});

	test("skips large files' contents, and caps the list", async () => {
		fx.write("big.bin", "x".repeat(LIMIT + 1));
		fx.write("small.txt", "s\n");
		fx.write("other.txt", "o\n");
		const doc = await worktreeFiles(fx.repo, cat, "unstaged", MAX, LIMIT);
		const byPath = Object.fromEntries(doc.files.map((f) => [f.path, f]));
		expect(byPath["big.bin"]?.tooLarge).toBe(true);
		expect(byPath["big.bin"]?.commit).toBeUndefined();
		const capped = await worktreeFiles(fx.repo, cat, "unstaged", 2, LIMIT);
		expect([capped.files.length, capped.omitted]).toEqual([2, 1]);
	});

	test("flags binary contents, as git decides it", async () => {
		writeFileSync(join(fx.dir, "b.txt"), Buffer.from([98, 0, 10]));
		const doc = await worktreeFiles(fx.repo, cat, "unstaged", MAX, LIMIT);
		expect(doc.files.map((f) => [f.path, f.binary])).toEqual([["b.txt", true]]);
	});

	test("tolerates a file vanishing between git's status and reading it", async () => {
		fx.write("b.txt", "b unstaged\n");
		const racing = repoInterleaved(
			fx.repo,
			(args) => args[0] === "rev-parse",
			() => rmSync(join(fx.dir, "b.txt")),
		);
		const doc = await worktreeFiles(racing, cat, "unstaged", MAX, LIMIT);
		expect(doc.files.map((f) => [f.path, f.commit])).toEqual([["b.txt", undefined]]);
	});

	test("leaves the repository untouched, a held index lock included", async () => {
		fx.write("b.txt", "b unstaged\n");
		const index = join(fx.dir, ".git", "index");
		const before = { bytes: readFileSync(index), mtime: statSync(index).mtimeMs };
		writeFileSync(join(fx.dir, ".git", "index.lock"), "held");
		const status = await worktreeStatus(fx.repo, MAX);
		await documents();
		expect(status.unstaged).toBe(1);
		expect(readFileSync(join(fx.dir, ".git", "index.lock"), "utf8")).toBe("held");
		expect({ bytes: readFileSync(index), mtime: statSync(index).mtimeMs }).toEqual(before);
	});

	test("the session serves both sides, with the file's indentation from HEAD's configs", async () => {
		fx.commit("config", { ".editorconfig": "[*]\nindent_size = 3\n" });
		fx.write("a.txt", "a staged\n");
		fx.git("add", "a.txt");
		fx.write("b.txt", "b unstaged\n");
		const session = await Session.openRepo(fx.repo, undefined);
		try {
			expect(await session.worktreeStatus()).toMatchObject({ staged: 1, unstaged: 1, conflicted: false });
			const staged = await session.worktreeDocument("staged");
			expect([staged.side, staged.files.map((f) => [f.path, f.indentation.size]), staged.omitted]).toEqual(["staged", [["a.txt", 3]], 0]);
			expect((await session.worktreeDocument("unstaged")).files.map((f) => f.path)).toEqual(["b.txt"]);
		} finally {
			session.close();
		}
	});

	test("handles odd paths, intent-to-add, and attributes marking files binary", async () => {
		fx.commit("attributes", { ".gitattributes": "*.dat binary\n" });
		fx.write("sp ace.txt", "s\n");
		// Windows allows no line break in a file name.
		const weird = process.platform === "win32" ? undefined : "we\nird.txt";
		if (weird !== undefined) {
			fx.write(weird, "w\n");
		}
		fx.write("data.dat", "looks like text\n");
		fx.write("planned.txt", "planned\n");
		fx.git("add", "-N", "planned.txt");
		const status = await worktreeStatus(fx.repo, MAX);
		const docs = await documents();
		expect(docs.unstaged["sp ace.txt"]?.[2]).toBe("s\n");
		if (weird !== undefined) {
			expect(docs.unstaged[weird]?.[2]).toBe("w\n");
		}
		expect(docs.unstaged["planned.txt"]).toEqual(["A", undefined, "planned\n"]);
		expect(docs.raw.unstaged.files.find((f) => f.path === "data.dat")?.binary).toBe(true);
		expect([status.staged, status.unstaged]).toEqual([docs.raw.staged.files.length, docs.raw.unstaged.files.length]);
	});

	test("shows a file turned into a submodule as the commit it points at, and leaves out nested repositories", async () => {
		const inner = join(fx.dir, "nested");
		fx.write("nested/f.txt", "f\n");
		fx.git("-C", inner, "init", "-q");
		fx.git("-C", inner, "add", "f.txt");
		fx.git("-C", inner, "commit", "-q", "-m", "inner");
		const innerHead = fx.git("-C", inner, "rev-parse", "HEAD");
		expect((await worktreeStatus(fx.repo, MAX)).unstaged).toBe(0);
		fx.git("rm", "-q", "--cached", "b.txt");
		fx.git("update-index", "--add", "--cacheinfo", `160000,${innerHead},b.txt`);
		const docs = await documents();
		expect(docs.staged["b.txt"]?.[2]).toBe(`Subproject commit ${innerHead}\n`);
	});

	test("works on an unborn branch, and writes no objects", async () => {
		const unborn = await repoFixture();
		const unbornCat = new CatFile(unborn.repo);
		try {
			unborn.write("first.txt", "1\n");
			unborn.git("add", "first.txt");
			unborn.write("second.txt", "2\n");
			const objects = unborn.git("count-objects");
			const staged = await worktreeFiles(unborn.repo, unbornCat, "staged", MAX, LIMIT);
			const unstaged = await worktreeFiles(unborn.repo, unbornCat, "unstaged", MAX, LIMIT);
			expect([staged.files.map((f) => f.path), unstaged.files.map((f) => f.path)]).toEqual([["first.txt"], ["second.txt"]]);
			expect(unborn.git("count-objects")).toBe(objects);
		} finally {
			unbornCat.close();
			await unborn.cleanup();
		}
	});

	test("leaves out what changed inside a submodule", async () => {
		const inner = join(fx.dir, "sub");
		fx.write("sub/f.txt", "f\n");
		fx.git("-C", inner, "init", "-q");
		fx.git("-C", inner, "add", "f.txt");
		fx.git("-C", inner, "commit", "-q", "-m", "inner");
		fx.git("add", "sub");
		fx.git("commit", "-q", "-m", "add sub");
		writeFileSync(join(inner, "f.txt"), "changed\n");
		expect((await worktreeStatus(fx.repo, MAX)).unstaged).toBe(0);
	});

	test("reports a conflicted index, showing the conflicted file against our side", async () => {
		fx.git("switch", "-q", "-c", "other");
		fx.commit("theirs", { "a.txt": "theirs\n" });
		fx.git("switch", "-q", "-");
		fx.commit("ours", { "a.txt": "ours\n" });
		expect(fx.gitTry("merge", "-q", "other").code).not.toBe(0);
		const status = await worktreeStatus(fx.repo, MAX);
		expect(status.conflicted).toBe(true);
		const docs = await documents();
		expect(docs.unstaged["a.txt"]?.[1]).toBe("ours\n");
		expect(status.unstaged).toBe(docs.raw.unstaged.files.length);
	});
});
