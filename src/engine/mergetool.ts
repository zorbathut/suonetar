import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ErrorGit } from "./errors.ts";
import type { Oid, Repo } from "./git.ts";
import type { ConflictStage } from "./merge.ts";
import { reportOnce } from "./report.ts";
import { configGet } from "./stack.ts";

export type MergetoolResult =
	// The tool resolved the file; `content` is its result in repository form.
	| { readonly kind: "merged"; readonly content: Buffer }
	// The tool exited without resolving the file (its exit code, or the file left unchanged).
	| { readonly kind: "unresolved"; readonly output: string }
	| { readonly kind: "cancelled" }
	| { readonly kind: "unconfigured" };

// The user's `merge.tool`; without one `git mergetool` guesses a tool and prompts, so none is offered.
export function mergetoolName(repo: Repo): Promise<string | undefined> {
	return configGet(repo, "merge.tool");
}

// Runs the user's merge tool on one conflicted path, through `git mergetool` so built-in tools, `mergetool.<tool>.cmd`, and `trustExitCode` all behave as configured. It runs against a throwaway index and work tree holding only that path, so nothing the tool leaves behind (or writes after a cancel) can reach a repository's worktree; `content` is what `$MERGED` starts as.
export async function mergetoolRun(
	repo: Repo,
	input: { readonly path: string; readonly stages: readonly ConflictStage[]; readonly attrSource: Oid; readonly content: Buffer },
	signal: AbortSignal,
): Promise<MergetoolResult> {
	if ((await mergetoolName(repo)) === undefined) {
		return { kind: "unconfigured" };
	}
	for (const left of leftBehind) {
		await scratchRemove(left);
	}
	const parent = join(repo.commonDir, "suonetar");
	mkdirSync(parent, { recursive: true });
	const dir = mkdtempSync(join(parent, "mergetool-"));
	try {
		const index = join(dir, "index");
		const worktree = join(dir, "wt");
		const env = { GIT_INDEX_FILE: index };
		const entries = input.stages.map((s) => `${s.mode} ${s.oid} ${s.stage}\t${input.path}\0`).join("");
		const listed = await repo.run(["update-index", "-z", "--index-info"], { cwd: repo.worktree, env, input: entries });
		if (listed.code !== 0) {
			throw new ErrorGit(["update-index", "--index-info"], listed.code, listed.stderr);
		}
		const file = join(worktree, input.path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, input.content);

		// Temporary files outside the work tree and no backup, so a cancelled tool leaves nothing next to the file; no hooks for the `git add` it runs.
		const args = [
			"-c",
			"mergetool.writeToTemp=true",
			"-c",
			"mergetool.keepBackup=false",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"core.longpaths=true",
			"mergetool",
			"--no-prompt",
			"--",
			input.path,
		];
		const ran = await repo.runHook(args, {
			cwd: worktree,
			env: { ...repo.envExtra, GIT_DIR: repo.gitDir, GIT_WORK_TREE: worktree, GIT_INDEX_FILE: index, GIT_ATTR_SOURCE: input.attrSource },
			signal,
			group: "leave",
		});
		if (signal.aborted) {
			return { kind: "cancelled" };
		}
		const unmerged = await repo.run(["ls-files", "-u", "--", input.path], { cwd: repo.worktree, env });
		if (unmerged.code !== 0) {
			throw new ErrorGit(["ls-files", "-u"], unmerged.code, unmerged.stderr);
		}
		if (ran.code !== 0 || unmerged.stdout.length > 0) {
			return { kind: "unresolved", output: ran.output };
		}
		// The staged blob, not the work-tree file: `git add` applied the path's clean filters and line-ending conversion.
		const merged = await repo.run(["cat-file", "blob", `:0:${input.path}`], { cwd: repo.worktree, env });
		if (merged.code !== 0) {
			throw new ErrorGit(["cat-file", "blob", `:0:${input.path}`], merged.code, merged.stderr);
		}
		return { kind: "merged", content: merged.stdout };
	} finally {
		await scratchRemove(dir);
	}
}

// Throwaway directories that could not be removed yet, retried on this process's next run. Only this process's own: on Linux another Suonetar's directory would be removed even while its tool runs in it.
const leftBehind = new Set<string>();

// On Windows a cancelled tool, and the `git mergetool` still waiting on it, keep the directory as their cwd and its files open, and it cannot be removed while they run. Left behind and reported rather than failing the run.
async function scratchRemove(dir: string): Promise<void> {
	try {
		await rm(dir, { recursive: true, force: true, maxRetries: 3 });
		leftBehind.delete(dir);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EACCES") {
			throw err;
		}
		leftBehind.add(dir);
		reportOnce(dir, `${dir} is still in use by the merge tool, so it is removed later`, err);
	}
}
