import type { Result } from "../shared/api.ts";

// Runs one IPC call, turning a thrown error into data the renderer can show; the error is also logged here, where its stack is available.
export async function resultOf<T>(fn: () => Promise<T>, log: (message: string, err: unknown) => void): Promise<Result<T>> {
	try {
		return { ok: true, value: await fn() };
	} catch (err) {
		log("IPC call failed", err);
		if (err instanceof Error) {
			return { ok: false, error: { name: err.name, message: err.message } };
		}
		return { ok: false, error: { name: "Error", message: String(err) } };
	}
}
