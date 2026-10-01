import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Oid } from "./git.ts";
import { type HookChoice, Session } from "./session.ts";
import { type Fixture, lineSet, lines, repoFixture } from "./test-support/repo.ts";

const RUN: HookChoice = { kind: "run", skip: [] };

describe("pre-commit hooks at apply", () => {
	let fx: Fixture;
	let session: Session;
	let log: string;
	let c1: Oid;
	let c2: Oid;
	let c3: Oid;

	beforeEach(async () => {
		fx = await repoFixture();
		log = join(fx.dir, ".git", "hook.log");
		fx.commit("base", { "a.txt": lines("a"), "b.txt": lines("b"), "c.txt": lines("c") });
		fx.git("switch", "-q", "-c", "feature");
		c1 = fx.commit("c1", { "a.txt": lineSet(lines("a"), 2, "c1") });
		c2 = fx.commit("c2", { "b.txt": lineSet(lines("b"), 2, "c2") });
		c3 = fx.commit("c3", { "c.txt": lineSet(lines("c"), 2, "c3") });
		session = await Session.openRepo(fx.repo);
	});

	afterEach(() => {
		session.close();
		fx.cleanup();
	});

	function hookInstall(body: string, path = join(fx.dir, ".git", "hooks", "pre-commit")): void {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, `#!/bin/sh\n${body}\n`);
		chmodSync(path, 0o755);
	}

	// One line per hook run: the worktree it ran in and the staged paths.
	const LOGGING = `echo "$(git rev-parse --show-toplevel)|$(git diff --cached --name-only | tr '\\n' ,)" >> "${"$"}LOG"`;

	function logLines(): string[] {
		return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
	}

	function show(rev: string, path: string): string {
		return fx.git("show", `${rev}:${path}`);
	}

	async function apply(choice: HookChoice = RUN) {
		return session.apply(choice, () => undefined);
	}

	test("without a hook nothing runs and no worktree is created", async () => {
		await session.draftSetFile(c2, "b.txt", Buffer.from("edited\n"));
		expect((await apply()).kind).toBe("published");
		expect(existsSync(join(fx.dir, ".git", "suonetar", "wt"))).toBe(false);
	});

	test("the hook runs once per rewritten commit, in the private worktree, with the commit's change staged", async () => {
		hookInstall(LOGGING.replace("$LOG", log));
		const statusBefore = fx.git("status", "--porcelain");
		await session.draftSetFile(c2, "b.txt", Buffer.from("edited\n"));
		const result = await apply();
		expect(result.kind).toBe("published");
		const wt = realpathSync(join(fx.dir, ".git", "suonetar", "wt"));
		expect(logLines()).toEqual([`${wt}|b.txt,`, `${wt}|c.txt,`]);
		expect(fx.git("status", "--porcelain")).toBe(statusBefore);
		expect(fx.git("log", "--all", "--format=%s")).not.toContain("suonetar: hook parent");
		expect(fx.git("worktree", "list")).toContain("detached");
	});

	test("a formatter's changes are folded in, and later commits build on them without conflicts", async () => {
		fx.git("reset", "-q", "--hard", "main");
		c1 = fx.commit("c1", { "f.txt": "one  \ntwo  \nthree  \nfour\nfive\n" });
		c2 = fx.commit("c2", { "f.txt": "one  \ntwo  \nthree  \nfour\nFIVE  \n" });
		c3 = fx.commit("c3", { "g.txt": "g\n" });
		hookInstall(`changed=0
for f in $(git diff --cached --name-only --diff-filter=ACM); do
  if grep -q ' $' "$f"; then sed -i 's/ *$//' "$f"; changed=1; fi
done
exit $changed`);
		await session.draftSetFile(c1, "f.txt", Buffer.from("one  \nTWO  \nthree  \nfour\nfive\n"));
		const result = await apply();
		if (result.kind !== "published") {
			throw new Error(`apply: ${JSON.stringify(result)}`);
		}
		expect(show("HEAD~2", "f.txt")).toBe("one\nTWO\nthree\nfour\nfive");
		expect(show("HEAD~1", "f.txt")).toBe("one\nTWO\nthree\nfour\nFIVE");
		expect(show("HEAD", "f.txt")).toBe("one\nTWO\nthree\nfour\nFIVE");
		expect(fx.git("diff", "--stat", "HEAD~2", "HEAD~1")).toContain("1 insertion(+), 1 deletion(-)");
		expect(result.hookChanges.map((c) => [c.subject, c.paths])).toEqual([
			["c1", ["f.txt"]],
			["c2", ["f.txt"]],
		]);
	});

	test("a later commit that deletes a reformatted file deletes it", async () => {
		fx.git("reset", "-q", "--hard", "main");
		c1 = fx.commit("c1", { "f.txt": "x  \n" });
		c2 = fx.commit("c2", { "f.txt": null });
		hookInstall(`for f in $(git diff --cached --name-only --diff-filter=ACM); do sed -i 's/ *$//' "$f"; git add "$f"; done`);
		await session.draftSetFile(c1, "h.txt", Buffer.from("h\n"));
		expect((await apply()).kind).toBe("published");
		expect(show("HEAD~1", "f.txt")).toBe("x");
		expect(fx.gitTry("cat-file", "-e", "HEAD:f.txt").code).not.toBe(0);
	});

	test("a hook that stages its own fix and exits 0 is taken as is; unrelated files it touches are left out", async () => {
		hookInstall(`for f in $(git diff --cached --name-only); do echo fixed >> "$f"; git add "$f"; done; echo stray >> a.txt; exit 0`);
		await session.draftSetFile(c2, "b.txt", Buffer.from("edited\n"));
		expect((await apply()).kind).toBe("published");
		expect(show("HEAD~1", "b.txt")).toBe("edited\nfixed");
		expect(show("HEAD~1", "a.txt")).toBe(lineSet(lines("a"), 2, "c1").trimEnd());
	});

	test("a failing hook stops the apply with its output, and nothing changes", async () => {
		hookInstall(`echo "lint: something is wrong" >&2; exit 2`);
		await session.draftSetFile(c2, "b.txt", Buffer.from("edited\n"));
		const tip = fx.git("rev-parse", "HEAD");
		const result = await apply();
		if (result.kind !== "hook-failed") {
			throw new Error(`apply: ${JSON.stringify(result)}`);
		}
		expect(result.failure).toBe("exit");
		expect(result.code).toBe(2);
		expect(result.commit.oid).toBe(c2);
		expect(result.output).toContain("lint: something is wrong");
		expect(fx.git("rev-parse", "HEAD")).toBe(tip);
		const state = await session.state();
		expect(state.kind === "ready" ? state.drafts.length : -1).toBe(1);
	});

	test("a hook that changes files on every run fails as unsettled", async () => {
		hookInstall(`for f in $(git diff --cached --name-only); do echo more >> "$f"; done; exit 1`);
		await session.draftSetFile(c2, "b.txt", Buffer.from("edited\n"));
		const result = await apply();
		expect(result.kind === "hook-failed" ? [result.failure, result.changed] : result.kind).toEqual(["unsettled", ["b.txt"]]);
	});

	test("skipping hooks, for the apply or for one commit", async () => {
		const flag = join(fx.dir, ".git", "fail-on");
		hookInstall(`if git diff --cached --name-only | grep -qx "$(cat ${flag})"; then exit 1; fi; ${LOGGING.replace("$LOG", log)}`);
		writeFileSync(flag, "b.txt");
		await session.draftSetFile(c2, "b.txt", Buffer.from("edited\n"));
		expect((await apply()).kind).toBe("hook-failed");
		const result = await apply({ kind: "run", skip: [c2] });
		expect(result.kind).toBe("published");
		expect(logLines().map((l) => l.split("|")[1])).toEqual(["c.txt,"]);
		const c2New = fx.git("rev-parse", "HEAD~1");
		await session.draftSetFile(c2New, "b.txt", Buffer.from("edited again\n"));
		rmSync(log);
		expect((await apply({ kind: "skip" })).kind).toBe("published");
		expect(logLines()).toEqual([]);
	});

	test("commits that already passed are not re-run after a later failure is fixed", async () => {
		const flag = join(fx.dir, ".git", "fail-on");
		hookInstall(`${LOGGING.replace("$LOG", log)}; if git diff --cached --name-only | grep -qx "$(cat ${flag})"; then exit 1; fi`);
		writeFileSync(flag, "c.txt");
		await session.draftSetFile(c2, "b.txt", Buffer.from("edited\n"));
		expect((await apply()).kind).toBe("hook-failed");
		expect(logLines().length).toBe(2);
		writeFileSync(flag, "nothing");
		expect((await apply()).kind).toBe("published");
		expect(logLines().map((l) => l.split("|")[1])).toEqual(["b.txt,", "c.txt,", "c.txt,"]);
	});

	test("a message edit below a commit does not re-run its hook", async () => {
		hookInstall(LOGGING.replace("$LOG", log));
		await session.draftSetMessage(c1, Buffer.from("c1 reworded\n"));
		expect((await apply()).kind).toBe("published");
		expect(logLines()).toEqual([]);
	});

	test("cancelling stops a hanging hook, and the next apply works", async () => {
		const started = join(fx.dir, ".git", "started");
		hookInstall(`touch ${started}; sleep 30`);
		await session.draftSetFile(c3, "c.txt", Buffer.from("edited\n"));
		const running = apply();
		for (let i = 0; i < 200 && !existsSync(started); i++) {
			await new Promise((r) => setTimeout(r, 25));
		}
		const cancelledAt = Date.now();
		session.applyCancel();
		expect((await running).kind).toBe("cancelled");
		expect(Date.now() - cancelledAt).toBeLessThan(5000);
		hookInstall("exit 0");
		expect((await apply()).kind).toBe("published");
	});

	test("config-based hooks are found and run", async () => {
		fx.git("config", "hook.check.event", "pre-commit");
		fx.git("config", "hook.check.command", `echo ran >> ${log}`);
		await session.draftSetFile(c3, "c.txt", Buffer.from("edited\n"));
		expect((await apply()).kind).toBe("published");
		expect(logLines()).toEqual(["ran"]);
	});

	test("a relative hooks path that only exists in the main worktree (husky) still runs", async () => {
		fx.write(".gitignore", "_hooks/\n");
		hookInstall(LOGGING.replace("$LOG", log), join(fx.dir, "_hooks", "pre-commit"));
		fx.git("config", "core.hooksPath", "_hooks");
		await session.draftSetFile(c3, "c.txt", Buffer.from("edited\n"));
		expect((await apply()).kind).toBe("published");
		expect(logLines().length).toBe(1);
	});

	test("a tracked hooks directory runs each commit's own version", async () => {
		fx.git("reset", "-q", "--hard", "main");
		hookInstall(`echo v1 >> ${log}`, join(fx.dir, "hooks", "pre-commit"));
		fx.git("add", "hooks");
		fx.git("commit", "-qm", "hooks v1");
		hookInstall(`echo v2 >> ${log}`, join(fx.dir, "hooks", "pre-commit"));
		fx.git("commit", "-qam", "hooks v2");
		const c = fx.commit("change", { "c.txt": "c\n" });
		fx.git("config", "core.hooksPath", "hooks");
		const before = fx.git("rev-parse", "HEAD~2");
		await session.draftSetFile(before, "a.txt", Buffer.from("edited\n"));
		expect((await apply()).kind).toBe("published");
		// The v2 commit changes the hook, and is checked by its own new version.
		expect(logLines()).toEqual(["v1", "v2", "v2"]);
		expect(c).not.toBe(fx.git("rev-parse", "HEAD"));
	});

	test("a deleted worktree directory is recreated", async () => {
		hookInstall("exit 0");
		await session.draftSetFile(c3, "c.txt", Buffer.from("edited\n"));
		expect((await apply()).kind).toBe("published");
		rmSync(join(fx.dir, ".git", "suonetar", "wt"), { recursive: true, force: true });
		await session.draftSetFile(fx.git("rev-parse", "HEAD"), "c.txt", Buffer.from("edited again\n"));
		expect((await apply()).kind).toBe("published");
	});

	test("another live process holding the worktree makes the apply busy", async () => {
		hookInstall("exit 0");
		const other = spawn("sleep", ["30"]);
		try {
			mkdirSync(join(fx.dir, ".git", "suonetar"), { recursive: true });
			writeFileSync(join(fx.dir, ".git", "suonetar", "wt.lock"), String(other.pid));
			await session.draftSetFile(c3, "c.txt", Buffer.from("edited\n"));
			expect((await apply()).kind).toBe("busy");
		} finally {
			other.kill();
		}
		expect((await apply()).kind).toBe("published");
	});

	test("a cancel pressed before the hook pass starts still cancels", async () => {
		hookInstall(LOGGING.replace("$LOG", log));
		await session.draftSetFile(c3, "c.txt", Buffer.from("edited\n"));
		const tip = fx.git("rev-parse", "HEAD");
		const running = apply();
		session.applyCancel();
		expect((await running).kind).toBe("cancelled");
		expect(fx.git("rev-parse", "HEAD")).toBe(tip);
		expect(logLines()).toEqual([]);
	});

	test("a hooks path outside the repository is used as is", async () => {
		const shared = join(fx.dir, "..", `shared-hooks-${Date.now()}`);
		try {
			hookInstall(LOGGING.replace("$LOG", log), join(shared, "pre-commit"));
			fx.git("config", "core.hooksPath", `../${shared.split("/").at(-1)}`);
			await session.draftSetFile(c3, "c.txt", Buffer.from("edited\n"));
			expect((await apply()).kind).toBe("published");
			expect(logLines().length).toBe(1);
		} finally {
			rmSync(shared, { recursive: true, force: true });
		}
	});

	test("creating the private worktree leaves the user's other worktrees alone, even ones whose directory is missing", async () => {
		hookInstall("exit 0");
		const other = join(fx.dir, "..", `other-wt-${Date.now()}`);
		fx.git("worktree", "add", "-q", "--detach", other, "main");
		rmSync(other, { recursive: true, force: true });
		await session.draftSetFile(c3, "c.txt", Buffer.from("edited\n"));
		expect((await apply()).kind).toBe("published");
		expect(fx.git("worktree", "list", "--porcelain")).toContain(other.split("/").at(-1));
	});

	test("a commit whose hook is skipped keeps the formatting earlier commits received", async () => {
		fx.git("reset", "-q", "--hard", "main");
		c1 = fx.commit("c1", { "f.txt": "one  \ntwo  \nthree  \nfour\nfive\n" });
		c2 = fx.commit("c2", { "f.txt": "one  \ntwo  \nthree  \nfour\nFIVE\n", "lint.txt": "bad\n" });
		hookInstall(`if git diff --cached --name-only | grep -qx lint.txt; then exit 3; fi
changed=0
for f in $(git diff --cached --name-only --diff-filter=ACM); do
  if grep -q ' $' "$f"; then sed -i 's/ *$//' "$f"; changed=1; fi
done
exit $changed`);
		await session.draftSetFile(c1, "f.txt", Buffer.from("one  \nTWO  \nthree  \nfour\nfive\n"));
		expect((await apply()).kind).toBe("hook-failed");
		expect((await apply({ kind: "run", skip: [c2] })).kind).toBe("published");
		expect(show("HEAD", "f.txt")).toBe("one\nTWO\nthree\nfour\nFIVE");
	});

	test("an edit the hook undoes clears the draft instead of staying forever", async () => {
		fx.git("reset", "-q", "--hard", "main");
		c1 = fx.commit("c1", { "f.txt": "one\ntwo\n" });
		hookInstall(`changed=0
for f in $(git diff --cached --name-only --diff-filter=ACM); do
  if grep -q ' $' "$f"; then sed -i 's/ *$//' "$f"; changed=1; fi
done
exit $changed`);
		const tip = fx.git("rev-parse", "HEAD");
		await session.draftSetFile(c1, "f.txt", Buffer.from("one  \ntwo\n"));
		expect((await apply()).kind).toBe("hook-reverted");
		expect(fx.git("rev-parse", "HEAD")).toBe(tip);
		const state = await session.state();
		expect(state.kind === "ready" ? state.drafts.length : -1).toBe(0);
	});

	test("a commit touching tens of thousands of files", async () => {
		fx.git("reset", "-q", "--hard", "main");
		c1 = fx.commit("c1", { "a.txt": "edited by c1\n" });
		const blob = fx.git("hash-object", "-w", "/dev/null");
		const dir = `vendor/${"long-directory-name-".repeat(4)}`;
		const index = join(fx.dir, ".git", "big-index");
		const entries = Array.from({ length: 30000 }, (_, i) => `100644 ${blob}\t${dir}/file-number-${i}.txt`).join("\n");
		execFileSync("git", ["read-tree", c1], { cwd: fx.dir, env: { ...process.env, GIT_INDEX_FILE: index } });
		execFileSync("git", ["update-index", "--index-info"], { cwd: fx.dir, input: `${entries}\n`, env: { ...process.env, GIT_INDEX_FILE: index } });
		const tree = execFileSync("git", ["write-tree"], { cwd: fx.dir, env: { ...process.env, GIT_INDEX_FILE: index }, encoding: "utf8" }).trim();
		const big = fx.git("commit-tree", "-p", c1, "-m", "vendor drop", fx.git("rev-parse", `${tree}`));
		fx.git("update-ref", "refs/heads/feature", big);
		fx.git("read-tree", "-m", "-u", c1, big);
		hookInstall("exit 0");
		await session.draftSetFile(c1, "a.txt", Buffer.from("edited again\n"));
		expect((await apply()).kind).toBe("published");
	}, 120000);

	test("a hook-created file that a later commit's change would drop is a collision, not a loss", async () => {
		fx.git("reset", "-q", "--hard", "main");
		c1 = fx.commit("c1", { "a.txt": "c1\n" });
		c2 = fx.commit("c2", { gen: "a file named gen\n" });
		hookInstall(`if git diff --cached --name-only | grep -qx a.txt; then mkdir -p gen; echo made > gen/x; git add gen/x; fi; exit 0`);
		await session.draftSetFile(c1, "a.txt", Buffer.from("c1 edited\n"));
		const result = await apply();
		expect(result.kind === "hook-failed" ? [result.failure, result.changed] : result.kind).toEqual(["collision", ["gen/x"]]);
	});

	test("a commit whose tracked hooks directory has no pre-commit is reported, not failed", async () => {
		fx.git("reset", "-q", "--hard", "main");
		hookInstall("exit 0", join(fx.dir, "hooks", "post-merge"));
		fx.git("add", "hooks");
		fx.git("commit", "-qm", "hooks dir");
		c1 = fx.commit("c1", { "a.txt": "c1\n" });
		hookInstall(`echo ran >> ${log}`, join(fx.dir, "hooks", "pre-commit"));
		fx.git("add", "hooks");
		fx.git("commit", "-qm", "add pre-commit");
		fx.git("config", "core.hooksPath", "hooks");
		await session.draftSetFile(c1, "a.txt", Buffer.from("c1 edited\n"));
		const result = await apply();
		if (result.kind !== "published") {
			throw new Error(`apply: ${JSON.stringify(result)}`);
		}
		expect(result.hookless.map((c) => c.subject)).toEqual(["c1"]);
		expect(logLines()).toEqual(["ran"]);
	});

	test("when the branch moves during the pass, applying again reuses the passed commits", async () => {
		const once = join(fx.dir, ".git", "moved-once");
		hookInstall(`${LOGGING.replace("$LOG", log)}
if git diff --cached --name-only | grep -qx c.txt && [ ! -e ${once} ]; then touch ${once}; env -u GIT_DIR -u GIT_INDEX_FILE git -C ${fx.dir} commit -q --no-verify --allow-empty -m claude; fi`);
		await session.draftSetFile(c2, "b.txt", Buffer.from("edited\n"));
		expect((await apply()).kind).toBe("moved");
		expect(logLines().length).toBe(2);
		expect((await apply()).kind).toBe("published");
		// b.txt and c.txt from the cache; only Claude's new commit is checked.
		expect(logLines().map((l) => l.split("|")[1])).toEqual(["b.txt,", "c.txt,", ""]);
	});

	test("a broken private worktree or a stale lock inside it is repaired", async () => {
		hookInstall("exit 0");
		await session.draftSetFile(c3, "c.txt", Buffer.from("edited\n"));
		expect((await apply()).kind).toBe("published");
		const wt = join(fx.dir, ".git", "suonetar", "wt");
		const admin = fx.git("-C", wt, "rev-parse", "--absolute-git-dir");
		writeFileSync(join(admin, "index.lock"), "");
		await session.draftSetFile(fx.git("rev-parse", "HEAD"), "c.txt", Buffer.from("edited twice\n"));
		expect((await apply()).kind).toBe("published");
		writeFileSync(join(wt, ".git"), "gitdir: /nowhere\n");
		await session.draftSetFile(fx.git("rev-parse", "HEAD"), "c.txt", Buffer.from("edited thrice\n"));
		expect((await apply()).kind).toBe("published");
	});

	test("when the hook machinery itself fails, the apply says so instead of throwing", async () => {
		hookInstall("exit 0");
		const dir = join(fx.dir, ".git", "suonetar");
		await session.draftSetFile(c3, "c.txt", Buffer.from("edited\n"));
		mkdirSync(dir, { recursive: true });
		chmodSync(dir, 0o555);
		try {
			const result = await apply();
			expect(result.kind).toBe("hook-error");
		} finally {
			chmodSync(dir, 0o755);
		}
	});
});
