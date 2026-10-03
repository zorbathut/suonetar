import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ErrorEditStale } from "./errors.ts";
import type { Oid } from "./git.ts";
import { CatFile } from "./objects.ts";
import { type CommitStatus, Session } from "./session.ts";
import { storeRead, storeWrite } from "./store.ts";
import { draftFile } from "./test-support/drafts.ts";
import { type Fixture, lineSet, lines, repoFixture } from "./test-support/repo.ts";
import { TIMEOUT_SCALE } from "./test-support/timeout.ts";

// Edits carried up the stack before Apply: what each commit shows, how edits made on top of edits below are kept, and how conflicts are tagged and resolved where they arise.
describe("restacking", () => {
	let fx: Fixture;
	let session: Session;

	beforeEach(async () => {
		fx = await repoFixture();
		fx.commit("base", { "a.txt": lines("a"), "b.txt": lines("b") });
		fx.git("switch", "-q", "-c", "feature");
		session = await Session.openRepo(fx.repo, undefined);
	});

	afterEach(async () => {
		session.close();
		await fx.cleanup();
	});

	async function statuses(): Promise<Map<Oid, CommitStatus>> {
		const state = await session.state();
		if (state.kind !== "ready") {
			throw new Error(`state is ${state.kind}`);
		}
		return new Map(state.commits.map((c) => [c.oid, c]));
	}

	async function kinds(): Promise<string[]> {
		return [...(await statuses()).values()].map((s) => s.kind);
	}

	async function file(oid: Oid, path: string) {
		const found = (await session.commitDocument(oid)).files.find((f) => f.path === path);
		if (found === undefined) {
			throw new Error(`${path} not in the document of ${oid}`);
		}
		return { parent: found.parent?.toString(), commit: found.commit?.toString(), draft: found.draft?.toString(), provisional: found.provisional, mineUnknown: found.mineUnknown };
	}

	async function applied(): Promise<void> {
		expect((await session.apply({ kind: "skip" }, () => undefined)).kind).toBe("published");
	}

	async function conflictOf(oid: Oid) {
		return session.commitConflict(oid);
	}

	test("an edit below shows in the documents above it, on both sides of their diffs", async () => {
		const c1 = fx.commit("c1", { "a.txt": lineSet(lines("a"), 2, "c1") });
		const c2 = fx.commit("c2", { "a.txt": lineSet(lineSet(lines("a"), 2, "c1"), 8, "c2") });
		await draftFile(session, c1, "a.txt", Buffer.from(lineSet(lineSet(lines("a"), 2, "c1"), 5, "edit")));
		const above = await file(c2, "a.txt");
		expect(above.parent).toBe(lineSet(lineSet(lines("a"), 2, "c1"), 5, "edit"));
		expect(above.draft).toBe(lineSet(lineSet(lineSet(lines("a"), 2, "c1"), 5, "edit"), 8, "c2"));
		// The commit's own change, restacked: nothing the user did to it.
		expect(above.commit).toBe(above.draft);
		expect(await kinds()).toEqual(["edited", "rewritten"]);
	});

	test("an edit made on top of an edit below keeps both when the one below changes again", async () => {
		const c1 = fx.commit("c1", { "a.txt": lineSet(lines("a"), 2, "c1") });
		const c2 = fx.commit("c2", { "b.txt": lineSet(lines("b"), 2, "c2") });
		await draftFile(session, c1, "a.txt", Buffer.from(lineSet(lineSet(lines("a"), 2, "c1"), 4, "below")));
		// Typed in c2's restacked view, which shows the edit below: the save must not bake it in a second time, or lose it.
		await draftFile(session, c2, "a.txt", Buffer.from(lineSet(lineSet(lineSet(lines("a"), 2, "c1"), 4, "below"), 9, "above")));
		await draftFile(session, c1, "a.txt", Buffer.from(lineSet(lineSet(lines("a"), 2, "c1"), 4, "below again")));
		expect((await file(c2, "a.txt")).draft).toBe(lineSet(lineSet(lineSet(lines("a"), 2, "c1"), 4, "below again"), 9, "above"));
		await applied();
		expect(fx.git("show", "HEAD:a.txt")).toBe(lineSet(lineSet(lineSet(lines("a"), 2, "c1"), 4, "below again"), 9, "above").trimEnd());
		expect(fx.git("show", "HEAD~1:a.txt")).toBe(lineSet(lineSet(lines("a"), 2, "c1"), 4, "below again").trimEnd());
	});

	test("reverting an edit made on top of an edit below drops the draft", async () => {
		const c1 = fx.commit("c1", { "a.txt": lineSet(lines("a"), 2, "c1") });
		const c2 = fx.commit("c2", { "b.txt": lineSet(lines("b"), 2, "c2") });
		await draftFile(session, c1, "a.txt", Buffer.from(lineSet(lineSet(lines("a"), 2, "c1"), 4, "below")));
		const shown = lineSet(lineSet(lines("a"), 2, "c1"), 4, "below");
		await draftFile(session, c2, "a.txt", Buffer.from(lineSet(shown, 9, "above")));
		expect(await kinds()).toEqual(["edited", "edited"]);
		await draftFile(session, c2, "a.txt", Buffer.from(shown));
		expect(await kinds()).toEqual(["edited", "rewritten"]);
	});

	test("a save from a document whose commit changed underneath merges into it rather than overwriting it", async () => {
		const c1 = fx.commit("c1", { "a.txt": lineSet(lines("a"), 2, "c1") });
		const c2 = fx.commit("c2", { "a.txt": lineSet(lineSet(lines("a"), 2, "c1"), 8, "c2"), "b.txt": lineSet(lines("b"), 2, "c2") });
		const doc = await session.commitDocument(c2);
		const shownA = doc.files.find((f) => f.path === "a.txt")?.draftOid ?? null;
		const shownB = doc.files.find((f) => f.path === "b.txt")?.draftOid ?? null;
		// Another window edits the commit below, in a line of a.txt this document showed as it was.
		const other = await Session.openRepo(fx.repo, undefined);
		try {
			await draftFile(other, c1, "a.txt", Buffer.from(lineSet(lineSet(lines("a"), 2, "c1"), 5, "other window")));
		} finally {
			other.close();
		}
		// b.txt is as this document showed it, so the edit lands on the commit as it is now.
		await session.draftSetFile(c2, doc.parentTree, "b.txt", shownB, Buffer.from(lineSet(lineSet(lines("b"), 2, "c2"), 7, "mine")));
		// a.txt changed since; the edit is laid on the commit as the document showed it, and the change below merges in.
		await session.draftSetFile(c2, doc.parentTree, "a.txt", shownA, Buffer.from(lineSet(lineSet(lineSet(lines("a"), 2, "c1"), 8, "c2"), 10, "mine")));
		expect((await file(c2, "a.txt")).draft).toBe(lineSet(lineSet(lineSet(lineSet(lines("a"), 2, "c1"), 5, "other window"), 8, "c2"), 10, "mine"));
		expect((await file(c2, "b.txt")).draft).toBe(lineSet(lineSet(lines("b"), 2, "c2"), 7, "mine"));
	});

	test("a save naming a version of the file that was never shown is refused as stale", async () => {
		const c1 = fx.commit("c1", { "a.txt": lineSet(lines("a"), 2, "c1") });
		const doc = await session.commitDocument(c1);
		const elsewhere = fx.git("hash-object", "-w", "--stdin");
		await expect(session.draftSetFile(c1, doc.parentTree, "a.txt", elsewhere, Buffer.from("x\n"))).rejects.toBeInstanceOf(ErrorEditStale);
	});

	describe("conflicts", () => {
		let c1: Oid;
		let c2: Oid;
		let c3: Oid;

		beforeEach(() => {
			c1 = fx.commit("c1", { "a.txt": lineSet(lines("a"), 5, "c1") });
			c2 = fx.commit("c2", { "a.txt": lineSet(lines("a"), 5, "c2") });
			c3 = fx.commit("c3", { "a.txt": lineSet(lineSet(lines("a"), 5, "c2"), 9, "c3") });
			fx.commit("c4", { "b.txt": lineSet(lines("b"), 1, "c4") });
		});

		const edited = lineSet(lines("a"), 5, "edited");

		test("are tagged where they arise, and the commits above still derive with their own changes", async () => {
			await draftFile(session, c1, "a.txt", Buffer.from(edited));
			expect(await kinds()).toEqual(["edited", "conflict", "rewritten", "rewritten"]);
			const above = (await statuses()).get(c3);
			expect(above?.provisional).toEqual(["a.txt"]);
			expect(above?.conflictBelow).toBe(c2);
			// c3's own change on the conflicted file, against c2's own version of it.
			const shown = await file(c3, "a.txt");
			expect(shown.provisional).toBe(true);
			expect(shown.parent).toBe(lineSet(lines("a"), 5, "c2"));
			expect(shown.draft).toBe(lineSet(lineSet(lines("a"), 5, "c2"), 9, "c3"));
			expect((await session.preview()).kind).toBe("conflict");
			expect((await session.apply({ kind: "skip" }, () => undefined)).kind).toBe("conflict");
		});

		test("an edit above an unresolved conflict merges with its resolution", async () => {
			await draftFile(session, c1, "a.txt", Buffer.from(edited));
			await draftFile(session, c3, "a.txt", Buffer.from(lineSet(lineSet(lineSet(lines("a"), 5, "c2"), 9, "c3"), 1, "edit above")));
			const report = await conflictOf(c2);
			expect(report.edited).toBe(false);
			const [conflict] = report.conflicts;
			expect(
				await session.resolve(report.inputs, conflict?.key ?? "", [{ path: "a.txt", content: Buffer.from(lineSet(lines("a"), 5, "edited and c2")), markersAllowed: false }]),
			).toEqual({
				kind: "resolved",
			});
			expect(await kinds()).toEqual(["edited", "resolved", "edited", "rewritten"]);
			expect((await file(c3, "a.txt")).draft).toBe(lineSet(lineSet(lineSet(lines("a"), 5, "edited and c2"), 9, "c3"), 1, "edit above"));
			await applied();
			expect(fx.git("show", "HEAD~1:a.txt")).toBe(lineSet(lineSet(lineSet(lines("a"), 5, "edited and c2"), 9, "c3"), 1, "edit above").trimEnd());
		});

		test("a resolution keeps the commit's message edit, survives a disjoint edit below, and is redone after an overlapping one", async () => {
			await draftFile(session, c1, "a.txt", Buffer.from(edited));
			await session.draftSetMessage(c2, Buffer.from("c2 reworded\n"));
			const report = await conflictOf(c2);
			await session.resolve(report.inputs, report.conflicts[0]?.key ?? "", [{ path: "a.txt", content: Buffer.from(lineSet(lines("a"), 5, "both")), markersAllowed: false }]);
			expect((await session.commitDocument(c2)).draftMessage?.toString()).toBe("c2 reworded\n");
			await draftFile(session, c1, "a.txt", Buffer.from(lineSet(edited, 1, "disjoint")));
			expect(await kinds()).toEqual(["edited", "resolved", "rewritten", "rewritten"]);
			expect((await file(c2, "a.txt")).draft).toBe(lineSet(lineSet(lines("a"), 5, "both"), 1, "disjoint"));
			await draftFile(session, c1, "a.txt", Buffer.from(lineSet(lineSet(lines("a"), 5, "edited again"), 1, "disjoint")));
			expect((await statuses()).get(c2)?.kind).toBe("conflict");
			expect((await conflictOf(c2)).edited).toBe(true);
		});

		test("discarding the edit that caused a resolved conflict gives back the commit as it was", async () => {
			await draftFile(session, c1, "a.txt", Buffer.from(edited));
			const report = await conflictOf(c2);
			await session.resolve(report.inputs, report.conflicts[0]?.key ?? "", [{ path: "a.txt", content: Buffer.from(lineSet(lines("a"), 5, "both")), markersAllowed: false }]);
			await session.draftDiscard(c1);
			expect(await kinds()).toEqual(["unchanged", "unchanged", "unchanged", "unchanged"]);
			expect((await file(c2, "a.txt")).draft).toBe(lineSet(lines("a"), 5, "c2"));
			// Nothing is left stored that would keep Undo or Apply waiting.
			const state = await session.state();
			expect(state.kind === "ready" && state.drafts).toEqual([]);
		});

		test("undoing the edit that caused a resolved conflict, in the editor, gives back the commit's own edit", async () => {
			await draftFile(session, c2, "a.txt", Buffer.from(lineSet(lineSet(lines("a"), 5, "c2"), 1, "mine")));
			await draftFile(session, c1, "a.txt", Buffer.from(edited));
			const report = await conflictOf(c2);
			await session.resolve(report.inputs, report.conflicts[0]?.key ?? "", [
				{ path: "a.txt", content: Buffer.from(lineSet(lineSet(lines("a"), 5, "both"), 1, "mine")), markersAllowed: false },
			]);
			await draftFile(session, c1, "a.txt", Buffer.from(lineSet(lines("a"), 5, "c1")));
			expect(await kinds()).toEqual(["unchanged", "edited", "rewritten", "rewritten"]);
			expect((await file(c2, "a.txt")).draft).toBe(lineSet(lineSet(lines("a"), 5, "c2"), 1, "mine"));
		});

		test("a save to a commit that became conflicted meanwhile is kept, and the conflict stays", async () => {
			const doc = await session.commitDocument(c2);
			const shown = doc.files.find((f) => f.path === "a.txt")?.draftOid ?? null;
			await draftFile(session, c1, "a.txt", Buffer.from(edited));
			await session.draftSetFile(c2, doc.parentTree, "a.txt", shown, Buffer.from(lineSet(lineSet(lines("a"), 5, "c2"), 1, "typed")));
			expect((await statuses()).get(c2)?.kind).toBe("conflict");
			const report = await conflictOf(c2);
			expect(report.edited).toBe(true);
			expect(fx.git("cat-file", "blob", `${report.inputs.theirs}:a.txt`)).toBe(lineSet(lineSet(lines("a"), 5, "c2"), 1, "typed").trimEnd());
		});
	});

	test("a commit with two conflicts stays tagged until both are resolved, then holds the resolution", async () => {
		const c1 = fx.commit("c1", { "a.txt": lineSet(lines("a"), 5, "c1"), "b.txt": lineSet(lines("b"), 5, "c1") });
		const c2 = fx.commit("c2", { "a.txt": lineSet(lines("a"), 5, "c2"), "b.txt": lineSet(lines("b"), 5, "c2") });
		await draftFile(session, c1, "a.txt", Buffer.from(lineSet(lines("a"), 5, "edited")));
		await draftFile(session, c1, "b.txt", Buffer.from(lineSet(lines("b"), 5, "edited")));
		const report = await session.commitConflict(c2);
		expect(report.conflicts.map((c) => c.paths)).toEqual([["a.txt"], ["b.txt"]]);
		const [first, second] = report.conflicts;
		await session.resolve(report.inputs, first?.key ?? "", [{ path: "a.txt", stage: 2, from: undefined }]);
		expect((await statuses()).get(c2)?.kind).toBe("conflict");
		expect((await session.commitConflict(c2)).conflicts.map((c) => c.resolved)).toEqual([true, false]);
		await session.resolve(report.inputs, second?.key ?? "", [{ path: "b.txt", stage: 3, from: undefined }]);
		expect((await statuses()).get(c2)?.kind).toBe("resolved");
		expect((await file(c2, "a.txt")).draft).toBe(lineSet(lines("a"), 5, "edited"));
		expect((await file(c2, "b.txt")).draft).toBe(lineSet(lines("b"), 5, "c2"));
		const cat = new CatFile(fx.repo);
		try {
			expect((await storeRead(fx.repo, cat)).resolutions.size).toBe(0);
		} finally {
			cat.close();
		}
	});

	test("a message-only draft above a file edit keeps the restacked tree", async () => {
		const c1 = fx.commit("c1", { "a.txt": lineSet(lines("a"), 2, "c1") });
		const c2 = fx.commit("c2", { "b.txt": lineSet(lines("b"), 2, "c2") });
		await draftFile(session, c1, "a.txt", Buffer.from(lineSet(lineSet(lines("a"), 2, "c1"), 4, "edit")));
		await session.draftSetMessage(c2, Buffer.from("c2 reworded\n"));
		await applied();
		expect(fx.git("log", "-1", "--format=%s")).toBe("c2 reworded");
		expect(fx.git("show", "HEAD:a.txt")).toContain("edit");
		expect(fx.git("show", "HEAD:b.txt")).toContain("c2");
		expect(c2).not.toBe(fx.git("rev-parse", "HEAD"));
	});

	test("a draft stored before parent trees were recorded applies as it was made, on the original parent", async () => {
		const c1 = fx.commit("c1", { "a.txt": lineSet(lines("a"), 2, "c1") });
		fx.commit("c2", { "a.txt": lineSet(lineSet(lines("a"), 2, "c1"), 8, "c2") });
		await draftFile(session, c1, "a.txt", Buffer.from(lineSet(lineSet(lines("a"), 2, "c1"), 5, "legacy")));
		const cat = new CatFile(fx.repo);
		try {
			const store = await storeRead(fx.repo, cat);
			const draft = store.drafts.get(c1);
			if (draft === undefined) {
				throw new Error("no draft");
			}
			await storeWrite(fx.repo, store, new Map([[c1, { ...draft, parentTree: undefined, baseParent: undefined }]]), store.resolutions);
		} finally {
			cat.close();
		}
		await applied();
		expect(fx.git("show", "HEAD:a.txt")).toBe(lineSet(lineSet(lineSet(lines("a"), 2, "c1"), 5, "legacy"), 8, "c2").trimEnd());
	});

	test("a new branch at the same commit does not show the other branch's edits", async () => {
		const c1 = fx.commit("c1", { "a.txt": lineSet(lines("a"), 2, "c1") });
		fx.commit("c2", { "b.txt": lineSet(lines("b"), 2, "c2") });
		await draftFile(session, c1, "a.txt", Buffer.from(lineSet(lineSet(lines("a"), 2, "c1"), 4, "edit")));
		expect(await kinds()).toEqual(["edited", "rewritten"]);
		fx.git("switch", "-q", "-c", "other");
		expect(await kinds()).toEqual(["unchanged", "unchanged"]);
	});

	test("the tip Apply publishes is the tree the top commit showed", async () => {
		const c1 = fx.commit("c1", { "a.txt": lineSet(lines("a"), 2, "c1") });
		const c2 = fx.commit("c2", { "b.txt": lineSet(lines("b"), 2, "c2") });
		await draftFile(session, c1, "a.txt", Buffer.from(lineSet(lineSet(lines("a"), 2, "c1"), 4, "edit")));
		await draftFile(session, c2, "a.txt", Buffer.from(lineSet(lineSet(lineSet(lines("a"), 2, "c1"), 4, "edit"), 6, "top")));
		const shown = (await session.commitDocument(c2)).tree;
		await applied();
		expect(fx.git("rev-parse", "HEAD^{tree}")).toBe(shown);
	});

	test("an outside rewrite below a draft made on an edited parent carries both, pending confirmation", async () => {
		const c1 = fx.commit("c1", { "a.txt": lineSet(lines("a"), 2, "c1") });
		const c2 = fx.commit("c2", { "b.txt": lineSet(lines("b"), 2, "c2") });
		await draftFile(session, c1, "a.txt", Buffer.from(lineSet(lineSet(lines("a"), 2, "c1"), 4, "below")));
		await draftFile(session, c2, "a.txt", Buffer.from(lineSet(lineSet(lineSet(lines("a"), 2, "c1"), 4, "below"), 9, "above")));
		// Claude Code amends c1 with a new file and rebases c2 onto it.
		fx.git("switch", "-q", "--detach", c1);
		fx.write("c.txt", "amended\n");
		fx.git("add", "c.txt");
		fx.git("commit", "-q", "--amend", "--no-edit");
		fx.git("cherry-pick", c2);
		fx.git("branch", "-f", "feature", "HEAD");
		fx.git("switch", "-q", "feature");
		const state = await session.state();
		expect(state.kind === "ready" && state.drafts.map((d) => d.kind)).toEqual(["rebased", "rebased"]);
		await session.draftConfirm(c1);
		await session.draftConfirm(c2);
		await applied();
		expect(fx.git("show", "HEAD:a.txt")).toBe(lineSet(lineSet(lineSet(lines("a"), 2, "c1"), 4, "below"), 9, "above").trimEnd());
		expect(fx.git("show", "HEAD~1:a.txt")).toBe(lineSet(lineSet(lines("a"), 2, "c1"), 4, "below").trimEnd());
		expect(fx.git("show", "HEAD~1:c.txt")).toBe("amended");
	});

	// About one `merge-tree` per commit above the edit, a few milliseconds each: a stack of a hundred restacks in well under a second on Linux.
	test("a hundred-commit stack restacks after an edit at the bottom within budget", { timeout: 120000 * TIMEOUT_SCALE }, async () => {
		const oids: Oid[] = [];
		for (let i = 0; i < 100; i++) {
			oids.push(fx.commit(`c${i}`, { [`f${i}.txt`]: `c${i}\n`, "a.txt": lineSet(lines("a"), 1 + (i % 10), `c${i}`) }));
		}
		await draftFile(session, oids[0] as Oid, "f0.txt", Buffer.from("edited\n"));
		const started = Date.now();
		expect((await statuses()).get(oids[99] as Oid)?.kind).toBe("rewritten");
		expect(Date.now() - started).toBeLessThan(2000 * TIMEOUT_SCALE);
	});

	test("a save landing after an outside rewrite, from a document above an edit, is kept for confirmation", async () => {
		const c1 = fx.commit("c1", { "a.txt": lineSet(lines("a"), 2, "c1") });
		fx.commit("c2", { "b.txt": lineSet(lines("b"), 2, "c2") });
		const c3 = fx.commit("c3", { "c.txt": "c3\n" });
		await draftFile(session, c1, "a.txt", Buffer.from(lineSet(lineSet(lines("a"), 2, "c1"), 4, "below")));
		const doc = await session.commitDocument(c3);
		const shown = doc.files.find((f) => f.path === "c.txt")?.draftOid ?? null;
		// Claude Code rewords c3 while it is open.
		fx.git("commit", "-q", "--amend", "-m", "c3 reworded");
		await session.draftSetFile(c3, doc.parentTree, "c.txt", shown, Buffer.from("c3 typed late\n"));
		const state = await session.state();
		expect(state.kind === "ready" && state.drafts.map((d) => d.kind).sort()).toEqual(["current", "rebased"]);
		await session.draftConfirm(c3);
		await applied();
		expect(fx.git("show", "HEAD:c.txt")).toBe("c3 typed late");
		expect(fx.git("show", "HEAD:a.txt")).toContain("below");
	});

	test("merges remembered across saves are redone once git gc has pruned them", async () => {
		const c1 = fx.commit("c1", { "a.txt": lineSet(lines("a"), 2, "c1") });
		fx.commit("c2", { "b.txt": lineSet(lines("b"), 2, "c2") });
		const c3 = fx.commit("c3", { "c.txt": "c3\n" });
		await draftFile(session, c1, "a.txt", Buffer.from(lineSet(lineSet(lines("a"), 2, "c1"), 4, "below")));
		await draftFile(session, c3, "c.txt", Buffer.from("first\n"));
		// Nothing stored refers to the restacked c2 any more, so pruning removes it while the session still remembers the merge.
		await session.draftDiscard(c3);
		fx.git("gc", "-q", "--prune=now");
		await draftFile(session, c3, "c.txt", Buffer.from("second\n"));
		expect((await file(c3, "c.txt")).draft).toBe("second\n");
		await applied();
		expect(fx.git("show", "HEAD:c.txt")).toBe("second");
		expect(fx.git("show", "HEAD:a.txt")).toContain("below");
	});

	test("a conflict on a commit whose draft waits for confirmation cannot be resolved until it is decided", async () => {
		const c1 = fx.commit("c1", { "a.txt": lineSet(lines("a"), 5, "c1") });
		const c2 = fx.commit("c2", { "a.txt": lineSet(lines("a"), 5, "c2") });
		await draftFile(session, c2, "b.txt", Buffer.from("draft on c2\n"));
		await draftFile(session, c1, "a.txt", Buffer.from(lineSet(lines("a"), 5, "edited")));
		fx.git("commit", "-q", "--amend", "--no-edit", "--allow-empty");
		const rewritten = fx.git("rev-parse", "HEAD");
		expect(rewritten).not.toBe(c2);
		const report = await session.commitConflict(rewritten);
		const result = await session.resolve(report.inputs, report.conflicts[0]?.key ?? "", [{ path: "a.txt", stage: 2, from: undefined }]);
		expect(result.kind).toBe("invalid");
	});

	describe("objects", () => {
		function looseObjects(): number {
			return Number(/^count: (\d+)$/m.exec(fx.git("count-objects", "-v"))?.[1]);
		}

		test("showing the restacked stack writes nothing to the repository's objects", async () => {
			const c1 = fx.commit("c1", { "a.txt": lineSet(lines("a"), 2, "c1") });
			for (let i = 0; i < 5; i++) {
				fx.commit(`c${i + 2}`, { "b.txt": lineSet(lines("b"), i + 1, `c${i + 2}`) });
			}
			await draftFile(session, c1, "a.txt", Buffer.from(lineSet(lineSet(lines("a"), 2, "c1"), 4, "edit")));
			const before = looseObjects();
			const state = await session.state();
			for (const c of state.kind === "ready" ? state.stack.commits : []) {
				await session.commitDocument(c.oid);
			}
			await session.preview();
			expect(looseObjects()).toBe(before);
		});

		test("what is stored stays readable after the session's private objects are gone", async () => {
			const c1 = fx.commit("c1", { "a.txt": lineSet(lines("a"), 2, "c1") });
			const c2 = fx.commit("c2", { "b.txt": lineSet(lines("b"), 2, "c2") });
			await draftFile(session, c1, "a.txt", Buffer.from(lineSet(lineSet(lines("a"), 2, "c1"), 4, "edit")));
			await draftFile(session, c2, "b.txt", Buffer.from(lineSet(lineSet(lines("b"), 2, "c2"), 6, "edit")));
			session.close();
			expect(readdirSync(join(fx.dir, ".git", "suonetar")).filter((n) => n.startsWith("objects-"))).toEqual([]);
			expect(fx.git("fsck", "--connectivity-only", "--no-dangling")).toBe("");
			session = await Session.openRepo(fx.repo, undefined);
			await applied();
			expect(fx.git("show", "HEAD:b.txt")).toContain("edit");
		});

		test("the private objects of a session on this machine whose process is gone are removed", async () => {
			const stale = join(fx.dir, ".git", "suonetar", `objects-${hostname().replace(/[^0-9A-Za-z.]/g, "_")}-999999999-abc`);
			const elsewhere = join(fx.dir, ".git", "suonetar", "objects-another.machine-999999999-abc");
			mkdirSync(elsewhere, { recursive: true });
			mkdirSync(stale, { recursive: true });
			const other = await Session.openRepo(fx.repo, undefined);
			other.close();
			expect(existsSync(stale)).toBe(false);
			expect(existsSync(elsewhere)).toBe(true);
		});
	});

	// Every git process costs tens of milliseconds on Windows, so an operation reads the stack and the merge settings once, and again only after it moves the branch.
	describe("reads per operation", () => {
		const calls: string[][] = [];
		const stackReads = (): number => calls.filter((a) => a[0] === "rev-list" && a.includes("--first-parent") && a.includes("--parents")).length;
		const configReads = (): number => calls.filter((a) => a.includes("^(merge|diff)\\.")).length;
		let c1: Oid;

		beforeEach(async () => {
			c1 = fx.commit("c1", { "a.txt": lineSet(lines("a"), 2, "c1") });
			for (let i = 2; i <= 4; i++) {
				fx.commit(`c${i}`, { "b.txt": lineSet(lines("b"), i * 2, `c${i}`) });
			}
			session.close();
			session = await Session.openRepo(
				{
					...fx.repo,
					run: (args, opts) => {
						calls.push([...args]);
						return fx.repo.run(args, opts);
					},
				},
				undefined,
			);
			calls.length = 0;
		});

		test("a save reads each once", async () => {
			await draftFile(session, c1, "a.txt", Buffer.from(lineSet(lines("a"), 2, "first")));
			const doc = await session.commitDocument(c1);
			const shown = doc.files.find((f) => f.path === "a.txt")?.draftOid;
			calls.length = 0;
			await session.draftSetFile(c1, doc.parentTree, "a.txt", shown ?? null, Buffer.from(lineSet(lines("a"), 2, "second")));
			expect([stackReads(), configReads()]).toEqual([1, 1]);
		});

		test("showing a commit on a fresh session reads each once", async () => {
			await session.commitDocument(c1);
			expect([stackReads(), configReads()]).toEqual([1, 1]);
		});

		test("an Apply whose hooks undo every edit reads the stack and the settings again after the hooks", async () => {
			mkdirSync(join(fx.dir, ".git", "hooks"), { recursive: true });
			// A formatter stripping trailing spaces, which is all the edit adds.
			writeFileSync(
				join(fx.dir, ".git", "hooks", "pre-commit"),
				`#!/bin/sh\nchanged=0\nfor f in $(git diff --cached --name-only --diff-filter=ACM); do\n  if grep -q ' $' "$f"; then sed -i 's/ *$//' "$f"; changed=1; fi\ndone\nexit $changed\n`,
			);
			chmodSync(join(fx.dir, ".git", "hooks", "pre-commit"), 0o755);
			await draftFile(session, c1, "a.txt", Buffer.from(lineSet(lines("a"), 2, "c1  ")));
			calls.length = 0;
			expect((await session.apply({ kind: "run", skip: [] }, () => undefined)).kind).toBe("hook-reverted");
			expect([stackReads(), configReads()]).toEqual([2, 2]);
		});

		test("an Apply reads the stack again after it moves the branch", async () => {
			await draftFile(session, c1, "a.txt", Buffer.from(lineSet(lines("a"), 2, "applied")));
			calls.length = 0;
			await applied();
			expect(stackReads()).toBe(2);
		});

		test("an operation that fails, or whose stack read fails, leaves the next to read afresh", async () => {
			await expect(session.commitDocument("1".repeat(40))).rejects.toThrow();
			const tip = fx.commit("c5", { "c.txt": "c\n" });
			const state = await session.state();
			expect(state.kind === "ready" ? state.stack.tipOid : state.kind).toBe(tip);
			// A save while detached, which only a commit that already has a draft takes: its stack read fails, and that failure is not remembered past it.
			await draftFile(session, c1, "a.txt", Buffer.from("attached\n"));
			fx.git("switch", "-q", "--detach", "HEAD");
			await draftFile(session, c1, "a.txt", Buffer.from("detached\n"));
			fx.git("switch", "-q", "feature");
			expect((await session.state()).kind).toBe("ready");
		});
	});
});
