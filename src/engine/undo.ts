import type { Oid } from "./git.ts";

// What a Suonetar entry in a branch's reflog did: an apply, or an undo or redo of the entry before it.
export type ReflogVerb = "apply" | "undo" | "redo";

const REFLOG_PATTERN = /^suonetar: (apply|undo|redo) (\d+) commits? from ([0-9a-f]{40,64})$/;

// The branch reflog message for a Suonetar move. It names the old tip because no reflog format shows an entry's old value, and inferring it from the next entry goes wrong once entries are dropped.
export function reflogMessage(verb: ReflogVerb, count: number, old: Oid): string {
	return `suonetar: ${verb} ${count} commit${count === 1 ? "" : "s"} from ${old}`;
}

export function reflogParse(subject: string): { readonly verb: ReflogVerb; readonly count: number; readonly old: Oid } | undefined {
	const match = REFLOG_PATTERN.exec(subject);
	if (match === null) {
		return undefined;
	}
	const [, verb, count, old] = match;
	if ((verb !== "apply" && verb !== "undo" && verb !== "redo") || count === undefined || old === undefined) {
		return undefined;
	}
	return { verb, count: Number(count), old };
}
