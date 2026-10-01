import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { gitOk, type HookResult, type Oid, type Repo } from "./git.ts";
import { mergeTrees } from "./merge.ts";
import { treeDiffRaw } from "./objects.ts";
import type { ReplayStep } from "./replay.ts";
import type { WorktreePrivate } from "./worktree-private.ts";
import { commitWrite, type TreeChange, treeWithChanges } from "./write.ts";

export type HookProgress = { readonly index: number; readonly total: number; readonly subject: string };

export type HookCommit = { readonly oid: Oid; readonly subject: string };

export type HookFailure = {
	readonly commit: HookCommit;
	// "exit": the hook failed; "unsettled": it changed files on every run; "collision": the commit's own change cannot be laid over an earlier hook's result without dropping files.
	readonly failure: "exit" | "unsettled" | "collision";
	readonly code: number | null;
	readonly output: string;
	// Paths the hook had changed before it gave up, or for a collision the paths that would be dropped.
	readonly changed: readonly string[];
};

export type HookPassResult =
	| {
			readonly kind: "passed";
			readonly steps: readonly ReplayStep[];
			// What the hook changed while checking each commit.
			readonly changed: readonly (HookCommit & { readonly paths: readonly string[] })[];
			// Commits whose own tree has a tracked hooks directory without a pre-commit hook.
			readonly hookless: readonly HookCommit[];
	  }
	| ({ readonly kind: "failed" } & HookFailure)
	| { readonly kind: "cancelled" };

// Results of passing hook runs, by hooked parent tree, input tree, and hook identity.
export type HookCache = Map<string, Oid>;

const RUNS_MAX = 3;
const STAND_IN_MESSAGE = Buffer.from("suonetar: hook parent\n");

// What decides how the pre-commit hook behaves, as far as it lives outside the commit's tree; undefined when `git commit` would run no pre-commit hook.
export async function hookIdentity(repo: Repo): Promise<string | undefined> {
	const list = await repo.run(["hook", "list", "pre-commit"], { cwd: repo.worktree });
	if (list.code === 1) {
		return undefined;
	}
	if (list.code !== 0) {
		throw new Error(`git hook list pre-commit failed: ${list.stderr}`);
	}
	const file = (await gitOk(repo, ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit"])).toString("utf8").trim();
	const fileHash = existsSync(file) ? createHash("sha1").update(readFileSync(file)).digest("hex") : "";
	const config = await repo.run(["config", "--get-regexp", "^(hook\\.|core\\.hookspath$)"], { cwd: repo.worktree });
	if (config.code > 1) {
		throw new Error(`reading hook configuration failed: ${config.stderr}`);
	}
	return [list.stdout.toString("utf8"), file, fileHash, config.stdout.toString("utf8")].join("\0");
}

// A relative `core.hooksPath` is resolved where the hook runs, so in the private worktree it names the commit's own copy. Undefined when the setting is absent or absolute, which need nothing extra.
async function hooksPathRelative(repo: Repo): Promise<string | undefined> {
	const configured = await repo.run(["config", "--type=path", "--get", "core.hooksPath"], { cwd: repo.worktree });
	if (configured.code === 1) {
		return undefined;
	}
	if (configured.code !== 0) {
		throw new Error(`reading core.hooksPath failed: ${configured.stderr}`);
	}
	const hooksPath = configured.stdout.toString("utf8").trim();
	return isAbsolute(hooksPath) ? undefined : hooksPath;
}

// The `-c` arguments for running the hook on `tree`. A relative hooks path the tree tracks runs the commit's own version; one it does not track (husky's ignored `.husky/_`, or a directory outside the repository) is pinned to the main worktree's copy rather than finding no hook.
async function hookConfig(repo: Repo, hooksPath: string | undefined, tree: Oid): Promise<string[]> {
	if (hooksPath === undefined) {
		return [];
	}
	const absolute = resolve(repo.worktree, hooksPath);
	const inside = relative(repo.worktree, absolute);
	if (inside !== "" && !inside.startsWith("..") && !isAbsolute(inside)) {
		const tracked = await gitOk(repo, ["ls-tree", tree, "--", inside]);
		if (tracked.length > 0) {
			return [];
		}
	}
	return ["-c", `core.hooksPath=${absolute}`];
}

// A commit the hook does not run on keeps the formatting earlier commits received wherever it did not change the same lines; only where it did does it fall back to its own lines laid over the hooked parent.
async function treeUnhooked(repo: Repo, plainParent: Oid, hookedParent: Oid, plainTree: Oid, overlay: Oid): Promise<Oid> {
	if (hookedParent === plainParent) {
		return plainTree;
	}
	const merged = await mergeTrees(repo, plainParent, hookedParent, plainTree);
	return merged.kind === "clean" ? merged.tree : overlay;
}

export type HookPassInput = {
	readonly baseOid: Oid;
	readonly baseTree: Oid;
	readonly steps: readonly ReplayStep[];
	readonly skip: ReadonlySet<Oid>;
	readonly identity: string;
	readonly cache: HookCache;
	readonly progress: (p: HookProgress) => void;
	readonly signal: AbortSignal;
};

// Runs the pre-commit hook on every rewritten commit in stack order, as `git commit` would have run it on that commit.
export async function hooksPass(repo: Repo, wt: WorktreePrivate, input: HookPassInput): Promise<HookPassResult> {
	const out: ReplayStep[] = [];
	const changed: (HookCommit & { paths: string[] })[] = [];
	const hookless: HookCommit[] = [];
	const total = input.steps.filter((s) => s.rewrite).length;
	const hooksPath = await hooksPathRelative(repo);
	let index = 0;
	// The parent as published (hooked) and as replayed (unhooked), and a commit whose tree is the hooked parent.
	let hookedParent = input.baseTree;
	let plainParent = input.baseTree;
	let parentCommit = input.baseOid;
	let originalParentTree = input.baseTree;
	for (const step of input.steps) {
		const commit = { oid: step.commit.oid, subject: step.commit.subject };
		if (!step.rewrite) {
			out.push(step);
			hookedParent = plainParent = originalParentTree = step.tree;
			parentCommit = step.commit.oid;
			continue;
		}
		index += 1;
		input.progress({ index, total, subject: step.commit.subject });

		// The commit's own change laid over the hooked parent, path by path: a three-way merge would conflict wherever the commit edits lines an earlier formatting pass touched.
		const own = await treeDiffRaw(repo, plainParent, step.tree);
		let inputTree = step.tree;
		let dropped: string[] = [];
		if (hookedParent !== plainParent) {
			const changes: TreeChange[] = own.map((c) => (c.new === undefined ? { path: c.path, delete: "file" } : { path: c.path, mode: c.new.mode, oid: c.new.oid }));
			inputTree = await treeWithChanges(repo, hookedParent, changes);
			const ownPaths = new Set(own.map((c) => c.path));
			dropped = (await treeDiffRaw(repo, hookedParent, inputTree)).filter((c) => !ownPaths.has(c.path)).map((c) => c.path);
		}
		let result: Oid;
		// The state the commit was originally made from was already checked when it was committed (a message edit below it changes nothing here).
		const unchanged = hookedParent === originalParentTree && inputTree === step.commit.tree;
		if (unchanged) {
			result = inputTree;
		} else if (input.skip.has(step.commit.oid)) {
			result = await treeUnhooked(repo, plainParent, hookedParent, step.tree, inputTree);
		} else if (dropped.length > 0) {
			return { kind: "failed", commit, failure: "collision", code: null, output: "", changed: dropped };
		} else {
			const key = `${hookedParent} ${inputTree} ${input.identity}`;
			let ran = true;
			const cached = input.cache.get(key);
			// A cached tree is unreachable once the worktree moves on, so `git gc --prune=now` may have removed it since.
			if (cached !== undefined && (await repo.run(["cat-file", "-e", `${cached}^{tree}`], { cwd: repo.worktree })).code === 0) {
				result = cached;
			} else {
				const config = await hookConfig(repo, hooksPath, inputTree);
				await wt.materialise(parentCommit, inputTree);
				const listed = await wt.hookGit(["hook", "list", "pre-commit"], config, input.signal);
				if (input.signal.aborted) {
					return { kind: "cancelled" };
				}
				ran = listed.code !== 1;
				if (!ran) {
					hookless.push(commit);
					result = await treeUnhooked(repo, plainParent, hookedParent, step.tree, inputTree);
				} else {
					const staged = own.filter((c) => c.new !== undefined).map((c) => c.path);
					const settled = await settle(wt, inputTree, staged, config, input.signal);
					if (settled.kind === "cancelled") {
						return settled;
					}
					if (settled.kind === "failed") {
						const paths = (await treeDiffRaw(repo, inputTree, settled.tree)).map((c) => c.path);
						return { kind: "failed", commit, failure: settled.failure, code: settled.code, output: settled.output, changed: paths };
					}
					result = settled.tree;
					input.cache.set(key, result);
				}
			}
			if (ran && result !== inputTree) {
				changed.push({ ...commit, paths: (await treeDiffRaw(repo, inputTree, result)).map((c) => c.path) });
			}
		}

		out.push({ ...step, tree: result });
		parentCommit = await commitWrite(repo, { tree: result, parent: parentCommit, authorLine: step.commit.authorLine, message: STAND_IN_MESSAGE, encoding: undefined }, false);
		hookedParent = result;
		plainParent = step.tree;
		originalParentTree = step.commit.tree;
	}
	return { kind: "passed", steps: out, changed, hookless };
}

type Settled =
	| { readonly kind: "passed"; readonly tree: Oid }
	| { readonly kind: "failed"; readonly failure: "exit" | "unsettled"; readonly tree: Oid; readonly code: number | null; readonly output: string }
	| { readonly kind: "cancelled" };

// Runs the hook until it passes. A hook that exits 0 is done, with whatever it staged plus its edits to the commit's own files; one that fails after changing files (a formatter) is run again on its result, as a user would re-run `git commit`.
async function settle(wt: WorktreePrivate, inputTree: Oid, paths: readonly string[], config: readonly string[], signal: AbortSignal): Promise<Settled> {
	let current = inputTree;
	let last: HookResult = { code: null, output: "" };
	for (let run = 0; run < RUNS_MAX; run++) {
		last = await wt.hookGit(["hook", "run", "pre-commit"], config, signal);
		if (signal.aborted) {
			return { kind: "cancelled" };
		}
		const after = await wt.stage(paths);
		if (last.code === 0) {
			return { kind: "passed", tree: after };
		}
		if (after === current) {
			return { kind: "failed", failure: "exit", tree: after, code: last.code, output: last.output };
		}
		current = after;
	}
	return { kind: "failed", failure: "unsettled", tree: current, code: last.code, output: last.output };
}
