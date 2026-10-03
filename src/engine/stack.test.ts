import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ErrorNoBase, ErrorNotOnBranch } from "./errors.ts";
import { CatFile } from "./objects.ts";
import { stackRead } from "./stack.ts";
import { type Fixture, repoFixture } from "./test-support/repo.ts";

describe("stackRead", () => {
	let fx: Fixture;
	let cat: CatFile;

	beforeEach(async () => {
		fx = await repoFixture();
		cat = new CatFile(fx.repo);
		fx.commit("base", { "a.txt": "a\n" });
	});

	afterEach(async () => {
		cat.close();
		await fx.cleanup();
	});

	test("lists the commits between main and the branch, oldest first", async () => {
		const base = fx.git("rev-parse", "HEAD");
		fx.git("switch", "-q", "-c", "feature");
		const c1 = fx.commit("one", { "a.txt": "1\n" });
		const c2 = fx.commit("two", { "b.txt": "2\n" });
		const stack = await stackRead(fx.repo, cat, undefined);
		expect(stack.branch).toBe("refs/heads/feature");
		expect(stack.baseRef).toBe("refs/heads/main");
		expect(stack.baseOid).toBe(base);
		expect(stack.commits.map((c) => c.oid)).toEqual([c1, c2]);
		expect(stack.commits.map((c) => c.subject)).toEqual(["one", "two"]);
		expect(stack.commits[1]?.parent).toBe(c1);
		expect(stack.frozenBelow).toBeUndefined();
		expect(stack.generation).toContain(c2);
	});

	test("falls back to master, honours suonetar.base, and refuses without a base", async () => {
		fx.git("branch", "-m", "master");
		fx.git("switch", "-q", "-c", "feature");
		fx.commit("one", { "a.txt": "1\n" });
		expect((await stackRead(fx.repo, cat, undefined)).baseRef).toBe("refs/heads/master");

		const mid = fx.git("rev-parse", "HEAD");
		fx.git("branch", "mid", mid);
		fx.commit("two", { "a.txt": "2\n" });
		fx.git("config", "suonetar.base", "mid");
		const stack = await stackRead(fx.repo, cat, undefined);
		expect(stack.baseOid).toBe(mid);
		expect(stack.commits).toHaveLength(1);

		fx.git("config", "--unset", "suonetar.base");
		fx.git("switch", "-q", "master");
		await expect(stackRead(fx.repo, cat, undefined)).rejects.toBeInstanceOf(ErrorNoBase);
	});

	test("a candidate sharing no history with the branch is passed over", async () => {
		const base = fx.git("rev-parse", "HEAD");
		const tree = fx.git("rev-parse", "HEAD^{tree}");
		fx.git("update-ref", "refs/remotes/origin/main", fx.git("commit-tree", "-m", "unrelated", tree));
		fx.git("switch", "-q", "-c", "feature");
		fx.commit("one", { "a.txt": "1\n" });
		const stack = await stackRead(fx.repo, cat, undefined);
		expect(stack.baseRef).toBe("refs/heads/main");
		expect(stack.baseOid).toBe(base);
	});

	test("a candidate whose history git cannot read fails the read rather than being passed over", async () => {
		const tree = fx.git("rev-parse", "HEAD^{tree}");
		// A commit naming a parent that is not in the repository.
		const broken = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--literally", "--stdin"], {
			cwd: fx.dir,
			input: `tree ${tree}\nparent ${"1".repeat(40)}\nauthor A <a@a> 1700000000 +0000\ncommitter A <a@a> 1700000000 +0000\n\nbroken\n`,
			encoding: "utf8",
		}).trim();
		fx.git("update-ref", "refs/remotes/origin/main", broken);
		fx.git("switch", "-q", "-c", "feature");
		fx.commit("one", { "a.txt": "1\n" });
		await expect(stackRead(fx.repo, cat, undefined)).rejects.toThrow(/merge-base/);
	});

	test("prefers a remote base whose merge-base is newer than the stale local one", async () => {
		fx.git("switch", "-q", "-c", "feature");
		const upstreamWork = fx.commit("someone else's work on main", { "u.txt": "u\n" });
		fx.git("update-ref", "refs/remotes/origin/main", upstreamWork);
		const mine = fx.commit("mine", { "a.txt": "mine\n" });
		const stack = await stackRead(fx.repo, cat, undefined);
		expect(stack.baseRef).toBe("refs/remotes/origin/main");
		expect(stack.commits.map((c) => c.oid)).toEqual([mine]);
	});

	test("on the remote's default branch itself, the stack is the unpushed commits", async () => {
		fx.git("switch", "-q", "-c", "dev");
		const pushed = fx.commit("pushed", { "a.txt": "pushed\n" });
		fx.git("update-ref", "refs/remotes/origin/dev", pushed);
		fx.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/dev");
		let stack = await stackRead(fx.repo, cat, undefined);
		expect(stack.baseRef).toBe("refs/remotes/origin/dev");
		expect(stack.commits).toEqual([]);
		const local = fx.commit("local", { "a.txt": "local\n" });
		stack = await stackRead(fx.repo, cat, undefined);
		expect(stack.baseOid).toBe(pushed);
		expect(stack.commits.map((c) => c.oid)).toEqual([local]);
	});

	test("a branch forked from the remote's default branch starts at the fork", async () => {
		fx.git("switch", "-q", "-c", "dev");
		const devWork = fx.commit("dev work", { "d.txt": "d\n" });
		fx.git("update-ref", "refs/remotes/upstream/dev", devWork);
		fx.git("symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/dev");
		fx.git("switch", "-q", "-c", "feature");
		const mine = fx.commit("mine", { "a.txt": "mine\n" });
		const stack = await stackRead(fx.repo, cat, undefined);
		expect(stack.baseRef).toBe("refs/remotes/upstream/dev");
		expect(stack.commits.map((c) => c.oid)).toEqual([mine]);
	});

	test("another remote's HEAD that already contains the branch does not hide its commits", async () => {
		fx.git("update-ref", "refs/remotes/origin/main", fx.git("rev-parse", "main"));
		fx.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
		fx.git("switch", "-q", "-c", "feature");
		const f1 = fx.commit("f1", { "a.txt": "f1\n" });
		fx.git("update-ref", "refs/remotes/laptop/feature", f1);
		fx.git("symbolic-ref", "refs/remotes/laptop/HEAD", "refs/remotes/laptop/feature");
		const stack = await stackRead(fx.repo, cat, undefined);
		expect(stack.baseRef).toBe("refs/remotes/origin/main");
		expect(stack.commits.map((c) => c.oid)).toEqual([f1]);
	});

	test("a branch forked from a local copy of the remote default with unpushed work starts at the fork", async () => {
		fx.git("switch", "-q", "-c", "dev");
		const pushed = fx.commit("pushed", { "a.txt": "pushed\n" });
		fx.git("update-ref", "refs/remotes/origin/dev", pushed);
		fx.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/dev");
		fx.commit("unpushed on dev", { "d.txt": "d\n" });
		fx.git("switch", "-q", "-c", "feature");
		const mine = fx.commit("mine", { "a.txt": "mine\n" });
		const stack = await stackRead(fx.repo, cat, undefined);
		expect(stack.baseRef).toBe("refs/heads/dev");
		expect(stack.commits.map((c) => c.oid)).toEqual([mine]);
	});

	test("a remote HEAD left dangling by a pruned default falls back instead of failing", async () => {
		fx.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/gone");
		fx.git("switch", "-q", "-c", "feature");
		const mine = fx.commit("mine", { "a.txt": "mine\n" });
		const stack = await stackRead(fx.repo, cat, undefined);
		expect(stack.baseRef).toBe("refs/heads/main");
		expect(stack.commits.map((c) => c.oid)).toEqual([mine]);
	});

	test("init.defaultBranch names a base when there is no remote", async () => {
		fx.git("branch", "-m", "trunk");
		fx.git("config", "init.defaultBranch", "trunk");
		const base = fx.git("rev-parse", "HEAD");
		fx.git("switch", "-q", "-c", "feature");
		fx.commit("one", { "a.txt": "1\n" });
		const stack = await stackRead(fx.repo, cat, undefined);
		expect(stack.baseRef).toBe("refs/heads/trunk");
		expect(stack.baseOid).toBe(base);
	});

	describe("the branch's own copy on the server", () => {
		beforeEach(() => {
			fx.git("remote", "add", "origin", "/nonexistent");
			fx.git("update-ref", "refs/remotes/origin/main", fx.git("rev-parse", "main"));
			fx.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
			fx.git("switch", "-q", "-c", "feature");
		});

		test("is the base while the branch has commits it lacks", async () => {
			const f1 = fx.commit("f1", { "a.txt": "f1\n" });
			fx.git("update-ref", "refs/remotes/origin/feature", f1);
			const f2 = fx.commit("f2", { "a.txt": "f2\n" });
			const stack = await stackRead(fx.repo, cat, undefined);
			expect(stack.baseRef).toBe("refs/remotes/origin/feature");
			expect(stack.commits.map((c) => c.oid)).toEqual([f2]);
		});

		test("gives way to the default branch once everything is pushed", async () => {
			const f1 = fx.commit("f1", { "a.txt": "f1\n" });
			const f2 = fx.commit("f2", { "a.txt": "f2\n" });
			fx.git("update-ref", "refs/remotes/origin/feature", f2);
			const stack = await stackRead(fx.repo, cat, undefined);
			expect(stack.baseRef).toBe("refs/remotes/origin/main");
			expect(stack.commits.map((c) => c.oid)).toEqual([f1, f2]);
			expect(stack.commits.every((c) => c.published)).toBe(true);
		});

		test("is found through where git push sends it when it has another name", async () => {
			const f1 = fx.commit("f1", { "a.txt": "f1\n" });
			fx.git("update-ref", "refs/remotes/origin/me/wip", f1);
			fx.git("config", "push.default", "upstream");
			fx.git("config", "branch.feature.remote", "origin");
			fx.git("config", "branch.feature.merge", "refs/heads/me/wip");
			const f2 = fx.commit("f2", { "a.txt": "f2\n" });
			const stack = await stackRead(fx.repo, cat, undefined);
			expect(stack.baseRef).toBe("refs/remotes/origin/me/wip");
			expect(stack.commits.map((c) => c.oid)).toEqual([f2]);
		});

		test("an upstream whose remote branch is gone falls back to the default branch", async () => {
			fx.git("config", "branch.feature.remote", "origin");
			fx.git("config", "branch.feature.merge", "refs/heads/feature");
			const f1 = fx.commit("f1", { "a.txt": "f1\n" });
			const stack = await stackRead(fx.repo, cat, undefined);
			expect(stack.baseRef).toBe("refs/remotes/origin/main");
			expect(stack.commits.map((c) => c.oid)).toEqual([f1]);
		});

		test("an upstream that is a local branch is not the branch's copy", async () => {
			const parent = fx.commit("parent work", { "p.txt": "p\n" });
			fx.git("switch", "-q", "-c", "child", "--track", "feature");
			const c1 = fx.commit("c1", { "a.txt": "c1\n" });
			const stack = await stackRead(fx.repo, cat, undefined);
			expect(stack.baseRef).toBe("refs/remotes/origin/main");
			expect(stack.commits.map((c) => c.oid)).toEqual([parent, c1]);
		});

		test("a remote branch it was cut from and tracks is a parent, not its copy", async () => {
			fx.git("switch", "-q", "--detach", "main");
			const dev = fx.commit("dev work", { "d.txt": "d\n" });
			fx.git("update-ref", "refs/remotes/origin/dev", dev);
			fx.git("switch", "-q", "-c", "cut", "--track", "origin/dev");
			const c1 = fx.commit("c1", { "a.txt": "c1\n" });
			const stack = await stackRead(fx.repo, cat, undefined);
			expect(stack.baseRef).toBe("refs/remotes/origin/main");
			expect(stack.commits.map((c) => c.oid)).toEqual([dev, c1]);
		});

		test("wins a tie with the default branch", async () => {
			fx.git("update-ref", "refs/remotes/origin/feature", "HEAD");
			const f1 = fx.commit("f1", { "a.txt": "f1\n" });
			const stack = await stackRead(fx.repo, cat, undefined);
			expect(stack.baseRef).toBe("refs/remotes/origin/feature");
			expect(stack.commits.map((c) => c.oid)).toEqual([f1]);
		});

		test("a rebase onto a newer default branch starts at the default, not the stale copy", async () => {
			fx.commit("f1", { "a.txt": "f1\n" });
			fx.git("update-ref", "refs/remotes/origin/feature", "HEAD");
			fx.git("switch", "-q", "main");
			const theirs = fx.commit("theirs", { "t.txt": "t\n" });
			fx.git("update-ref", "refs/remotes/origin/main", theirs);
			fx.git("switch", "-q", "feature");
			fx.git("rebase", "-q", "origin/main");
			const rebased = fx.git("rev-parse", "HEAD");
			const stack = await stackRead(fx.repo, cat, undefined);
			expect(stack.baseRef).toBe("refs/remotes/origin/main");
			expect(stack.commits.map((c) => c.oid)).toEqual([rebased]);
		});

		test("after a pushed commit is rewritten, the stack starts where the branch left its copy", async () => {
			const f1 = fx.commit("f1", { "a.txt": "f1\n" });
			fx.commit("f2", { "a.txt": "f2\n" });
			fx.git("update-ref", "refs/remotes/origin/feature", "HEAD");
			fx.git("commit", "-q", "--amend", "-m", "f2 amended");
			const amended = fx.git("rev-parse", "HEAD");
			const f3 = fx.commit("f3", { "a.txt": "f3\n" });
			const stack = await stackRead(fx.repo, cat, undefined);
			expect(stack.baseRef).toBe("refs/remotes/origin/feature");
			expect(stack.baseOid).toBe(f1);
			expect(stack.commits.map((c) => c.oid)).toEqual([amended, f3]);
		});
	});

	test("a base given by the caller wins over suonetar.base and detection", async () => {
		fx.git("switch", "-q", "-c", "feature");
		const c1 = fx.commit("one", { "a.txt": "1\n" });
		fx.git("branch", "core", c1);
		const c2 = fx.commit("two", { "a.txt": "2\n" });
		fx.git("config", "suonetar.base", "main");
		const stack = await stackRead(fx.repo, cat, "core");
		expect(stack.baseRef).toBe("core");
		expect(stack.baseOid).toBe(c1);
		expect(stack.commits.map((c) => c.oid)).toEqual([c2]);
	});

	test("a base that names no commit is refused with a reason that names it", async () => {
		fx.git("switch", "-q", "-c", "feature");
		fx.commit("one", { "a.txt": "1\n" });
		const fromCaller = await stackRead(fx.repo, cat, "origin/nope").catch((err: unknown) => err);
		fx.git("config", "suonetar.base", "nope");
		const fromConfig = await stackRead(fx.repo, cat, undefined).catch((err: unknown) => err);
		expect(fromCaller).toBeInstanceOf(ErrorNoBase);
		expect(fromConfig).toBeInstanceOf(ErrorNoBase);
		expect(String(fromCaller)).toContain("origin/nope");
		expect(String(fromConfig)).toContain("nope");
		expect(String(fromCaller).replace("origin/nope", "nope")).not.toBe(String(fromConfig));
	});

	test("reads suonetar.base as git config --get does: an empty value, the last of several, spaces kept", async () => {
		fx.git("switch", "-q", "-c", "feature");
		fx.commit("the base", { "b.txt": "b\n" });
		const mark = fx.git("rev-parse", "HEAD");
		fx.commit("one", { "a.txt": "1\n" });
		appendFileSync(join(fx.dir, ".git", "config"), "[suonetar]\n\tbase\n");
		const empty = await stackRead(fx.repo, cat, undefined).catch((err: unknown) => err);
		expect(String(empty)).toBe(String(new ErrorNoBase("feature", { kind: "chosen", ref: "", by: "config" })));
		fx.git("config", "--unset-all", "suonetar.base");
		fx.git("config", "--add", "suonetar.base", "nope");
		fx.git("config", "--add", "suonetar.base", "feature^{/the base}");
		const stack = await stackRead(fx.repo, cat, undefined);
		expect(stack.baseRef).toBe("feature^{/the base}");
		expect(stack.baseOid).toBe(mark);
	});

	test("a candidate holding an annotated tag, or a tag of one, resolves to its commit", async () => {
		const base = fx.git("rev-parse", "HEAD");
		fx.git("switch", "-q", "-c", "feature");
		fx.commit("one", { "a.txt": "1\n" });
		fx.git("tag", "-a", "-m", "tag", "inner", base);
		fx.git("tag", "-a", "-m", "tag of a tag", "outer", "inner");
		fx.git("branch", "-q", "-D", "main");
		for (const tag of ["inner", "outer"]) {
			fx.git("update-ref", "refs/remotes/origin/main", fx.git("rev-parse", `refs/tags/${tag}`));
			const stack = await stackRead(fx.repo, cat, undefined);
			expect(stack.baseRef).toBe("refs/remotes/origin/main");
			expect(stack.baseOid).toBe(base);
		}
	});

	test("reads the stack in a few processes, none spent on the bases that are not there", async () => {
		fx.git("switch", "-q", "-c", "feature");
		fx.commit("one", { "a.txt": "1\n" });
		fx.commit("two", { "a.txt": "2\n" });
		const calls: string[][] = [];
		const counted = {
			...fx.repo,
			run: (args: readonly string[], opts: Parameters<typeof fx.repo.run>[1]) => {
				calls.push([...args]);
				return fx.repo.run(args, opts);
			},
		};
		const counts = async (): Promise<{ mergeBases: number; others: number }> => {
			calls.length = 0;
			await stackRead(counted, cat, undefined);
			const mergeBases = calls.filter((a) => a[0] === "merge-base").length;
			return { mergeBases, others: calls.length - mergeBases };
		};
		// Only main exists of the candidate bases.
		const alone = await counts();
		expect(alone.mergeBases).toBe(1);
		// Main's commit on origin's main and master and upstream's main, origin's HEAD naming its main, and the branch's copy on origin a commit behind: candidates at two distinct commits.
		const main = fx.git("rev-parse", "main");
		for (const ref of ["refs/remotes/origin/main", "refs/remotes/upstream/main", "refs/remotes/origin/master"]) {
			fx.git("update-ref", ref, main);
		}
		fx.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
		fx.git("update-ref", "refs/remotes/origin/feature", fx.git("rev-parse", "feature~1"));
		const crowded = await counts();
		expect(crowded.others).toBe(alone.others);
		// One merge-base for each distinct commit among the candidates, and one comparison between them.
		expect(crowded.mergeBases).toBe(3);
		expect(alone.others).toBeLessThanOrEqual(5);
	});

	test("a branch naming an object that is not in the repository does not stop the read", async () => {
		const base = fx.git("rev-parse", "HEAD");
		mkdirSync(join(fx.dir, ".git", "refs", "heads", "zz"), { recursive: true });
		writeFileSync(join(fx.dir, ".git", "refs", "heads", "zz", "old"), `${"2".repeat(40)}\n`);
		fx.git("switch", "-q", "-c", "feature");
		fx.commit("one", { "a.txt": "1\n" });
		const stack = await stackRead(fx.repo, cat, undefined);
		expect(stack.baseRef).toBe("refs/heads/main");
		expect(stack.baseOid).toBe(base);
	});

	test("refuses a detached HEAD", async () => {
		fx.git("switch", "-q", "--detach", "HEAD");
		await expect(stackRead(fx.repo, cat, undefined)).rejects.toBeInstanceOf(ErrorNotOnBranch);
	});

	test("cuts the stack at a merge, keeping the merge as the base", async () => {
		fx.git("switch", "-q", "-c", "feature");
		fx.commit("early", { "early.txt": "e\n" });
		fx.git("switch", "-q", "main");
		fx.commit("main advances", { "m.txt": "m\n" });
		fx.git("switch", "-q", "feature");
		fx.git("merge", "-q", "--no-edit", "main");
		const merge = fx.git("rev-parse", "HEAD");
		const c1 = fx.commit("after merge", { "a.txt": "after\n" });
		const stack = await stackRead(fx.repo, cat, undefined);
		expect(stack.frozenBelow).toBe(merge);
		expect(stack.baseOid).toBe(merge);
		expect(stack.commits.map((c) => c.oid)).toEqual([c1]);
	});

	test("marks commits reachable from any remote as published", async () => {
		fx.git("switch", "-q", "-c", "feature");
		const c1 = fx.commit("pushed", { "a.txt": "1\n" });
		fx.git("update-ref", "refs/remotes/fork/feature", c1);
		fx.commit("local", { "a.txt": "2\n" });
		const stack = await stackRead(fx.repo, cat, undefined);
		expect(stack.commits.map((c) => c.published)).toEqual([true, false]);
	});

	test("reports other branches that contain stack commits as left behind", async () => {
		fx.git("switch", "-q", "-c", "feature");
		const c1 = fx.commit("one", { "a.txt": "1\n" });
		fx.git("branch", "backup", c1);
		fx.commit("two", { "a.txt": "2\n" });
		fx.git("branch", "unrelated", "main");
		expect((await stackRead(fx.repo, cat, undefined)).leftBehind).toEqual(["backup"]);
	});
});
