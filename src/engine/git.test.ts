import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { hookRunnerSpawn } from "./git.ts";

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

describe("hook runner", () => {
	let dir: string;
	const env = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "suonetar-hook-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// A shell alias stands in for `git hook run`: same process tree shape, no repository needed.
	function alias(script: string): string[] {
		return ["-c", `alias.h=!${script}`, "h"];
	}

	test("a background child holding the output pipe neither delays the result nor survives it", async () => {
		const pidFile = join(dir, "pid");
		const started = Date.now();
		const result = await hookRunnerSpawn()(alias(`echo done; (sleep 30; echo late >&2) & echo $! > ${pidFile}; exit 3`), {
			cwd: dir,
			env,
			signal: new AbortController().signal,
		});
		expect(Date.now() - started).toBeLessThan(5000);
		expect(result.code).toBe(3);
		expect(result.output).toContain("done");
		const pid = Number(readFileSync(pidFile, "utf8"));
		expect(await eventually(() => !alive(pid))).toBe(true);
	});

	test("aborting kills the hook and its children", async () => {
		const pidFile = join(dir, "pid");
		const controller = new AbortController();
		const running = hookRunnerSpawn()(alias(`sleep 30 & echo $! > ${pidFile}; wait`), { cwd: dir, env, signal: controller.signal });
		await eventually(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
		const pid = Number(readFileSync(pidFile, "utf8"));
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
		process.env.PATH = ["/proj/node_modules/.bin", "/usr/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin", saved.PATH].join(":");
		try {
			const out = join(dir, "env");
			await hookRunnerSpawn()(alias(`env > ${out}`), { cwd: dir, env: { ...env, EXTRA: "1" }, signal: new AbortController().signal });
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

	test("a cancelled hook gets time to clean up before it is killed", async () => {
		const cleaned = join(dir, "cleaned");
		const started = join(dir, "started");
		const controller = new AbortController();
		const running = hookRunnerSpawn()(alias(`trap 'sleep 0.5; touch ${cleaned}; exit 1' TERM; touch ${started}; sleep 30 & wait`), { cwd: dir, env, signal: controller.signal });
		await eventually(() => existsSync(started));
		controller.abort();
		await running;
		expect(existsSync(cleaned)).toBe(true);
	});
});
