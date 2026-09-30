import { describe, expect, it } from "vitest";
import { saveBytesFile, saveBytesMessage } from "./save-bytes.ts";

const utf8 = (s: string) => new TextEncoder().encode(s);
const lf = { bom: false, eol: "\n" } as const;
const show = (b: Uint8Array | null) => (b === null ? null : new TextDecoder().decode(b));

describe("saveBytesMessage", () => {
	it("is null when the text comes back to the original, with or without its final newline", () => {
		expect(saveBytesMessage("subject\n", lf, utf8("subject\n"))).toBeNull();
		expect(saveBytesMessage("subject", lf, utf8("subject\n"))).toBeNull();
		expect(saveBytesMessage("subject", lf, utf8("subject"))).toBeNull();
	});

	it("ends an edited message with a newline", () => {
		expect(show(saveBytesMessage("subject\n\nbody", lf, utf8("subject\n")))).toBe("subject\n\nbody\n");
	});
});

describe("saveBytesFile", () => {
	it("takes an emptied added file out of the commit", () => {
		expect(saveBytesFile("", lf, { parent: undefined, commit: utf8("x\n") })).toBeNull();
	});

	it("keeps an empty file that the commit added empty, or one that existed before", () => {
		expect(show(saveBytesFile("", lf, { parent: undefined, commit: utf8("") }))).toBe("");
		expect(show(saveBytesFile("", lf, { parent: utf8("old\n"), commit: utf8("x\n") }))).toBe("");
	});
});
