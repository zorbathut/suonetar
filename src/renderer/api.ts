import type { Result, SuonetarApi } from "../shared/api.ts";

// An error the main process reported; `remoteName` is the engine's error class (`ErrorStale`, `ErrorEditRefused`, ...).
export class ErrorRemote extends Error {
	readonly remoteName: string;

	constructor(remoteName: string, message: string) {
		super(message);
		this.name = "ErrorRemote";
		this.remoteName = remoteName;
	}
}

export const api: SuonetarApi = window.suonetar;

export async function call<T>(pending: Promise<Result<T>>): Promise<T> {
	const result = await pending;
	if (!result.ok) {
		throw new ErrorRemote(result.error.name, result.error.message);
	}
	return result.value;
}

export function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
