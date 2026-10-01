import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { renameRetrying } from "./apply.ts";
import { draftWithFile } from "./drafts.ts";
import type { Oid } from "./git.ts";
import { CatFile } from "./objects.ts";
import { Session } from "./session.ts";
import { type DraftEntry, storeRead, storeWrite } from "./store.ts";
import { beforeReadTree, beforeRefTransaction, repoInterleaved } from "./test-support/interleave.ts";
import { type Fixture, lineSet, lines, repoFixture, symlinksWork } from "./test-support/repo.ts";

describe("apply", () => {
	let fx: Fixture;
	let session: Session;
	let c1: Oid;
	let c2: Oid;

	beforeEach(async () => {
		fx = await repoFixture();
		fx.commit("base", { "a.txt": lines("a"), "b.txt": lines("b"), "c.txt": lines("c") });
		fx.git("switch", "-q", "-c", "feature");
		c1 = fx.commit("c1", { "a.txt": lineSet(lines("a"), 2, "c1") });
		c2 = fx.commit("c2", { "b.txt": lineSet(lines("b"), 2, "c2") });
		session = await Session.openRepo(fx.repo, undefined);
	});

	afterEach(async () => {
		session.close();
		await fx.cleanup();
	});

	const edited = lineSet(lineSet(lines("a"), 2, "c1"), 5, "suonetar edit");
	const disk = (path: string) => readFileSync(join(fx.dir, path), "utf8");

	async function sessionWith(predicate: (args: readonly string[]) => boolean, action: () => void | Promise<void>): Promise<Session> {
		session.close();
		session = await Session.openRepo(repoInterleaved(fx.repo, predicate, action), undefined);
		return session;
	}

	test("publishes: moves the branch, updates files and index, logs it, and clears the draft", async () => {
		await session.draftSetFile(c1, "a.txt", Buffer.from(edited));
		expect(await session.apply({ kind: "run", skip: [] }, () => undefined)).toEqual({ kind: "published", warning: undefined, hookChanges: [], hookless: [] });
		expect(fx.git("rev-parse", "HEAD")).not.toBe(c2);
		expect(fx.git("show", "HEAD~1:a.txt")).toBe(edited.trimEnd());
		expect(disk("a.txt")).toBe(edited);
		expect(fx.git("status", "--porcelain")).toBe("");
		expect(fx.git("reflog", "-1", "--format=%gs", "feature")).toBe(`suonetar: apply 2 commits from ${c2}`);
		expect(fx.git("reflog", "-1", "--format=%gs", "HEAD")).toBe(`suonetar: apply 2 commits from ${c2}`);
		const state = await session.state();
		expect(state.kind === "ready" && state.drafts).toEqual([]);
		expect(existsSync(join(fx.dir, ".git", "index.lock"))).toBe(false);
	});

	test("refuses when an uncommitted edit touches an affected file, changing nothing", async () => {
		await session.draftSetFile(c1, "a.txt", Buffer.from(edited));
		fx.write("a.txt", "claude's work in progress\n");
		const result = await session.apply({ kind: "run", skip: [] }, () => undefined);
		expect(result.kind).toBe("refused");
		expect(fx.git("rev-parse", "HEAD")).toBe(c2);
		expect(disk("a.txt")).toBe("claude's work in progress\n");
		const state = await session.state();
		expect(state.kind === "ready" && state.drafts.length).toBe(1);
	});

	test("refuses over a same-size edit made in the same second the index was written", async () => {
		await session.draftSetFile(c1, "a.txt", Buffer.from(edited));
		// Without ctime to tell them apart (core.trustctime=false, common on network and Windows filesystems), only the index's own mtime marks such an entry as possibly stale.
		fx.git("config", "core.trustctime", "false");
		const second = Math.floor(Date.now() / 1000) - 100;
		const file = join(fx.dir, "a.txt");
		utimesSync(file, second, second);
		fx.git("update-index", "--refresh");
		utimesSync(join(fx.dir, ".git", "index"), second, second);
		const theirs = disk("a.txt").replace("c1", "C1");
		writeFileSync(file, theirs);
		utimesSync(file, second, second);
		// Plumbing that never writes the index, which would end the race this test sets up.
		expect(fx.git("diff-files", "--name-only")).toBe("a.txt");
		expect((await session.apply({ kind: "run", skip: [] }, () => undefined)).kind).toBe("refused");
		expect(disk("a.txt")).toBe(theirs);
	});

	test("installs the new index stamped no later than the files the update wrote, however long publishing took", async () => {
		await session.draftSetFile(c1, "a.txt", Buffer.from(edited));
		let stamped = 0;
		// Between the worktree update and installing the index, a second boundary passes.
		const s = await sessionWith(beforeRefTransaction, async () => {
			stamped = Math.floor(statSync(join(fx.dir, ".git", "suonetar", "index.private")).mtimeMs / 1000);
			await new Promise((r) => setTimeout(r, 1100));
		});
		expect((await s.apply({ kind: "run", skip: [] }, () => undefined)).kind).toBe("published");
		// An index stamped later than the files would hide an edit made in their second.
		expect(Math.floor(statSync(join(fx.dir, ".git", "index")).mtimeMs / 1000)).toBe(stamped);
	});

	test("keeps unrelated uncommitted and staged changes, and ignores touched-but-unchanged files", async () => {
		await session.draftSetFile(c1, "a.txt", Buffer.from(edited));
		fx.write("c.txt", "unstaged work\n");
		fx.write("new.txt", "staged work\n");
		fx.git("add", "new.txt");
		fx.write("b.txt", disk("b.txt"));
		expect(await session.apply({ kind: "run", skip: [] }, () => undefined)).toEqual({ kind: "published", warning: undefined, hookChanges: [], hookless: [] });
		expect(disk("c.txt")).toBe("unstaged work\n");
		expect(fx.git("status", "--porcelain").split("\n").sort()).toEqual([" M c.txt", "A  new.txt"]);
	});

	test("refuses when an ignored file is where the update would write", async () => {
		fx.commit("ignore", { ".gitignore": "gen.txt\ngendir\n" });
		const top = fx.git("rev-parse", "HEAD");
		fx.write("gen.txt", "precious local output\n");
		await session.draftSetFile(top, "gen.txt", Buffer.from("now tracked\n"));
		expect((await session.apply({ kind: "run", skip: [] }, () => undefined)).kind).toBe("refused");
		expect(disk("gen.txt")).toBe("precious local output\n");

		await session.draftDiscard(top);
		fx.write("gendir", "an ignored file where a directory must go\n");
		await session.draftSetFile(top, "gendir/x.txt", Buffer.from("x\n"));
		expect((await session.apply({ kind: "run", skip: [] }, () => undefined)).kind).toBe("refused");
		expect(disk("gendir")).toBe("an ignored file where a directory must go\n");
	});

	test("reports a held index.lock with its age", async () => {
		await session.draftSetFile(c1, "a.txt", Buffer.from(edited));
		writeFileSync(join(fx.dir, ".git", "index.lock"), "");
		const result = await session.apply({ kind: "run", skip: [] }, () => undefined);
		expect(result.kind).toBe("locked");
		expect(existsSync(join(fx.dir, ".git", "index.lock"))).toBe(true);
		expect(existsSync(join(fx.dir, ".git", "suonetar", "intent.json"))).toBe(false);
	});

	test("refuses while a rebase is in progress", async () => {
		await session.draftSetFile(c1, "a.txt", Buffer.from(edited));
		mkdirSync(join(fx.dir, ".git", "rebase-merge"));
		expect((await session.apply({ kind: "run", skip: [] }, () => undefined)).kind).toBe("refused");
		expect(fx.git("rev-parse", "HEAD")).toBe(c2);
	});

	test("refuses when the branch is also checked out in another worktree", async () => {
		await session.draftSetFile(c1, "a.txt", Buffer.from(edited));
		fx.git("worktree", "add", "-q", "--force", join(fx.dir, "..", `${basename(fx.dir)}-wt`), "feature");
		try {
			expect((await session.apply({ kind: "run", skip: [] }, () => undefined)).kind).toBe("refused");
		} finally {
			fx.git("worktree", "remove", "--force", join(fx.dir, "..", `${basename(fx.dir)}-wt`));
		}
	});

	test("the other process cannot commit while the update holds the index lock", async () => {
		let claude = { code: -1, out: "" };
		const s = await sessionWith(beforeReadTree, () => {
			fx.write("c.txt", "claude edit\n");
			claude = fx.gitTry("commit", "-qam", "claude");
		});
		await s.draftSetFile(c1, "a.txt", Buffer.from(edited));
		expect(await s.apply({ kind: "run", skip: [] }, () => undefined)).toEqual({ kind: "published", warning: undefined, hookChanges: [], hookless: [] });
		expect(claude.code).not.toBe(0);
		expect(claude.out).toContain("index.lock");
		expect(disk("c.txt")).toBe("claude edit\n");
		expect(fx.git("status", "--porcelain")).toBe(" M c.txt");
	});

	test("a branch moved by reset --soft during the update fails the swap and puts the worktree back", async () => {
		const s = await sessionWith(beforeRefTransaction, () => {
			fx.git("reset", "-q", "--soft", "HEAD~1");
		});
		await s.draftSetFile(c1, "a.txt", Buffer.from(edited));
		const result = await s.apply({ kind: "run", skip: [] }, () => undefined);
		expect(result).toMatchObject({ kind: "moved", unreverted: [] });
		expect(fx.git("rev-parse", "HEAD")).toBe(c1);
		expect(disk("a.txt")).toBe(lineSet(lines("a"), 2, "c1"));
		const state = await s.state();
		expect(state.kind === "ready" && state.drafts.map((d) => d.kind)).toEqual(["current"]);
	});

	test("when the other process also edited an updated file, that file is left alone and reported", async () => {
		const s = await sessionWith(beforeRefTransaction, () => {
			fx.write("a.txt", "claude rewrote this\n");
			fx.git("reset", "-q", "--soft", "HEAD~1");
		});
		await s.draftSetFile(c1, "a.txt", Buffer.from(edited));
		await s.draftSetFile(c2, "b.txt", Buffer.from("suonetar b\n"));
		const result = await s.apply({ kind: "run", skip: [] }, () => undefined);
		expect(result).toMatchObject({ kind: "moved", unreverted: ["a.txt"] });
		expect(disk("a.txt")).toBe("claude rewrote this\n");
		expect(disk("b.txt")).toBe(lineSet(lines("b"), 2, "c2"));
	});

	test("a branch switch during the transaction rolls the branch back", async () => {
		// `git switch -c` does not take the index lock when the tree is unchanged, so it can run mid-apply.
		const s = await sessionWith(beforeRefTransaction, () => {
			fx.git("switch", "-q", "-c", "backup");
		});
		await s.draftSetFile(c1, "a.txt", Buffer.from(edited));
		const result = await s.apply({ kind: "run", skip: [] }, () => undefined);
		expect(result.kind).toBe("moved");
		expect(fx.git("rev-parse", "feature")).toBe(c2);
		expect(fx.git("rev-parse", "backup")).toBe(c2);
		expect(disk("a.txt")).toBe(lineSet(lines("a"), 2, "c1"));
		expect(existsSync(join(fx.dir, ".git", "index.lock"))).toBe(false);
	});

	function intentWrite(phase: string, pid = 999999): void {
		mkdirSync(join(fx.dir, ".git", "suonetar"), { recursive: true });
		writeFileSync(join(fx.dir, ".git", "suonetar", "intent.json"), JSON.stringify({ branch: "refs/heads/feature", oldTip: c2, newTip: c1, pid, time: "", phase }));
	}

	test("an apply that stopped after locking stays reported, whether or not the lock is still there", async () => {
		intentWrite("worktree-updated");
		writeFileSync(join(fx.dir, ".git", "index.lock"), "");
		expect((await session.state()).kind).toBe("interrupted");
		expect((await session.apply({ kind: "run", skip: [] }, () => undefined)).kind).toBe("interrupted");
		rmSync(join(fx.dir, ".git", "index.lock"));
		expect((await session.state()).kind).toBe("interrupted");
	});

	test("an apply that never got the lock is cleared", async () => {
		intentWrite("locking");
		expect((await session.state()).kind).toBe("ready");
		expect(existsSync(join(fx.dir, ".git", "suonetar", "intent.json"))).toBe(false);
	});

	test("an apply by a live process is busy, not interrupted", async () => {
		intentWrite("worktree-updated", process.ppid);
		expect((await session.state()).kind).toBe("ready");
		await session.draftSetFile(c1, "a.txt", Buffer.from(edited));
		expect((await session.apply({ kind: "run", skip: [] }, () => undefined)).kind).toBe("busy");
	});

	test("a draft changed by someone else during the apply is kept, not cleared", async () => {
		const s = await sessionWith(beforeRefTransaction, async () => {
			// Another process edits the same commit's draft mid-apply, writing the store directly.
			const cat = new CatFile(fx.repo);
			try {
				const store = await storeRead(fx.repo, cat);
				const existing = store.drafts.get(c2);
				const commit = { oid: c2, tree: fx.git("rev-parse", `${c2}^{tree}`), authorLine: existing?.meta.authorLine ?? "", subject: "c2", message: Buffer.from("c2\n") };
				const next = await draftWithFile(fx.repo, "refs/heads/feature", commit, existing, "b.txt", Buffer.from("later edit\n"));
				await storeWrite(fx.repo, store, new Map([[c2, next as DraftEntry]]), store.resolutions);
			} finally {
				cat.close();
			}
		});
		await s.draftSetFile(c2, "b.txt", Buffer.from("first edit\n"));
		expect((await s.apply({ kind: "run", skip: [] }, () => undefined)).kind).toBe("published");
		const state = await s.state();
		expect(state.kind === "ready" && state.drafts.length).toBe(1);
	});

	test("an ignored directory where the update writes a file is refused", async () => {
		fx.commit("ignore", { ".gitignore": "build\n" });
		const top = fx.git("rev-parse", "HEAD");
		mkdirSync(join(fx.dir, "build"));
		fx.write("build/precious.o", "object code\n");
		await session.draftSetFile(top, "build", Buffer.from("now a file\n"));
		expect((await session.apply({ kind: "run", skip: [] }, () => undefined)).kind).toBe("refused");
		expect(disk("build/precious.o")).toBe("object code\n");
	});

	test.skipIf(!symlinksWork)("an ignored symlink where the update writes a file is refused", async () => {
		fx.commit("ignore", { ".gitignore": "lnk\n" });
		const top = fx.git("rev-parse", "HEAD");
		symlinkSync("a.txt", join(fx.dir, "lnk"));
		await session.draftSetFile(top, "lnk", Buffer.from("now a file\n"));
		expect((await session.apply({ kind: "run", skip: [] }, () => undefined)).kind).toBe("refused");
		expect(lstatSync(join(fx.dir, "lnk")).isSymbolicLink()).toBe(true);
	});

	test("a worktree update that fails partway is reverted and reported as refused", async () => {
		mkdirSync(join(fx.dir, "ro"));
		fx.write("ro/keep.txt", "k\n");
		fx.git("add", "ro/keep.txt");
		const c3 = fx.commit("c3", {});
		await session.draftSetFile(c1, "a.txt", Buffer.from(edited));
		// What stops it: a read-only directory it must write into, or on Windows, which has none, a directory it must replace with a file that some process has as its cwd.
		let release: () => void;
		if (process.platform === "win32") {
			await session.draftSetFile(c3, "ro/keep.txt", null);
			await session.draftSetFile(c3, "ro", Buffer.from("now a file\n"));
			const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { cwd: join(fx.dir, "ro") });
			await once(holder, "spawn");
			release = () => holder.kill();
		} else {
			await session.draftSetFile(c3, "ro/new.txt", Buffer.from("cannot be written\n"));
			chmodSync(join(fx.dir, "ro"), 0o555);
			release = () => chmodSync(join(fx.dir, "ro"), 0o755);
		}
		try {
			const result = await session.apply({ kind: "run", skip: [] }, () => undefined);
			expect(result.kind).toBe("refused");
			expect(disk("a.txt")).toBe(lineSet(lines("a"), 2, "c1"));
			expect(fx.git("status", "--porcelain")).toBe("");
			expect(existsSync(join(fx.dir, ".git", "index.lock"))).toBe(false);
		} finally {
			release();
		}
	});

	test("an error after the worktree update puts the worktree back and releases everything", async () => {
		let calls = 0;
		const failing: typeof fx.repo = {
			...fx.repo,
			run: (args, opts) => {
				if (args[0] === "symbolic-ref" && ++calls === 3) {
					return Promise.reject(new Error("spawn EAGAIN"));
				}
				return fx.repo.run(args, opts);
			},
		};
		session.close();
		session = await Session.openRepo(failing, undefined);
		await session.draftSetFile(c1, "a.txt", Buffer.from(edited));
		calls = 0;
		await expect(session.apply({ kind: "run", skip: [] }, () => undefined)).rejects.toThrow("EAGAIN");
		expect(disk("a.txt")).toBe(lineSet(lines("a"), 2, "c1"));
		expect(fx.git("rev-parse", "HEAD")).toBe(c2);
		expect(fx.git("status", "--porcelain")).toBe("");
		expect(existsSync(join(fx.dir, ".git", "index.lock"))).toBe(false);
		expect(existsSync(join(fx.dir, ".git", "suonetar", "intent.json"))).toBe(false);
	});

	const lockSteal = () => {
		rmSync(join(fx.dir, ".git", "index.lock"));
		writeFileSync(join(fx.dir, ".git", "index.lock"), "someone else's");
	};

	test("a lock taken over after the last ownership check leaves everything for recovery", async () => {
		const s = await sessionWith(beforeRefTransaction, lockSteal);
		await s.draftSetFile(c1, "a.txt", Buffer.from(edited));
		expect((await s.apply({ kind: "run", skip: [] }, () => undefined)).kind).toBe("interrupted");
		expect(readFileSync(join(fx.dir, ".git", "index.lock"), "utf8")).toBe("someone else's");
		expect(existsSync(join(fx.dir, ".git", "suonetar", "index.private"))).toBe(true);
		expect((await s.state()).kind).toBe("interrupted");
	});

	test("a lock taken over before the ref moves backs out", async () => {
		const s = await sessionWith(beforeReadTree, () => {
			rmSync(join(fx.dir, ".git", "index.lock"));
			writeFileSync(join(fx.dir, ".git", "index.lock"), "someone else's");
		});
		await s.draftSetFile(c1, "a.txt", Buffer.from(edited));
		expect((await s.apply({ kind: "run", skip: [] }, () => undefined)).kind).toBe("moved");
		expect(fx.git("rev-parse", "HEAD")).toBe(c2);
		expect(disk("a.txt")).toBe(lineSet(lines("a"), 2, "c1"));
		expect(readFileSync(join(fx.dir, ".git", "index.lock"), "utf8")).toBe("someone else's");
	});

	test("backing out restores files that became directories and removes added files", async () => {
		const s = await sessionWith(beforeRefTransaction, () => {
			fx.git("reset", "-q", "--soft", "HEAD~1");
		});
		await s.draftSetFile(c1, "a.txt", null);
		await s.draftSetFile(c1, "a.txt/inner.txt", Buffer.from("inner\n"));
		await s.draftSetFile(c2, "added/deep/file.txt", Buffer.from("added\n"));
		expect(await s.apply({ kind: "run", skip: [] }, () => undefined)).toMatchObject({ kind: "moved", unreverted: [] });
		expect(disk("a.txt")).toBe(lineSet(lines("a"), 2, "c1"));
		expect(existsSync(join(fx.dir, "added"))).toBe(false);
	});
});

describe("renameRetrying", () => {
	const failing = (code: string, times: number) => {
		const calls: string[] = [];
		const rename = (from: string, to: string) => {
			calls.push(`${from}>${to}`);
			if (calls.length <= times) {
				throw Object.assign(new Error(code), { code });
			}
		};
		return { calls, rename };
	};

	test("retries while another process holds the target, as git does", async () => {
		const { calls, rename } = failing("EPERM", 2);
		await renameRetrying("lock", "index", rename);
		expect(calls).toEqual(["lock>index", "lock>index", "lock>index"]);
	});

	test("gives up with the error after about a second, and at once on any other error", async () => {
		const held = failing("EACCES", 1000);
		await expect(renameRetrying("lock", "index", held.rename)).rejects.toMatchObject({ code: "EACCES" });
		expect(held.calls.length).toBeGreaterThan(3);
		const missing = failing("ENOENT", 1000);
		await expect(renameRetrying("lock", "index", missing.rename)).rejects.toMatchObject({ code: "ENOENT" });
		expect(missing.calls.length).toBe(1);
	});
});
