import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { delimiter, join, posix } from "node:path";
import { ErrorGit, ErrorNotRepository } from "./errors.ts";
import { reportOnce } from "./report.ts";

export type Oid = string;

export type GitResult = { readonly stdout: Buffer; readonly stderr: string; readonly code: number };

export type GitCallOptions = {
	readonly cwd: string;
	readonly input?: string | Buffer;
	readonly env?: Readonly<Record<string, string>>;
};

export type GitRunner = (args: readonly string[], opts: GitCallOptions) => Promise<GitResult>;

// A hook's exit code and its whole transcript (stdout and stderr interleaved as they arrived); `code` is null when a signal ended it.
export type HookResult = { readonly code: number | null; readonly output: string };

// Runs `git <args>` for a hook or a tool, in the user's own environment rather than the engine's fixed one. With `group: "kill"` (hooks), the whole process group is killed on abort and cleaned up after exit; with `"leave"` (a merge tool, which may start an IDE the user keeps working in), abort only stops git itself and nothing it started is killed.
// On Windows there are no process groups: an abort kills the process tree at once, with no grace period, and nothing the hook left running after it exited can be found to kill. A "leave" abort stops nothing there, since killing the `git` launcher would not stop the git it started; the run just stops waiting.
export type HookRunner = (
	args: readonly string[],
	opts: { readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly signal: AbortSignal; readonly group: "kill" | "leave" },
) => Promise<HookResult>;

// Reads a file outside the repository (an `.editorconfig` above the worktree); undefined when there is none to read.
export type FileReader = (path: string) => Promise<Buffer | undefined>;

export type Repo = {
	readonly run: GitRunner;
	readonly runHook: HookRunner;
	readonly readOutside: FileReader;
	readonly worktree: string;
	readonly gitDir: string;
	readonly commonDir: string;
	// Extra environment for processes the engine spawns outside the runner (the cat-file reader); tests use it to isolate config.
	readonly envExtra: Readonly<Record<string, string>>;
};

const WINDOWS = process.platform === "win32";

// Stable stderr for parsing, and no optional index-lock-taking refreshes behind the other process's back.
const ENV_FIXED = { LANG: "C", LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } as const;

// Inherited from a parent git process (a hook, say), these would silently redirect every command to some other repository or index.
const ENV_STRIPPED = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX"];

// What an AppImage's launcher sets for the app alone. Passed on, git, hooks and merge tools would run with the libraries and data bundled into Suonetar's AppImage.
const ENV_APPIMAGE = ["APPDIR", "APPIMAGE", "ARGV0", "OWD"];
const ENV_APPIMAGE_LISTS = ["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS", "GSETTINGS_SCHEMA_DIR"];

// The parent's environment for a child process: without what would redirect git to another repository, and, under an AppImage, without what its launcher added.
export function envInherited(parent: Readonly<Record<string, string | undefined>>): Record<string, string> {
	const appDir = parent.APPIMAGE !== undefined && parent.APPDIR !== undefined && parent.APPDIR !== "" ? parent.APPDIR : undefined;
	const inside = (value: string) => appDir !== undefined && (value === appDir || value.startsWith(`${appDir}/`));
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(parent)) {
		if (value === undefined || ENV_STRIPPED.includes(key)) {
			continue;
		}
		if (appDir !== undefined) {
			if (ENV_APPIMAGE.includes(key)) {
				continue;
			}
			if (ENV_APPIMAGE_LISTS.includes(key)) {
				// AppImages exist only on Linux, so these lists are colon-separated whatever platform reads them.
				const kept = value.split(posix.delimiter).filter((entry) => !inside(entry));
				if (kept.length > 0) {
					env[key] = kept.join(posix.delimiter);
				}
				continue;
			}
		}
		env[key] = value;
	}
	return env;
}

export function envGit(extra: Readonly<Record<string, string>> | undefined): Record<string, string> {
	return { ...envInherited(process.env), ...ENV_FIXED, ...extra };
}

export function gitRunnerSpawn(): GitRunner {
	return (args, opts) =>
		new Promise((resolve, reject) => {
			const hasInput = opts.input !== undefined;
			const child = spawn("git", args, { cwd: opts.cwd, env: envGit(opts.env), stdio: [hasInput ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true });
			const out: Buffer[] = [];
			const err: Buffer[] = [];
			let stdinError = "";
			child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
			child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
			child.on("error", reject);
			child.on("close", (code, signal) => {
				const stderr = Buffer.concat(err).toString("utf8") + stdinError + (signal ? `\n(killed by ${signal})` : "");
				resolve({ stdout: Buffer.concat(out), stderr, code: code ?? 128 });
			});
			if (child.stdin) {
				// A process that exits before reading all its input makes the write fail; the exit code is what reports the failure, and the write error is kept in stderr.
				child.stdin.on("error", (e) => {
					stdinError += `\n(writing stdin: ${e.message})`;
				});
				child.stdin.end(opts.input);
			}
		});
}

// The environment a hook sees: the user's, without variables that would redirect git to another repository and without what `npm run` injects (its package's `node_modules/.bin` on PATH would hand the hook Suonetar's own tools).
function envHook(extra: Readonly<Record<string, string>>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(envInherited(process.env))) {
		if (!key.startsWith("npm_") && key !== "INIT_CWD") {
			env[key] = value;
		}
	}
	// Windows names it `Path`, and a plain copy of process.env loses its case-insensitive lookup.
	const pathKey = WINDOWS ? Object.keys(env).find((key) => key.toUpperCase() === "PATH") : "PATH";
	const path = pathKey === undefined ? undefined : env[pathKey];
	if (pathKey !== undefined && path !== undefined) {
		env[pathKey] = path
			.split(delimiter)
			.filter((dir) => !/[/\\]node_modules[/\\]\.bin$/.test(dir) && !/[/\\]node-gyp-bin$/.test(dir))
			.join(delimiter);
	}
	// npx without a terminal assumes --yes and downloads whatever is missing; in a checkout without node_modules it must fail instead.
	return { ...env, npm_config_yes: "false", ...extra };
}

// How long a hook's output pipes may stay open after it exits (a background child still holding them) before the group is killed.
const HOOK_DRAIN_MS = 200;
// After a cancel, how long the hook's process group gets to clean up after SIGTERM before SIGKILL.
const HOOK_KILL_GRACE_MS = 2000;
const HOOK_OUTPUT_LIMIT = 64 * 1024;

// Signals a process group; false once the group no longer exists. A failure to signal is not an error the caller can act on, so it is returned as text for the transcript.
function groupSignal(pid: number, signal: NodeJS.Signals | 0): { alive: boolean; problem: string | undefined } {
	try {
		process.kill(-pid, signal);
		return { alive: true, problem: undefined };
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		return code === "ESRCH" ? { alive: false, problem: undefined } : { alive: true, problem: `signalling the hook's processes failed: ${(err as Error).message}` };
	}
}

// Kills a process and everything it started, as far as Windows still links them to it. Reports through `problem`, which may come after the run has settled.
function treeKill(pid: number, problem: (text: string, err: unknown) => void): void {
	const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
		stdio: ["ignore", "ignore", "pipe"],
		windowsHide: true,
	});
	const err: Buffer[] = [];
	killer.stderr.on("data", (chunk: Buffer) => err.push(chunk));
	killer.on("error", (e) => problem(`stopping the hook's processes failed: ${e.message}`, e));
	killer.on("close", (code) => {
		// 128: the process is already gone.
		if (code !== 0 && code !== 128) {
			const text = Buffer.concat(err).toString("utf8").trim();
			problem(`stopping the hook's processes failed: taskkill exited ${code}: ${text}`, text);
		}
	});
}

// The last `limit` bytes of the output, starting at a character boundary.
function outputTail(chunks: readonly Buffer[], limit: number): string {
	const all = Buffer.concat(chunks);
	let start = Math.max(0, all.length - limit);
	while (start < all.length && start > 0 && ((all[start] as number) & 0xc0) === 0x80) {
		start += 1;
	}
	return all.subarray(start).toString("utf8");
}

export function hookRunnerSpawn(): HookRunner {
	return (args, opts) =>
		new Promise((resolve, reject) => {
			if (opts.signal.aborted) {
				resolve({ code: null, output: "" });
				return;
			}
			// Its own process group, so the hook's children (a framework, its interpreter, the formatter) can be killed with it. Not on Windows, where a detached git would give every console program the hook starts a window of its own.
			const child = spawn("git", args, { cwd: opts.cwd, env: envHook(opts.env), stdio: ["ignore", "pipe", "pipe"], detached: !WINDOWS, windowsHide: true });
			let chunks: Buffer[] = [];
			let buffered = 0;
			const problems: string[] = [];
			const collect = (chunk: Buffer) => {
				chunks.push(chunk);
				buffered += chunk.length;
				if (buffered > 2 * HOOK_OUTPUT_LIMIT) {
					const tail = Buffer.from(outputTail(chunks, HOOK_OUTPUT_LIMIT), "utf8");
					chunks = [tail];
					buffered = tail.length;
				}
			};
			child.stdout.on("data", collect);
			child.stderr.on("data", collect);
			const signal = (sig: NodeJS.Signals | 0): boolean => {
				if (child.pid === undefined) {
					return false;
				}
				const result = groupSignal(child.pid, sig);
				if (result.problem !== undefined) {
					problems.push(result.problem);
				}
				return result.alive;
			};
			let abortedAt: number | undefined;
			let settled = false;
			const onAbort = () => {
				abortedAt = Date.now();
				if (opts.group === "kill") {
					if (!WINDOWS) {
						signal("SIGTERM");
					} else if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
						// Only while git runs: Windows reuses process ids quickly.
						const pid = child.pid;
						treeKill(pid, (text, err) => {
							if (settled) {
								reportOnce(`${pid}\0${text}`, text, err);
							} else {
								problems.push(text);
							}
						});
					}
				} else if (WINDOWS) {
					finish();
				} else {
					// A no-op once git has exited, where signalling its pid could reach a reused one.
					child.kill("SIGTERM");
				}
			};
			opts.signal.addEventListener("abort", onAbort, { once: true });
			child.on("error", (err) => {
				opts.signal.removeEventListener("abort", onAbort);
				reject(err);
			});
			let exited = false;
			let code: number | null = null;
			let pipesOpen = 2;
			const finish = () => {
				if (settled) {
					return;
				}
				settled = true;
				opts.signal.removeEventListener("abort", onAbort);
				if (opts.group === "kill") {
					if (!WINDOWS) {
						signal("SIGKILL");
					}
					// Whatever still holds the pipes is neither waited for nor collected from.
					child.stdout.destroy();
					child.stderr.destroy();
				}
				const output = outputTail(chunks, HOOK_OUTPUT_LIMIT) + problems.map((p) => `\n(${p})`).join("");
				resolve({ code, output });
			};
			// Settles on exit rather than on close: a daemon the hook left behind can hold the pipes open indefinitely. After a cancel the group gets its grace period to clean up (lint-staged restores its backup) before SIGKILL.
			const settle = () => {
				if (settled || !exited) {
					return;
				}
				const graceLeft = abortedAt === undefined || opts.group === "leave" || WINDOWS ? 0 : abortedAt + HOOK_KILL_GRACE_MS - Date.now();
				if (graceLeft > 0 && signal(0)) {
					setTimeout(settle, Math.min(100, graceLeft));
					return;
				}
				finish();
			};
			const pipeClosed = () => {
				pipesOpen -= 1;
				if (pipesOpen === 0) {
					settle();
				}
			};
			child.stdout.once("close", pipeClosed);
			child.stderr.once("close", pipeClosed);
			child.on("exit", (exitCode) => {
				exited = true;
				code = exitCode;
				if (pipesOpen === 0) {
					settle();
				} else {
					setTimeout(settle, HOOK_DRAIN_MS);
				}
			});
		});
}

export async function gitOk(repo: Repo, args: readonly string[], opts: { input?: string | Buffer; env?: Readonly<Record<string, string>> } = {}): Promise<Buffer> {
	const result = await repo.run(args, { cwd: repo.worktree, ...opts });
	if (result.code !== 0) {
		throw new ErrorGit(args, result.code, result.stderr);
	}
	return result.stdout;
}

export async function gitText(repo: Repo, args: readonly string[], opts: { input?: string | Buffer; env?: Readonly<Record<string, string>> } = {}): Promise<string> {
	return (await gitOk(repo, args, opts)).toString("utf8").replace(/\n$/, "");
}

// A file that is absent reads as undefined. One that cannot be read (a directory, no permission) is reported and also reads as undefined: a stray file above the repository must not break every document.
export function fileReaderDisk(): FileReader {
	return async (path) => {
		try {
			return await readFile(path);
		} catch (err) {
			const code = err instanceof Error && "code" in err ? String(err.code) : "";
			if (code !== "ENOENT") {
				reportOnce(`${path}\0${code}`, `reading ${path} failed, so it is ignored`, err);
			}
			return undefined;
		}
	};
}

export async function repoOpen(run: GitRunner, runHook: HookRunner, readOutside: FileReader, path: string, envExtra: Readonly<Record<string, string>> = {}): Promise<Repo> {
	const probe = await run(["rev-parse", "--show-toplevel", "--absolute-git-dir", "--path-format=absolute", "--git-common-dir"], { cwd: path });
	if (probe.code !== 0) {
		// Both the "parent directories" and the "mount point" forms; not a broken `.git` file's "not a git repository: <path>", which is a repository the user is in.
		if (/^fatal: not a git repository \(or any /m.test(probe.stderr)) {
			throw new ErrorNotRepository(probe.stderr);
		}
		throw new ErrorGit(["rev-parse"], probe.code, probe.stderr);
	}
	const [worktree, gitDir, commonDir] = probe.stdout.toString("utf8").trim().split("\n");
	if (worktree === undefined || gitDir === undefined || commonDir === undefined) {
		throw new Error(`unexpected rev-parse output: ${probe.stdout.toString("utf8")}`);
	}
	return { run, runHook, readOutside, worktree, gitDir, commonDir, envExtra };
}

// Characters of arguments per command: Windows caps a whole command line at 32K, and the `git` launcher passes it on re-quoted.
const ARG_CHUNK_CHARS = 16_000;

// Splits arguments (paths, for commands that cannot read them from stdin) into runs that fit one command line, in order.
export function argChunks(items: readonly string[]): string[][] {
	const chunks: string[][] = [];
	let current: string[] = [];
	let length = 0;
	for (const item of items) {
		if (current.length > 0 && length + item.length + 1 > ARG_CHUNK_CHARS) {
			chunks.push(current);
			current = [];
			length = 0;
		}
		current.push(item);
		length += item.length + 1;
	}
	if (current.length > 0) {
		chunks.push(current);
	}
	return chunks;
}

// Splits NUL-terminated output, dropping the empty string after the final terminator.
export function splitNul(data: Buffer | string): string[] {
	const text = typeof data === "string" ? data : data.toString("utf8");
	const parts = text.split("\0");
	if (parts.at(-1) === "") {
		parts.pop();
	}
	return parts;
}
