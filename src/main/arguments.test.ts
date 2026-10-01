import { describe, expect, test } from "vitest";
import { argumentsRead } from "./arguments.ts";

describe("argumentsRead", () => {
	test("unpackaged, the repository and base follow electron and the app path", () => {
		expect(argumentsRead(["/x/electron", ".", "repo", "origin/core"], false, undefined, "/work")).toEqual({ repo: "/work/repo", base: "origin/core" });
	});

	test("packaged, they follow the executable, and flags are skipped wherever they are", () => {
		expect(argumentsRead(["/opt/suonetar", "--no-sandbox", "/abs/repo", "--enable-logging", "dev"], true, undefined, "/work")).toEqual({ repo: "/abs/repo", base: "dev" });
	});

	test("a relative repository resolves against where npm was run", () => {
		expect(argumentsRead(["/x/electron", ".", "../other"], false, "/home/me/werk/here", "/pkg")).toEqual({ repo: "/home/me/werk/other", base: undefined });
	});

	test("a packaged build resolves against its own working directory, whatever npm left behind", () => {
		expect(argumentsRead(["/opt/suonetar", "repo"], true, "/stale/npm/dir", "/work")).toEqual({ repo: "/work/repo", base: undefined });
	});

	test("nothing given is nothing", () => {
		expect(argumentsRead(["/opt/suonetar"], true, undefined, "/work")).toEqual({ repo: undefined, base: undefined });
	});
});
