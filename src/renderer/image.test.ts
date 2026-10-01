import { describe, expect, it } from "vitest";
import { imagePanes, imageType } from "./image.ts";

const bytes = (...parts: (string | number[])[]) => new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((ch) => ch.charCodeAt(0)) : p)));
const PNG = bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a], "rest");
const GIF = bytes("GIF89a", [1, 0]);
const TEXT = bytes("hello\n");
const file = (parent: Uint8Array | undefined, draft: Uint8Array | undefined, status: "A" | "M" | "D" | "T" | "=" = "M") => ({ parent, draft, status });

describe("imageType", () => {
	it("recognises each format by its magic bytes", () => {
		expect(imageType(PNG)).toBe("image/png");
		expect(imageType(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
		expect(imageType(bytes("GIF87a"))).toBe("image/gif");
		expect(imageType(GIF)).toBe("image/gif");
		expect(imageType(bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 "))).toBe("image/webp");
		expect(imageType(bytes([0, 0, 0, 0x1c], "ftypavif"))).toBe("image/avif");
		expect(imageType(bytes([0, 0, 0, 0x1c], "ftypavis"))).toBe("image/avif");
		expect(imageType(bytes("BM", [0, 0, 0, 0]))).toBe("image/bmp");
		expect(imageType(bytes([0, 0, 1, 0, 1, 0]))).toBe("image/x-icon");
	});

	it("rejects text, a truncated header, other containers, and nothing", () => {
		expect(imageType(TEXT)).toBeUndefined();
		expect(imageType(PNG.subarray(0, 4))).toBeUndefined();
		expect(imageType(bytes("RIFF", [0, 0, 0, 0], "WAVEfmt "))).toBeUndefined();
		expect(imageType(bytes([0, 0, 0, 0x1c], "ftypmp42"))).toBeUndefined();
		expect(imageType(bytes("XXXX", [0, 0, 0, 0], "WEBPVP8 "))).toBeUndefined();
		expect(imageType(new Uint8Array())).toBeUndefined();
	});
});

describe("imagePanes", () => {
	it("shows a modified, added, or deleted image against what was there", () => {
		expect(imagePanes(file(PNG, GIF))).toEqual({
			before: { kind: "image", bytes: PNG, type: "image/png" },
			after: { kind: "image", bytes: GIF, type: "image/gif" },
			undone: false,
		});
		expect(imagePanes(file(undefined, PNG, "A"))).toMatchObject({ before: { kind: "absent" }, after: { kind: "image" } });
		expect(imagePanes(file(PNG, undefined, "D"))).toMatchObject({ before: { kind: "image" }, after: { kind: "absent" } });
	});

	it("explains a draft that undoes the commit's change", () => {
		expect(imagePanes(file(PNG, PNG, "="))?.undone).toBe(true);
		expect(imagePanes(file(PNG, GIF))?.undone).toBe(false);
	});

	it("shows a side that is not an image as such, next to one that is", () => {
		expect(imagePanes(file(TEXT, PNG))).toMatchObject({ before: { kind: "other" }, after: { kind: "image" } });
		expect(imagePanes(file(PNG, bytes("target/path"), "T"))).toMatchObject({ before: { kind: "image" }, after: { kind: "other" } });
		// Text that happens to start like a bitmap is still text.
		expect(imagePanes(file(bytes("BMW/models\n"), PNG, "T"))).toMatchObject({ before: { kind: "other" }, after: { kind: "image" } });
	});

	it("is not used without an image to show", () => {
		expect(imagePanes(file(undefined, undefined, "="))).toBeUndefined();
		expect(imagePanes(file(bytes([0, 1, 2]), bytes([3, 0, 4])))).toBeUndefined();
	});
});
