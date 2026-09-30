import { intentCheck, type PublishResult, publish } from "./apply.ts";
import { type CommitBasics, type DraftStatus, draftConfirmed, draftMessage, draftsResolve, draftWithEntry, draftWithFile, draftWithMessage, editability } from "./drafts.ts";
import { ErrorEditRefused, ErrorNoBase, ErrorNotOnBranch, ErrorStale, ErrorStoreChanged } from "./errors.ts";
import { gitOk, gitRunnerSpawn, type Oid, type Repo, repoOpen } from "./git.ts";
import { type Conflict, mergeTrees } from "./merge.ts";
import { CatFile, type CommitInfo, commitParse, commitRead, commitSubject, treeDiff } from "./objects.ts";
import { type Edit, type MergeInputs, type ReplayStep, replayCommit, replayTrees } from "./replay.ts";
import { branchCurrent, configGet, type Stack, stackRead } from "./stack.ts";
import { type DraftEntry, type ResolutionChange, type ResolutionEntry, type Store, storeRead, storeRefOid, storeWrite } from "./store.ts";
import { blobWrite, signingWanted } from "./write.ts";

export type SessionState =
	| { readonly kind: "ready"; readonly stack: Stack; readonly drafts: readonly DraftStatus[] }
	| { readonly kind: "unavailable"; readonly reason: string }
	| Extract<PublishResult, { kind: "interrupted" }>;

export type StepSummary = { readonly oid: Oid; readonly subject: string; readonly rewrite: boolean; readonly empty: boolean; readonly dropsSignature: boolean };

export type ConflictReport = {
	readonly commit: CommitBasics & { readonly parent: Oid };
	readonly inputs: MergeInputs;
	readonly markerTree: Oid;
	readonly conflicts: readonly (Conflict & { readonly resolved: boolean })[];
};

export type PreviewResult =
	| { readonly kind: "nothing" }
	| { readonly kind: "drafts-need-attention"; readonly drafts: readonly DraftStatus[] }
	| ({ readonly kind: "conflict" } & ConflictReport)
	| { readonly kind: "clean"; readonly steps: readonly StepSummary[] };

export type ApplyResult =
	| Exclude<PreviewResult, { kind: "clean" }>
	| Exclude<PublishResult, { kind: "published" }>
	// `warning` is set when publishing succeeded but tidying up the applied drafts did not; the drafts then show as current or orphaned.
	| { readonly kind: "published"; readonly warning: string | undefined };

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

export class Session {
	readonly repo: Repo;
	readonly #cat: CatFile;
	readonly #mutex: Mutex;

	private constructor(repo: Repo, cat: CatFile) {
		this.repo = repo;
		this.#cat = cat;
		this.#mutex = mutexFor(repo);
	}

	static async open(path: string): Promise<Session> {
		return Session.openRepo(await repoOpen(gitRunnerSpawn(), path));
	}

	static async openRepo(repo: Repo): Promise<Session> {
		// Every commit Suonetar replaces stays reachable from the reflog; a year instead of git's 30 days, so nothing it rewrote is pruned soon.
		if ((await configGet(repo, "gc.reflogExpireUnreachable")) === undefined) {
			await gitOk(repo, ["config", "--local", "gc.reflogExpireUnreachable", "1.year"]);
		}
		return new Session(repo, new CatFile(repo));
	}

	close(): void {
		this.#cat.close();
	}

	// Closes once the operation in progress (and any queued behind it) has finished.
	closeWhenIdle(): Promise<void> {
		return this.#mutex.run(async () => this.close());
	}

	// Cheap enough to poll: changes when HEAD switches or moves, the draft store changes, or the configured base changes.
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
				const stack = await stackRead(this.repo, this.#cat);
				const store = await storeRead(this.repo, this.#cat);
				return { kind: "ready", stack, drafts: await draftsResolve(this.repo, stack, store.drafts) };
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
			const next = await draftWithFile(this.repo, branch, commit, existing, path, content);
			await this.#storeUpdate(store, (drafts) => (next === undefined ? drafts.delete(oid) : drafts.set(oid, next)));
		});
	}

	// Sets one file of a commit's draft back to its version in the commit or in the commit's parent, mode and all; absent there means deleted.
	draftRestore(oid: Oid, path: string, from: "commit" | "parent"): Promise<void> {
		return this.#mutex.run(async () => {
			const commit = await this.#basics(oid);
			let source = commit.tree;
			if (from === "parent") {
				const parent = (await this.#commit(oid)).parents[0];
				if (parent === undefined) {
					throw new ErrorStale(`the parent of ${oid.slice(0, 12)}`);
				}
				source = (await commitRead(this.#cat, parent)).tree;
			}
			const store = await storeRead(this.repo, this.#cat);
			const existing = store.drafts.get(oid);
			const next = await draftWithEntry(this.repo, await this.#draftBranch(existing, path), commit, existing, path, source);
			await this.#storeUpdate(store, (drafts) => (next === undefined ? drafts.delete(oid) : drafts.set(oid, next)));
		});
	}

	draftSetMessage(oid: Oid, message: Buffer | undefined): Promise<void> {
		return this.#mutex.run(async () => {
			const commit = await this.#basics(oid);
			const store = await storeRead(this.repo, this.#cat);
			const existing = store.drafts.get(oid);
			const next = draftWithMessage(await this.#draftBranch(existing, "(message)"), commit, existing, message);
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
			const stack = await stackRead(this.repo, this.#cat);
			const store = await storeRead(this.repo, this.#cat);
			const status = (await draftsResolve(this.repo, stack, store.drafts)).find((s) => s.draft.meta.against === against);
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

	apply(): Promise<ApplyResult> {
		return this.#mutex.run(async (): Promise<ApplyResult> => {
			const pending = intentCheck(this.repo);
			if (pending) {
				return pending;
			}
			const plan = await this.#plan();
			if (plan.preview.kind !== "clean" || plan.steps === undefined) {
				return plan.preview.kind === "clean" ? { kind: "nothing" } : plan.preview;
			}
			const { tip, rewritten } = await replayCommit(this.repo, plan.stack.baseOid, plan.steps, await signingWanted(this.repo));
			const published = await publish(this.repo, plan.stack.branch, plan.stack.tipOid, tip, `suonetar: apply ${rewritten.length} commits`);
			if (published.kind !== "published") {
				return published;
			}
			try {
				await this.#draftsClear(plan.applied);
				return { kind: "published", warning: undefined };
			} catch (err) {
				return { kind: "published", warning: `published, but the applied drafts could not be cleared: ${(err as Error).message}` };
			}
		});
	}

	async #plan(): Promise<{ stack: Stack; preview: PreviewResult; steps?: readonly ReplayStep[]; applied: DraftEntry[] }> {
		const stack = await stackRead(this.repo, this.#cat);
		const store = await storeRead(this.repo, this.#cat);
		const statuses = await draftsResolve(this.repo, stack, store.drafts);
		const blocking = statuses.filter((s) => s.kind === "rebased" || s.kind === "conflict");
		if (blocking.length > 0) {
			return { stack, preview: { kind: "drafts-need-attention", drafts: blocking }, applied: [] };
		}
		const current = statuses.filter((s): s is Extract<DraftStatus, { kind: "current" }> => s.kind === "current");
		const edits = new Map<Oid, Edit>(current.map((s) => [s.commit.oid, s.edit]));
		const resolutions = new Map([...store.resolutions].map(([key, r]) => [key, r.changes]));
		const baseTree = (await commitRead(this.#cat, stack.baseOid)).tree;
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

	async #basics(oid: Oid): Promise<CommitBasics> {
		const info = await this.#commit(oid);
		return { oid, tree: info.tree, authorLine: info.authorLine, subject: commitSubject(info), message: info.message };
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
