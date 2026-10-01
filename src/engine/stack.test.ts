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

	test("on the remote's default branch itself, the stack is the unpushed commits", async () => {
		fx.git("switch", "-q", "-c", "dev");
		const pushed = fx.commit("pushed", { "a.txt": "pushed\n" });
		fx.git("update-ref", "refs/remotes/origin/dev", pushed);
		fx.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/dev");
		let stack = await stackRead(fx.repo, cat);
		expect(stack.baseRef).toBe("refs/remotes/origin/dev");
		expect(stack.commits).toEqual([]);
		const local = fx.commit("local", { "a.txt": "local\n" });
		stack = await stackRead(fx.repo, cat);
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
		const stack = await stackRead(fx.repo, cat);
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
		const stack = await stackRead(fx.repo, cat);
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
		const stack = await stackRead(fx.repo, cat);
		expect(stack.baseRef).toBe("refs/heads/dev");
		expect(stack.commits.map((c) => c.oid)).toEqual([mine]);
	});

	test("a remote HEAD left dangling by a pruned default falls back instead of failing", async () => {
		fx.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/gone");
		fx.git("switch", "-q", "-c", "feature");
		const mine = fx.commit("mine", { "a.txt": "mine\n" });
		const stack = await stackRead(fx.repo, cat);
		expect(stack.baseRef).toBe("refs/heads/main");
		expect(stack.commits.map((c) => c.oid)).toEqual([mine]);
	});

	test("init.defaultBranch names a base when there is no remote", async () => {
		fx.git("branch", "-m", "trunk");
		fx.git("config", "init.defaultBranch", "trunk");
		const base = fx.git("rev-parse", "HEAD");
		fx.git("switch", "-q", "-c", "feature");
		fx.commit("one", { "a.txt": "1\n" });
		const stack = await stackRead(fx.repo, cat);
		expect(stack.baseRef).toBe("refs/heads/trunk");
		expect(stack.baseOid).toBe(base);
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
