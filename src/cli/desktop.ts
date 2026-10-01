// `npm run desktop` installs a launcher that starts this checkout, with Suonetar's icon, into the user's applications menu; `npm run desktop -- --remove` takes it out again. Run it again after moving the checkout. Linux only.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { desktopEntry } from "./desktop-entry.ts";

function fail(message: string): never {
	console.error(`desktop: ${message}`);
	process.exit(1);
}

if (process.platform !== "linux") {
	fail("launchers are installed this way on Linux only");
}
const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== "--remove");
if (unknown.length > 0) {
	fail(`unknown argument ${unknown.join(" ")}; the only one is --remove`);
}

const checkout = resolve(import.meta.dirname, "../..");
// The XDG base directory spec ignores an empty or relative XDG_DATA_HOME.
const dataHome = process.env.XDG_DATA_HOME;
const data = dataHome !== undefined && isAbsolute(dataHome) ? dataHome : join(homedir(), ".local", "share");
const entryPath = join(data, "applications", "suonetar.desktop");
const icons = [
	{ from: join(checkout, "resources", "icon.svg"), to: join(data, "icons", "hicolor", "scalable", "apps", "suonetar.svg") },
	{ from: join(checkout, "resources", "icon.png"), to: join(data, "icons", "hicolor", "256x256", "apps", "suonetar.png") },
];

if (args.includes("--remove")) {
	for (const path of [entryPath, ...icons.map((icon) => icon.to)]) {
		if (existsSync(path)) {
			rmSync(path);
			console.log(`removed ${path}`);
		}
	}
} else {
	for (const icon of icons) {
		mkdirSync(dirname(icon.to), { recursive: true });
		copyFileSync(icon.from, icon.to);
		console.log(`installed ${icon.to}`);
	}
	mkdirSync(dirname(entryPath), { recursive: true });
	writeFileSync(entryPath, desktopEntry(checkout));
	console.log(`installed ${entryPath}, starting ${checkout}`);
}

// Plasma's menu usually notices the change by itself; rebuilding its cache makes sure. A failure leaves the launcher in place, so it is reported rather than fatal, and elsewhere the tool is simply absent.
const rebuilt = spawnSync("kbuildsycoca6", [], { encoding: "utf8" });
const absent = rebuilt.error !== undefined && "code" in rebuilt.error && rebuilt.error.code === "ENOENT";
if (rebuilt.error !== undefined && !absent) {
	console.warn(`desktop: kbuildsycoca6 failed: ${rebuilt.error.message}`);
} else if (rebuilt.status !== 0 && !absent) {
	console.warn(`desktop: kbuildsycoca6 ${rebuilt.signal === null ? `exited ${rebuilt.status}` : `was killed by ${rebuilt.signal}`}: ${rebuilt.stderr.trim()}`);
}
