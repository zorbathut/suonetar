import { describe, expect, it } from "vitest";
import { bytesEqual, textDecode, textEncode } from "./codec.ts";

const utf8 = (s: string) => new TextEncoder().encode(s);

function roundTrip(bytes: Uint8Array): Uint8Array {
	const decoded = textDecode(bytes);
	if (decoded.kind !== "text") {
		throw new Error(`expected text, got ${decoded.kind}`);
	}
	return textEncode(decoded.text, decoded.codec);
}

describe("textDecode / textEncode", () => {
	it.each([
		["plain LF", "a\nb\n"],
		["no trailing newline", "a\nb"],
		["empty", ""],
		["CRLF", "a\r\nb\r\n"],
		["BOM", "﻿a\nb\n"],
		["BOM and CRLF", "﻿a\r\nb"],
		["non-ASCII", "é ☃ 🎞\n"],
	])("round-trips %s exactly", (_name, text) => {
		const bytes = utf8(text);
		expect(bytesEqual(roundTrip(bytes), bytes)).toBe(true);
	});

	it("gives the editor LF text for CRLF files and restores CRLF on edit", () => {
		const decoded = textDecode(utf8("a\r\nb\r\n"));
		expect(decoded.kind === "text" && decoded.text).toBe("a\nb\n");
		if (decoded.kind === "text") {
			expect(new TextDecoder().decode(textEncode("a\nx\nb\n", decoded.codec))).toBe("a\r\nx\r\nb\r\n");
		}
	});

	it("strips the BOM from the editor text", () => {
		const decoded = textDecode(utf8("﻿hello"));
		expect(decoded.kind === "text" && decoded.text).toBe("hello");
	});

	it.each([
		["mixed endings", utf8("a\r\nb\n")],
		["CR only", utf8("a\rb\r")],
		["invalid UTF-8", new Uint8Array([0x61, 0xff, 0x62])],
	])("opens %s read-only", (_name, bytes) => {
		const decoded = textDecode(bytes);
		expect(decoded.kind).toBe("readonly");
		expect(decoded.kind === "readonly" && decoded.reason).not.toBe("");
	});

	it("treats NUL bytes as binary", () => {
		expect(textDecode(new Uint8Array([0x61, 0, 0x62])).kind).toBe("binary");
	});
});
