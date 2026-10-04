import type { DocumentFile } from "../engine/session.ts";
import type { ChangeKind } from "./overview.ts";

export type FileStatus = DocumentFile["status"];

export function statusLabel(status: FileStatus): string {
	switch (status) {
		case "A":
			return "added";
		case "M":
			return "modified";
		case "D":
			return "deleted";
		case "T":
			return "type changed";
		case "=":
			return "unchanged by this commit";
		default: {
			const never: never = status;
			throw new Error(`unknown status ${String(never)}`);
		}
	}
}

// The change a file's status makes as a whole: what the overview marks a file it has no editor for with.
export function statusChange(status: FileStatus): ChangeKind | undefined {
	switch (status) {
		case "A":
			return "added";
		case "D":
			return "removed";
		case "M":
		case "T":
			return "modified";
		case "=":
			return undefined;
		default: {
			const never: never = status;
			throw new Error(`unknown status ${String(never)}`);
		}
	}
}

// The status letter's element classes; "=" is not usable in a class selector.
export function statusClass(status: FileStatus): string {
	return `status status-${status === "=" ? "same" : status}`;
}
