import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type GitRunner, gitRunnerSpawn, type Repo, repoOpen } from "../git.ts";

export type Fixture = {
	readonly dir: string;
	readonly repo: Repo;
	// Synchronous git in the fixture, as a user or Claude Code would run it. Throws on failure.
	git(...args: string[]): string;
	// Like git(), but returns the exit code and output instead of throwing.
	gitTry(...args: string[]): { code: number; out: string };
	write(path: string, content: string): void;
	commit(message: string, files: Readonly<Record<string, string | null>>): string;
	cleanup(): void;
};

let clock = 1_700_000_000;

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

export async function repoFixture(): Promise<Fixture> {
	const dir = mkdtempSync(join(tmpdir(), "suonetar-test-"));
	const gitSync = (args: string[]) => execFileSync("git", args, { cwd: dir, env: envUser(dir), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).replace(/\n$/, "");
	gitSync(["init", "-q", "-b", "main"]);
	gitSync(["config", "user.name", "Committer"]);
	gitSync(["config", "user.email", "committer@example.com"]);
	const fixture: Fixture = {
		dir,
		// The engine's runner sees the same isolated config as the fixture's own git calls.
		repo: await repoOpen(runnerIsolated(dir), dir, envIsolated(dir)),
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
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
	return fixture;
}

// The production runner, but with global and system config excluded so the developer's own git config cannot leak into tests.
function runnerIsolated(home: string): GitRunner {
	const real = gitRunnerSpawn();
	return (args, opts) => real(args, { ...opts, env: { ...envIsolated(home), ...opts.env } });
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
