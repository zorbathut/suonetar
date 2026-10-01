import type { DocumentFile } from "../engine/session.ts";
import type { Wire } from "../shared/api.ts";
import { textDecode } from "./codec.ts";
import { el } from "./dom.ts";

// Formats Chromium decodes, by their magic bytes: every part must match at its offset.
const SIGNATURES: readonly { readonly type: string; readonly parts: readonly (readonly [number, readonly (number | string)[]])[] }[] = [
	{ type: "image/png", parts: [[0, [0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a]]] },
	{ type: "image/jpeg", parts: [[0, [0xff, 0xd8, 0xff]]] },
	{ type: "image/gif", parts: [[0, ["GIF87a"]]] },
	{ type: "image/gif", parts: [[0, ["GIF89a"]]] },
	{
		type: "image/webp",
		parts: [
			[0, ["RIFF"]],
			[8, ["WEBP"]],
		],
	},
	{ type: "image/avif", parts: [[4, ["ftypavif"]]] },
	{ type: "image/avif", parts: [[4, ["ftypavis"]]] },
	{ type: "image/bmp", parts: [[0, ["BM"]]] },
	{ type: "image/x-icon", parts: [[0, [0, 0, 1, 0]]] },
];

function partMatches(data: Uint8Array, at: number, part: readonly (number | string)[]): boolean {
	const expected = part.flatMap((p) => (typeof p === "string" ? [...p].map((ch) => ch.charCodeAt(0)) : [p]));
	return data.length >= at + expected.length && expected.every((b, i) => data[at + i] === b);
}

// The image's MIME type, judged by content rather than file name, or undefined when it is not an image Suonetar shows.
export function imageType(data: Uint8Array): string | undefined {
	return SIGNATURES.find((s) => s.parts.every(([at, part]) => partMatches(data, at, part)))?.type;
}

export type ImagePane = { readonly kind: "image"; readonly bytes: Uint8Array; readonly type: string } | { readonly kind: "absent" } | { readonly kind: "other" };

// `undone`: the draft puts the file back as it was before the commit, so both sides are the same.
export type ImagePanes = { readonly before: ImagePane; readonly after: ImagePane; readonly undone: boolean };

function paneOf(data: Uint8Array | undefined): ImagePane {
	if (data === undefined) {
		return { kind: "absent" };
	}
	const type = imageType(data);
	// The weakest signatures ("BM") also start ordinary text, such as the other side of a text file replaced by an image.
	return type === undefined || textDecode(data).kind === "text" ? { kind: "other" } : { kind: "image", bytes: data, type };
}

// What a binary file's before and after panes show: the parent's version and the version as it would be published (the draft side, absent when deleted). Undefined when neither is an image, so the file keeps the plain binary note.
export function imagePanes(file: Pick<Wire<DocumentFile>, "parent" | "draft" | "status">): ImagePanes | undefined {
	const before = paneOf(file.parent);
	const after = paneOf(file.draft);
	if (before.kind !== "image" && after.kind !== "image") {
		return undefined;
	}
	return { before, after, undone: file.status === "=" };
}

function sizeText(n: number): string {
	return n < 1024 ? `${n} bytes` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

// One image from bytes. Its object URL is revoked once it has loaded (or failed): a loaded image keeps painting without it, so nothing has to track the URL. `onSize` gets the pixel size.
export function imageElement(data: Uint8Array, type: string, alt: string, onSize: (width: number, height: number) => void = () => undefined): HTMLElement {
	const holder = el("div", { class: "image-checker" });
	const img = el("img", {});
	img.alt = alt;
	const url = URL.createObjectURL(new Blob([data.slice()], { type }));
	img.addEventListener("load", () => {
		URL.revokeObjectURL(url);
		onSize(img.naturalWidth, img.naturalHeight);
	});
	img.addEventListener("error", () => {
		URL.revokeObjectURL(url);
		holder.replaceWith(el("div", { class: "note", text: "(cannot be displayed)" }));
	});
	img.src = url;
	holder.append(img);
	return holder;
}

function paneCreate(label: string, pane: ImagePane): HTMLElement {
	const caption = el("div", { class: "image-caption", text: label });
	switch (pane.kind) {
		case "absent":
			return el("div", { class: "image-pane" }, caption, el("div", { class: "note", text: "(no file)" }));
		case "other":
			return el("div", { class: "image-pane" }, caption, el("div", { class: "note", text: "(not an image)" }));
		case "image": {
			const size = sizeText(pane.bytes.length);
			caption.textContent = `${label} · ${size}`;
			const image = imageElement(pane.bytes, pane.type, label, (width, height) => {
				caption.textContent = `${label} · ${width}×${height} · ${size}`;
			});
			return el("div", { class: "image-pane" }, caption, image);
		}
		default: {
			const never: never = pane;
			throw new Error(`unknown image pane ${String(never)}`);
		}
	}
}

// A binary file's image change, before and after side by side.
export function imageCompare(panes: ImagePanes): HTMLElement {
	const root = el("div", { class: "image-compare" });
	if (panes.undone) {
		root.append(el("div", { class: "note", text: "Your edit undoes this commit's change to the file." }));
	}
	root.append(el("div", { class: "image-panes" }, paneCreate("Before", panes.before), paneCreate("After", panes.after)));
	return root;
}
