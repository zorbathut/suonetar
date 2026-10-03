import { createHash } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { intentCheck, type PublishResult, pidAlive, preflightPosition, publish } from "./apply.ts";
import { type DerivedCommit, type DeriveTrees, derivedSteps, type Edit, type MergeInputs, stackDerive, treeRestacked, treeTakingPaths } from "./derive.ts";
import {
	type CommitBasics,
	type DraftStatus,
	draftConfirmed,
	draftFor,
	draftMessage,
	draftsResolve,
	draftVersion,
	editability,
	treeWithEntry,
	treeWithFile,
	type Version,
} from "./drafts.ts";
import { type Indentation, indentationFor } from "./editorconfig.ts";
import { ErrorEditRefused, ErrorEditStale, ErrorGit, ErrorNoBase, ErrorNotOnBranch, ErrorStale, ErrorStoreChanged } from "./errors.ts";
import { fileReaderDisk, gitOk, gitRunnerSpawn, hookRunnerSpawn, type Oid, type Repo, repoOpen, repoWithObjects } from "./git.ts";
import { type HookCache, type HookCommit, type HookFailure, type HookPassResult, type HookProgress, hookIdentity, hooksPass } from "./hooks.ts";
import { type Conflict, type MergeResult, mergeTrees } from "./merge.ts";
import { type MergetoolResult, mergetoolName, mergetoolRun } from "./mergetool.ts";
import { CatFile, type CommitInfo, commitParse, commitRead, commitSubject, treeDiff, treeList } from "./objects.ts";
import { type ReplayStep, replayCommit, stepsReflag } from "./replay.ts";
import { branchCurrent, configGet, type Stack, type StackCommit, stackRead } from "./stack.ts";
import { type DraftEntry, type ResolutionChange, type ResolutionEntry, STORE_REF, type Store, storeRead, storeWrite } from "./store.ts";
import { reflogMessage, type UndoInfo, undoAssess, undoDrafts } from "./undo.ts";
import { type WorktreeSide, type WorktreeStatus, worktreeFiles, worktreeStatus } from "./worktree-changes.ts";
import { WorktreePrivate } from "./worktree-private.ts";
import { blobWrite, signingWanted, treeWithChanges } from "./write.ts";

// What becomes of one stack commit at Apply, as the stack list shows it.
export type CommitStatus = {
	readonly oid: Oid;
	// "edited": the user changed it; "resolved": a conflict in it was resolved; "rewritten": only restacked onto changes below.
	readonly kind: "unchanged" | "rewritten" | "edited" | "resolved" | "conflict";
	// Paths this commit shows without the edits below them, because a conflict below is unresolved; the lowest such conflict is `conflictBelow`.
	readonly provisional: readonly string[];
	readonly conflictBelow: Oid | undefined;
};

export type SessionState =
	// `undo` describes undoing the branch's last Suonetar move, when there is one. `commits` matches `stack.commits`, oldest first.
	| { readonly kind: "ready"; readonly stack: Stack; readonly drafts: readonly DraftStatus[]; readonly undo: UndoInfo | undefined; readonly commits: readonly CommitStatus[] }
	| { readonly kind: "unavailable"; readonly reason: string }
	| Extract<PublishResult, { kind: "interrupted" }>;

export type StepSummary = { readonly oid: Oid; readonly subject: string; readonly rewrite: boolean; readonly empty: boolean; readonly dropsSignature: boolean };

export type ConflictReport = {
	readonly commit: CommitBasics & { readonly parent: Oid };
	readonly inputs: MergeInputs;
	readonly markerTree: Oid;
	readonly conflicts: readonly (Conflict & { readonly resolved: boolean })[];
	// The commit's own side includes the user's edits to it or an earlier resolution, not just the commit as it was.
	readonly edited: boolean;
};

export type PreviewResult =
	| { readonly kind: "nothing" }
	| { readonly kind: "drafts-need-attention"; readonly drafts: readonly DraftStatus[] }
	| ({ readonly kind: "conflict" } & ConflictReport)
	| { readonly kind: "clean"; readonly steps: readonly StepSummary[] };

// Whether apply runs the pre-commit hook, and on which commits it does not.
export type HookChoice = { readonly kind: "run"; readonly skip: readonly Oid[] } | { readonly kind: "skip" };

export type ApplyProgress = { readonly step: "prepare" } | ({ readonly step: "hook" } & HookProgress) | { readonly step: "write" } | { readonly step: "publish" };

type HookChanges = readonly (HookCommit & { readonly paths: readonly string[] })[];

export type ApplyResult =
	| Exclude<PreviewResult, { kind: "clean" }>
	| Exclude<PublishResult, { kind: "published" }>
	// The pre-commit hook failed on a commit; nothing was published.
	| ({ readonly kind: "hook-failed" } & HookFailure)
	// Running the hook at all failed (the private worktree, git itself); nothing was published.
	| { readonly kind: "hook-error"; readonly message: string }
	// The hook undid every edit (a formatter reverting a whitespace change): nothing to publish, and the drafts were cleared as if published.
	| { readonly kind: "hook-reverted"; readonly hookChanges: HookChanges }
	| { readonly kind: "cancelled" }
	| {
			readonly kind: "published";
			// Set when publishing succeeded but tidying up the applied drafts did not; the drafts then show as current or orphaned.
			readonly warning: string | undefined;
			// What the pre-commit hook changed while checking each commit, and the commits that had no hook to run.
			readonly hookChanges: HookChanges;
			readonly hookless: readonly HookCommit[];
	  };

export type UndoResult =
	| Exclude<PublishResult, { kind: "published" }>
	| { readonly kind: "published"; readonly verb: "undo" | "redo" }
	// The branch moved since, so the undo was written as drafts, which the user reviews and applies.
	| { readonly kind: "drafted"; readonly verb: "undo" | "redo"; readonly drafts: number }
	| { readonly kind: "unavailable"; readonly reason: string }
	// The branch's last Suonetar move is no longer the one the user confirmed undoing.
	| { readonly kind: "stale" };

export type MergetoolOutcome = MergetoolResult | { readonly kind: "stale" };

// The staged or unstaged changes as a read-only document; `omitted` files were left out past the cap.
export type WorktreeDocument = { readonly side: WorktreeSide; readonly files: readonly DocumentFile[]; readonly omitted: number; readonly conflicted: boolean };

export type DocumentFile = {
	readonly path: string;
	// Status of the file in the commit as it would be published (with the draft); "=" when the draft undoes the commit's whole change to it.
	readonly status: "A" | "M" | "D" | "T" | "=";
	readonly binary: boolean;
	// Why the file cannot be edited as text, or undefined when it can.
	readonly refusal: string | undefined;
	// Contents at the parent, at the commit without the user's edits, and as shown (with them); undefined where the file does not exist, or when `tooLarge`. For a commit in the stack, all three are as restacked onto the edits below.
	readonly parent: Buffer | undefined;
	readonly commit: Buffer | undefined;
	readonly draft: Buffer | undefined;
	// The blob shown as `draft`, which a save names to say what it changes; undefined where the file does not exist.
	readonly draftOid: Oid | undefined;
	readonly tooLarge: boolean;
	// From EditorConfig, as of the version shown (the parent's, for a file that version deletes).
	readonly indentation: Indentation;
	// `commit` is the commit's original version rather than a restacked one, since restacking it conflicts, so the user's edits cannot be told apart from that.
	readonly mineUnknown: boolean;
	// Shown without the edits below it, because a conflict below is unresolved.
	readonly provisional: boolean;
};

export type CommitDocument = {
	readonly oid: Oid;
	readonly parent: Oid;
	// The parent tree the document shows the commit on, which a save names, and the commit's tree as shown.
	readonly parentTree: Oid;
	readonly tree: Oid;
	readonly subject: string;
	readonly message: Buffer;
	readonly draftMessage: Buffer | undefined;
	readonly hasDraft: boolean;
	readonly files: readonly DocumentFile[];
};

// How one path of a conflict is resolved: leave the marker tree's entry, take a stage's entry (optionally from another path, for directory/file conflicts), write new content, or delete a file or directory.
export type ResolutionChoice =
	| { readonly path: string; readonly keep: true }
	| { readonly path: string; readonly stage: 1 | 2 | 3; readonly from: string | undefined }
	| { readonly path: string; readonly content: Buffer; readonly markersAllowed: boolean }
	| { readonly path: string; readonly delete: "file" | "directory" };

export type ResolveResult = { readonly kind: "resolved" } | { readonly kind: "invalid"; readonly reason: string };

const BLOB_LIMIT = 4 * 1024 * 1024;
// Uncommitted files shown, and stat-ed per poll, at most: an agent's `npm install` into an unignored directory would otherwise flood both.
const WORKTREE_FILES_MAX = 2000;
// Merge results a session remembers per repository, at most; past that it starts over.
const MERGES_REMEMBERED_MAX = 10_000;
// The private object directories of sessions, each named for its machine and process: `objects-<host>-<pid>-<random>`.
const OBJECTS_PATTERN = /^objects-(.+)-(\d+)-[0-9a-z]+$/;

// Serialises every operation on a repository, across all sessions in this process: an autosave landing in the middle of an apply must not interleave with it.
class Mutex {
	#tail: Promise<unknown> = Promise.resolve();

	run<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(fn, fn);
		this.#tail = result.catch(() => undefined);
		return result;
	}
}

const mutexes = new Map<string, Mutex>();

function mutexFor(repo: Repo): Mutex {
	let mutex = mutexes.get(repo.commonDir);
	if (mutex === undefined) {
		mutex = new Mutex();
		mutexes.set(repo.commonDir, mutex);
	}
	return mutex;
}

// Whether this branch has stored drafts; those made on other branches are left out.
function draftsHere(drafts: readonly DraftStatus[]): boolean {
	return drafts.some((d) => d.kind !== "elsewhere");
}

function inputsEqual(a: MergeInputs, b: MergeInputs): boolean {
	return a.base === b.base && a.ours === b.ours && a.theirs === b.theirs;
}

// This machine's name as it can stand in a directory name.
function hostName(): string {
	return hostname().replace(/[^0-9A-Za-z.]/g, "_");
}

// Removes the private object directories of sessions whose process is gone. Only this machine's processes can be checked; a repository shared with another machine keeps that machine's.
function objectsSweep(dir: string): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return;
		}
		throw err;
	}
	for (const name of names) {
		const [, host, pid] = OBJECTS_PATTERN.exec(name) ?? [];
		if (host === hostName() && pid !== undefined && !pidAlive(Number(pid))) {
			rmSync(join(dir, name), { recursive: true, force: true });
		}
	}
}

// The stack restacked onto every edit, with what it was computed from.
type Derivation = {
	readonly stack: Stack;
	readonly store: Store;
	readonly baseTree: Oid;
	readonly statuses: readonly DraftStatus[];
	readonly commits: readonly DerivedCommit[];
};

type Current = Extract<DraftStatus, { kind: "current" }>;

// What an operation has read so far, as the reads in flight.
type Reads = { stack?: Promise<Stack>; config?: Promise<string> };

// Where an edit to a commit lands: the version of its files it changes, and the commit's own tree restacked onto that version's parent (`restacked` false when that conflicts, so the tree is only a stand-in).
type EditTarget = { readonly commit: CommitBasics; readonly version: Version; readonly unedited: Oid; readonly restacked: boolean };

export class Session {
	readonly repo: Repo;
	// The repository with new objects going to a private directory, for merges made only to show the restacked stack; everything stored is written through `repo` instead.
	readonly #view: Repo;
	readonly #objects: string;
	// The base chosen on the command line, which wins over `suonetar.base` and detection.
	readonly #base: string | undefined;
	readonly #cat: CatFile;
	readonly #mutex: Mutex;
	// What the running operation has read of the stack and the merge settings, kept for the rest of it: operations run one at a time, and each reads them once. Anything an operation does that moves the branch or runs the user's code (a publish, the hook pass) forgets them, so what follows reads them afresh.
	#reads: Reads | undefined;
	readonly #hookCache: HookCache = new Map();
	// Merge results and conflict stand-ins by merge settings and inputs, for the repository and for `#view`: an edit changes only the commits above it, so most of a derivation repeats the last one.
	readonly #merges = new Map<Repo, Map<string, MergeResult | Oid>>();
	// The last restacked stack shown, keyed by the stack's and the store's identity.
	#shown: { readonly key: string; readonly derivation: Derivation } | undefined;
	#abort: AbortController | undefined;
	// The merge tool being waited for, which holds a throwaway directory until it returns.
	#tool: Promise<MergetoolOutcome> | undefined;

	private constructor(repo: Repo, base: string | undefined) {
		this.repo = repo;
		this.#base = base;
		const dir = join(repo.commonDir, "suonetar");
		objectsSweep(dir);
		this.#objects = join(dir, `objects-${hostName()}-${process.pid}-${Math.random().toString(36).slice(2)}`);
		this.#view = repoWithObjects(repo, this.#objects);
		this.#cat = new CatFile(this.#view);
		this.#mutex = mutexFor(repo);
	}

	static async open(path: string, base: string | undefined): Promise<Session> {
		return Session.openRepo(await repoOpen(gitRunnerSpawn(), hookRunnerSpawn(), fileReaderDisk(), path), base);
	}

	static async openRepo(repo: Repo, base: string | undefined): Promise<Session> {
		return new Session(repo, base);
	}

	// Runs an operation alone under the repository's mutex, with its reads of the stack and the merge settings remembered for its duration.
	#op<T>(fn: () => Promise<T>): Promise<T> {
		return this.#mutex.run(async () => {
			if (this.#reads !== undefined) {
				throw new Error("a session operation started while another was running");
			}
			this.#reads = {};
			try {
				return await fn();
			} finally {
				this.#reads = undefined;
			}
		});
	}

	#readsCurrent(): Reads {
		if (this.#reads === undefined) {
			throw new Error("the stack or the merge settings were read outside a session operation");
		}
		return this.#reads;
	}

	#readsForget(): void {
		this.#readsCurrent();
		this.#reads = {};
	}

	#stackRead(): Promise<Stack> {
		const reads = this.#readsCurrent();
		reads.stack ??= stackRead(this.repo, this.#cat, this.#base);
		return reads.stack;
	}

	// Moves the branch, so the operation's reads are forgotten whatever comes of it: a publish can be rolled back, or interrupted after the ref moved.
	async #publish(branch: string, oldTip: Oid, newTip: Oid, message: string): Promise<PublishResult> {
		try {
			return await publish(this.repo, branch, oldTip, newTip, message);
		} finally {
			this.#readsForget();
		}
	}

	close(): void {
		this.#cat.close();
		rmSync(this.#objects, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}

	// Closes once the operation in progress (and any queued behind it) has finished, including a merge tool, which runs outside the queue.
	closeWhenIdle(): Promise<void> {
		const tool = this.#tool;
		return this.#op(async () => {
			try {
				await tool;
			} finally {
				this.close();
			}
		});
	}

	// Cheap enough to poll: changes when HEAD switches or moves, the draft store changes, the configured base changes, or any branch moves (a push or fetch changes the base and what is pushed). Two processes, since the renderer polls it every second: one listing of HEAD, every branch and the store ref, and the base setting.
	generation(): Promise<string> {
		return this.#op(async () => {
			const refs = await gitOk(this.repo, ["for-each-ref", "--include-root-refs", "--format=%(refname) %(objectname) %(symref)", "HEAD", "refs/heads", "refs/remotes", STORE_REF]);
			// A HEAD on a branch with no commits yet is not listed; which branch it names then takes a process of its own.
			const unborn =
				refs.subarray(0, 5).toString("utf8") === "HEAD " ? "" : (await this.repo.run(["symbolic-ref", "-q", "HEAD"], { cwd: this.repo.worktree })).stdout.toString("utf8").trim();
			const base = (await configGet(this.repo, "suonetar.base")) ?? "";
			return `${createHash("sha1").update(refs).digest("hex")} ${unborn} ${base}`;
		});
	}

	state(): Promise<SessionState> {
		return this.#op(async () => {
			const pending = intentCheck(this.repo);
			if (pending?.kind === "interrupted") {
				return pending;
			}
			try {
				const derivation = await this.#derivationShown();
				return {
					kind: "ready",
					stack: derivation.stack,
					drafts: derivation.statuses,
					undo: await this.#undoInfo(derivation.stack, derivation.statuses),
					commits: commitStatuses(derivation),
				};
			} catch (err) {
				if (err instanceof ErrorNotOnBranch || err instanceof ErrorNoBase) {
					return { kind: "unavailable", reason: err.message };
				}
				throw err;
			}
		});
	}

	// The whole commit as the editor shows it, restacked onto the edits below: every file its change or its draft touches, with the three versions of each.
	commitDocument(oid: Oid): Promise<CommitDocument> {
		return this.#op(async () => {
			const derivation = await this.#derivationShown();
			const derived = derivedFor(derivation, oid);
			const commit = derived.commit;
			const current = currentFor(derivation, oid);
			const originalParent = originalParentTree(derivation, oid);
			const unedited = await treeRestacked(this.#view, originalParent, derived.parentTree, commit.tree);
			const files = await this.#documentFiles(derived.parentTree, unedited.tree, derived.tree, new Set(unedited.conflicted), new Set(derived.provisional));
			const draftMsg = current === undefined ? undefined : draftMessage(current.draft);
			return {
				oid,
				parent: commit.parent,
				parentTree: derived.parentTree,
				tree: derived.tree,
				subject: commit.subject,
				message: commit.message,
				draftMessage: draftMsg,
				hasDraft: current !== undefined,
				files,
			};
		});
	}

	// The conflict restacking this commit runs into, for resolving it.
	commitConflict(oid: Oid): Promise<ConflictReport> {
		return this.#op(async () => {
			const derivation = await this.#derivationShown();
			const report = conflictReport(derivation, derivedFor(derivation, oid));
			if (report === undefined) {
				throw new ErrorStale(`a conflict in ${oid.slice(0, 12)}`);
			}
			return report;
		});
	}

	// A draft's own changes, relative to the commit it was made on; works for drafts whose commit is gone, so orphans can be looked at before discarding them.
	draftDocument(against: Oid): Promise<CommitDocument> {
		return this.#op(async () => {
			const draft = (await storeRead(this.repo, this.#cat)).drafts.get(against);
			if (draft === undefined) {
				throw new ErrorStale(`the draft for ${against.slice(0, 12)}`);
			}
			// Made on a parent with edits of its own, the draft is shown against the commit as restacked onto that parent, so only its own changes show.
			const before =
				draft.parentTree === undefined || draft.baseParent === undefined ? draft.base : (await treeRestacked(this.#view, draft.baseParent, draft.parentTree, draft.base)).tree;
			const files = await this.#documentFiles(before, before, draft.tree ?? before, new Set(), new Set());
			const baseMessage = draft.meta.baseMessage === undefined ? Buffer.alloc(0) : Buffer.from(draft.meta.baseMessage, "base64");
			return {
				oid: against,
				parent: against,
				parentTree: before,
				tree: draft.tree ?? before,
				subject: draft.meta.subject,
				message: baseMessage,
				draftMessage: draftMessage(draft),
				hasDraft: true,
				files,
			};
		});
	}

	blobAt(tree: Oid, path: string): Promise<Buffer | undefined> {
		return this.#op(() => this.#blobAt(tree, path));
	}

	blob(oid: Oid): Promise<Buffer | undefined> {
		return this.#op(async () => {
			const obj = await this.#cat.read(oid);
			return obj?.type === "blob" ? obj.data : undefined;
		});
	}

	// Sets one file of a commit's draft (null deletes it), as edited in a document that showed the commit on `parentTree` with the file as blob `shown` (null: absent). Returns the blob now stored, or null for a deletion. The commit need not be in the current stack: an edit saved against a commit rewritten meanwhile is kept and later offered for confirmation onto its successor.
	draftSetFile(oid: Oid, parentTree: Oid, path: string, shown: Oid | null, content: Buffer | null): Promise<Oid | null> {
		return this.#op(async () => {
			const derivation = await this.#derivationIfAny(oid);
			const store = derivation?.store ?? (await storeRead(this.repo, this.#cat));
			const existing = store.drafts.get(oid);
			const branch = await this.#draftBranch(existing, path);
			const target = await this.#editTarget(store, derivation, oid, parentTree, { path, blob: shown ?? undefined });
			const tree = await treeWithFile(this.repo, target.version.tree, target.commit.tree, path, content);
			await this.#versionStore(store, target, branch, existing, tree);
			return (await this.#entryOid(this.repo, tree, path)) ?? null;
		});
	}

	// Sets one file of a commit's draft back to its version in the commit (as restacked) or in the parent shown, mode and all; absent there means deleted.
	draftRestore(oid: Oid, parentTree: Oid, path: string, from: "commit" | "parent"): Promise<void> {
		return this.#op(async () => {
			const derivation = await this.#derivationIfAny(oid);
			const store = derivation?.store ?? (await storeRead(this.repo, this.#cat));
			const existing = store.drafts.get(oid);
			const branch = await this.#draftBranch(existing, path);
			const target = await this.#editTarget(store, derivation, oid, parentTree, undefined);
			const source = from === "parent" ? target.version.parentTree : target.unedited;
			const tree = await treeWithEntry(this.repo, target.version.tree, path, source);
			await this.#versionStore(store, target, branch, existing, tree);
		});
	}

	draftSetMessage(oid: Oid, message: Buffer | undefined): Promise<void> {
		return this.#op(async () => {
			const store = await storeRead(this.repo, this.#cat);
			const existing = store.drafts.get(oid);
			const branch = await this.#draftBranch(existing, "(message)");
			const commit = await this.#basics(oid);
			const version = existing === undefined ? undefined : draftVersion(existing, commit);
			const made = draftFor(commit, branch, version, message);
			// A resolution stays one when only its message changes.
			const next = made === undefined || existing === undefined ? made : { ...made, meta: { ...made.meta, origin: existing.meta.origin }, fallback: existing.fallback };
			await this.#storeUpdate(store, (drafts) => (next === undefined ? drafts.delete(oid) : drafts.set(oid, next)));
		});
	}

	draftDiscard(against: Oid): Promise<void> {
		return this.#op(async () => {
			await this.#storeUpdate(await storeRead(this.repo, this.#cat), (drafts) => drafts.delete(against));
		});
	}

	draftConfirm(against: Oid): Promise<void> {
		return this.#op(async () => {
			const stack = await this.#stackRead();
			const store = await storeRead(this.repo, this.#cat);
			const baseTree = (await commitRead(this.#cat, stack.baseOid)).tree;
			const status = (await draftsResolve(this.repo, stack, baseTree, store.drafts)).find((s) => s.draft.meta.against === against);
			if (status?.kind !== "rebased") {
				throw new ErrorStale(`a rebased draft for ${against.slice(0, 12)}`);
			}
			const confirmed = draftConfirmed(status);
			await this.#storeUpdate(store, (drafts) => {
				drafts.delete(against);
				if (confirmed !== undefined) {
					drafts.set(status.commit.oid, confirmed);
				}
			});
		});
	}

	// Moves a draft made on another branch onto the current one, where it is then matched like any other.
	draftAdopt(against: Oid): Promise<void> {
		return this.#op(async () => {
			const store = await storeRead(this.repo, this.#cat);
			const draft = store.drafts.get(against);
			if (draft === undefined) {
				throw new ErrorStale(`the draft for ${against.slice(0, 12)}`);
			}
			const branch = await branchCurrent(this.repo);
			await this.#storeUpdate(store, (drafts) => drafts.set(against, { ...draft, meta: { ...draft.meta, branch }, entryOid: undefined }));
		});
	}

	// Records how one conflict (identified by its key) is resolved. Every path the conflict involves must be accounted for, and text must be free of conflict markers unless explicitly allowed. Once every conflict of the commit is resolved, the result becomes the commit's stored version, made on the parent it was resolved against.
	resolve(inputs: MergeInputs, key: string, choices: readonly ResolutionChoice[]): Promise<ResolveResult> {
		return this.#op(async () => {
			const derivation = await this.#derivationConflicted(inputs);
			const derived = derivation?.commits.find((d) => d.conflict !== undefined && inputsEqual(d.conflict.inputs, inputs));
			const found = derived?.conflict;
			const conflict = found?.conflicts.find((c) => c.key === key);
			if (derivation === undefined || derived === undefined || found === undefined || conflict === undefined) {
				return { kind: "invalid", reason: "that conflict no longer occurs; refresh" };
			}
			if (derivation.statuses.some((s) => (s.kind === "rebased" || s.kind === "conflict") && s.commit.oid === derived.commit.oid)) {
				return { kind: "invalid", reason: "an edit to this commit waits for confirmation; confirm or discard it first" };
			}
			const mentioned = new Set(choices.flatMap((c) => ("from" in c && c.from !== undefined ? [c.path, c.from] : [c.path])));
			const missing = conflict.paths.filter((p) => !mentioned.has(p));
			if (missing.length > 0) {
				return { kind: "invalid", reason: `no choice made for ${missing.join(", ")}` };
			}
			const changes: ResolutionChange[] = [];
			for (const choice of choices) {
				if ("keep" in choice) {
					continue;
				}
				if ("delete" in choice) {
					changes.push({ path: choice.path, delete: choice.delete });
				} else if ("stage" in choice) {
					const entry = conflict.stages[choice.from ?? choice.path]?.find((s) => s.stage === choice.stage);
					if (entry === undefined) {
						return { kind: "invalid", reason: `${choice.from ?? choice.path} has no stage ${choice.stage}` };
					}
					changes.push({ path: choice.path, mode: entry.mode, oid: entry.oid });
				} else {
					if (!choice.markersAllowed && /^(<{7}|>{7})( |$)/m.test(choice.content.toString("utf8"))) {
						return { kind: "invalid", reason: `${choice.path} still contains conflict markers` };
					}
					const stages = conflict.stages[choice.path] ?? [];
					const mode = (stages.find((s) => s.stage === 3) ?? stages.find((s) => s.stage === 2))?.mode ?? "100644";
					changes.push({ path: choice.path, mode, oid: await blobWrite(this.repo, choice.content) });
				}
			}
			const store = derivation.store;
			const rowOf = (k: string) => (k === key ? changes : store.resolutions.get(k)?.changes);
			if (!found.conflicts.every((c) => rowOf(c.key) !== undefined)) {
				await this.#storeUpdate(store, undefined, (resolutions) => resolutions.set(key, { changes, entryOid: undefined }));
				return { kind: "resolved" };
			}
			const tree = await treeWithChanges(
				this.repo,
				found.markerTree,
				found.conflicts.flatMap((c) => rowOf(c.key) ?? []),
			);
			const commit = derived.commit;
			const existing = store.drafts.get(commit.oid);
			const branch = await this.#draftBranch(existing, "(resolution)");
			const basics: CommitBasics = { ...commit, parentTree: originalParentTree(derivation, commit.oid) };
			const previous = existing === undefined ? undefined : draftVersion(existing, basics);
			// What this resolution replaces, to fall back on should it stop merging: the version from before any resolution.
			const fallback = existing?.meta.origin === "resolution" ? existing.fallback : (previous ?? { tree: commit.tree, parentTree: basics.parentTree });
			const made = draftFor(basics, branch, { tree, parentTree: derived.parentTree }, existing === undefined ? undefined : draftMessage(existing));
			if (made === undefined) {
				throw new Error("a resolution always has a version");
			}
			const folded: DraftEntry = { ...made, meta: { ...made.meta, origin: "resolution" }, fallback };
			await this.#storeUpdate(
				store,
				(drafts) => drafts.set(commit.oid, folded),
				(resolutions) => {
					for (const c of found.conflicts) {
						resolutions.delete(c.key);
					}
				},
			);
			return { kind: "resolved" };
		});
	}

	preview(): Promise<PreviewResult> {
		return this.#op(async () => (await this.#plan(await this.#derivationShown())).preview);
	}

	// Publishes every draft: the restacked stack, the pre-commit hook on each rewritten commit (unless skipped), then the locked publish.
	async apply(hooks: HookChoice, progress: (p: ApplyProgress) => void): Promise<ApplyResult> {
		// Created before queueing, so a cancel pressed while the apply waits or prepares is not lost.
		const abort = new AbortController();
		this.#abort = abort;
		try {
			return await this.#op(() => this.#apply(hooks, progress, abort.signal));
		} finally {
			if (this.#abort === abort) {
				this.#abort = undefined;
			}
		}
	}

	// The working tree's staged and unstaged change counts, cheap enough to poll.
	worktreeStatus(): Promise<WorktreeStatus> {
		return this.#op(() => worktreeStatus(this.repo, WORKTREE_FILES_MAX));
	}

	worktreeDocument(side: WorktreeSide): Promise<WorktreeDocument> {
		return this.#op(async () => ({ side, ...(await worktreeFiles(this.repo, this.#cat, side, WORKTREE_FILES_MAX, BLOB_LIMIT)) }));
	}

	// A path's EditorConfig indentation as of `tree`, for editors that show something other than a document file (a conflict's marker file).
	indentation(tree: Oid, path: string): Promise<Indentation> {
		return this.#op(async () => {
			const found = (await indentationFor(this.#view, this.#cat, tree, [path])).get(path);
			if (found === undefined) {
				throw new Error(`no indentation resolved for ${path}`);
			}
			return found;
		});
	}

	mergetoolName(): Promise<string | undefined> {
		return this.#op(() => mergetoolName(this.repo));
	}

	// Opens one path of a content conflict in the user's merge tool, starting from `content` (the resolve view's current text). `stale` when the conflict no longer occurs. The tool may stay open for minutes, so it runs outside the mutex: it touches nothing but its own throwaway index and work tree, and object writes.
	async mergetool(inputs: MergeInputs, key: string, path: string, content: Buffer): Promise<MergetoolOutcome> {
		const running = this.#mergetool(inputs, key, path, content);
		this.#tool = running;
		try {
			return await running;
		} finally {
			if (this.#tool === running) {
				this.#tool = undefined;
			}
		}
	}

	async #mergetool(inputs: MergeInputs, key: string, path: string, content: Buffer): Promise<MergetoolOutcome> {
		const abort = new AbortController();
		this.#abort = abort;
		try {
			// Merged into the repository's own objects: the tool runs in the user's environment, and may start an IDE that commits, which must not write into objects that go away.
			const conflict = await this.#op(async () => {
				const derived = (await this.#derivationConflicted(inputs))?.commits.find((d) => d.conflict !== undefined && inputsEqual(d.conflict.inputs, inputs));
				return derived?.conflict?.conflicts.find((c) => c.key === key);
			});
			if (conflict === undefined) {
				return { kind: "stale" };
			}
			const stages = conflict.stages[path];
			if (conflict.kind !== "content" || stages === undefined || stages.some((s) => s.mode !== "100644" && s.mode !== "100755")) {
				throw new Error(`${path} is not a text path of conflict ${key}`);
			}
			return await mergetoolRun(this.repo, { path, stages, attrSource: inputs.theirs, content }, abort.signal);
		} finally {
			if (this.#abort === abort) {
				this.#abort = undefined;
			}
		}
	}

	// Stops the long operation in progress: an apply that has not started publishing (publishing itself is never interrupted), or a merge tool being waited for. Not serialised: an apply holds the mutex while it runs. Only one of the two runs at a time, since the window is busy during either.
	cancel(): void {
		this.#abort?.abort();
	}

	// Undoes the branch's last Suonetar move, which must still be the one from `old` to `newTip`, the user confirmed as `kind`.
	undo(old: Oid, newTip: Oid, kind: "exact" | "edits"): Promise<UndoResult> {
		return this.#op(async () => {
			const pending = intentCheck(this.repo);
			if (pending) {
				return pending;
			}
			const stack = await this.#stackRead();
			const store = await storeRead(this.repo, this.#cat);
			const baseTree = (await commitRead(this.#cat, stack.baseOid)).tree;
			const assessed = await undoAssess(this.repo, this.#cat, stack, draftsHere(await draftsResolve(this.repo, stack, baseTree, store.drafts)));
			const info = assessed?.info;
			if (info === undefined || info.kind === "unavailable" || info.old !== old || info.new !== newTip || info.kind !== kind || assessed?.pairing === undefined) {
				return info?.kind === "unavailable" ? { kind: "unavailable", reason: info.reason } : { kind: "stale" };
			}
			if (info.kind === "exact") {
				const published = await this.#publish(stack.branch, info.new, info.old, reflogMessage(info.verb, info.commits, info.new));
				return published.kind === "published" ? { kind: "published", verb: info.verb } : published;
			}
			const drafts = await undoDrafts(this.repo, this.#cat, stack.branch, assessed.pairing);
			if (drafts.length === 0) {
				return { kind: "unavailable", reason: "it changed nothing that edits could restore" };
			}
			// Drafts on this branch were refused above; one stored for the same commit from another branch must not be overwritten.
			const taken = drafts.find((d) => store.drafts.has(d.meta.against));
			if (taken !== undefined) {
				return { kind: "unavailable", reason: `an edit to “${taken.meta.subject}” made on another branch is stored; adopt or discard it first` };
			}
			await this.#storeUpdate(store, (map) => {
				for (const draft of drafts) {
					map.set(draft.meta.against, draft);
				}
			});
			return { kind: "drafted", verb: info.verb, drafts: drafts.length };
		});
	}

	// Undo as the state shows it. Reading the reflog and pairing commits can fail without the rest of the state being wrong, so a failure is shown on the undo button instead of failing the whole read.
	async #undoInfo(stack: Stack, drafts: readonly DraftStatus[]): Promise<UndoInfo | undefined> {
		try {
			return (await undoAssess(this.repo, this.#cat, stack, draftsHere(drafts)))?.info;
		} catch (err) {
			return { kind: "unavailable", verb: "undo", reason: `reading the branch's history failed: ${(err as Error).message}` };
		}
	}

	// The stack restacked onto every current draft, up to and including `upTo` if given. Through `#view` for showing, and through `repo` for anything that will be stored or published, so the trees it names are in the repository.
	async #derivation(repo: Repo, upTo?: Oid): Promise<Derivation> {
		return this.#derivationOf(repo, await this.#stackRead(), await storeRead(this.repo, this.#cat), upTo);
	}

	async #derivationOf(repo: Repo, stack: Stack, store: Store, upTo?: Oid): Promise<Derivation> {
		const baseTree = (await commitRead(this.#cat, stack.baseOid)).tree;
		const statuses = await draftsResolve(repo, stack, baseTree, store.drafts);
		const edits = new Map<Oid, Edit>(statuses.filter((s): s is Current => s.kind === "current").map((s) => [s.commit.oid, s.edit]));
		const resolutions = new Map([...store.resolutions].map(([key, r]) => [key, r.changes]));
		const end = upTo === undefined ? stack.commits.length - 1 : stack.commits.findIndex((c) => c.oid === upTo);
		const commits = await this.#stackDerive(repo, stack.commits.slice(0, end + 1), baseTree, edits, resolutions);
		return { stack, store, baseTree, statuses, commits };
	}

	// `stackDerive` with remembered merges and stand-ins. A remembered result whose objects `git gc` has since pruned (they are unreachable until stored) fails a merge or a final check, and the derivation is done again from scratch.
	async #stackDerive(
		repo: Repo,
		commits: readonly StackCommit[],
		baseTree: Oid,
		edits: ReadonlyMap<Oid, Edit>,
		resolutions: ReadonlyMap<string, readonly ResolutionChange[]>,
	): Promise<DerivedCommit[]> {
		let memo = this.#merges.get(repo);
		if (memo === undefined) {
			memo = new Map();
			this.#merges.set(repo, memo);
		}
		const remembered = memo;
		const config = await this.#mergeConfig();
		for (let attempt = 0; ; attempt++) {
			const reused: Oid[] = [];
			const remember = <T extends MergeResult | Oid>(key: string, result: T): T => {
				if (remembered.size >= MERGES_REMEMBERED_MAX) {
					remembered.clear();
				}
				remembered.set(key, result);
				return result;
			};
			const trees: DeriveTrees = {
				repo,
				merge: async (base, ours, theirs) => {
					const key = `${config}\0merge ${base} ${ours} ${theirs}`;
					const known = remembered.get(key);
					if (known !== undefined && typeof known !== "string") {
						reused.push(known.kind === "clean" ? known.tree : known.markerTree);
						return known;
					}
					return remember(key, await mergeTrees(repo, base, ours, theirs));
				},
				standIn: async (markerTree, theirs, paths) => {
					const key = `standIn ${markerTree} ${theirs} ${JSON.stringify(paths)}`;
					const known = remembered.get(key);
					if (typeof known === "string") {
						reused.push(known);
						return known;
					}
					return remember(key, await treeTakingPaths(repo, markerTree, theirs, paths));
				},
			};
			try {
				const derived = await stackDerive(trees, commits, baseTree, edits, resolutions);
				if (attempt > 0 || (await objectsPresent(repo, reused))) {
					return derived;
				}
			} catch (err) {
				if (attempt > 0 || !(err instanceof ErrorGit)) {
					throw err;
				}
			}
			remembered.clear();
		}
	}

	// The derivation, for storing, up to the commit whose restacking runs into the merge `inputs`, which the shown derivation finds; undefined when none does.
	async #derivationConflicted(inputs: MergeInputs): Promise<Derivation | undefined> {
		const shown = (await this.#derivationShown()).commits.find((d) => d.conflict !== undefined && inputsEqual(d.conflict.inputs, inputs));
		return shown === undefined ? undefined : this.#derivation(this.repo, shown.commit.oid);
	}

	// The derivation for storing an edit to `oid` (only what is below it matters), or undefined when there is no stack to derive (HEAD detached mid-rebase, no base), where an edit can still be saved against the commit it was made on.
	async #derivationIfAny(oid: Oid): Promise<Derivation | undefined> {
		try {
			return await this.#derivation(this.repo, oid);
		} catch (err) {
			if (err instanceof ErrorNotOnBranch || err instanceof ErrorNoBase) {
				return undefined;
			}
			throw err;
		}
	}

	// The settings that change how merges come out.
	#mergeConfig(): Promise<string> {
		const reads = this.#readsCurrent();
		reads.config ??= this.#mergeConfigRead();
		return reads.config;
	}

	async #mergeConfigRead(): Promise<string> {
		const result = await this.repo.run(["config", "--get-regexp", "^(merge|diff)\\."], { cwd: this.repo.worktree });
		if (result.code > 1) {
			throw new Error(`git config --get-regexp failed: ${result.stderr}`);
		}
		return result.stdout.toString("utf8");
	}

	// What the restacking depends on is the branch, its commits, its base, the store, and the merge settings; the rest of the stack (what is pushed, other branches) is read afresh.
	async #derivationShown(): Promise<Derivation> {
		const stack = await this.#stackRead();
		const store = await storeRead(this.repo, this.#cat);
		const key = `${stack.branch}\0${stack.generation}\0${store.refOid ?? ""}\0${await this.#mergeConfig()}`;
		// Trees made since are unreachable, so `git gc --prune=now` elsewhere may have removed some.
		if (
			this.#shown?.key !== key ||
			!(await objectsPresent(
				this.#view,
				this.#shown.derivation.commits.map((d) => d.tree),
			))
		) {
			this.#shown = { key, derivation: await this.#derivationOf(this.#view, stack, store) };
		}
		return { ...this.#shown.derivation, stack };
	}

	async #apply(hooks: HookChoice, progress: (p: ApplyProgress) => void, signal: AbortSignal): Promise<ApplyResult> {
		const pending = intentCheck(this.repo);
		if (pending) {
			return pending;
		}
		const plan = await this.#plan(await this.#derivation(this.repo));
		if (plan.preview.kind !== "clean" || plan.steps === undefined) {
			return plan.preview.kind === "clean" ? { kind: "nothing" } : plan.preview;
		}
		let steps = plan.steps;
		let hookChanges: HookChanges = [];
		let hookless: readonly HookCommit[] = [];
		if (hooks.kind === "run") {
			const hooked = await this.#hooksRun(plan.stack, steps, hooks.skip, progress, signal);
			if (hooked.kind !== "passed") {
				return hooked;
			}
			steps = hooked.steps;
			hookChanges = hooked.changed;
			hookless = hooked.hookless;
			if (!steps.some((s) => s.rewrite)) {
				await this.#draftsClear(plan.applied);
				return { kind: "hook-reverted", hookChanges };
			}
		}
		if (signal.aborted) {
			return { kind: "cancelled" };
		}
		progress({ step: "write" });
		const { tip, rewritten } = await replayCommit(this.repo, plan.stack.baseOid, steps, await signingWanted(this.repo));
		progress({ step: "publish" });
		const published = await this.#publish(plan.stack.branch, plan.stack.tipOid, tip, reflogMessage("apply", rewritten.length, plan.stack.tipOid));
		if (published.kind !== "published") {
			return published;
		}
		try {
			await this.#draftsClear(plan.applied);
			return { kind: "published", warning: undefined, hookChanges, hookless };
		} catch (err) {
			return { kind: "published", warning: `published, but the applied drafts could not be cleared: ${(err as Error).message}`, hookChanges, hookless };
		}
	}

	// The pre-commit pass in the private worktree, with its steps reflagged. Any failure of the machinery itself becomes `hook-error`, so the user can still apply without hooks.
	async #hooksRun(
		stack: Stack,
		steps: readonly ReplayStep[],
		skip: readonly Oid[],
		progress: (p: ApplyProgress) => void,
		signal: AbortSignal,
	): Promise<Extract<HookPassResult, { kind: "passed" }> | Extract<ApplyResult, { kind: "hook-failed" | "hook-error" | "cancelled" | "moved" | "refused" | "busy" }>> {
		try {
			const identity = await hookIdentity(this.repo);
			if (identity === undefined) {
				return { kind: "passed", steps, changed: [], hookless: [] };
			}
			const blocked = await preflightPosition(this.repo, stack.branch, stack.tipOid);
			if (blocked) {
				return blocked;
			}
			if (signal.aborted) {
				return { kind: "cancelled" };
			}
			progress({ step: "prepare" });
			const baseTree = (await commitRead(this.#cat, stack.baseOid)).tree;
			const wt = await WorktreePrivate.acquire(this.repo, stack.baseOid);
			if (wt === "busy") {
				return { kind: "busy" };
			}
			let pass: HookPassResult;
			try {
				pass = await hooksPass(this.repo, wt, {
					baseOid: stack.baseOid,
					baseTree,
					steps,
					skip: new Set(skip),
					identity,
					cache: this.#hookCache,
					progress: (p) => progress({ step: "hook", ...p }),
					signal,
				});
			} finally {
				try {
					await wt.park(stack.baseOid);
				} finally {
					wt.release();
				}
			}
			switch (pass.kind) {
				case "passed":
					return { ...pass, steps: stepsReflag(baseTree, pass.steps) };
				case "failed":
					return { ...pass, kind: "hook-failed" };
				case "cancelled":
					return pass;
				default: {
					const never: never = pass;
					throw new Error(`unknown hook pass result ${String(never)}`);
				}
			}
		} catch (err) {
			return { kind: "hook-error", message: (err as Error).message };
		} finally {
			// The hooks are the user's code and run for a while; the branch or the settings may move meanwhile.
			this.#readsForget();
		}
	}

	async #plan(derivation: Derivation): Promise<{ stack: Stack; preview: PreviewResult; steps?: readonly ReplayStep[]; applied: DraftEntry[] }> {
		const { stack, statuses } = derivation;
		const blocking = statuses.filter((s) => s.kind === "rebased" || s.kind === "conflict");
		if (blocking.length > 0) {
			return { stack, preview: { kind: "drafts-need-attention", drafts: blocking }, applied: [] };
		}
		const applied = statuses.filter((s): s is Current => s.kind === "current").map((s) => s.draft);
		const conflicted = derivation.commits.map((d) => conflictReport(derivation, d)).find((r) => r !== undefined);
		if (conflicted !== undefined) {
			return { stack, preview: { kind: "conflict", ...conflicted }, applied };
		}
		const steps = derivedSteps(derivation.baseTree, derivation.commits);
		if (!steps.some((s) => s.rewrite)) {
			return { stack, preview: { kind: "nothing" }, applied };
		}
		const summaries = steps.map((s) => ({ oid: s.commit.oid, subject: s.commit.subject, rewrite: s.rewrite, empty: s.empty, dropsSignature: s.rewrite && s.commit.signed }));
		return { stack, preview: { kind: "clean", steps: summaries }, steps, applied };
	}

	// Where an edit to `oid`, made in a document that showed it on `parentTree`, lands. With `shown`, the file must still be that blob there, or the edit was made on something that has changed since.
	async #editTarget(
		store: Store,
		derivation: Derivation | undefined,
		oid: Oid,
		parentTree: Oid,
		shown: { readonly path: string; readonly blob: Oid | undefined } | undefined,
	): Promise<EditTarget> {
		const matches = async (tree: Oid) => shown === undefined || (await this.#entryOid(this.repo, tree, shown.path)) === shown.blob;
		const stale = () => new ErrorEditStale(shown?.path ?? oid.slice(0, 12));
		const derived = derivation?.commits.find((d) => d.commit.oid === oid);
		const commit = derivation === undefined || derived === undefined ? await this.#basics(oid) : { ...derived.commit, parentTree: originalParentTree(derivation, oid) };
		const existing = store.drafts.get(oid);
		const stored = (existing === undefined ? undefined : draftVersion(existing, commit)) ?? { tree: commit.tree, parentTree: commit.parentTree };
		let version: Version | undefined;
		// The commit as derived now, unless a conflict in it makes that a stand-in, or the document showed it on another parent.
		if (derived !== undefined && derived.conflict === undefined && (derived.parentTree === parentTree || shown !== undefined) && (await matches(derived.tree))) {
			version = { tree: derived.tree, parentTree: derived.parentTree };
		} else if ((stored.parentTree === parentTree || shown !== undefined) && (await matches(stored.tree))) {
			// The file is as the document showed it, so the edit lands on the stored version whatever parent the document showed it on.
			version = stored;
		} else if ((await this.repo.run(["cat-file", "-e", `${parentTree}^{tree}`], { cwd: this.repo.worktree })).code === 0) {
			const rebuilt = await treeRestacked(this.repo, stored.parentTree, parentTree, stored.tree);
			version = rebuilt.conflicted.length === 0 && (await matches(rebuilt.tree)) ? { tree: rebuilt.tree, parentTree } : undefined;
		}
		if (version === undefined) {
			throw stale();
		}
		const unedited = await treeRestacked(this.repo, commit.parentTree, version.parentTree, commit.tree);
		return { commit, version, unedited: unedited.tree, restacked: unedited.conflicted.length === 0 };
	}

	// Stores `tree` as the commit's new version on the target's parent, or drops the draft's files when that is just the commit restacked.
	async #versionStore(store: Store, target: EditTarget, branch: string, existing: DraftEntry | undefined, tree: Oid): Promise<void> {
		const unchanged = target.restacked && tree === target.unedited;
		const next = draftFor(
			target.commit,
			branch,
			unchanged ? undefined : { tree, parentTree: target.version.parentTree },
			existing === undefined ? undefined : draftMessage(existing),
		);
		const oid = target.commit.oid;
		await this.#storeUpdate(store, (drafts) => (next === undefined ? drafts.delete(oid) : drafts.set(oid, next)));
	}

	async #entryOid(repo: Repo, tree: Oid, path: string): Promise<Oid | undefined> {
		const [entry] = await treeList(repo, tree, { recursive: false, paths: [`:(literal)${path}`] });
		return entry !== undefined && entry.path === path && entry.type === "blob" ? entry.oid : undefined;
	}

	// Removes the drafts that were published, but only those unchanged since the apply read them: an edit saved meanwhile stays. Resolutions are cleared too; they were specific to the stack just replaced.
	async #draftsClear(applied: readonly DraftEntry[]): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			const store = await storeRead(this.repo, this.#cat);
			try {
				await this.#storeUpdate(
					store,
					(drafts) => {
						for (const draft of applied) {
							if (drafts.get(draft.meta.against)?.entryOid === draft.entryOid) {
								drafts.delete(draft.meta.against);
							}
						}
					},
					(resolutions) => resolutions.clear(),
				);
				return;
			} catch (err) {
				if (!(err instanceof ErrorStoreChanged) || attempt >= 3) {
					throw err;
				}
			}
		}
	}

	async #storeUpdate(store: Store, drafts?: (drafts: Map<Oid, DraftEntry>) => void, resolutions?: (resolutions: Map<string, ResolutionEntry>) => void): Promise<void> {
		const nextDrafts = new Map(store.drafts);
		const nextResolutions = new Map(store.resolutions);
		drafts?.(nextDrafts);
		resolutions?.(nextResolutions);
		await storeWrite(this.repo, store, nextDrafts, nextResolutions);
		await this.#resolutionsSpentDrop();
	}

	// A resolution whose own version no longer merges, while the version it replaced does, resolved a conflict that is gone (the edit below that caused it was undone): the commit goes back to that version, so nothing is left stored that changes nothing. Computed as the stack is shown, which the next read reuses.
	async #resolutionsSpentDrop(): Promise<void> {
		let derivation: Derivation;
		try {
			derivation = await this.#derivationShown();
		} catch (err) {
			if (err instanceof ErrorNotOnBranch || err instanceof ErrorNoBase) {
				return;
			}
			throw err;
		}
		const spent = derivation.commits.flatMap((d) => {
			const current = currentFor(derivation, d.commit.oid);
			const fallback = current?.draft.fallback;
			return d.fallback && current !== undefined && current.draft.meta.origin === "resolution" && fallback !== undefined ? [{ d, current, fallback }] : [];
		});
		if (spent.length === 0) {
			return;
		}
		const drafts = new Map(derivation.store.drafts);
		for (const { d, current, fallback } of spent) {
			const commit: CommitBasics = { ...d.commit, parentTree: originalParentTree(derivation, d.commit.oid) };
			const implicit = fallback.tree === commit.tree && fallback.parentTree === commit.parentTree;
			const next = draftFor(commit, current.draft.meta.branch, implicit ? undefined : fallback, draftMessage(current.draft));
			if (next === undefined) {
				drafts.delete(d.commit.oid);
			} else {
				drafts.set(d.commit.oid, next);
			}
		}
		await storeWrite(this.repo, derivation.store, drafts, derivation.store.resolutions);
	}

	// Read through the private objects, so trees made only for showing can be listed.
	async #documentFiles(parentTree: Oid, commitTree: Oid, draftTree: Oid, mineUnknown: ReadonlySet<string>, provisional: ReadonlySet<string>): Promise<DocumentFile[]> {
		const repo = this.#view;
		const byCommit = await treeDiff(repo, parentTree, commitTree);
		const byDraft = draftTree === commitTree ? byCommit : await treeDiff(repo, parentTree, draftTree);
		const paths = [...new Set([...byCommit, ...byDraft].map((c) => c.path))].sort();
		const refusals = await editability(repo, draftTree, paths);
		const shown = await indentationFor(repo, this.#cat, draftTree, paths);
		const deleted = byDraft.filter((c) => c.status === "D").map((c) => c.path);
		const before = deleted.length === 0 ? new Map<string, Indentation>() : await indentationFor(repo, this.#cat, parentTree, deleted);
		const blobs = new Map(
			paths.length === 0
				? []
				: (await treeList(repo, draftTree, { recursive: true, paths: paths.map((p) => `:(literal)${p}`) })).filter((e) => e.type === "blob").map((e) => [e.path, e.oid]),
		);
		const indentationOf = (path: string): Indentation => {
			const found = before.get(path) ?? shown.get(path);
			if (found === undefined) {
				throw new Error(`no indentation resolved for ${path}`);
			}
			return found;
		};
		const files: DocumentFile[] = [];
		for (const path of paths) {
			const inDraft = byDraft.find((c) => c.path === path);
			const inCommit = byCommit.find((c) => c.path === path);
			const [parent, commit, draft] = await Promise.all([this.#blobAt(parentTree, path), this.#blobAt(commitTree, path), this.#blobAt(draftTree, path)]);
			const tooLarge = [parent, commit, draft].some((b) => b !== undefined && b.length > BLOB_LIMIT);
			files.push({
				path,
				status: inDraft?.status ?? "=",
				binary: (inDraft?.binary ?? false) || (inCommit?.binary ?? false),
				refusal: refusals.get(path),
				parent: tooLarge ? undefined : parent,
				commit: tooLarge ? undefined : commit,
				draft: tooLarge ? undefined : draft,
				draftOid: blobs.get(path),
				tooLarge,
				indentation: indentationOf(path),
				mineUnknown: mineUnknown.has(path),
				provisional: provisional.has(path),
			});
		}
		return files;
	}

	async #blobAt(tree: Oid, path: string): Promise<Buffer | undefined> {
		const obj = await this.#cat.read(`${tree}:${path}`);
		return obj?.type === "blob" ? obj.data : undefined;
	}

	async #commit(oid: Oid): Promise<CommitInfo> {
		const obj = await this.#cat.read(oid);
		if (obj?.type !== "commit") {
			throw new ErrorStale(`commit ${oid.slice(0, 12)}`);
		}
		return commitParse(oid, obj.data);
	}

	// Any commit, in the stack or not, with its parent's tree.
	async #basics(oid: Oid): Promise<CommitBasics> {
		const info = await this.#commit(oid);
		const parent = info.parents[0];
		if (parent === undefined) {
			throw new ErrorStale(`the parent of ${oid.slice(0, 12)}`);
		}
		return { oid, tree: info.tree, authorLine: info.authorLine, subject: commitSubject(info), message: info.message, parentTree: (await commitRead(this.#cat, parent)).tree };
	}

	// The branch a draft belongs to: the checked-out branch, or while HEAD is detached (mid-rebase, say) the branch the draft already has. A draft from another branch is never extended; it has to be adopted first.
	async #draftBranch(existing: DraftEntry | undefined, path: string): Promise<string> {
		let branch: string;
		try {
			branch = await branchCurrent(this.repo);
		} catch (err) {
			if (err instanceof ErrorNotOnBranch && existing !== undefined) {
				return existing.meta.branch;
			}
			if (err instanceof ErrorNotOnBranch) {
				throw new ErrorEditRefused(path, "HEAD is detached (a rebase may be in progress); try again once it is back on a branch");
			}
			throw err;
		}
		if (existing !== undefined && existing.meta.branch !== branch) {
			throw new ErrorEditRefused(path, `an edit made on ${existing.meta.branch} is stored for this commit; adopt or discard it first`);
		}
		return branch;
	}
}

// Whether every one of `oids` is in the repository's objects (through `repo`, so the private ones count for `#view`).
async function objectsPresent(repo: Repo, oids: readonly Oid[]): Promise<boolean> {
	if (oids.length === 0) {
		return true;
	}
	const listed = await repo.run(["cat-file", "--batch-check"], { cwd: repo.worktree, input: `${oids.join("\n")}\n` });
	if (listed.code !== 0) {
		throw new ErrorGit(["cat-file", "--batch-check"], listed.code, listed.stderr);
	}
	return !/ missing$/m.test(listed.stdout.toString("utf8"));
}

function derivedFor(derivation: Derivation, oid: Oid): DerivedCommit {
	const derived = derivation.commits.find((d) => d.commit.oid === oid);
	if (derived === undefined) {
		throw new ErrorStale(`commit ${oid.slice(0, 12)}`);
	}
	return derived;
}

function currentFor(derivation: Derivation, oid: Oid): Current | undefined {
	return derivation.statuses.find((s): s is Current => s.kind === "current" && s.commit.oid === oid);
}

// The tree of a stack commit's original parent.
function originalParentTree(derivation: Derivation, oid: Oid): Oid {
	const index = derivation.stack.commits.findIndex((c) => c.oid === oid);
	if (index === -1) {
		throw new ErrorStale(`commit ${oid.slice(0, 12)}`);
	}
	return derivation.stack.commits[index - 1]?.tree ?? derivation.baseTree;
}

function conflictReport(derivation: Derivation, derived: DerivedCommit): ConflictReport | undefined {
	const conflict = derived.conflict;
	if (conflict === undefined) {
		return undefined;
	}
	const commit: StackCommit = derived.commit;
	return {
		commit: {
			oid: commit.oid,
			tree: commit.tree,
			authorLine: commit.authorLine,
			subject: commit.subject,
			message: commit.message,
			parent: commit.parent,
			parentTree: originalParentTree(derivation, commit.oid),
		},
		inputs: conflict.inputs,
		markerTree: conflict.markerTree,
		conflicts: conflict.conflicts,
		edited: currentFor(derivation, commit.oid)?.edit.tree !== undefined,
	};
}

function commitStatuses(derivation: Derivation): CommitStatus[] {
	const steps = derivedSteps(derivation.baseTree, derivation.commits);
	let conflictBelow: Oid | undefined;
	return derivation.commits.map((d, i) => {
		const current = currentFor(derivation, d.commit.oid);
		let kind: CommitStatus["kind"];
		if (d.conflict !== undefined) {
			kind = "conflict";
		} else if (d.resolvedByTable || (current?.draft.meta.origin === "resolution" && !d.fallback)) {
			kind = "resolved";
		} else if (current !== undefined && current.draft.meta.origin !== "resolution") {
			kind = "edited";
		} else {
			kind = steps[i]?.rewrite === true ? "rewritten" : "unchanged";
		}
		const status: CommitStatus = { oid: d.commit.oid, kind, provisional: d.provisional, conflictBelow: d.provisional.length === 0 ? undefined : conflictBelow };
		if (d.conflict !== undefined && conflictBelow === undefined) {
			conflictBelow = d.commit.oid;
		}
		return status;
	});
}
