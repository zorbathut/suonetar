import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join, sep } from "node:path";
import { type Indentation, indentationFor } from "./editorconfig.ts";
import { ErrorGit } from "./errors.ts";
import { type Oid, type Repo, splitNul } from "./git.ts";
import type { CatFile } from "./objects.ts";
import { reportOnce } from "./report.ts";
import type { DocumentFile } from "./session.ts";

// Staged is HEAD to the index; unstaged is the index to the working tree, untracked files included.
export type WorktreeSide = "staged" | "unstaged";

export type WorktreeStatus = {
	readonly staged: number;
	readonly unstaged: number;
	// The index holds unresolved conflicts (a merge or rebase stopped).
	readonly conflicted: boolean;
	// Change whenever that side's contents change, so a view of it knows to refresh.
	readonly stagedPrint: string;
	readonly unstagedPrint: string;
};

// One status record, parsed; `record` is its raw text, which the prints hash.
type Entry = { readonly record: string; readonly path: string } & (
	| { readonly kind: "ordinary"; readonly x: string; readonly y: string; readonly mH: string; readonly mI: string; readonly hH: Oid; readonly hI: Oid }
	| { readonly kind: "unmerged"; readonly m2: string; readonly h2: Oid }
	| { readonly kind: "untracked" }
);

const MODE_NONE = "000000";
// Every untracked file, whatever status.showUntrackedFiles says (a new directory is otherwise one entry), and no submodule contents, which no document shows.
const STATUS_ARGS = ["status", "--porcelain=v2", "-z", "--no-renames", "--untracked-files=all", "--ignore-submodules=all"];

// A record's first `count` space-separated fields, read by position, and the path after them (which may itself hold spaces).
function fields(record: string, count: number): { field: (i: number) => string; path: string } {
	const parts: string[] = [];
	let at = 0;
	for (let i = 0; i < count; i++) {
		const space = record.indexOf(" ", at);
		if (space < 0) {
			throw new Error(`unparseable status record: ${record}`);
		}
		parts.push(record.slice(at, space));
		at = space + 1;
	}
	const field = (i: number): string => {
		const value = parts[i];
		if (value === undefined) {
			throw new Error(`status record has no field ${i}: ${record}`);
		}
		return value;
	};
	return { field, path: record.slice(at) };
}

// `git status` runs with optional locks off (the runner's environment), so it neither takes the index lock nor rewrites the index.
async function statusRead(repo: Repo): Promise<readonly Entry[]> {
	const result = await repo.run(STATUS_ARGS, { cwd: repo.worktree });
	if (result.code !== 0) {
		throw new ErrorGit(STATUS_ARGS, result.code, result.stderr);
	}
	const entries: Entry[] = [];
	for (const record of splitNul(result.stdout)) {
		if (record.startsWith("1 ")) {
			const { field, path } = fields(record, 8);
			const xy = field(1);
			entries.push({ record, kind: "ordinary", path, x: xy.charAt(0), y: xy.charAt(1), mH: field(3), mI: field(4), hH: field(6), hI: field(7) });
		} else if (record.startsWith("u ")) {
			const { field, path } = fields(record, 10);
			entries.push({ record, kind: "unmerged", path, m2: field(4), h2: field(8) });
		} else if (record.startsWith("? ")) {
			// A nested repository shows as its directory; like submodules, it is not shown.
			if (!record.endsWith("/")) {
				entries.push({ record, kind: "untracked", path: record.slice(2) });
			}
		} else {
			throw new Error(`unexpected status record: ${record}`);
		}
	}
	return entries;
}

function pathOrder(entries: readonly Entry[]): Entry[] {
	return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function onSide(entry: Entry, side: WorktreeSide): boolean {
	if (entry.kind === "ordinary") {
		return side === "staged" ? entry.x !== "." : entry.y !== ".";
	}
	return side === "unstaged";
}

function hash(parts: readonly string[]): string {
	return createHash("sha1").update(parts.join("\0")).digest("hex");
}

// The counts, and prints that change with each side's contents: the staged side's status records name its blobs exactly; the unstaged side's do not change when a modified file is edited again, so its files' stats (at most `max`) go into its print.
export async function worktreeStatus(repo: Repo, max: number): Promise<WorktreeStatus> {
	const entries = await statusRead(repo);
	const staged = entries.filter((e) => onSide(e, "staged"));
	const unstaged = entries.filter((e) => onSide(e, "unstaged"));
	const stats: string[] = [];
	// The same files the document shows, so an edit to any shown file changes the print.
	for (const entry of pathOrder(unstaged).slice(0, max)) {
		try {
			const s = await lstat(join(repo.worktree, entry.path), { bigint: true });
			stats.push(`${entry.path}\0${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`);
		} catch (err) {
			stats.push(`${entry.path}\0${err instanceof Error && "code" in err ? String(err.code) : "unreadable"}`);
		}
	}
	return {
		staged: staged.length,
		unstaged: unstaged.length,
		conflicted: entries.some((e) => e.kind === "unmerged"),
		// Only the index side of each record: an unstaged edit to a staged file leaves the staged side as it was.
		stagedPrint: hash(staged.map((e) => (e.kind === "ordinary" ? `${e.x} ${e.mH} ${e.mI} ${e.hH} ${e.hI}\0${e.path}` : e.record))),
		unstagedPrint: hash([...unstaged.map((e) => e.record), ...stats]),
	};
}

// Up to 8000 bytes, as git looks, for a NUL.
const BINARY_SNIFF = 8000;

function binaryLooking(data: Buffer | undefined): boolean {
	return data?.subarray(0, BINARY_SNIFF).includes(0) === true;
}

// Paths the attributes mark as binary (`binary`, `-diff`), as the commit view's numstat treats them.
async function binaryByAttributes(repo: Repo, paths: readonly string[]): Promise<Set<string>> {
	if (paths.length === 0) {
		return new Set();
	}
	const args = ["check-attr", "-z", "--stdin", "diff"];
	const result = await repo.run(args, { cwd: repo.worktree, input: paths.map((p) => `${p}\0`).join("") });
	if (result.code !== 0) {
		throw new ErrorGit(args, result.code, result.stderr);
	}
	const parts = splitNul(result.stdout);
	const binary = new Set<string>();
	for (let i = 0; i + 2 < parts.length; i += 3) {
		const path = parts[i];
		if (path !== undefined && parts[i + 2] === "unset") {
			binary.add(path);
		}
	}
	return binary;
}

type Read = { readonly data: Buffer | undefined; readonly tooLarge: boolean };

const MODE_GITLINK = "160000";

async function blobRead(cat: CatFile, mode: string, oid: Oid, limit: number): Promise<Read> {
	if (mode === MODE_NONE) {
		return { data: undefined, tooLarge: false };
	}
	// A submodule side (a file turned into one, or back) is a commit, not a blob; shown as `git diff` shows it.
	if (mode === MODE_GITLINK) {
		return { data: Buffer.from(`Subproject commit ${oid}\n`), tooLarge: false };
	}
	const data = await cat.readType(oid, "blob");
	return data.length > limit ? { data: undefined, tooLarge: true } : { data, tooLarge: false };
}

// The working tree's version, as git would hash it for a symlink (its target) and absent when it is gone or not a file. A file that cannot be read is reported and shown as absent: the view is only a view.
async function diskRead(repo: Repo, path: string, limit: number): Promise<Read> {
	const full = join(repo.worktree, path);
	try {
		const stat = await lstat(full);
		if (stat.isSymbolicLink()) {
			// Windows writes link targets with backslashes; git records them with slashes.
			return { data: Buffer.from((await readlink(full)).replaceAll(sep, "/")), tooLarge: false };
		}
		if (!stat.isFile()) {
			return { data: undefined, tooLarge: false };
		}
		return stat.size > limit ? { data: undefined, tooLarge: true } : { data: await readFile(full), tooLarge: false };
	} catch (err) {
		const code = err instanceof Error && "code" in err ? String(err.code) : "";
		if (code !== "ENOENT" && code !== "ENOTDIR") {
			reportOnce(`${full}\0${code}`, `reading ${full} failed, so it shows as absent`, err);
		}
		return { data: undefined, tooLarge: false };
	}
}

function statusLetter(letter: string): DocumentFile["status"] {
	return letter === "A" || letter === "D" || letter === "T" ? letter : "M";
}

const INDENTATION_NONE: Indentation = { style: undefined, size: undefined, tabWidth: undefined };

// One side as document files, in path order, at most `max` of them; contents over `limit` bytes are left out as too large.
export async function worktreeFiles(
	repo: Repo,
	cat: CatFile,
	side: WorktreeSide,
	max: number,
	limit: number,
): Promise<{ readonly files: readonly DocumentFile[]; readonly omitted: number; readonly conflicted: boolean }> {
	const entries = await statusRead(repo);
	const listed = pathOrder(entries.filter((e) => onSide(e, side)));
	const shown = listed.slice(0, max);
	// Indentation as HEAD's configs set it; on an unborn branch there are none.
	const head = await repo.run(["rev-parse", "--verify", "--quiet", "HEAD^{tree}"], { cwd: repo.worktree });
	const indentation =
		head.code === 0
			? await indentationFor(
					repo,
					cat,
					head.stdout.toString("utf8").trim(),
					shown.map((e) => e.path),
				)
			: new Map(shown.map((e) => [e.path, INDENTATION_NONE]));
	const binaryMarked = await binaryByAttributes(
		repo,
		shown.map((e) => e.path),
	);
	const files: DocumentFile[] = [];
	for (const entry of shown) {
		let parent: Read;
		let shownVersion: Read;
		let status: DocumentFile["status"];
		if (entry.kind === "ordinary" && side === "staged") {
			parent = await blobRead(cat, entry.mH, entry.hH, limit);
			shownVersion = await blobRead(cat, entry.mI, entry.hI, limit);
			status = statusLetter(entry.x);
		} else if (entry.kind === "ordinary") {
			parent = await blobRead(cat, entry.mI, entry.hI, limit);
			shownVersion = entry.y === "D" ? { data: undefined, tooLarge: false } : await diskRead(repo, entry.path, limit);
			status = statusLetter(entry.y);
		} else if (entry.kind === "unmerged") {
			// Against our side of the conflict: the version the stopped operation is applying changes onto.
			parent = await blobRead(cat, entry.m2, entry.h2, limit);
			shownVersion = await diskRead(repo, entry.path, limit);
			status = "M";
		} else {
			parent = { data: undefined, tooLarge: false };
			shownVersion = await diskRead(repo, entry.path, limit);
			status = "A";
		}
		const tooLarge = parent.tooLarge || shownVersion.tooLarge;
		const fileIndentation = indentation.get(entry.path);
		if (fileIndentation === undefined) {
			throw new Error(`no indentation resolved for ${entry.path}`);
		}
		files.push({
			path: entry.path,
			status,
			binary: binaryMarked.has(entry.path) || binaryLooking(parent.data) || binaryLooking(shownVersion.data),
			refusal: undefined,
			parent: tooLarge ? undefined : parent.data,
			commit: tooLarge ? undefined : shownVersion.data,
			draft: tooLarge ? undefined : shownVersion.data,
			tooLarge,
			indentation: fileIndentation,
		});
	}
	return {
		files,
		omitted: listed.length - shown.length,
		conflicted: entries.some((e) => e.kind === "unmerged"),
	};
}
