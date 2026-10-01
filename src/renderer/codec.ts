// How a text file's bytes map onto the editor's string, so that saving an unedited file reproduces it byte for byte.
export type TextCodec = { readonly bom: boolean; readonly eol: "\n" | "\r\n" };

export type Decoded =
	// Editor text always uses "\n"; `textEncode` puts the file's own line ending back.
	| { readonly kind: "text"; readonly text: string; readonly codec: TextCodec }
	// Shown, but saving could not reproduce the bytes faithfully, so it is not editable.
	| { readonly kind: "readonly"; readonly text: string; readonly reason: string }
	| { readonly kind: "binary" };

const BOM = "﻿";

function lenient(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export function textDecode(bytes: Uint8Array): Decoded {
	if (bytes.includes(0)) {
		return { kind: "binary" };
	}
	let raw: string;
	try {
		raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch (err) {
		if (err instanceof TypeError) {
			return { kind: "readonly", text: lenient(bytes), reason: "is not valid UTF-8" };
		}
		throw err;
	}
	const bom = raw.startsWith(BOM);
	const body = bom ? raw.slice(1) : raw;
	const crlf = body.match(/\r\n/g)?.length ?? 0;
	const cr = (body.match(/\r/g)?.length ?? 0) - crlf;
	const lf = (body.match(/\n/g)?.length ?? 0) - crlf;
	if (cr > 0 || (crlf > 0 && lf > 0)) {
		return { kind: "readonly", text: body.replace(/\r\n?/g, "\n"), reason: cr > 0 && crlf === 0 && lf === 0 ? "uses CR line endings" : "has mixed line endings" };
	}
	const eol = crlf > 0 ? "\r\n" : "\n";
	return { kind: "text", text: eol === "\r\n" ? body.replaceAll("\r\n", "\n") : body, codec: { bom, eol } };
}

export function textEncode(text: string, codec: TextCodec): Uint8Array {
	const body = codec.eol === "\n" ? text : text.replaceAll("\n", codec.eol);
	return new TextEncoder().encode(codec.bom ? BOM + body : body);
}

// Text for display only, whatever the bytes are.
export function textShow(bytes: Uint8Array | undefined): string {
	return bytes === undefined ? "" : lenient(bytes).replace(/\r\n?/g, "\n");
}

export function bytesEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
	if (a === undefined || b === undefined) {
		return a === b;
	}
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
}
