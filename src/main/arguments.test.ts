import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { argumentsRead } from "./arguments.ts";

describe("argumentsRead", () => {
	test("unpackaged, the repository and base follow electron and the app path", () => {
		expect(argumentsRead(["/x/electron", ".", "repo", "origin/core"], false, undefined, "/work")).toEqual({
			repo: resolve("/work/repo"),
			base: "origin/core",
			dirInvoked: resolve("/work"),
		});
	});

	test("packaged, they follow the executable, and flags are skipped wherever they are", () => {
		expect(argumentsRead(["/opt/suonetar", "--no-sandbox", "/abs/repo", "--enable-logging", "dev"], true, undefined, "/work")).toEqual({
			repo: resolve("/abs/repo"),
			base: "dev",
			dirInvoked: resolve("/work"),
		});
	});

	test("a relative repository resolves against where npm was run", () => {
		expect(argumentsRead(["/x/electron", ".", "../other"], false, "/home/me/werk/here", "/pkg")).toEqual({
			repo: resolve("/home/me/werk/other"),
			base: undefined,
			dirInvoked: resolve("/home/me/werk/here"),
		});
	});

	test("a packaged build resolves against its own working directory, whatever npm left behind", () => {
		expect(argumentsRead(["/opt/suonetar", "repo"], true, "/stale/npm/dir", "/work")).toEqual({ repo: resolve("/work/repo"), base: undefined, dirInvoked: resolve("/work") });
	});

	test("unpackaged, nothing given looks where npm was run, not in the package", () => {
		expect(argumentsRead(["/x/electron", "."], false, "/home/me/werk/here", "/pkg")).toEqual({ repo: undefined, base: undefined, dirInvoked: resolve("/home/me/werk/here") });
	});

	test("nothing given is nothing", () => {
		expect(argumentsRead(["/opt/suonetar"], true, undefined, "/work")).toEqual({ repo: undefined, base: undefined, dirInvoked: resolve("/work") });
	});

	test("flags alone are nothing too", () => {
		expect(argumentsRead(["/opt/suonetar", "--no-sandbox"], true, undefined, "/work")).toEqual({ repo: undefined, base: undefined, dirInvoked: resolve("/work") });
	});
});
