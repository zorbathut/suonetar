import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { argChunks, envInherited, fileReaderDisk, hookRunnerSpawn } from "./git.ts";
import { dirRemove, shPath, shSleeper } from "./test-support/repo.ts";

const WINDOWS = process.platform === "win32";

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ESRCH") {
			return false;
		}
		throw err;
	}
}

async function eventually(check: () => boolean): Promise<boolean> {
	for (let i = 0; i < 50; i++) {
		if (check()) {
			return true;
		}
		await new Promise((r) => setTimeout(r, 20));
	}
	return check();
}

// The pid a shSleeper wrote, once it has.
async function pidRead(file: string): Promise<number> {
	await eventually(() => existsSync(file) && readFileSync(file, "utf8").trim() !== "");
	return Number(readFileSync(file, "utf8"));
}

describe("hook runner", () => {
	let dir: string;
	const env = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "suonetar-hook-"));
	});

	afterEach(async () => {
		await dirRemove(dir);
	});

	// A shell alias stands in for `git hook run`: same process tree shape, no repository needed.
	function alias(script: string): string[] {
		return ["-c", `alias.h=!${script}`, "h"];
	}

	test("a background child holding the output pipe neither delays the result nor survives it", async () => {
		const pidFile = join(dir, "pid");
		const started = Date.now();
		const result = await hookRunnerSpawn()(alias(`echo done; ${shSleeper(pidFile)} & exit 3`), {
			cwd: dir,
			env,
			signal: new AbortController().signal,
			group: "kill",
		});
		expect(Date.now() - started).toBeLessThan(5000);
		expect(result.code).toBe(3);
		expect(result.output).toContain("done");
		const pid = await pidRead(pidFile);
		// Windows has no process group to find it by once the hook has exited.
		if (WINDOWS) {
			process.kill(pid);
		} else {
			expect(await eventually(() => !alive(pid))).toBe(true);
		}
	});

	test("aborting kills the hook and its children", async () => {
		const pidFile = join(dir, "pid");
		const controller = new AbortController();
		const running = hookRunnerSpawn()(alias(`${shSleeper(pidFile)} & wait`), { cwd: dir, env, signal: controller.signal, group: "kill" });
		const pid = await pidRead(pidFile);
		controller.abort();
		const result = await running;
		expect(result.code).not.toBe(0);
		expect(await eventually(() => !alive(pid))).toBe(true);
	});

	test("the hook gets the user's environment without npm's additions or repository redirections", async () => {
		const saved = { ...process.env };
		process.env.npm_lifecycle_event = "app";
		process.env.INIT_CWD = "/somewhere";
		process.env.GIT_DIR = "/elsewhere/.git";
		process.env.SUONETAR_TEST_KEPT = "yes";
		process.env.PATH = [resolve("/proj/node_modules/.bin"), resolve("/usr/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin"), saved.PATH].join(delimiter);
		try {
			const out = join(dir, "env");
			await hookRunnerSpawn()(alias(`env > ${shPath(out)}`), { cwd: dir, env: { ...env, EXTRA: "1" }, signal: new AbortController().signal, group: "kill" });
			const seen = readFileSync(out, "utf8");
			expect(seen.split("\n").filter((l) => l.startsWith("npm_"))).toEqual(["npm_config_yes=false"]);
			expect(seen).not.toMatch(/^INIT_CWD=/m);
			expect(seen).not.toMatch(/^GIT_DIR=/m);
			expect(seen).toMatch(/^SUONETAR_TEST_KEPT=yes$/m);
			expect(seen).toMatch(/^EXTRA=1$/m);
			const path = /^PATH=(.*)$/m.exec(seen)?.[1] ?? "";
			expect(path).not.toContain("node_modules/.bin");
			expect(path).not.toContain("node-gyp-bin");
		} finally {
			process.env = saved;
		}
	});

	// Windows has no signal a hook could trap; a cancel kills at once.
	test.skipIf(WINDOWS)("a cancelled hook gets time to clean up before it is killed", async () => {
		const cleaned = join(dir, "cleaned");
		const started = join(dir, "started");
		const controller = new AbortController();
		const running = hookRunnerSpawn()(alias(`trap 'sleep 0.5; touch ${cleaned}; exit 1' TERM; touch ${started}; sleep 30 & wait`), {
			cwd: dir,
			env,
			signal: controller.signal,
			group: "kill",
		});
		await eventually(() => existsSync(started));
		controller.abort();
		await running;
		expect(existsSync(cleaned)).toBe(true);
	});

	test("with the group left alone, a background child outlives the run and an abort leaves the tool running", async () => {
		const pidFile = join(dir, "pid");
		const result = await hookRunnerSpawn()(alias(`${shSleeper(pidFile)} > /dev/null 2>&1 & exit 0`), {
			cwd: dir,
			env,
			signal: new AbortController().signal,
			group: "leave",
		});
		expect(result.code).toBe(0);
		const pid = await pidRead(pidFile);
		await new Promise((r) => setTimeout(r, 300));
		expect(alive(pid)).toBe(true);
		process.kill(pid);

		// git stops its own direct child when signalled; the tool, as under `git mergetool`, is that child's child.
		const toolPid = join(dir, "tool");
		const controller = new AbortController();
		const running = hookRunnerSpawn()(alias(`${shSleeper(toolPid)}; true`), { cwd: dir, env, signal: controller.signal, group: "leave" });
		const tool = await pidRead(toolPid);
		const begun = Date.now();
		controller.abort();
		await running;
		expect(Date.now() - begun).toBeLessThan(2000);
		await new Promise((r) => setTimeout(r, 300));
		expect(alive(tool)).toBe(true);
		process.kill(tool);
	});
});

describe("envInherited", () => {
	test("under an AppImage, drops what its launcher added and keeps the rest", () => {
		const env = envInherited({
			APPIMAGE: "/home/me/Suonetar.AppImage",
			APPDIR: "/tmp/.mount_SuonXY",
			ARGV0: "Suonetar.AppImage",
			OWD: "/home/me",
			PATH: "/tmp/.mount_SuonXY:/tmp/.mount_SuonXY/usr/sbin:/usr/bin:/bin",
			LD_LIBRARY_PATH: "/tmp/.mount_SuonXY/usr/lib",
			XDG_DATA_DIRS: "/tmp/.mount_SuonXY/usr/share/:/usr/local/share:/usr/share",
			GSETTINGS_SCHEMA_DIR: "/tmp/.mount_SuonXY/usr/share/glib-2.0/schemas:/home/me/schemas",
			GIT_DIR: "/elsewhere/.git",
			HOME: "/home/me",
		});
		expect(env).toEqual({ PATH: "/usr/bin:/bin", XDG_DATA_DIRS: "/usr/local/share:/usr/share", GSETTINGS_SCHEMA_DIR: "/home/me/schemas", HOME: "/home/me" });
	});

	test("outside an AppImage, passes everything on but repository redirections", () => {
		const parent = { APPDIR: "/opt/x", PATH: "/opt/x:/usr/bin", LD_LIBRARY_PATH: "", GIT_WORK_TREE: "/w", HOME: "/home/me" };
		expect(envInherited(parent)).toEqual({ APPDIR: "/opt/x", PATH: "/opt/x:/usr/bin", LD_LIBRARY_PATH: "", HOME: "/home/me" });
	});
});

describe("fileReaderDisk", () => {
	test("reads a file, and gives undefined for one missing or unreadable, reporting the latter once", async () => {
		const dir = mkdtempSync(join(tmpdir(), "suonetar-read-"));
		const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			writeFileSync(join(dir, "file"), "contents");
			mkdirSync(join(dir, "directory"));
			const read = fileReaderDisk();
			expect((await read(join(dir, "file")))?.toString()).toBe("contents");
			expect(await read(join(dir, "missing"))).toBeUndefined();
			expect(await read(join(dir, "directory"))).toBeUndefined();
			expect(await read(join(dir, "directory"))).toBeUndefined();
			expect(reported).toHaveBeenCalledTimes(1);
		} finally {
			reported.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("argChunks", () => {
	test("splits a long argument list into runs short enough for a Windows command line, keeping order", () => {
		const items = Array.from({ length: 1000 }, (_, i) => `${"p".repeat(100)}-${i}`);
		const chunks = argChunks(items);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.flat()).toEqual(items);
		// Half of Windows' 32K command line, leaving room for git's own arguments and the launcher's re-quoting.
		for (const chunk of chunks) {
			expect(chunk.join(" ").length).toBeLessThanOrEqual(16_000);
		}
		expect(argChunks(["a", "b"])).toEqual([["a", "b"]]);
		expect(argChunks([])).toEqual([]);
	});
});
