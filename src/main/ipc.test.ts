import type { WebContents } from "electron";
import { describe, expect, it } from "vitest";
import { APPLY_PROGRESS_CHANNEL, apiChannel, type Result, type SuonetarApi } from "../shared/api.ts";
import { ipcRegister, type SessionApi } from "./ipc.ts";

type Handler = (event: { sender: WebContents }, ...args: unknown[]) => Promise<Result<unknown>>;

const OID = "0123456789abcdef0123456789abcdef01234567";
const sent: [string, unknown][] = [];
const ours = { isDestroyed: () => false, send: (channel: string, value: unknown) => sent.push([channel, value]) } as unknown as WebContents;
const stranger = {} as WebContents;

// Every API method; a missing key is a compile error.
const NAMES: Record<keyof SuonetarApi, true> = {
	state: true,
	generation: true,
	commitDocument: true,
	commitConflict: true,
	draftDocument: true,
	blob: true,
	blobAt: true,
	draftSetFile: true,
	draftRestore: true,
	draftSetMessage: true,
	draftDiscard: true,
	draftConfirm: true,
	draftAdopt: true,
	resolve: true,
	preview: true,
	apply: true,
	undo: true,
	worktreeStatus: true,
	worktreeDocument: true,
	indentation: true,
	mergetoolName: true,
	mergetool: true,
	cancel: true,
};

function harness() {
	const handlers = new Map<string, Handler>();
	const calls: [string, unknown[]][] = [];
	const record =
		(name: string, value: unknown = undefined) =>
		async (...args: unknown[]) => {
			calls.push([name, args]);
			return value;
		};
	const session = Object.fromEntries(Object.keys(NAMES).map((n) => [n, record(n, n === "resolve" ? { kind: "resolved" } : undefined)])) as unknown as SessionApi;
	let current: SessionApi | undefined = session;
	ipcRegister(
		{
			handle: (channel: string, handler: Handler) => {
				handlers.set(channel, handler);
			},
		} as never,
		() => {
			if (current === undefined) {
				throw new Error("No repository is open");
			}
			return current;
		},
		(sender) => sender === ours,
		() => undefined,
	);
	const invoke = (name: keyof SuonetarApi, ...args: unknown[]) => {
		const handler = handlers.get(apiChannel(name));
		if (handler === undefined) {
			throw new Error(`no handler for ${name}`);
		}
		return handler({ sender: ours }, ...args);
	};
	const close = () => {
		current = undefined;
	};
	return { handlers, calls, invoke, close };
}

describe("ipcRegister", () => {
	it("registers exactly one channel per API method", () => {
		const { handlers } = harness();
		expect([...handlers.keys()].sort()).toEqual(
			Object.keys(NAMES)
				.map((n) => apiChannel(n as keyof SuonetarApi))
				.sort(),
		);
	});

	it("calls whichever session is open at the time, and fails cleanly with none", async () => {
		const { invoke, calls, close } = harness();
		expect((await invoke("state")).ok).toBe(true);
		close();
		const result = await invoke("state");
		expect(result.ok).toBe(false);
		expect(calls.map(([name]) => name)).toEqual(["state"]);
	});

	it("refuses calls from any other page", async () => {
		const { handlers, calls } = harness();
		const result = await handlers.get(apiChannel("apply"))?.({ sender: stranger });
		expect(result?.ok).toBe(false);
		expect(calls).toEqual([]);
	});

	it("turns bytes into Buffers and null into a deletion or an absent file", async () => {
		const { invoke, calls } = harness();
		expect((await invoke("draftSetFile", OID, OID, "a.txt", OID, new Uint8Array([104, 105]))).ok).toBe(true);
		expect((await invoke("draftSetFile", OID, OID, "a.txt", null, null)).ok).toBe(true);
		const [first, second] = calls;
		expect(Buffer.isBuffer(first?.[1][4])).toBe(true);
		expect(String(first?.[1][4])).toBe("hi");
		expect(second?.[1][3]).toBeNull();
		expect(second?.[1][4]).toBeNull();
	});

	it.each([
		["a non-oid", "commitDocument", ["HEAD"]],
		["a revision passed as a blob id", "blob", [`${OID}:path`]],
		["a string for content", "draftSetFile", [OID, OID, "a.txt", OID, "text"]],
		["a non-oid parent tree", "draftSetFile", [OID, "HEAD", "a.txt", OID, new Uint8Array([104])]],
		["a non-oid shown blob", "draftSetFile", [OID, OID, "a.txt", "HEAD:a.txt", new Uint8Array([104])]],
		["an unknown restore source", "draftRestore", [OID, OID, "a.txt", "somewhere"]],
		["a malformed choice", "resolve", [{ base: OID, ours: OID, theirs: OID }, "key", [{ path: "p", sideways: true }]]],
		["incomplete merge inputs", "resolve", [{ base: OID }, "key", []]],
		["an unknown hook choice", "apply", [{ kind: "sometimes" }]],
		["a non-oid commit to skip", "apply", [{ kind: "run", skip: ["HEAD"] }]],
		["an unknown undo kind", "undo", [OID, OID, "sideways"]],
		["a non-oid undo target", "undo", ["HEAD", OID, "exact"]],
		["an unknown worktree side", "worktreeDocument", ["both"]],
		["text instead of bytes for the merge tool", "mergetool", [{ base: OID, ours: OID, theirs: OID }, "key", "a.txt", "text"]],
	] as const)("rejects %s without calling the session", async (_what, name, args) => {
		const { invoke, calls } = harness();
		const result = await invoke(name, ...args);
		expect(result.ok ? undefined : result.error.name).toBe("ErrorIpcArgument");
		expect(calls).toEqual([]);
	});

	it("passes every resolution choice kind through", async () => {
		const { invoke, calls } = harness();
		const choices = [
			{ path: "a", keep: true },
			{ path: "b", stage: 2, from: "b~x" },
			{ path: "c", content: new Uint8Array([120]), markersAllowed: true },
			{ path: "d", delete: "directory" },
		];
		expect((await invoke("resolve", { base: OID, ours: OID, theirs: OID }, "key", choices)).ok).toBe(true);
		const passed = calls[0]?.[1][2] as { path: string; content?: unknown }[];
		expect(passed.map((c) => c.path)).toEqual(["a", "b", "c", "d"]);
		expect(Buffer.isBuffer(passed[2]?.content)).toBe(true);
	});

	it("passes the hook choice through and sends progress to the calling page", async () => {
		const { invoke, calls } = harness();
		sent.length = 0;
		expect((await invoke("apply", { kind: "run", skip: [OID] })).ok).toBe(true);
		const [name, args] = calls[0] ?? ["", []];
		expect(name).toBe("apply");
		expect(args[0]).toEqual({ kind: "run", skip: [OID] });
		(args[1] as (p: unknown) => void)({ step: "write" });
		expect(sent).toEqual([[APPLY_PROGRESS_CHANNEL, { step: "write" }]]);
	});
});
