// The Electron main that layout tests run (layout-harness.ts beside it): opens a page in a hidden offscreen window of a given size, runs one of the scenarios the page puts in `window.layoutScenarios`, and writes `{ value }` or `{ error }` to a file. A file rather than stdout, so that nothing depends on output being flushed before the process exits. The page's console goes to stderr, for the harness to show when a run fails.
import { writeFileSync } from "node:fs";
import { app, BrowserWindow } from "electron";

const [page, scenario, width, height, resultPath] = process.argv.slice(-5);

// Runs in the page: the scenario's error comes back as data, since Electron reduces a rejection to its message.
const SCENARIO_RUN = `(name, width, height) => {
	if (innerWidth !== width || innerHeight !== height) {
		return { error: "the window is " + innerWidth + "×" + innerHeight + ", not " + width + "×" + height };
	}
	const scenario = window.layoutScenarios?.[name];
	if (scenario === undefined) {
		return { error: "the page has no scenario " + name };
	}
	return Promise.resolve().then(scenario).then((value) => ({ value }), (e) => ({ error: String(e?.stack ?? e) }));
}`;

async function main(): Promise<void> {
	if (page === undefined || scenario === undefined || resultPath === undefined) {
		throw new Error("usage: layout-harness-main.ts <page> <scenario> <width> <height> <result file>");
	}
	const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
	window.webContents.on("console-message", (e) => {
		process.stderr.write(`page ${e.level}: ${e.message}\n`);
	});
	window.webContents.on("render-process-gone", (_e, details) => {
		process.stderr.write(`page process gone: ${details.reason}\n`);
	});
	// The size otherwise follows the display: 639×479 under xvfb, 1×1 headless.
	window.setContentSize(Number(width), Number(height));
	// The offscreen maximum: scroll passes wait on frames, and the results are the same at any rate.
	window.webContents.setFrameRate(240);
	await window.loadFile(page);
	const result: unknown = await window.webContents.executeJavaScript(`(${SCENARIO_RUN})(${JSON.stringify(scenario)}, ${Number(width)}, ${Number(height)})`);
	writeFileSync(resultPath, JSON.stringify(result));
	app.exit(0);
}

function fail(error: unknown): void {
	if (resultPath !== undefined) {
		writeFileSync(resultPath, JSON.stringify({ error: error instanceof Error ? (error.stack ?? error.message) : String(error) }));
	}
	app.exit(1);
}

// Not a top-level await, which hangs an Electron main.
app.whenReady().then(main).catch(fail);
