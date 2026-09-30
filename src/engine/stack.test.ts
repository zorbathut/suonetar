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

	afterEach(() => {
		cat.close();
		fx.cleanup();
	});

	test("lists the commits between main and the branch, oldest first", async () => {
		const base = fx.git("rev-parse", "HEAD");
		fx.git("switch", "-q", "-c", "feature");
		const c1 = fx.commit("one", { "a.txt": "1\n" });
		const c2 = fx.commit("two", { "b.txt": "2\n" });
		const stack = await stackRead(fx.repo, cat);
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
		expect((await stackRead(fx.repo, cat)).baseRef).toBe("refs/heads/master");

		const mid = fx.git("rev-parse", "HEAD");
		fx.git("branch", "mid", mid);
		fx.commit("two", { "a.txt": "2\n" });
		fx.git("config", "suonetar.base", "mid");
		const stack = await stackRead(fx.repo, cat);
		expect(stack.baseOid).toBe(mid);
		expect(stack.commits).toHaveLength(1);

		fx.git("config", "--unset", "suonetar.base");
		fx.git("switch", "-q", "master");
		await expect(stackRead(fx.repo, cat)).rejects.toBeInstanceOf(ErrorNoBase);
	});

	test("prefers a remote base whose merge-base is newer than the stale local one", async () => {
		fx.git("switch", "-q", "-c", "feature");
		const upstreamWork = fx.commit("someone else's work on main", { "u.txt": "u\n" });
		fx.git("update-ref", "refs/remotes/origin/main", upstreamWork);
		const mine = fx.commit("mine", { "a.txt": "mine\n" });
		const stack = await stackRead(fx.repo, cat);
		expect(stack.baseRef).toBe("refs/remotes/origin/main");
		expect(stack.commits.map((c) => c.oid)).toEqual([mine]);
	});

	test("refuses a detached HEAD", async () => {
		fx.git("switch", "-q", "--detach", "HEAD");
		await expect(stackRead(fx.repo, cat)).rejects.toBeInstanceOf(ErrorNotOnBranch);
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
		const stack = await stackRead(fx.repo, cat);
		expect(stack.frozenBelow).toBe(merge);
		expect(stack.baseOid).toBe(merge);
		expect(stack.commits.map((c) => c.oid)).toEqual([c1]);
	});

	test("marks commits reachable from any remote as published", async () => {
		fx.git("switch", "-q", "-c", "feature");
		const c1 = fx.commit("pushed", { "a.txt": "1\n" });
		fx.git("update-ref", "refs/remotes/fork/feature", c1);
		fx.commit("local", { "a.txt": "2\n" });
		const stack = await stackRead(fx.repo, cat);
		expect(stack.commits.map((c) => c.published)).toEqual([true, false]);
	});

	test("reports other branches that contain stack commits as left behind", async () => {
		fx.git("switch", "-q", "-c", "feature");
		const c1 = fx.commit("one", { "a.txt": "1\n" });
		fx.git("branch", "backup", c1);
		fx.commit("two", { "a.txt": "2\n" });
		fx.git("branch", "unrelated", "main");
		expect((await stackRead(fx.repo, cat)).leftBehind).toEqual(["backup"]);
	});
});
