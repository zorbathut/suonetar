import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Oid } from "./git.ts";
import { Session } from "./session.ts";
import { type Fixture, lineSet, lines, repoFixture } from "./test-support/repo.ts";
import { reflogMessage, reflogParse } from "./undo.ts";

describe("reflog messages", () => {
	test("round-trip, so an entry's old tip is read from its own message", () => {
		const old = "a".repeat(40);
		expect(reflogParse(reflogMessage("apply", 3, old))).toEqual({ verb: "apply", count: 3, old });
		expect(reflogParse(reflogMessage("redo", 1, old))).toEqual({ verb: "redo", count: 1, old });
		expect(reflogParse(`${reflogMessage("undo", 2, old)} (rolled back)`)).toBeUndefined();
		expect(reflogParse("commit: suonetar: apply 2 commits from x")).toBeUndefined();
	});
});

describe("undo", () => {
	let fx: Fixture;
	let session: Session;
	let c1: Oid;
	let c2: Oid;
	let c3: Oid;
	const edited = lineSet(lineSet(lines("a"), 2, "c1"), 6, "edit");
	const disk = (path: string) => readFileSync(join(fx.dir, path), "utf8");
	const tree = (rev: string) => fx.git("rev-parse", `${rev}^{tree}`);

	beforeEach(async () => {
		fx = await repoFixture();
		fx.commit("base", { "a.txt": lines("a"), "b.txt": lines("b"), "c.txt": lines("c") });
		fx.git("switch", "-q", "-c", "feature");
		c1 = fx.commit("c1", { "a.txt": lineSet(lines("a"), 2, "c1") });
		c2 = fx.commit("c2", { "b.txt": lineSet(lines("b"), 2, "c2") });
		c3 = fx.commit("c3", { "c.txt": lineSet(lines("c"), 2, "c3") });
		session = await Session.openRepo(fx.repo, undefined);
	});

	afterEach(() => {
		session.close();
		fx.cleanup();
	});

	async function ready() {
		const state = await session.state();
		if (state.kind !== "ready") {
			throw new Error(`state is ${state.kind}`);
		}
		return state;
	}

	async function undoInfo() {
		return (await ready()).undo;
	}

	async function applied(): Promise<Oid> {
		expect((await session.apply({ kind: "run", skip: [] }, () => undefined)).kind).toBe("published");
		return fx.git("rev-parse", "HEAD");
	}

	async function unavailableReason(): Promise<string> {
		const info = await undoInfo();
		if (info?.kind !== "unavailable" || info.reason === "") {
			throw new Error(`undo is ${info?.kind}`);
		}
		return info.reason;
	}

	async function undoNow() {
		const info = await undoInfo();
		if (info === undefined || info.kind === "unavailable") {
			throw new Error(`undo is ${info?.kind}`);
		}
		return session.undo(info.old, info.new, info.kind);
	}

	test("is not offered before Suonetar moved the branch", async () => {
		expect(await undoInfo()).toBeUndefined();
	});

	test("puts back the exact commits, then redoes, then undoes again", async () => {
		await session.draftSetFile(c1, "a.txt", Buffer.from(edited));
		const appliedTip = await applied();
		expect(await undoInfo()).toEqual({ kind: "exact", verb: "undo", old: c3, new: appliedTip, commits: 3, pushed: 0 });

		expect(await undoNow()).toEqual({ kind: "published", verb: "undo" });
		expect(fx.git("rev-parse", "HEAD")).toBe(c3);
		expect(disk("a.txt")).toBe(lineSet(lines("a"), 2, "c1"));
		expect(fx.git("status", "--porcelain")).toBe("");
		expect(fx.git("reflog", "-1", "--format=%gs", "feature")).toBe(`suonetar: undo 3 commits from ${appliedTip}`);

		expect(await undoInfo()).toMatchObject({ kind: "exact", verb: "redo", old: appliedTip, new: c3 });
		expect(await undoNow()).toEqual({ kind: "published", verb: "redo" });
		expect(fx.git("rev-parse", "HEAD")).toBe(appliedTip);
		expect(disk("a.txt")).toBe(edited);

		expect(await undoInfo()).toMatchObject({ kind: "exact", verb: "undo", old: c3, new: appliedTip });
		expect(await undoNow()).toEqual({ kind: "published", verb: "undo" });
		expect(fx.git("rev-parse", "HEAD")).toBe(c3);
	});

	test("counts replaced commits that are already pushed, even once they sit below the base", async () => {
		await session.draftSetFile(c2, "b.txt", Buffer.from("pushed edit\n"));
		const appliedTip = await applied();
		fx.git("update-ref", "refs/remotes/origin/main", appliedTip);
		const state = await ready();
		expect(state.stack.commits).toEqual([]);
		expect(state.undo).toMatchObject({ kind: "exact", commits: 2, pushed: 2 });
	});

	test("skips a move that was rolled back", async () => {
		await session.draftSetFile(c1, "a.txt", Buffer.from(edited));
		const appliedTip = await applied();
		const other = fx.git("commit-tree", "-p", appliedTip, "-m", "other", tree(appliedTip));
		fx.git("update-ref", "-m", reflogMessage("apply", 1, appliedTip), "refs/heads/feature", other, appliedTip);
		fx.git("update-ref", "-m", `${reflogMessage("apply", 1, appliedTip)} (rolled back)`, "refs/heads/feature", appliedTip, other);
		fx.git("reset", "-q", "--hard");
		expect(await undoInfo()).toMatchObject({ kind: "exact", old: c3, new: appliedTip });
	});

	test("refuses over an uncommitted change to a file it would rewrite, and leaves the change alone", async () => {
		await session.draftSetFile(c1, "a.txt", Buffer.from(edited));
		const appliedTip = await applied();
		writeFileSync(join(fx.dir, "a.txt"), "mine\n");
		expect((await undoNow()).kind).toBe("refused");
		expect(disk("a.txt")).toBe("mine\n");
		expect(fx.git("rev-parse", "HEAD")).toBe(appliedTip);
	});

	test("after commits on top, writes drafts that restore the replaced commits, and applying them keeps the new work", async () => {
		await session.draftSetFile(c1, "a.txt", Buffer.from(edited));
		const appliedTip = await applied();
		const c4 = fx.commit("c4", { "d.txt": "claude\n" });
		const info = await undoInfo();
		expect(info).toEqual({ kind: "edits", verb: "undo", old: c3, new: appliedTip, commits: 3 });

		expect(await undoNow()).toEqual({ kind: "drafted", verb: "undo", drafts: 1 });
		const state = await ready();
		expect(state.drafts.map((d) => [d.kind, d.draft.meta.subject])).toEqual([["current", "c1"]]);
		expect(fx.git("rev-parse", "HEAD")).toBe(c4);

		await applied();
		expect(tree("HEAD~1")).toBe(tree(c3));
		expect(fx.git("show", "HEAD:d.txt")).toBe("claude");
		expect(fx.git("log", "--format=%s", "-4").split("\n")).toEqual(["c4", "c3", "c2", "c1"]);
	});

	test("restores a changed message as a message-only draft", async () => {
		await session.draftSetMessage(c2, Buffer.from("c2 reworded\n"));
		await applied();
		fx.commit("c4", { "d.txt": "claude\n" });
		expect(await undoNow()).toEqual({ kind: "drafted", verb: "undo", drafts: 1 });
		const [status] = (await ready()).drafts;
		expect(status?.draft.tree).toBeUndefined();
		expect(Buffer.from(status?.draft.meta.message ?? "", "base64").toString()).toBe("c2\n");
	});

	test("drafts for commits rewritten since show as rebased", async () => {
		await session.draftSetFile(c1, "a.txt", Buffer.from(edited));
		await applied();
		fx.git("rebase", "-q", "--force-rebase", "main");
		expect(await undoNow()).toEqual({ kind: "drafted", verb: "undo", drafts: 1 });
		expect((await ready()).drafts.map((d) => d.kind)).toEqual(["rebased"]);
	});

	test("a commit whose replay needed a resolution gets its old tree as the draft", async () => {
		const base = fx.git("rev-parse", "main");
		fx.git("reset", "-q", "--hard", base);
		const k1 = fx.commit("k1", { "a.txt": lineSet(lines("a"), 2, "k1") });
		const k2 = fx.commit("k2", { "a.txt": lineSet(lineSet(lines("a"), 2, "k1"), 3, "k2") });
		session.close();
		session = await Session.openRepo(fx.repo, undefined);
		await session.draftSetFile(k1, "a.txt", Buffer.from(lineSet(lineSet(lines("a"), 2, "k1"), 3, "edit")));
		const preview = await session.preview();
		if (preview.kind !== "conflict") {
			throw new Error(`preview is ${preview.kind}`);
		}
		const key = preview.conflicts[0]?.key ?? "";
		const resolved = lineSet(lineSet(lines("a"), 2, "k1"), 3, "both");
		expect(await session.resolve(preview.inputs, key, [{ path: "a.txt", content: Buffer.from(resolved), markersAllowed: false }])).toEqual({ kind: "resolved" });
		await applied();
		fx.commit("k3", { "d.txt": "claude\n" });
		expect(await undoNow()).toEqual({ kind: "drafted", verb: "undo", drafts: 2 });
		const drafts = (await ready()).drafts;
		expect(drafts.find((d) => d.draft.meta.subject === "k2")?.draft.tree).toBe(tree(k2));
		// The stored resolution went with the apply, so applying the undo asks again.
		expect((await session.preview()).kind).toBe("conflict");
	});

	test("leaves an edit made on another branch alone, refusing rather than overwriting it", async () => {
		await session.draftSetFile(c1, "a.txt", Buffer.from(edited));
		await applied();
		fx.commit("c4", { "d.txt": "claude\n" });
		const c1Applied = fx.git("rev-parse", "HEAD~3");
		fx.git("switch", "-q", "-c", "other");
		await session.draftSetFile(c1Applied, "b.txt", Buffer.from("elsewhere\n"));
		fx.git("switch", "-q", "feature");
		expect((await undoInfo())?.kind).toBe("edits");
		const refused = await undoNow();
		expect(refused.kind).toBe("unavailable");
		const [status] = (await ready()).drafts;
		expect(status?.kind).toBe("elsewhere");
		expect(fx.git("show", `${status?.draft.tree}:b.txt`)).toBe("elsewhere");
	});

	test("is unavailable when a commit it would restore was dropped from the stack, or its entry is in an unknown form", async () => {
		await session.draftSetFile(c1, "a.txt", Buffer.from(edited));
		const appliedTip = await applied();
		fx.git("rebase", "-q", "--onto", "HEAD~2", "HEAD~1");
		const dropped = await unavailableReason();

		fx.git("reset", "-q", "--hard", appliedTip);
		const older = fx.git("commit-tree", "-p", appliedTip, "-m", "older", tree(appliedTip));
		fx.git("update-ref", "-m", "suonetar: apply 1 commits", "refs/heads/feature", older);
		fx.git("reset", "-q", "--hard");
		expect(await unavailableReason()).not.toBe(dropped);
	});

	test("is unavailable while drafts exist, after a manual reset, or when the entry's commits are gone", async () => {
		await session.draftSetFile(c1, "a.txt", Buffer.from(edited));
		const appliedTip = await applied();
		const reasons: string[] = [];
		const c2Applied = fx.git("rev-parse", "HEAD~1");
		await session.draftSetFile(c2Applied, "b.txt", Buffer.from("later\n"));
		reasons.push(await unavailableReason());
		await session.draftDiscard(c2Applied);

		fx.git("reset", "-q", "--hard", c3);
		reasons.push(await unavailableReason());

		fx.git("reset", "-q", "--hard", appliedTip);
		const moved = fx.git("commit-tree", "-p", appliedTip, "-m", "moved", tree(appliedTip));
		fx.git("update-ref", "-m", reflogMessage("apply", 1, "1".repeat(40)), "refs/heads/feature", moved);
		fx.git("reset", "-q", "--hard");
		reasons.push(await unavailableReason());
		// Each case is refused for its own reason.
		expect(new Set(reasons).size).toBe(3);
	});

	test("refuses as stale when the move changed after the user confirmed it", async () => {
		await session.draftSetFile(c1, "a.txt", Buffer.from(edited));
		const appliedTip = await applied();
		expect(await session.undo(c3, appliedTip, "edits")).toEqual({ kind: "stale" });
		expect(await session.undo(c2, appliedTip, "exact")).toEqual({ kind: "stale" });
		expect(fx.git("rev-parse", "HEAD")).toBe(appliedTip);
	});
});
