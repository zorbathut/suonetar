// Runs renderer code under real layout, for what jsdom can't show: a page bundled from a test entry is opened in the project's own Electron, in a hidden offscreen window (layout-harness-main.ts), and each scenario the page defines in `window.layoutScenarios` returns plain JSON measurements for the test to assert on.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { build } from "vite";
import { TIMEOUT_SCALE } from "../../engine/test-support/timeout.ts";

// The window's content size, which pages can count on: the main checks it before running a scenario.
export const LAYOUT_WIDTH = 1000;
export const LAYOUT_HEIGHT = 800;

// The longest a scenario's Electron may run, startup included, before it is killed and its output shown.
const RUN_TIMEOUT = 60_000 * TIMEOUT_SCALE;
// A test's own timeout, longer, so that a hung scenario fails with Electron's output rather than Vitest's bare timeout.
export const LAYOUT_TEST_TIMEOUT = RUN_TIMEOUT + 20_000 * TIMEOUT_SCALE;

const MAIN = join(import.meta.dirname, "layout-harness-main.ts");

export type LayoutPage = { readonly html: string; readonly dir: string };

// A directory Electron may still be writing in as it exits, or (on Windows) holding open a moment after.
function dirRemove(dir: string): Promise<void> {
	return rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

// Bundles `entry` and the styles it imports into a page in a fresh temporary directory, which `layoutPageRemove` deletes.
export async function layoutPage(entry: string): Promise<LayoutPage> {
	const dir = await mkdtemp(join(tmpdir(), "suonetar-layout-"));
	try {
		await build({
			configFile: false,
			logLevel: "silent",
			build: { outDir: dir, emptyOutDir: false, minify: false, cssCodeSplit: false, lib: { entry, formats: ["es"], fileName: "page" } },
		});
		// Only the entry: the other scripts are chunks it imports when it needs them, such as each language's support.
		const styles = readdirSync(dir)
			.filter((f) => f.endsWith(".css"))
			.map((f) => `<link rel="stylesheet" href="./${f}">`);
		const html = join(dir, "page.html");
		writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8">${styles.join("")}</head><body><script type="module" src="./page.js"></script></body></html>`);
		return { html, dir };
	} catch (err) {
		await dirRemove(dir);
		throw err;
	}
}

export function layoutPageRemove(page: LayoutPage): Promise<void> {
	return dirRemove(page.dir);
}

// The Electron binary, found as the electron package finds it; asking the package itself would download a missing binary synchronously, in the middle of a test.
function electronBinary(): string {
	const pkg = dirname(createRequire(import.meta.url).resolve("electron/package.json"));
	const pathFile = join(pkg, "path.txt");
	if (existsSync(pathFile)) {
		const executable = readFileSync(pathFile, "utf8");
		const override = process.env.ELECTRON_OVERRIDE_DIST_PATH;
		const binary = override === undefined ? join(pkg, "dist", executable) : join(override, executable);
		if (existsSync(binary)) {
			return binary;
		}
	}
	throw new Error("the Electron binary is not installed; run `npx install-electron`");
}

type Exit = { readonly output: string; readonly timedOut: boolean };

// Runs Electron to its end, killing it after RUN_TIMEOUT; resolves once it has closed, its output complete.
function electronRun(binary: string, args: readonly string[]): Promise<Exit> {
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	return new Promise((resolve, reject) => {
		const child = spawn(binary, args, { env, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		let timedOut = false;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (d: string) => {
			output += d;
		});
		child.stderr.on("data", (d: string) => {
			output += d;
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, RUN_TIMEOUT);
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", () => {
			clearTimeout(timer);
			resolve({ output, timedOut });
		});
	});
}

// Runs `scenario` of `page` in a fresh Electron, and gives what it returned; rejects with the scenario's error, or with Electron's output when it gave nothing.
export async function layoutRun(page: LayoutPage, scenario: string): Promise<unknown> {
	const binary = electronBinary();
	const scratch = await mkdtemp(join(tmpdir(), "suonetar-layout-run-"));
	const resultPath = join(scratch, "result.json");
	const args = [
		// Ubuntu's AppArmor refuses Chromium's sandbox to an unpackaged Electron; the page is the test's own.
		"--no-sandbox",
		...(process.platform === "linux" ? ["--ozone-platform=headless"] : []),
		`--user-data-dir=${join(scratch, "profile")}`,
		MAIN,
		page.html,
		scenario,
		String(LAYOUT_WIDTH),
		String(LAYOUT_HEIGHT),
		resultPath,
	];
	try {
		const { output, timedOut } = await electronRun(binary, args);
		if (timedOut) {
			throw new Error(`layout scenario ${scenario} timed out after ${RUN_TIMEOUT}ms:\n${output}`);
		}
		if (!existsSync(resultPath)) {
			throw new Error(`layout scenario ${scenario} gave no result:\n${output}`);
		}
		const result: unknown = JSON.parse(readFileSync(resultPath, "utf8"));
		if (typeof result !== "object" || result === null) {
			throw new Error(`layout scenario ${scenario} gave ${JSON.stringify(result)}`);
		}
		if ("error" in result) {
			throw new Error(`layout scenario ${scenario} failed: ${String(result.error)}\n${output}`);
		}
		if (!("value" in result)) {
			throw new Error(`layout scenario ${scenario} gave no value:\n${output}`);
		}
		return result.value;
	} finally {
		await dirRemove(scratch);
	}
}
