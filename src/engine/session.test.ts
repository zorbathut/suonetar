import { chmodSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ErrorEditRefused } from "./errors.ts";
import type { Oid } from "./git.ts";
import { Session } from "./session.ts";
import { type Fixture, lineSet, lines, repoFixture } from "./test-support/repo.ts";

describe("session drafts", () => {
	let fx: Fixture;
	let session: Session;
	let c1: Oid;
	let c2: Oid;

	beforeEach(async () => {
		fx = await repoFixture();
		fx.commit("base", { "a.txt": lines("a"), "b.txt": lines("b") });
		fx.git("switch", "-q", "-c", "feature");
		c1 = fx.commit("c1", { "a.txt": lineSet(lines("a"), 2, "c1") });
		c2 = fx.commit("c2", { "b.txt": lineSet(lines("b"), 2, "c2") });
		session = await Session.openRepo(fx.repo);
	});

	afterEach(() => {
		session.close();
		fx.cleanup();
	});

	async function drafts() {
		const state = await session.state();
		if (state.kind !== "ready") {
			throw new Error(`state is ${state.kind}`);
		}
		return state.drafts;
	}

	async function file(oid: Oid, path: string) {
		const found = (await session.commitDocument(oid)).files.find((f) => f.path === path);
		if (found === undefined) {
			throw new Error(`${path} not in the document`);
		}
		return found;
	}

	test("a draft shows in the commit document, and setting the file back removes it", async () => {
		await session.draftSetFile(c1, "a.txt", Buffer.from("changed\n"));
		const versions = await file(c1, "a.txt");
		expect(versions.parent?.toString()).toBe(lines("a"));
		expect(versions.commit?.toString()).toBe(lineSet(lines("a"), 2, "c1"));
		expect(versions.draft?.toString()).toBe("changed\n");
		expect((await drafts()).map((d) => d.kind)).toEqual(["current"]);
		await session.draftSetFile(c1, "a.txt", Buffer.from(lineSet(lines("a"), 2, "c1")));
		expect(await drafts()).toEqual([]);
	});

	test("drafts can add and delete files, and edits keep the file's mode", async () => {
		fx.write("run.sh", "#!/bin/sh\n");
		chmodSync(join(fx.dir, "run.sh"), 0o755);
		fx.git("add", "run.sh");
		const c3 = fx.commit("c3", {});
		await session.draftSetFile(c3, "run.sh", Buffer.from("#!/bin/sh\necho hi\n"));
		await session.draftSetFile(c3, "new/file.txt", Buffer.from("new\n"));
		await session.draftSetFile(c3, "b.txt", null);
		const files = (await session.commitDocument(c3)).files;
		expect(Object.fromEntries(files.map((f) => [f.path, f.status]))).toEqual({ "b.txt": "D", "new/file.txt": "A", "run.sh": "A" });
		expect(await session.apply()).toEqual({ kind: "published", warning: undefined });
		expect(fx.git("ls-tree", "HEAD", "run.sh").split(" ")[0]).toBe("100755");
		expect(readFileSync(join(fx.dir, "new/file.txt"), "utf8")).toBe("new\n");
	});

	test("a draft write that would drop other entries is refused", async () => {
		fx.git("rm", "-q", "a.txt");
		const c3 = fx.commit("a.txt becomes a directory", { "a.txt/inner.txt": "inner\n" });
		await session.draftSetFile(c3, "a.txt/inner.txt", Buffer.from("edited inner\n"));
		await expect(session.draftSetFile(c3, "a.txt", Buffer.from("x\n"))).rejects.toBeInstanceOf(ErrorEditRefused);
		expect((await file(c3, "a.txt/inner.txt")).draft?.toString()).toBe("edited inner\n");
		const c4 = fx.commit("b.txt goes away", { "b.txt": null });
		await session.draftSetFile(c4, "b.txt", Buffer.from("back as a file\n"));
		await expect(session.draftSetFile(c4, "b.txt/under.txt", Buffer.from("x\n"))).rejects.toBeInstanceOf(ErrorEditRefused);
	});

	test("a file the draft emptied out of the commit comes back with its mode", async () => {
		fx.write("run.sh", "#!/bin/sh\n");
		chmodSync(join(fx.dir, "run.sh"), 0o755);
		fx.git("add", "run.sh");
		const c3 = fx.commit("c3", {});
		await session.draftSetFile(c3, "run.sh", null);
		await session.draftSetFile(c3, "run.sh", Buffer.from("#!/bin/sh\necho again\n"));
		expect(await session.apply()).toEqual({ kind: "published", warning: undefined });
		expect(fx.git("ls-tree", "HEAD", "run.sh").split(" ")[0]).toBe("100755");
	});

	test("drafts persist across sessions and survive gc --prune=now", async () => {
		await session.draftSetFile(c1, "a.txt", Buffer.from("precious draft\n"));
		session.close();
		fx.git("reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all");
		fx.git("gc", "-q", "--prune=now");
		session = await Session.openRepo(fx.repo);
		expect((await file(c1, "a.txt")).draft?.toString()).toBe("precious draft\n");
		expect(fx.git("log", "--all", "--format=%s")).not.toContain("suonetar");
	});

	test("an externally amended commit gets the draft rebased onto it, pending confirmation", async () => {
		await session.draftSetFile(c1, "a.txt", Buffer.from(lineSet(lineSet(lines("a"), 2, "c1"), 9, "draft")));
		// Claude Code amends every commit in a rebase: new SHAs, same author lines.
		fx.git("rebase", "-q", "-x", "git commit -q --amend --no-edit --allow-empty", "HEAD~2");
		const statuses = await drafts();
		expect(statuses.map((d) => d.kind)).toEqual(["rebased"]);
		expect((await session.apply()).kind).toBe("drafts-need-attention");
		await session.draftConfirm(c1);
		expect((await drafts()).map((d) => d.kind)).toEqual(["current"]);
		expect(await session.apply()).toEqual({ kind: "published", warning: undefined });
		expect(fx.git("show", "HEAD~1:a.txt")).toContain("draft");
	});

	test("a draft whose commit was squashed away becomes an orphan that is kept", async () => {
		await session.draftSetFile(c2, "b.txt", Buffer.from("orphaned edit\n"));
		fx.git("reset", "-q", "--soft", "HEAD~2");
		fx.git("commit", "-q", "-m", "squashed");
		expect((await drafts()).map((d) => d.kind)).toEqual(["orphan"]);
		expect((await session.preview()).kind).toBe("nothing");
		expect((await drafts()).map((d) => d.kind)).toEqual(["orphan"]);
	});

	test("a message draft conflicts once the commit is reworded elsewhere", async () => {
		await session.draftSetMessage(c1, Buffer.from("suonetar wording\n"));
		fx.git("switch", "-q", "--detach", c1);
		fx.git("commit", "-q", "--amend", "-m", "claude wording");
		const reworded = fx.git("rev-parse", "HEAD");
		fx.git("cherry-pick", c2);
		fx.git("branch", "-f", "feature", "HEAD");
		fx.git("switch", "-q", "feature");
		expect(reworded).not.toBe(c1);
		expect((await drafts()).map((d) => d.kind)).toEqual(["conflict"]);
	});

	test("refuses to edit symlinks and filtered paths", async () => {
		symlinkSync("a.txt", join(fx.dir, "link"));
		writeFileSync(join(fx.dir, ".gitattributes"), "*.bin filter=lfs\n");
		fx.write("x.bin", "pointer\n");
		fx.git("add", "link", ".gitattributes", "x.bin");
		const c3 = fx.commit("c3", {});
		await expect(session.draftSetFile(c3, "link", Buffer.from("x"))).rejects.toBeInstanceOf(ErrorEditRefused);
		await expect(session.draftSetFile(c3, "x.bin", Buffer.from("x"))).rejects.toBeInstanceOf(ErrorEditRefused);
	});

	test("a conflict is resolved in the session and then applied", async () => {
		const c3 = fx.commit("c3", { "a.txt": lineSet(lines("a"), 2, "c3") });
		await session.draftSetFile(c1, "a.txt", Buffer.from(lineSet(lines("a"), 2, "suonetar")));
		const preview = await session.preview();
		if (preview.kind !== "conflict") {
			throw new Error(`expected conflict, got ${preview.kind}`);
		}
		expect(preview.commit.oid).toBe(c3);
		const [conflict] = preview.conflicts;
		if (conflict === undefined) {
			throw new Error("no conflict record");
		}
		const withMarkers = await session.resolve(preview.inputs, conflict.key, [{ path: "a.txt", content: Buffer.from("<<<<<<< x\n"), markersAllowed: false }]);
		expect(withMarkers.kind).toBe("invalid");
		expect((await session.resolve(preview.inputs, conflict.key, [])).kind).toBe("invalid");
		expect(await session.resolve(preview.inputs, conflict.key, [{ path: "a.txt", content: Buffer.from(lineSet(lines("a"), 2, "both")), markersAllowed: false }])).toEqual({
			kind: "resolved",
		});
		expect((await session.preview()).kind).toBe("clean");
		expect(await session.apply()).toEqual({ kind: "published", warning: undefined });
		expect(fx.git("show", "HEAD:a.txt")).toContain("both");
		expect(fx.git("show", "HEAD~2:a.txt")).toContain("suonetar");
	});

	test("signs rewritten commits when commit.gpgSign is set", async () => {
		const stub = join(fx.dir, "..", `${fx.dir.split("/").at(-1)}-gpg.sh`);
		writeFileSync(
			stub,
			'#!/bin/sh\ncat >/dev/null\necho "[GNUPG:] SIG_CREATED D 1 8 00 0 X" >&2\nprintf -- "-----BEGIN PGP SIGNATURE-----\\nfake\\n-----END PGP SIGNATURE-----\\n"\n',
		);
		chmodSync(stub, 0o755);
		fx.git("config", "gpg.program", stub);
		fx.git("config", "commit.gpgSign", "true");
		fx.git("config", "user.signingKey", "fake");
		await session.draftSetFile(c1, "a.txt", Buffer.from("signed edit\n"));
		expect((await session.preview()).kind).toBe("clean");
		expect(await session.apply()).toEqual({ kind: "published", warning: undefined });
		expect(fx.git("cat-file", "commit", "HEAD")).toContain("gpgsig");
		expect(fx.git("cat-file", "commit", "HEAD~1")).toContain("gpgsig");
		expect(fx.git("log", "-1", "--format=%an <%ae> %at", "HEAD~1")).toBe(fx.git("log", "-1", "--format=%an <%ae> %at", c1));
	});
	test("generation changes when the branch moves or a draft is saved", async () => {
		const first = await session.generation();
		await session.draftSetFile(c1, "a.txt", Buffer.from("draft\n"));
		const second = await session.generation();
		fx.commit("c3", { "c.txt": "c\n" });
		const third = await session.generation();
		expect(new Set([first, second, third]).size).toBe(3);
	});

	test("an edit saved against a commit rewritten meanwhile is kept and offered for confirmation", async () => {
		fx.git("switch", "-q", "--detach", c1);
		fx.git("commit", "-q", "--amend", "--no-edit", "--allow-empty");
		fx.git("cherry-pick", c2);
		fx.git("branch", "-f", "feature", "HEAD");
		fx.git("switch", "-q", "feature");
		await session.draftSetFile(c1, "a.txt", Buffer.from(lineSet(lineSet(lines("a"), 2, "c1"), 9, "typed late")));
		expect((await drafts()).map((d) => d.kind)).toEqual(["rebased"]);
	});

	test("saving works while HEAD is detached, for a commit that already has a draft", async () => {
		await session.draftSetFile(c1, "a.txt", Buffer.from("first\n"));
		fx.git("switch", "-q", "--detach", "HEAD");
		await session.draftSetFile(c1, "a.txt", Buffer.from("second\n"));
		await expect(session.draftSetFile(c2, "b.txt", Buffer.from("x\n"))).rejects.toBeInstanceOf(ErrorEditRefused);
		fx.git("switch", "-q", "feature");
		expect((await file(c1, "a.txt")).draft?.toString()).toBe("second\n");
	});

	test("drafts from another branch are listed apart and can be adopted", async () => {
		await session.draftSetFile(c2, "b.txt", Buffer.from("from feature\n"));
		fx.git("switch", "-q", "-c", "other");
		expect((await drafts()).map((d) => d.kind)).toEqual(["elsewhere"]);
		expect((await session.preview()).kind).toBe("nothing");
		await session.draftAdopt(c2);
		expect((await drafts()).map((d) => d.kind)).toEqual(["current"]);
	});

	test("an orphaned draft can still be looked at, and a discarded one stays in the store's reflog", async () => {
		await session.draftSetFile(c2, "b.txt", Buffer.from("orphaned edit\n"));
		fx.git("reset", "-q", "--hard", "HEAD~1");
		expect((await drafts()).map((d) => d.kind)).toEqual(["orphan"]);
		const doc = await session.draftDocument(c2);
		expect(doc.files.map((f) => [f.path, f.draft?.toString()])).toEqual([["b.txt", "orphaned edit\n"]]);
		await session.draftDiscard(c2);
		// `git reflog` only displays commits; the log file itself shows the store keeps its history.
		expect(
			readFileSync(join(fx.dir, ".git", "logs", "refs", "suonetar", "drafts"), "utf8")
				.trim()
				.split("\n").length,
		).toBe(2);
	});

	test("files that cannot be edited as text say why in the document", async () => {
		symlinkSync("a.txt", join(fx.dir, "link"));
		fx.git("add", "link");
		const c3 = fx.commit("c3", {});
		expect((await file(c3, "link")).refusal).toContain("symbolic link");
		await expect(session.draftSetFile(c3, "link/x", Buffer.from("x"))).rejects.toBeInstanceOf(ErrorEditRefused);
	});
});
