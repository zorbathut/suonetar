import { describe, expect, it } from "vitest";
import { ErrorStale } from "../engine/errors.ts";
import { resultOf } from "./result.ts";

describe("resultOf", () => {
	it("wraps a value", async () => {
		const logged: unknown[] = [];
		expect(
			await resultOf(
				async () => 42,
				(_m, err) => logged.push(err),
			),
		).toEqual({ ok: true, value: 42 });
		expect(logged).toEqual([]);
	});

	it("keeps the error class name and logs the error", async () => {
		const logged: unknown[] = [];
		const result = await resultOf(
			async () => {
				throw new ErrorStale("commit abc");
			},
			(_m, err) => logged.push(err),
		);
		expect(result.ok).toBe(false);
		expect(result.ok ? undefined : result.error.name).toBe("ErrorStale");
		expect(result.ok ? "" : result.error.message).not.toBe("");
		expect(logged).toHaveLength(1);
	});

	it("reports non-Error throws", async () => {
		const result = await resultOf(
			async () => {
				throw "boom";
			},
			() => undefined,
		);
		expect(result).toEqual({ ok: false, error: { name: "Error", message: "boom" } });
	});
});
