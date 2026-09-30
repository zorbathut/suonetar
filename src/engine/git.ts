import { spawn } from "node:child_process";
import { ErrorGit } from "./errors.ts";

export type Oid = string;

export type GitResult = { readonly stdout: Buffer; readonly stderr: string; readonly code: number };

export type GitCallOptions = {
	readonly cwd: string;
	readonly input?: string | Buffer;
	readonly env?: Readonly<Record<string, string>>;
};

export type GitRunner = (args: readonly string[], opts: GitCallOptions) => Promise<GitResult>;

export type Repo = {
	readonly run: GitRunner;
	readonly worktree: string;
	readonly gitDir: string;
	readonly commonDir: string;
	// Extra environment for processes the engine spawns outside the runner (the cat-file reader); tests use it to isolate config.
	readonly envExtra: Readonly<Record<string, string>>;
};

// Stable stderr for parsing, and no optional index-lock-taking refreshes behind the other process's back.
const ENV_FIXED = { LANG: "C", LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } as const;

// Inherited from a parent git process (a hook, say), these would silently redirect every command to some other repository or index.
const ENV_STRIPPED = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX"];

export function envGit(extra: Readonly<Record<string, string>> | undefined): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !ENV_STRIPPED.includes(key)) {
			env[key] = value;
		}
	}
	return { ...env, ...ENV_FIXED, ...extra };
}

export function gitRunnerSpawn(): GitRunner {
	return (args, opts) =>
		new Promise((resolve, reject) => {
			const hasInput = opts.input !== undefined;
			const child = spawn("git", args, { cwd: opts.cwd, env: envGit(opts.env), stdio: [hasInput ? "pipe" : "ignore", "pipe", "pipe"] });
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

export async function repoOpen(run: GitRunner, path: string, envExtra: Readonly<Record<string, string>> = {}): Promise<Repo> {
	const probe = await run(["rev-parse", "--show-toplevel", "--absolute-git-dir", "--path-format=absolute", "--git-common-dir"], { cwd: path });
	if (probe.code !== 0) {
		throw new ErrorGit(["rev-parse"], probe.code, probe.stderr);
	}
	const [worktree, gitDir, commonDir] = probe.stdout.toString("utf8").trim().split("\n");
	if (worktree === undefined || gitDir === undefined || commonDir === undefined) {
		throw new Error(`unexpected rev-parse output: ${probe.stdout.toString("utf8")}`);
	}
	return { run, worktree, gitDir, commonDir, envExtra };
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
