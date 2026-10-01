import type { DocumentFile } from "../engine/session.ts";

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

// The status letter's element classes; "=" is not usable in a class selector.
export function statusClass(status: FileStatus): string {
	return `status status-${status === "=" ? "same" : status}`;
}
