import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type GitRunner, gitRunnerSpawn, hookRunnerSpawn, type Repo, repoOpen } from "../git.ts";

export type Fixture = {
	readonly dir: string;
	readonly repo: Repo;
	// Files the engine reads from outside the repository, by absolute path; empty unless a test fills it, so nothing on the test machine leaks in.
	readonly outside: Map<string, string | Buffer>;
	// Synchronous git in the fixture, as a user or Claude Code would run it. Throws on failure.
	git(...args: string[]): string;
	// Like git(), but returns the exit code and output instead of throwing.
	gitTry(...args: string[]): { code: number; out: string };
	write(path: string, content: string): void;
	// Stages a symlink in the index only, so tests about symlinks in trees run where the filesystem cannot make one.
	symlinkStage(path: string, target: string): void;
	commit(message: string, files: Readonly<Record<string, string | null>>): string;
	cleanup(): Promise<void>;
};

let clock = 1_700_000_000;

// Whether this process can create symlinks: Windows needs Developer Mode or elevation.
export const symlinksWork = (() => {
	const dir = mkdtempSync(join(tmpdir(), "suonetar-symlink-probe-"));
	try {
		symlinkSync("target", join(dir, "link"));
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EPERM") {
			throw err;
		}
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
})();

// A path as a POSIX shell (Git for Windows' sh included) can take it inside a script.
export function shPath(path: string): string {
	return path.replaceAll("\\", "/");
}

// A shell command running a Node process that writes its pid to `pidFile` and idles for 30s. Under Git for Windows' sh, `$!` and `$$` are MSYS pids, which Node cannot signal.
export function shSleeper(pidFile: string): string {
	return `"${shPath(process.execPath)}" -e "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 30000)" "${shPath(pidFile)}"`;
}

// Windows refuses to delete a directory that is still some process's cwd, and a closed cat-file (or a killed hook) takes a moment to exit. The retries must not block: cat-file only sees its stdin close once the event loop runs.
export async function dirRemove(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true, maxRetries: 60, retryDelay: 50 });
}

function envIsolated(home: string): Record<string, string> {
	return { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: home, XDG_CONFIG_HOME: home };
}

// A plain user environment, as Claude Code's git would see it: fixed identity and dates, isolated config, nothing engine-specific.
function envUser(home: string): Record<string, string> {
	clock += 60;
	const date = `${clock} +0000`;
	return {
		...process.env,
		...envIsolated(home),
		LANG: "C",
		LC_ALL: "C",
		GIT_AUTHOR_NAME: "Author",
		GIT_AUTHOR_EMAIL: "author@example.com",
		GIT_AUTHOR_DATE: date,
		GIT_COMMITTER_NAME: "Committer",
		GIT_COMMITTER_EMAIL: "committer@example.com",
		GIT_COMMITTER_DATE: date,
	};
}

function outsideRead(outside: ReadonlyMap<string, string | Buffer>, path: string): Buffer | undefined {
	const contents = outside.get(path);
	return typeof contents === "string" ? Buffer.from(contents) : contents;
}

export async function repoFixture(): Promise<Fixture> {
	// Canonical, as git reports it: no 8.3 short names (a CI runner's temp directory) or symlinked prefixes.
	const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "suonetar-test-")));
	const outside = new Map<string, string | Buffer>();
	const gitSync = (args: string[], input?: string) =>
		execFileSync("git", args, { cwd: dir, env: envUser(dir), encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] }).replace(/\n$/, "");
	gitSync(["init", "-q", "-b", "main"]);
	// Git for Windows' init assumes no symlinks; where they work, check them out as such, as on other platforms.
	if (process.platform === "win32" && symlinksWork) {
		gitSync(["config", "core.symlinks", "true"]);
	}
	gitSync(["config", "user.name", "Committer"]);
	gitSync(["config", "user.email", "committer@example.com"]);
	const fixture: Fixture = {
		dir,
		// The engine's runner sees the same isolated config as the fixture's own git calls.
		repo: await repoOpen(runnerIsolated(dir), hookRunnerSpawn(), async (path) => outsideRead(outside, path), dir, envIsolated(dir)),
		outside,
		git: (...args) => gitSync(args),
		gitTry: (...args) => {
			try {
				return { code: 0, out: gitSync(args) };
			} catch (err) {
				const e = err as { status?: number; stdout?: string; stderr?: string };
				return { code: e.status ?? 128, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
			}
		},
		write: (path, content) => {
			mkdirSync(dirname(join(dir, path)), { recursive: true });
			writeFileSync(join(dir, path), content);
		},
		symlinkStage: (path, target) => {
			const oid = gitSync(["hash-object", "-w", "--stdin"], target);
			gitSync(["update-index", "--add", "--cacheinfo", `120000,${oid},${path}`]);
		},
		commit: (message, files) => {
			for (const [path, content] of Object.entries(files)) {
				if (content === null) {
					gitSync(["rm", "-q", "--", path]);
				} else {
					fixture.write(path, content);
					gitSync(["add", "--", path]);
				}
			}
			gitSync(["commit", "-q", "--allow-empty", "-m", message]);
			return gitSync(["rev-parse", "HEAD"]);
		},
		cleanup: () => dirRemove(dir),
	};
	return fixture;
}

// The production runner, but with global and system config excluded so the developer's own git config cannot leak into tests.
function runnerIsolated(home: string): GitRunner {
	const real = gitRunnerSpawn();
	return (args, opts) => real(args, { ...opts, env: { ...envIsolated(home), ...opts.env } });
}

// A tree of `count` files, each in its own directory with a 100-character name, so that 400 of them overflow a Windows command line (32K characters).
export async function treeWide(fx: Fixture, count: number): Promise<{ tree: string; directories: string[] }> {
	const directories = Array.from({ length: count }, (_, i) => `${"d".repeat(100)}-${i}`);
	const env = { GIT_INDEX_FILE: join(fx.dir, ".git", "wide-index") };
	const blob = (await fx.repo.run(["hash-object", "-w", "--stdin"], { cwd: fx.dir, input: "x\n" })).stdout.toString().trim();
	const listed = await fx.repo.run(["update-index", "--add", "--index-info"], { cwd: fx.dir, env, input: directories.map((d) => `100644 ${blob}\t${d}/f.txt\n`).join("") });
	if (listed.code !== 0) {
		throw new Error(listed.stderr);
	}
	return { tree: (await fx.repo.run(["write-tree"], { cwd: fx.dir, env })).stdout.toString().trim(), directories };
}

// Ten lines, so edits to different lines merge cleanly.
export function lines(tag: string, count = 10): string {
	return `${Array.from({ length: count }, (_, i) => `${tag} line ${i + 1}`).join("\n")}\n`;
}

export function lineSet(text: string, lineNumber: number, content: string): string {
	const all = text.split("\n");
	all[lineNumber - 1] = content;
	return all.join("\n");
}
