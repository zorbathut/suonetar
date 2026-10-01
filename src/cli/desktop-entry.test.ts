import { describe, expect, test } from "vitest";
import { desktopEntry, execArgument } from "./desktop-entry.ts";

describe("execArgument", () => {
	test("leaves a plain path alone", () => {
		expect(execArgument("/usr/bin/node")).toBe("/usr/bin/node");
	});

	test("quotes a path with spaces and escapes what the spec reserves, then the string escapes", () => {
		expect(execArgument("/home/me/my work")).toBe('"/home/me/my work"');
		expect(execArgument('/a "b" $c `d`')).toBe('"/a \\\\"b\\\\" \\\\$c \\\\`d\\\\`"');
		expect(execArgument("/back\\slash")).toBe('"/back\\\\\\\\slash"');
		expect(execArgument("/50%off")).toBe("/50%%off");
	});

	test("refuses a control character, which no desktop entry can hold", () => {
		expect(() => execArgument("/home/me/new\nline")).toThrow();
	});
});

describe("desktopEntry", () => {
	test("starts this checkout through npm, with the window's app ID as its class", () => {
		const entry = desktopEntry("/home/me/werk/suonetar");
		const keys = new Map(
			entry
				.split("\n")
				.filter((line) => line.includes("="))
				.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
		);
		expect(entry.startsWith("[Desktop Entry]\n")).toBe(true);
		expect(keys.get("Exec")).toBe("npm --prefix /home/me/werk/suonetar run app -- %f");
		expect(keys.get("StartupWMClass")).toBe("suonetar");
		expect(keys.get("Icon")).toBe("suonetar");
		expect(keys.get("Type")).toBe("Application");
	});
});
