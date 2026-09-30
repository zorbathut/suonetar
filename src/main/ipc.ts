import type { IpcMain, WebContents } from "electron";
import type { MergeInputs } from "../engine/replay.ts";
import type { ResolutionChoice, Session } from "../engine/session.ts";
import { type ApiValue, apiChannel, type SuonetarApi } from "../shared/api.ts";
import { resultOf } from "./result.ts";

// The renderer is our own code, so a malformed argument is a bug, not user input; it is still checked because IPC is a trust boundary.
export class ErrorIpcArgument extends Error {
	constructor(what: string) {
		super(`malformed IPC argument: ${what}`);
		this.name = "ErrorIpcArgument";
	}
}

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function argOid(args: readonly unknown[], i: number): string {
	const value = args[i];
	if (typeof value !== "string" || !OID.test(value)) {
		throw new ErrorIpcArgument(`argument ${i} is not an object id`);
	}
	return value;
}

function argString(args: readonly unknown[], i: number): string {
	const value = args[i];
	if (typeof value !== "string") {
		throw new ErrorIpcArgument(`argument ${i} is not a string`);
	}
	return value;
}

function bytes(value: unknown, what: string): Buffer {
	if (!(value instanceof Uint8Array)) {
		throw new ErrorIpcArgument(`${what} is not bytes`);
	}
	return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function argBytesOrNull(args: readonly unknown[], i: number): Buffer | null {
	return args[i] === null ? null : bytes(args[i], `argument ${i}`);
}

function record(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null) {
		throw new ErrorIpcArgument(`${what} is not an object`);
	}
	return value as Record<string, unknown>;
}

function argInputs(args: readonly unknown[], i: number): MergeInputs {
	const value = record(args[i], `argument ${i}`);
	const inputs = [value.base, value.ours, value.theirs];
	return { base: argOid(inputs, 0), ours: argOid(inputs, 1), theirs: argOid(inputs, 2) };
}

function choice(value: unknown): ResolutionChoice {
	const c = record(value, "a resolution choice");
	const path = argString([c.path], 0);
	if (c.keep === true) {
		return { path, keep: true };
	}
	if (c.stage === 1 || c.stage === 2 || c.stage === 3) {
		return { path, stage: c.stage, from: c.from === undefined ? undefined : argString([c.from], 0) };
	}
	if (c.content !== undefined) {
		return { path, content: bytes(c.content, "resolution content"), markersAllowed: c.markersAllowed === true };
	}
	if (c.delete === "file" || c.delete === "directory") {
		return { path, delete: c.delete };
	}
	throw new ErrorIpcArgument("unknown resolution choice");
}

function argChoices(args: readonly unknown[], i: number): ResolutionChoice[] {
	const value = args[i];
	if (!Array.isArray(value)) {
		throw new ErrorIpcArgument(`argument ${i} is not a list`);
	}
	return value.map(choice);
}

export type SessionApi = Pick<
	Session,
	| "state"
	| "generation"
	| "commitDocument"
	| "draftDocument"
	| "blob"
	| "blobAt"
	| "draftSetFile"
	| "draftRestore"
	| "draftSetMessage"
	| "draftDiscard"
	| "draftConfirm"
	| "draftAdopt"
	| "resolve"
	| "preview"
	| "apply"
>;

// One handler per `SuonetarApi` method, each a single call into the session; calls from any page but ours are refused.
export function ipcRegister(ipc: Pick<IpcMain, "handle">, session: SessionApi, trusted: (sender: WebContents) => boolean, log: (message: string, err: unknown) => void): void {
	function handle<K extends keyof SuonetarApi>(name: K, fn: (args: readonly unknown[]) => Promise<ApiValue<K>>): void {
		ipc.handle(apiChannel(name), (event, ...args: unknown[]) =>
			resultOf(() => {
				if (!trusted(event.sender)) {
					throw new ErrorIpcArgument("call from an unknown page");
				}
				return fn(args);
			}, log),
		);
	}
	handle("state", () => session.state());
	handle("generation", () => session.generation());
	handle("commitDocument", (a) => session.commitDocument(argOid(a, 0)));
	handle("draftDocument", (a) => session.draftDocument(argOid(a, 0)));
	handle("blob", (a) => session.blob(argOid(a, 0)));
	handle("blobAt", (a) => session.blobAt(argOid(a, 0), argString(a, 1)));
	handle("draftSetFile", async (a) => {
		await session.draftSetFile(argOid(a, 0), argString(a, 1), argBytesOrNull(a, 2));
		return undefined;
	});
	handle("draftRestore", async (a) => {
		const from = a[2];
		if (from !== "commit" && from !== "parent") {
			throw new ErrorIpcArgument("argument 2 is not commit or parent");
		}
		await session.draftRestore(argOid(a, 0), argString(a, 1), from);
		return undefined;
	});
	handle("draftSetMessage", async (a) => {
		await session.draftSetMessage(argOid(a, 0), argBytesOrNull(a, 1) ?? undefined);
		return undefined;
	});
	handle("draftDiscard", async (a) => {
		await session.draftDiscard(argOid(a, 0));
		return undefined;
	});
	handle("draftConfirm", async (a) => {
		await session.draftConfirm(argOid(a, 0));
		return undefined;
	});
	handle("draftAdopt", async (a) => {
		await session.draftAdopt(argOid(a, 0));
		return undefined;
	});
	handle("resolve", (a) => session.resolve(argInputs(a, 0), argString(a, 1), argChoices(a, 2)));
	handle("preview", () => session.preview());
	handle("apply", () => session.apply());
}
