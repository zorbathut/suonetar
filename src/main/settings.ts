import { readFile, rename, writeFile } from "node:fs/promises";
import { LAYOUTS, type Layout } from "../shared/api.ts";

// Settings that outlive a window live in a file of the app's profile, not the page's localStorage: Chromium gives every instance after the first an in-memory localStorage that is never saved, since the first holds the profile's lock, and every window is an instance.

export async function settingsLayoutRead(file: string): Promise<Layout> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (err) {
		if (err instanceof Error && "code" in err && err.code === "ENOENT") {
			return "inline";
		}
		throw err;
	}
	const parsed: unknown = JSON.parse(text);
	const value = typeof parsed === "object" && parsed !== null && "layout" in parsed ? parsed.layout : undefined;
	const layout = LAYOUTS.find((l) => l === value);
	if (layout === undefined) {
		throw new Error(`${file} names no layout this version knows: ${text.trim()}`);
	}
	return layout;
}

// Written whole and renamed into place, so a window starting meanwhile never reads half a file.
export async function settingsLayoutWrite(file: string, layout: Layout): Promise<void> {
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify({ layout })}\n`);
	await rename(temporary, file);
}
