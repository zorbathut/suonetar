import { bytesEqual, type TextCodec, textEncode } from "./codec.ts";

// The bytes to store for an edited message, or null when the edit comes back to the commit's own message. Like git's own cleanup, a stored message ends with a newline.
export function saveBytesMessage(text: string, codec: TextCodec, original: Uint8Array): Uint8Array | null {
	const typed = textEncode(text, codec);
	const ended = text === "" || text.endsWith("\n") ? typed : textEncode(`${text}\n`, codec);
	return bytesEqual(typed, original) || bytesEqual(ended, original) ? null : ended;
}

// The content to store for an edited file; null takes the file out of the commit, which is what emptying a file this commit adds means, unless it was added empty.
export function saveBytesFile(text: string, codec: TextCodec, file: { readonly parent: Uint8Array | undefined; readonly commit: Uint8Array | undefined }): Uint8Array | null {
	const drop = text === "" && file.parent === undefined && file.commit !== undefined && file.commit.length > 0;
	return drop ? null : textEncode(text, codec);
}
