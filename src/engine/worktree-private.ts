import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { pidAlive } from "./apply.ts";
import { ErrorGit } from "./errors.ts";
import type { GitResult, HookResult, Oid, Repo } from "./git.ts";

// Plumbing in the private worktree must not fire the user's hooks (`post-index-change`, `reference-transaction`), start an fsmonitor daemon for it, or give its HEAD a reflog that would pin every stand-in commit. Config-based hooks are disabled by name on top of this (`quietArgs`).
const QUIET = ["-c", "core.hooksPath=/dev/null", "-c", "core.logAllRefUpdates=false", "-c", "core.fsmonitor=false"];

// A lock file that cannot be parsed is treated as held until it is this old.
const LOCK_UNREADABLE_MS = 60_000;

// So materialising a commit never downloads LFS objects; hooks see pointer files.
const ENV_CHECKOUT = { GIT_LFS_SKIP_SMUDGE: "1" };

// A detached worktree under the git directory, used to present a commit to hooks the way `git commit` would. One process at a time: the pass holds a pid lock file for as long as it uses the worktree.
export class WorktreePrivate {
	readonly #repo: Repo;
	readonly path: string;
	readonly #admin: string;
	readonly #lock: LockHeld;
	readonly #quiet: readonly string[];
	#released = false;

	private constructor(repo: Repo, path: string, admin: string, lock: LockHeld, quiet: readonly string[]) {
		this.#repo = repo;
		this.path = path;
		this.#admin = admin;
		this.#lock = lock;
		this.#quiet = quiet;
	}

	// The worktree, healthy and ours until `release`, or "busy" while another live process holds it. `head` is where a newly created worktree's HEAD starts.
	static async acquire(repo: Repo, head: Oid): Promise<WorktreePrivate | "busy"> {
		const dir = join(repo.commonDir, "suonetar");
		mkdirSync(dir, { recursive: true });
		const lock = lockTake(join(dir, "wt.lock"));
		if (lock === undefined) {
			return "busy";
		}
		try {
			const quiet = await quietArgs(repo);
			const path = join(dir, "wt");
			const admin = (await adminOf(repo, path)) ?? (await create(repo, path, head, quiet));
			// Ours by the lock, so an index.lock here is left over from a git command killed by a cancel.
			rmSync(join(admin, "index.lock"), { force: true });
			return new WorktreePrivate(repo, path, admin, lock, quiet);
		} catch (err) {
			lockRelease(lock);
			throw err;
		}
	}

	get indexPath(): string {
		return join(this.#admin, "index");
	}

	// HEAD at `head`, index and files at `tree`: what `git commit` shows a hook when `tree` is staged on top of `head`.
	async materialise(head: Oid, tree: Oid): Promise<void> {
		await this.#ok(["update-ref", "--no-deref", "HEAD", head]);
		const reset = await this.#run(["read-tree", "--reset", "-u", tree], ENV_CHECKOUT);
		if (reset.code === 0) {
			return;
		}
		// Something a hook left behind (an untracked directory where a file must go) blocks the checkout; the worktree is ours to clear.
		await this.#ok(["clean", "-ffdxq"]);
		await this.#ok(["read-tree", "--reset", "-u", tree], ENV_CHECKOUT);
	}

	// Stages the hook's changes to `paths` on top of whatever it staged itself, and returns the resulting tree.
	async stage(paths: readonly string[]): Promise<Oid> {
		if (paths.length > 0) {
			// On stdin: a commit touching tens of thousands of files would overflow the argument list.
			await this.#ok(["add", "-u", "--pathspec-from-file=-", "--pathspec-file-nul"], {}, `${paths.map((p) => `:(literal)${p}`).join("\0")}\0`);
		}
		return (await this.#ok(["write-tree"])).stdout.toString("utf8").trim();
	}

	// Runs git as the user's hooks see it: their own configuration, plus `config` (`-c` pairs) on top.
	async hookGit(args: readonly string[], config: readonly string[], signal: AbortSignal): Promise<HookResult> {
		return this.#repo.runHook([...config, ...args], {
			cwd: this.path,
			env: { ...this.#repo.envExtra, GIT_INDEX_FILE: this.indexPath, GIT_EDITOR: ":" },
			signal,
			group: "kill",
		});
	}

	// Leaves HEAD on a commit that is already in the branch's history, so the worktree's HEAD (which `git log --all` includes) shows nothing new.
	async park(head: Oid): Promise<void> {
		await this.#ok(["update-ref", "--no-deref", "HEAD", head]);
	}

	release(): void {
		if (!this.#released) {
			this.#released = true;
			lockRelease(this.#lock);
		}
	}

	async #run(args: readonly string[], env: Readonly<Record<string, string>> = {}, input?: string): Promise<GitResult> {
		return this.#repo.run([...this.#quiet, ...args], { cwd: this.path, env, ...(input === undefined ? {} : { input }) });
	}

	async #ok(args: readonly string[], env: Readonly<Record<string, string>> = {}, input?: string): Promise<GitResult> {
		const result = await this.#run(args, env, input);
		if (result.code !== 0) {
			throw new ErrorGit(args, result.code, result.stderr);
		}
		return result;
	}
}

type LockHeld = { readonly path: string; readonly ino: number; readonly dev: number };

function uniqueSuffix(): string {
	return `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
}

// Takes the lock file, holding our pid, or returns undefined while another live process holds it. The file is linked into place already written, so it is never seen empty. A lock left by a process that no longer runs (or by this one, whose passes the session mutex serialises) is taken over.
function lockTake(path: string): LockHeld | undefined {
	for (let attempt = 0; attempt < 3; attempt++) {
		const written = `${path}.${uniqueSuffix()}`;
		writeFileSync(written, String(process.pid));
		try {
			linkSync(written, path);
			const stat = lstatSync(path);
			return { path, ino: stat.ino, dev: stat.dev };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
				throw err;
			}
		} finally {
			rmSync(written, { force: true });
		}
		const seen = fileRead(path);
		if (seen === undefined) {
			continue;
		}
		const pid = Number(seen.text.trim());
		if (!Number.isInteger(pid) || pid <= 0) {
			if (Date.now() - seen.mtimeMs < LOCK_UNREADABLE_MS) {
				return undefined;
			}
		} else if (pid !== process.pid && pidAlive(pid)) {
			return undefined;
		}
		// Stale: move it aside, and if what was moved is not what was judged stale (another process took over first), put that one back.
		const aside = `${path}.stale.${uniqueSuffix()}`;
		try {
			renameSync(path, aside);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				continue;
			}
			throw err;
		}
		const moved = fileRead(aside);
		if (moved !== undefined && moved.text !== seen.text) {
			linkSync(aside, path);
			rmSync(aside, { force: true });
			return undefined;
		}
		rmSync(aside, { force: true });
	}
	return undefined;
}

function fileRead(path: string): { text: string; mtimeMs: number } | undefined {
	try {
		return { text: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw err;
	}
}

// Removes the lock file only if it is still the one we created.
function lockRelease(lock: LockHeld): void {
	try {
		const stat = lstatSync(lock.path);
		if (stat.ino === lock.ino && stat.dev === lock.dev) {
			rmSync(lock.path);
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			throw err;
		}
	}
}

// QUIET plus every hook configured by name (`hook.<name>.event`), which `core.hooksPath` does not reach.
async function quietArgs(repo: Repo): Promise<string[]> {
	const configured = await repo.run(["config", "--get-regexp", "^hook\\..*\\.event$"], { cwd: repo.worktree });
	if (configured.code > 1) {
		throw new ErrorGit(["config", "--get-regexp"], configured.code, configured.stderr);
	}
	const names = configured.stdout
		.toString("utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => line.slice("hook.".length, line.indexOf(" ") - ".event".length));
	return [...QUIET, ...[...new Set(names)].flatMap((name) => ["-c", `hook.${name}.enabled=false`])];
}

// The worktree's admin directory when `path` is a working worktree registered in this repository, else undefined.
async function adminOf(repo: Repo, path: string): Promise<string | undefined> {
	if (!existsSync(join(path, ".git"))) {
		return undefined;
	}
	const probe = await repo.run(["rev-parse", "--absolute-git-dir"], { cwd: path });
	if (probe.code !== 0) {
		return undefined;
	}
	const admin = probe.stdout.toString("utf8").trim();
	if (!existsSync(join(repo.commonDir, "worktrees"))) {
		return undefined;
	}
	const worktrees = realpathSync.native(join(repo.commonDir, "worktrees")) + sep;
	const gitdirFile = join(admin, "gitdir");
	if (!realpathSync.native(admin).startsWith(worktrees) || !existsSync(gitdirFile)) {
		return undefined;
	}
	const pointsAt = readFileSync(gitdirFile, "utf8").trim();
	return existsSync(pointsAt) && realpathSync.native(pointsAt) === realpathSync.native(join(path, ".git")) ? admin : undefined;
}

async function create(repo: Repo, path: string, head: Oid, quiet: readonly string[]): Promise<string> {
	rmSync(path, { recursive: true, force: true });
	const run = async (args: readonly string[]) => {
		const result = await repo.run([...quiet, ...args], { cwd: repo.worktree });
		if (result.code !== 0) {
			throw new ErrorGit(args, result.code, result.stderr);
		}
	};
	// `-f -f` takes over our own registration (locked, its directory gone); nothing else is pruned, since other worktrees whose directories are missing (an unmounted drive) are the user's.
	await run(["worktree", "add", "-f", "-f", "--detach", "--no-checkout", "--lock", "--reason", "suonetar private worktree", path, head]);
	const admin = await adminOf(repo, path);
	if (admin === undefined) {
		throw new Error(`the worktree just created at ${path} is not usable`);
	}
	rmSync(join(admin, "logs", "HEAD"), { force: true });
	return admin;
}
