import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { MergeInputs } from "./derive.ts";
import { Session } from "./session.ts";
import { draftFile } from "./test-support/drafts.ts";
import { dirRemove, type Fixture, lineSet, lines, repoFixture, shPath, shSleeper } from "./test-support/repo.ts";

describe("mergetool", () => {
	let fx: Fixture;
	let session: Session;
	let inputs: MergeInputs;
	let key: string;
	let tmp: string;
	const tmpSaved = process.env.TMPDIR;
	const baseText = lineSet(lines("a"), 2, "k1");
	const oursText = lineSet(baseText, 3, "edit");
	const theirsText = lineSet(baseText, 3, "k2");

	// k2's change to line 3 conflicts with an edit to the same line in k1 below it.
	beforeEach(async () => {
		// git-mergetool leaves its temporary files behind when cancelled; keep them out of the real temporary directory.
		tmp = mkdtempSync(join(tmpdir(), "suonetar-mergetool-test-"));
		process.env.TMPDIR = tmp;
		fx = await repoFixture();
		fx.commit("base", { "a.txt": lines("a"), ".gitattributes": "*.crlf text eol=crlf\n" });
		fx.git("switch", "-q", "-c", "feature");
		const k1 = fx.commit("k1", { "a.txt": baseText });
		fx.commit("k2", { "a.txt": theirsText });
		session = await Session.openRepo(fx.repo, undefined);
		await draftFile(session, k1, "a.txt", Buffer.from(oursText));
		const preview = await session.preview();
		if (preview.kind !== "conflict") {
			throw new Error(`preview is ${preview.kind}`);
		}
		inputs = preview.inputs;
		key = preview.conflicts[0]?.key ?? "";
	});

	afterEach(async () => {
		session.close();
		await fx.cleanup();
		await dirRemove(tmp);
		if (tmpSaved === undefined) {
			delete process.env.TMPDIR;
		} else {
			process.env.TMPDIR = tmpSaved;
		}
	});

	function toolSet(cmd: string, trustExitCode: boolean): void {
		fx.git("config", "merge.tool", "fake");
		fx.git("config", "mergetool.fake.cmd", cmd);
		fx.git("config", "mergetool.fake.trustExitCode", String(trustExitCode));
	}

	function leftovers(): string[] {
		const dir = join(fx.dir, ".git", "suonetar");
		return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith("mergetool")) : [];
	}

	test("hands the tool base, below, and this commit, with $MERGED starting as the given text, and returns its result", async () => {
		toolSet(`cat "$BASE" "$LOCAL" "$REMOTE" "$MERGED" > "$MERGED.new" && mv "$MERGED.new" "$MERGED"`, true);
		const index = fx.git("ls-files", "-s");
		const result = await session.mergetool(inputs, key, "a.txt", Buffer.from("current\n"));
		expect(result).toEqual({ kind: "merged", content: Buffer.from(`${baseText}${oursText}${theirsText}current\n`) });
		expect(leftovers()).toEqual([]);
		expect(fx.git("status", "--porcelain")).toBe("");
		expect(fx.git("ls-files", "-s")).toBe(index);
	});

	test("a failing tool, or one that leaves the file unchanged without a trusted exit code, leaves it unresolved", async () => {
		toolSet(`echo giving up; exit 1`, true);
		const failed = await session.mergetool(inputs, key, "a.txt", Buffer.from("current\n"));
		expect(failed.kind).toBe("unresolved");
		expect(failed.kind === "unresolved" && failed.output).toContain("giving up");

		toolSet("true", false);
		expect((await session.mergetool(inputs, key, "a.txt", Buffer.from("current\n"))).kind).toBe("unresolved");

		toolSet("suonetar-no-such-tool", true);
		expect((await session.mergetool(inputs, key, "a.txt", Buffer.from("current\n"))).kind).toBe("unresolved");
		expect(leftovers()).toEqual([]);
	});

	test("without merge.tool, no tool is guessed", async () => {
		expect(await session.mergetool(inputs, key, "a.txt", Buffer.from("current\n"))).toEqual({ kind: "unconfigured" });
		expect(await session.mergetoolName()).toBeUndefined();
		toolSet("true", true);
		expect(await session.mergetoolName()).toBe("fake");
	});

	test("the result comes back in repository form, with the path's line-ending conversion applied", async () => {
		const k1 = fx.git("rev-parse", "HEAD~1");
		await session.draftDiscard(k1);
		fx.git("reset", "-q", "--hard", "main");
		const c1 = fx.commit("c1", { "f.crlf": "one\n" });
		fx.commit("c2", { "f.crlf": "two\n" });
		session.close();
		session = await Session.openRepo(fx.repo, undefined);
		await draftFile(session, c1, "f.crlf", Buffer.from("mine\n"));
		const preview = await session.preview();
		if (preview.kind !== "conflict") {
			throw new Error(`preview is ${preview.kind}`);
		}
		toolSet(`printf 'resolved\\r\\n' > "$MERGED"`, true);
		const result = await session.mergetool(preview.inputs, preview.conflicts[0]?.key ?? "", "f.crlf", Buffer.from("x\n"));
		expect(result).toEqual({ kind: "merged", content: Buffer.from("resolved\n") });
	});

	test("cancelling stops waiting for the tool without killing it, and cleans up", async () => {
		const pidFile = join(tmp, "tool.pid");
		toolSet(`${shSleeper(pidFile)} & touch "${shPath(join(fx.dir, "started"))}"; wait`, true);
		const running = session.mergetool(inputs, key, "a.txt", Buffer.from("current\n"));
		for (let i = 0; i < 100 && !(existsSync(join(fx.dir, "started")) && existsSync(pidFile) && readFileSync(pidFile, "utf8") !== ""); i++) {
			await new Promise((r) => setTimeout(r, 20));
		}
		session.cancel();
		expect(await running).toEqual({ kind: "cancelled" });
		// On Windows the tool, still running in the throwaway directory, keeps it until a later run.
		expect(leftovers().length).toBe(process.platform === "win32" ? 1 : 0);
		expect(fx.git("status", "--porcelain")).toBe("?? started");
		const tool = Number(readFileSync(pidFile, "utf8"));
		await new Promise((r) => setTimeout(r, 300));
		expect(() => process.kill(tool, 0)).not.toThrow();
		process.kill(tool);

		toolSet("true", false);
		for (let i = 0; i < 50 && leftovers().length > 0; i++) {
			await new Promise((r) => setTimeout(r, 100));
			await session.mergetool(inputs, key, "a.txt", Buffer.from("current\n"));
		}
		expect(leftovers()).toEqual([]);
	});

	test("works for a file added on both sides, in a subdirectory, with no base version", async () => {
		const k1 = fx.git("rev-parse", "HEAD~1");
		await session.draftDiscard(k1);
		fx.git("reset", "-q", "--hard", "main");
		const c1 = fx.commit("c1", { "b.txt": "b\n" });
		fx.commit("c2", { "sub/n.txt": "c2\n" });
		session.close();
		session = await Session.openRepo(fx.repo, undefined);
		await draftFile(session, c1, "sub/n.txt", Buffer.from("mine\n"));
		const preview = await session.preview();
		if (preview.kind !== "conflict") {
			throw new Error(`preview is ${preview.kind}`);
		}
		toolSet(`cat "$BASE" "$LOCAL" "$REMOTE" > "$MERGED"`, true);
		const result = await session.mergetool(preview.inputs, preview.conflicts[0]?.key ?? "", "sub/n.txt", Buffer.from("x\n"));
		expect(result).toEqual({ kind: "merged", content: Buffer.from("mine\nc2\n") });
	});

	test("a conflict that no longer occurs is stale", async () => {
		toolSet("true", true);
		expect(await session.mergetool(inputs, "no-such-key", "a.txt", Buffer.from("x\n"))).toEqual({ kind: "stale" });
	});
});
