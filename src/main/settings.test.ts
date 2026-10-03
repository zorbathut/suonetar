import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { settingsLayoutRead, settingsLayoutWrite } from "./settings.ts";

describe("settings", () => {
	const dirs: string[] = [];
	const file = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "suonetar-settings-"));
		dirs.push(dir);
		return join(dir, "settings.json");
	};
	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reads inline before anything is saved", async () => {
		expect(await settingsLayoutRead(file())).toBe("inline");
	});

	it("reads back the layout saved last", async () => {
		const path = file();
		await settingsLayoutWrite(path, "three");
		expect(await settingsLayoutRead(path)).toBe("three");
		await settingsLayoutWrite(path, "inline");
		expect(await settingsLayoutRead(path)).toBe("inline");
	});

	it("refuses a file naming no known layout", async () => {
		const path = file();
		writeFileSync(path, JSON.stringify({ layout: "sideways" }));
		await expect(settingsLayoutRead(path)).rejects.toThrow();
		writeFileSync(path, "not json");
		await expect(settingsLayoutRead(path)).rejects.toThrow();
	});
});
