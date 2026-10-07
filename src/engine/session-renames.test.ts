import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Oid } from "./git.ts";
import { Session } from "./session.ts";
import { draftFile, draftFileRestore } from "./test-support/drafts.ts";
import { type Fixture, lineSet, lines, repoFixture } from "./test-support/repo.ts";

// A renamed file shows as one file at its new path, diffed against the file it was renamed from.
describe("renames in documents", () => {
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

	const renamed = lineSet(lines("a"), 3, "renamed");

	async function files(oid: Oid) {
		return (await session.commitDocument(oid)).files.map((f) => ({
			path: f.path,
			status: f.status,
			renamedFrom: f.renamedFrom,
			parent: f.parent?.toString(),
			commit: f.commit?.toString(),
			draft: f.draft?.toString(),
			mineUnknown: f.mineUnknown,
		}));
	}

	function rename(): Oid {
		return fx.commit("rename", { "a.txt": null, "dir/a2.txt": renamed });
	}

	test("a rename with an edit shows as one file, against the file it came from", async () => {
		const c1 = rename();
		expect(await files(c1)).toEqual([{ path: "dir/a2.txt", status: "R", renamedFrom: "a.txt", parent: lines("a"), commit: renamed, draft: renamed, mineUnknown: false }]);
	});

	test("an edit below the rename shows on both sides, leaving only the commit's own change", async () => {
		const c1 = fx.commit("c1", { "b.txt": lineSet(lines("b"), 2, "c1") });
		const c2 = rename();
		await draftFile(session, c1, "a.txt", Buffer.from(lineSet(lines("a"), 8, "below")));
		const [shown] = (await files(c2)).filter((f) => f.path === "dir/a2.txt");
		expect(shown?.status).toBe("R");
		expect(shown?.parent).toBe(lineSet(lines("a"), 8, "below"));
		expect(shown?.draft).toBe(lineSet(renamed, 8, "below"));
		expect((await files(c2)).map((f) => f.path)).toEqual(["dir/a2.txt"]);
	});

	test("edits save at the new path, and a rewrite past recognition stays the commit's rename", async () => {
		const c1 = rename();
		await draftFile(session, c1, "dir/a2.txt", Buffer.from(lineSet(renamed, 9, "mine")));
		expect(await files(c1)).toEqual([
			{ path: "dir/a2.txt", status: "R", renamedFrom: "a.txt", parent: lines("a"), commit: renamed, draft: lineSet(renamed, 9, "mine"), mineUnknown: false },
		]);
		await draftFile(session, c1, "dir/a2.txt", Buffer.from("rewritten\n"));
		expect((await files(c1)).map((f) => [f.path, f.status, f.draft])).toEqual([["dir/a2.txt", "R", "rewritten\n"]]);
		await draftFileRestore(session, c1, "dir/a2.txt", "commit");
		expect((await files(c1)).map((f) => [f.path, f.status, f.draft])).toEqual([["dir/a2.txt", "R", renamed]]);
		const state = await session.state();
		expect(state.kind === "ready" ? state.drafts : undefined).toEqual([]);
	});

	test("restoring the old file, or deleting the new one, undoes the pairing", async () => {
		const c1 = rename();
		await draftFileRestore(session, c1, "a.txt", "parent");
		expect((await files(c1)).map((f) => [f.path, f.status, f.renamedFrom])).toEqual([
			["a.txt", "=", undefined],
			["dir/a2.txt", "A", undefined],
		]);
		await draftFileRestore(session, c1, "a.txt", "commit");
		await draftFile(session, c1, "dir/a2.txt", null);
		expect((await files(c1)).map((f) => [f.path, f.status, f.renamedFrom])).toEqual([
			["a.txt", "D", undefined],
			["dir/a2.txt", "=", undefined],
		]);
	});

	test("a rename made by a draft pairs in the draft's own document", async () => {
		const c1 = fx.commit("c1", { "b.txt": lineSet(lines("b"), 2, "c1") });
		await draftFile(session, c1, "a.txt", null);
		await draftFile(session, c1, "moved.txt", Buffer.from(lines("a")));
		const doc = await session.draftDocument(c1);
		expect(doc.files.map((f) => [f.path, f.status, f.renamedFrom])).toEqual([["moved.txt", "R", "a.txt"]]);
		expect((await files(c1)).map((f) => [f.path, f.status, f.renamedFrom])).toEqual([
			["b.txt", "M", undefined],
			["moved.txt", "R", "a.txt"],
		]);
	});

	test("a draft that moves a file the commit changes leaves the commit's change restorable, unpaired", async () => {
		const c1 = fx.commit("c1", { "a.txt": lineSet(lines("a"), 2, "c1") });
		await draftFile(session, c1, "a.txt", null);
		await draftFile(session, c1, "moved.txt", Buffer.from(lineSet(lines("a"), 2, "c1")));
		expect((await files(c1)).map((f) => [f.path, f.status, f.renamedFrom])).toEqual([
			["a.txt", "D", undefined],
			["moved.txt", "A", undefined],
		]);
	});

	test("an edit never pairs what the commit itself leaves as a deletion and an addition", async () => {
		const c1 = fx.commit("replace", { "a.txt": null, "c.txt": lines("c") });
		expect((await files(c1)).map((f) => [f.path, f.status])).toEqual([
			["a.txt", "D"],
			["c.txt", "A"],
		]);
		await draftFile(session, c1, "c.txt", Buffer.from(lineSet(lines("a"), 9, "c")));
		expect((await files(c1)).map((f) => [f.path, f.status])).toEqual([
			["a.txt", "D"],
			["c.txt", "A"],
		]);
	});

	test("a conflict below on the file it was renamed from leaves the edits unknown", async () => {
		const c1 = fx.commit("c1", { "b.txt": lineSet(lines("b"), 2, "c1") });
		const c2 = fx.commit("rename", { "a.txt": null, "a2.txt": lineSet(lines("a"), 5, "c2") });
		await draftFile(session, c1, "a.txt", Buffer.from(lineSet(lines("a"), 5, "below")));
		const [shown] = await files(c2);
		expect(shown?.path).toBe("a2.txt");
		expect(shown?.mineUnknown).toBe(true);
	});

	test("a file binary only under its old name is binary", async () => {
		fx.commit("attributes", { ".gitattributes": "old.dat binary\n", "old.dat": lines("x") });
		const c1 = fx.commit("rename", { "old.dat": null, "new.dat": lines("x") });
		const doc = await session.commitDocument(c1);
		expect(doc.files.map((f) => [f.path, f.status, f.binary])).toEqual([["new.dat", "R", true]]);
	});
});
