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
		case "R":
			return "renamed";
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
		case "R":
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

// A rename as git prints one, the parts both paths share outside the braces: `src/{a.ts → b.ts}`, `ui/{ → editor}/x.ts`.
export function renameLabel(from: string, to: string): string {
	const a = from.split("/");
	const b = to.split("/");
	const most = Math.min(a.length, b.length);
	let prefix = 0;
	while (prefix < most - 1 && a[prefix] === b[prefix]) {
		prefix++;
	}
	let suffix = 0;
	while (prefix + suffix < most && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
		suffix++;
	}
	if (prefix === 0 && suffix === 0) {
		return `${from} → ${to}`;
	}
	const head = a
		.slice(0, prefix)
		.map((part) => `${part}/`)
		.join("");
	const tail = a
		.slice(a.length - suffix)
		.map((part) => `/${part}`)
		.join("");
	return `${head}{${a.slice(prefix, a.length - suffix).join("/")} → ${b.slice(prefix, b.length - suffix).join("/")}}${tail}`;
}
