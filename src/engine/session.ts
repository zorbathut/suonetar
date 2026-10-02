import { createHash } from "node:crypto";
import { intentCheck, type PublishResult, preflightPosition, publish } from "./apply.ts";
import { type CommitBasics, type DraftStatus, draftConfirmed, draftFor, draftMessage, draftsResolve, draftVersion, editability, treeWithEntry, treeWithFile } from "./drafts.ts";
import { type Indentation, indentationFor } from "./editorconfig.ts";
import { ErrorEditRefused, ErrorNoBase, ErrorNotOnBranch, ErrorStale, ErrorStoreChanged } from "./errors.ts";
import { fileReaderDisk, gitOk, gitRunnerSpawn, hookRunnerSpawn, type Oid, type Repo, repoOpen } from "./git.ts";
import { type HookCache, type HookCommit, type HookFailure, type HookPassResult, type HookProgress, hookIdentity, hooksPass } from "./hooks.ts";
import { type Conflict, mergeTrees } from "./merge.ts";
import { type MergetoolResult, mergetoolName, mergetoolRun } from "./mergetool.ts";
import { CatFile, type CommitInfo, commitParse, commitRead, commitSubject, treeDiff } from "./objects.ts";
import { type Edit, type MergeInputs, type ReplayStep, replayCommit, replayTrees, stepsReflag } from "./replay.ts";
import { branchCurrent, configGet, type Stack, stackRead } from "./stack.ts";
import { type DraftEntry, type ResolutionChange, type ResolutionEntry, type Store, storeRead, storeRefOid, storeWrite } from "./store.ts";
import { reflogMessage, type UndoInfo, undoAssess, undoDrafts } from "./undo.ts";
import { type WorktreeSide, type WorktreeStatus, worktreeFiles, worktreeStatus } from "./worktree-changes.ts";
import { WorktreePrivate } from "./worktree-private.ts";
import { blobWrite, signingWanted } from "./write.ts";

export type SessionState =
	// `undo` describes undoing the branch's last Suonetar move, when there is one.
	| { readonly kind: "ready"; readonly stack: Stack; readonly drafts: readonly DraftStatus[]; readonly undo: UndoInfo | undefined }
	| { readonly kind: "unavailable"; readonly reason: string }
	| Extract<PublishResult, { kind: "interrupted" }>;

export type StepSummary = { readonly oid: Oid; readonly subject: string; readonly rewrite: boolean; readonly empty: boolean; readonly dropsSignature: boolean };

export type ConflictReport = {
	readonly commit: Omit<CommitBasics, "parentTree"> & { readonly parent: Oid };
	readonly inputs: MergeInputs;
	readonly markerTree: Oid;
	readonly conflicts: readonly (Conflict & { readonly resolved: boolean })[];
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
	// Contents at the parent, at the commit, and with the draft; undefined where the file does not exist, or when `tooLarge`.
	readonly parent: Buffer | undefined;
	readonly commit: Buffer | undefined;
	readonly draft: Buffer | undefined;
	readonly tooLarge: boolean;
	// From EditorConfig, as of the version shown (the parent's, for a file that version deletes).
	readonly indentation: Indentation;
};

export type CommitDocument = {
	readonly oid: Oid;
	readonly parent: Oid;
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

export class Session {
	readonly repo: Repo;
	// The base chosen on the command line, which wins over `suonetar.base` and detection.
	readonly #base: string | undefined;
	readonly #cat: CatFile;
	readonly #mutex: Mutex;
	readonly #hookCache: HookCache = new Map();
	#abort: AbortController | undefined;
	// The merge tool being waited for, which holds a throwaway directory until it returns.
	#tool: Promise<MergetoolOutcome> | undefined;

	private constructor(repo: Repo, cat: CatFile, base: string | undefined) {
		this.repo = repo;
		this.#base = base;
		this.#cat = cat;
		this.#mutex = mutexFor(repo);
	}

	static async open(path: string, base: string | undefined): Promise<Session> {
		return Session.openRepo(await repoOpen(gitRunnerSpawn(), hookRunnerSpawn(), fileReaderDisk(), path), base);
	}

	static async openRepo(repo: Repo, base: string | undefined): Promise<Session> {
		return new Session(repo, new CatFile(repo), base);
	}

	#stackRead(): Promise<Stack> {
		return stackRead(this.repo, this.#cat, this.#base);
	}

	close(): void {
		this.#cat.close();
	}

	// Closes once the operation in progress (and any queued behind it) has finished, including a merge tool, which runs outside the queue.
	closeWhenIdle(): Promise<void> {
		const tool = this.#tool;
		return this.#mutex.run(async () => {
			try {
				await tool;
			} finally {
				this.close();
			}
		});
	}

	// Cheap enough to poll: changes when HEAD switches or moves, the draft store changes, the configured base changes, or any branch moves (a push or fetch changes the base and what is pushed).
	generation(): Promise<string> {
		return this.#mutex.run(async () => {
			const symbolic = await this.repo.run(["symbolic-ref", "-q", "HEAD"], { cwd: this.repo.worktree });
			if (symbolic.code > 1) {
				throw new Error(`git symbolic-ref HEAD failed: ${symbolic.stderr}`);
			}
			const head = await this.repo.run(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: this.repo.worktree });
			if (head.code > 1) {
				throw new Error(`git rev-parse HEAD failed: ${head.stderr}`);
			}
			const parts = [
				symbolic.stdout.toString("utf8").trim(),
				head.stdout.toString("utf8").trim(),
				(await storeRefOid(this.repo)) ?? "",
				(await configGet(this.repo, "suonetar.base")) ?? "",
				// Every branch, local and remote: the base and the pushed marks follow them.
				createHash("sha1")
					.update(await gitOk(this.repo, ["for-each-ref", "--format=%(refname) %(objectname) %(symref)", "refs/heads", "refs/remotes"]))
					.digest("hex"),
			];
			return parts.join(" ");
		});
	}

	state(): Promise<SessionState> {
		return this.#mutex.run(async () => {
			const pending = intentCheck(this.repo);
			if (pending?.kind === "interrupted") {
				return pending;
			}
			try {
				const stack = await this.#stackRead();
				const store = await storeRead(this.repo, this.#cat);
				const drafts = await draftsResolve(this.repo, stack, await this.#baseTree(stack), store.drafts);
				return { kind: "ready", stack, drafts, undo: await this.#undoInfo(stack, drafts) };
			} catch (err) {
				if (err instanceof ErrorNotOnBranch || err instanceof ErrorNoBase) {
					return { kind: "unavailable", reason: err.message };
				}
				throw err;
			}
		});
	}

	// The whole commit as the editor shows it: every file its change or its draft touches, with the three versions of each.
	commitDocument(oid: Oid): Promise<CommitDocument> {
		return this.#mutex.run(async () => {
			const commit = await this.#commit(oid);
			const parent = commit.parents[0];
			if (parent === undefined) {
				throw new ErrorStale(`the parent of ${oid.slice(0, 12)}`);
			}
			const draft = await this.#draftHere((await storeRead(this.repo, this.#cat)).drafts.get(oid));
			const parentTree = (await commitRead(this.#cat, parent)).tree;
			const files = await this.#documentFiles(parentTree, commit.tree, draft?.tree ?? commit.tree);
			const draftMsg = draft ? draftMessage(draft) : undefined;
			return { oid, parent, subject: commitSubject(commit), message: commit.message, draftMessage: draftMsg, hasDraft: draft !== undefined, files };
		});
	}

	// A draft's own changes, relative to the commit it was made on; works for drafts whose commit is gone, so orphans can be looked at before discarding them.
	draftDocument(against: Oid): Promise<CommitDocument> {
		return this.#mutex.run(async () => {
			const draft = (await storeRead(this.repo, this.#cat)).drafts.get(against);
			if (draft === undefined) {
				throw new ErrorStale(`the draft for ${against.slice(0, 12)}`);
			}
			const files = await this.#documentFiles(draft.base, draft.base, draft.tree ?? draft.base);
			const baseMessage = draft.meta.baseMessage === undefined ? Buffer.alloc(0) : Buffer.from(draft.meta.baseMessage, "base64");
			return { oid: against, parent: against, subject: draft.meta.subject, message: baseMessage, draftMessage: draftMessage(draft), hasDraft: true, files };
		});
	}

	blobAt(tree: Oid, path: string): Promise<Buffer | undefined> {
		return this.#mutex.run(() => this.#blobAt(tree, path));
	}

	blob(oid: Oid): Promise<Buffer | undefined> {
		return this.#mutex.run(async () => {
			const obj = await this.#cat.read(oid);
			return obj?.type === "blob" ? obj.data : undefined;
		});
	}

	// Sets one file of a commit's draft; null deletes the file. The commit need not be in the current stack: an edit saved against a commit rewritten meanwhile is kept and later offered for confirmation onto its successor.
	draftSetFile(oid: Oid, path: string, content: Buffer | null): Promise<void> {
		return this.#mutex.run(async () => {
			const commit = await this.#basics(oid);
			const store = await storeRead(this.repo, this.#cat);
			const existing = store.drafts.get(oid);
			const branch = await this.#draftBranch(existing, path);
			const tree = await treeWithFile(this.repo, existing?.tree ?? commit.tree, commit.tree, path, content);
			const next = draftFor(commit, branch, tree === commit.tree ? undefined : { tree, parentTree: commit.parentTree }, existing ? draftMessage(existing) : undefined);
			await this.#storeUpdate(store, (drafts) => (next === undefined ? drafts.delete(oid) : drafts.set(oid, next)));
		});
	}

	// Sets one file of a commit's draft back to its version in the commit or in the commit's parent, mode and all; absent there means deleted.
	draftRestore(oid: Oid, path: string, from: "commit" | "parent"): Promise<void> {
		return this.#mutex.run(async () => {
			const commit = await this.#basics(oid);
			const source = from === "parent" ? commit.parentTree : commit.tree;
			const store = await storeRead(this.repo, this.#cat);
			const existing = store.drafts.get(oid);
			const branch = await this.#draftBranch(existing, path);
			const tree = await treeWithEntry(this.repo, existing?.tree ?? commit.tree, path, source);
			const next = draftFor(commit, branch, tree === commit.tree ? undefined : { tree, parentTree: commit.parentTree }, existing ? draftMessage(existing) : undefined);
			await this.#storeUpdate(store, (drafts) => (next === undefined ? drafts.delete(oid) : drafts.set(oid, next)));
		});
	}

	draftSetMessage(oid: Oid, message: Buffer | undefined): Promise<void> {
		return this.#mutex.run(async () => {
			const commit = await this.#basics(oid);
			const store = await storeRead(this.repo, this.#cat);
			const existing = store.drafts.get(oid);
			const next = draftFor(commit, await this.#draftBranch(existing, "(message)"), existing === undefined ? undefined : draftVersion(existing, commit), message);
			await this.#storeUpdate(store, (drafts) => (next === undefined ? drafts.delete(oid) : drafts.set(oid, next)));
		});
	}

	draftDiscard(against: Oid): Promise<void> {
		return this.#mutex.run(async () => {
			await this.#storeUpdate(await storeRead(this.repo, this.#cat), (drafts) => drafts.delete(against));
		});
	}

	draftConfirm(against: Oid): Promise<void> {
		return this.#mutex.run(async () => {
			const stack = await this.#stackRead();
			const store = await storeRead(this.repo, this.#cat);
			const status = (await draftsResolve(this.repo, stack, await this.#baseTree(stack), store.drafts)).find((s) => s.draft.meta.against === against);
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
		return this.#mutex.run(async () => {
			const store = await storeRead(this.repo, this.#cat);
			const draft = store.drafts.get(against);
			if (draft === undefined) {
				throw new ErrorStale(`the draft for ${against.slice(0, 12)}`);
			}
			const branch = await branchCurrent(this.repo);
			await this.#storeUpdate(store, (drafts) => drafts.set(against, { ...draft, meta: { ...draft.meta, branch }, entryOid: undefined }));
		});
	}

	// Records how one conflict (identified by its key) is resolved. Every path the conflict involves must be accounted for, and text must be free of conflict markers unless explicitly allowed.
	resolve(inputs: MergeInputs, key: string, choices: readonly ResolutionChoice[]): Promise<ResolveResult> {
		return this.#mutex.run(async () => {
			const merged = await mergeTrees(this.repo, inputs.base, inputs.ours, inputs.theirs);
			const conflict = merged.kind === "conflict" ? merged.conflicts.find((c) => c.key === key) : undefined;
			if (conflict === undefined) {
				return { kind: "invalid", reason: "that conflict no longer occurs; refresh" };
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
			await this.#storeUpdate(await storeRead(this.repo, this.#cat), undefined, (resolutions) => resolutions.set(key, { changes, entryOid: undefined }));
			return { kind: "resolved" };
		});
	}

	preview(): Promise<PreviewResult> {
		return this.#mutex.run(async () => (await this.#plan()).preview);
	}

	// Publishes every draft: replay, the pre-commit hook on each rewritten commit (unless skipped), then the locked publish.
	async apply(hooks: HookChoice, progress: (p: ApplyProgress) => void): Promise<ApplyResult> {
		// Created before queueing, so a cancel pressed while the apply waits or prepares is not lost.
		const abort = new AbortController();
		this.#abort = abort;
		try {
			return await this.#mutex.run(() => this.#apply(hooks, progress, abort.signal));
		} finally {
			if (this.#abort === abort) {
				this.#abort = undefined;
			}
		}
	}

	// The working tree's staged and unstaged change counts, cheap enough to poll.
	worktreeStatus(): Promise<WorktreeStatus> {
		return this.#mutex.run(() => worktreeStatus(this.repo, WORKTREE_FILES_MAX));
	}

	worktreeDocument(side: WorktreeSide): Promise<WorktreeDocument> {
		return this.#mutex.run(async () => ({ side, ...(await worktreeFiles(this.repo, this.#cat, side, WORKTREE_FILES_MAX, BLOB_LIMIT)) }));
	}

	// A path's EditorConfig indentation as of `tree`, for editors that show something other than a document file (a conflict's marker file).
	indentation(tree: Oid, path: string): Promise<Indentation> {
		return this.#mutex.run(async () => {
			const found = (await indentationFor(this.repo, this.#cat, tree, [path])).get(path);
			if (found === undefined) {
				throw new Error(`no indentation resolved for ${path}`);
			}
			return found;
		});
	}

	mergetoolName(): Promise<string | undefined> {
		return this.#mutex.run(() => mergetoolName(this.repo));
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
			const conflict = await this.#mutex.run(async () => {
				const merged = await mergeTrees(this.repo, inputs.base, inputs.ours, inputs.theirs);
				return merged.kind === "conflict" ? merged.conflicts.find((c) => c.key === key) : undefined;
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
		return this.#mutex.run(async () => {
			const pending = intentCheck(this.repo);
			if (pending) {
				return pending;
			}
			const stack = await this.#stackRead();
			const store = await storeRead(this.repo, this.#cat);
			const assessed = await undoAssess(this.repo, this.#cat, stack, draftsHere(await draftsResolve(this.repo, stack, await this.#baseTree(stack), store.drafts)));
			const info = assessed?.info;
			if (info === undefined || info.kind === "unavailable" || info.old !== old || info.new !== newTip || info.kind !== kind || assessed?.pairing === undefined) {
				return info?.kind === "unavailable" ? { kind: "unavailable", reason: info.reason } : { kind: "stale" };
			}
			if (info.kind === "exact") {
				const published = await publish(this.repo, stack.branch, info.new, info.old, reflogMessage(info.verb, info.commits, info.new));
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

	async #apply(hooks: HookChoice, progress: (p: ApplyProgress) => void, signal: AbortSignal): Promise<ApplyResult> {
		const pending = intentCheck(this.repo);
		if (pending) {
			return pending;
		}
		const plan = await this.#plan();
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
		const published = await publish(this.repo, plan.stack.branch, plan.stack.tipOid, tip, reflogMessage("apply", rewritten.length, plan.stack.tipOid));
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
		}
	}

	async #plan(): Promise<{ stack: Stack; preview: PreviewResult; steps?: readonly ReplayStep[]; applied: DraftEntry[] }> {
		const stack = await this.#stackRead();
		const store = await storeRead(this.repo, this.#cat);
		const baseTree = await this.#baseTree(stack);
		const statuses = await draftsResolve(this.repo, stack, baseTree, store.drafts);
		const blocking = statuses.filter((s) => s.kind === "rebased" || s.kind === "conflict");
		if (blocking.length > 0) {
			return { stack, preview: { kind: "drafts-need-attention", drafts: blocking }, applied: [] };
		}
		const current = statuses.filter((s): s is Extract<DraftStatus, { kind: "current" }> => s.kind === "current");
		const edits = new Map<Oid, Edit>(current.map((s) => [s.commit.oid, s.edit]));
		const resolutions = new Map([...store.resolutions].map(([key, r]) => [key, r.changes]));
		const result = await replayTrees(this.repo, stack.commits, baseTree, edits, resolutions);
		const applied = current.map((s) => s.draft);
		if (result.kind === "conflict") {
			const { commit, inputs, markerTree, conflicts } = result;
			return { stack, preview: { kind: "conflict", commit, inputs, markerTree, conflicts }, applied };
		}
		if (!result.steps.some((s) => s.rewrite)) {
			return { stack, preview: { kind: "nothing" }, applied };
		}
		const steps = result.steps.map((s) => ({ oid: s.commit.oid, subject: s.commit.subject, rewrite: s.rewrite, empty: s.empty, dropsSignature: s.rewrite && s.commit.signed }));
		return { stack, preview: { kind: "clean", steps }, steps: result.steps, applied };
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
	}

	async #documentFiles(parentTree: Oid, commitTree: Oid, draftTree: Oid): Promise<DocumentFile[]> {
		const byCommit = await treeDiff(this.repo, parentTree, commitTree);
		const byDraft = draftTree === commitTree ? byCommit : await treeDiff(this.repo, parentTree, draftTree);
		const paths = [...new Set([...byCommit, ...byDraft].map((c) => c.path))].sort();
		const refusals = await editability(this.repo, draftTree, paths);
		const shown = await indentationFor(this.repo, this.#cat, draftTree, paths);
		const deleted = byDraft.filter((c) => c.status === "D").map((c) => c.path);
		const before = deleted.length === 0 ? new Map<string, Indentation>() : await indentationFor(this.repo, this.#cat, parentTree, deleted);
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
				tooLarge,
				indentation: indentationOf(path),
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

	async #baseTree(stack: Stack): Promise<Oid> {
		return (await commitRead(this.#cat, stack.baseOid)).tree;
	}

	// A commit's stored draft, unless it belongs to another branch: that one is shown and adopted separately, never blended into this branch's view.
	async #draftHere(draft: DraftEntry | undefined): Promise<DraftEntry | undefined> {
		if (draft === undefined) {
			return undefined;
		}
		try {
			return draft.meta.branch === (await branchCurrent(this.repo)) ? draft : undefined;
		} catch (err) {
			if (err instanceof ErrorNotOnBranch) {
				return draft;
			}
			throw err;
		}
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
