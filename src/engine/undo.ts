import { type CommitBasics, draftFor } from "./drafts.ts";
import { gitText, type Oid, type Repo } from "./git.ts";
import { mergeTrees } from "./merge.ts";
import { type CatFile, type CommitInfo, commitRead, commitSubject } from "./objects.ts";
import type { Stack } from "./stack.ts";
import type { DraftEntry } from "./store.ts";

// What a Suonetar entry in a branch's reflog did: an apply, or an undo or redo of the entry before it.
export type ReflogVerb = "apply" | "undo" | "redo";

const REFLOG_PATTERN = /^suonetar: (apply|undo|redo) (\d+) commits? from ([0-9a-f]{40,64})$/;
const REFLOG_ROLLED_BACK = " (rolled back)";
// How far back undo looks for Suonetar's last entry; commits made since each add one.
const REFLOG_DEPTH = 200;

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

// Undoing an apply or a redo is an undo; undoing an undo is a redo.
export type UndoVerb = "undo" | "redo";

// The branch's last Suonetar move, as undoing it would see it: the tip it moved from (`old`) and the tip it moved to (`new`).
type UndoMove = { readonly verb: UndoVerb; readonly old: Oid; readonly new: Oid; readonly commits: number };

export type UndoInfo =
	// Nothing moved the branch since: undo moves it back to exactly the commits it had. `pushed` counts the commits that drops which are already on a remote.
	| ({ readonly kind: "exact"; readonly pushed: number } & UndoMove)
	// Commits were made since: undo writes drafts that restore the replaced commits' changes, for review and Apply.
	| ({ readonly kind: "edits" } & UndoMove)
	| { readonly kind: "unavailable"; readonly verb: UndoVerb; readonly reason: string };

type Pair = { readonly x: CommitInfo; readonly y: CommitInfo };

// The commits a move replaced (y, from `old`) against those it put in their place (x, from `new`), oldest first, above their merge-base.
export type UndoPairing = { readonly base: Oid; readonly pairs: readonly Pair[] };

const SUONETAR_PREFIX = "suonetar: ";

// The newest Suonetar entry in the branch's reflog, skipping moves that were rolled back; "foreign" when that entry is Suonetar's but not in a form this version reads.
async function undoTarget(repo: Repo, branch: string): Promise<(UndoMove & { readonly kind: "move" }) | { readonly kind: "foreign"; readonly subject: string } | undefined> {
	const log = await gitText(repo, ["log", "-g", `-n${REFLOG_DEPTH}`, "--format=%H%x00%gs", branch]);
	let skip = false;
	for (const line of log.split("\n")) {
		const [oid, subject] = line.split("\0");
		if (oid === undefined || subject === undefined) {
			continue;
		}
		if (skip) {
			skip = false;
			continue;
		}
		if (subject.endsWith(REFLOG_ROLLED_BACK)) {
			skip = true;
			continue;
		}
		const parsed = reflogParse(subject);
		if (parsed !== undefined) {
			return { kind: "move", verb: parsed.verb === "undo" ? "redo" : "undo", old: parsed.old, new: oid, commits: parsed.count };
		}
		if (subject.startsWith(SUONETAR_PREFIX)) {
			return { kind: "foreign", subject };
		}
	}
	return undefined;
}

// Pairs a move's commits. Suonetar rewrites commit for commit and keeps authors, so anything else is not one of its moves, or its commits are gone; the reason is returned instead.
async function undoPairs(repo: Repo, cat: CatFile, move: UndoMove): Promise<UndoPairing | string> {
	const gone = "the commits it replaced are no longer in the repository";
	const mergeBase = await repo.run(["merge-base", move.old, move.new], { cwd: repo.worktree });
	if (mergeBase.code !== 0) {
		return gone;
	}
	const base = mergeBase.stdout.toString("utf8").trim();
	const range = async (tip: Oid): Promise<CommitInfo[] | undefined> => {
		const listed = await repo.run(["rev-list", "--reverse", "--parents", `${base}..${tip}`], { cwd: repo.worktree });
		if (listed.code !== 0) {
			return undefined;
		}
		const commits: CommitInfo[] = [];
		for (const row of listed.stdout.toString("utf8").split("\n")) {
			if (row === "") {
				continue;
			}
			const [oid, parent, ...more] = row.split(" ");
			if (oid === undefined || parent === undefined || more.length > 0) {
				return undefined;
			}
			commits.push(await commitRead(cat, oid));
		}
		return commits;
	};
	const ys = await range(move.old);
	const xs = await range(move.new);
	if (ys === undefined || xs === undefined) {
		return gone;
	}
	const pairs: Pair[] = [];
	for (const [i, x] of xs.entries()) {
		const y = ys[i];
		if (y === undefined || y.authorLine !== x.authorLine) {
			break;
		}
		pairs.push({ x, y });
	}
	if (pairs.length !== xs.length || pairs.length !== ys.length || pairs.length !== move.commits) {
		return "its commits do not pair up one for one with those it replaced";
	}
	return { base, pairs };
}

// Whether undo is possible now and how, with the pairing it was judged on. `hasDrafts` is whether this branch has stored drafts, which an undo would tangle with.
export async function undoAssess(
	repo: Repo,
	cat: CatFile,
	stack: Stack,
	hasDrafts: boolean,
): Promise<{ readonly info: UndoInfo; readonly pairing: UndoPairing | undefined } | undefined> {
	const target = await undoTarget(repo, stack.branch);
	if (target === undefined) {
		return undefined;
	}
	if (target.kind === "foreign") {
		return {
			info: { kind: "unavailable", verb: "undo", reason: `the branch's last Suonetar entry is in a form this version does not read (“${target.subject}”)` },
			pairing: undefined,
		};
	}
	const unavailable = (reason: string) => ({ info: { kind: "unavailable", verb: target.verb, reason } as const, pairing: undefined });
	if (hasDrafts) {
		return unavailable("apply or discard the edits first");
	}
	const pairing = await undoPairs(repo, cat, target);
	if (typeof pairing === "string") {
		return unavailable(pairing);
	}
	const move: UndoMove = { verb: target.verb, old: target.old, new: target.new, commits: target.commits };
	if (stack.tipOid === target.new) {
		const unpushed = Number(await gitText(repo, ["rev-list", "--count", `${pairing.base}..${target.new}`, "--not", "--remotes"]));
		return { info: { kind: "exact", ...move, pushed: move.commits - unpushed }, pairing };
	}
	const ancestor = await repo.run(["merge-base", "--is-ancestor", target.old, stack.tipOid], { cwd: repo.worktree });
	if (ancestor.code === 0) {
		return unavailable("the branch already has the commits it would restore");
	}
	// A draft on a commit that is no longer in the stack would only be an orphan. Every replacement must still be there, not just those that will get a draft: which ones do is only known after merging.
	const inStack = (x: CommitInfo) => stack.commits.some((c) => c.oid === x.oid || c.authorLine === x.authorLine);
	if (!pairing.pairs.every((p) => inStack(p.x))) {
		return unavailable("some of the commits it would restore are no longer in the stack");
	}
	return { info: { kind: "edits", ...move }, pairing };
}

// Drafts that restore each replaced commit's own change on top of its replacement's parent as the move made it: Yᵢ's change laid onto Xᵢ₋₁. A commit that was only restacked gets the very merge its replay made, so no draft; where that merge conflicts, the draft is Yᵢ's whole tree, and restacking it shows the conflict for resolving.
export async function undoDrafts(repo: Repo, cat: CatFile, branch: string, pairing: UndoPairing): Promise<DraftEntry[]> {
	const baseTree = (await commitRead(cat, pairing.base)).tree;
	const drafts: DraftEntry[] = [];
	let xParent = baseTree;
	let yParent = baseTree;
	for (const { x, y } of pairing.pairs) {
		const merged = await mergeTrees(repo, yParent, xParent, y.tree);
		const tree = merged.kind === "clean" ? merged.tree : y.tree;
		const basics: CommitBasics = { oid: x.oid, tree: x.tree, authorLine: x.authorLine, subject: commitSubject(x), message: x.message, parentTree: xParent };
		const draft = draftFor(basics, branch, tree === x.tree ? undefined : { tree, parentTree: xParent }, y.message);
		if (draft !== undefined) {
			drafts.push(draft);
		}
		xParent = x.tree;
		yParent = y.tree;
	}
	return drafts;
}
