import type { Stats } from "node:fs";
import {
	closeSync,
	constants,
	copyFileSync,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmdirSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ErrorNotOnBranch } from "./errors.ts";
import { gitOk, gitText, type Oid, type Repo, splitNul } from "./git.ts";
import { type TreeSide, treeDiffRaw } from "./objects.ts";
import { branchCurrent } from "./stack.ts";

// How far an apply got; recorded in the intent file at every transition so a crash can be classified exactly.
export type Phase = "locking" | "locked" | "worktree-updated" | "ref-moved";

export type Intent = { readonly branch: string; readonly oldTip: Oid; readonly newTip: Oid; readonly pid: number; readonly time: string; readonly phase: Phase };

export type PublishResult =
	| { readonly kind: "published" }
	// Nothing changed; the reason names what was in the way.
	| { readonly kind: "refused"; readonly reason: string }
	| { readonly kind: "locked"; readonly lockPath: string; readonly ageSeconds: number }
	// The branch moved or HEAD switched meanwhile; the worktree was put back. `unreverted` lists files another process also changed, which keep that process's version.
	| { readonly kind: "moved"; readonly reason: string; readonly unreverted: readonly string[] }
	// Another apply on this repository is running right now.
	| { readonly kind: "busy" }
	// An apply stopped partway: the worktree, index, or branch may be inconsistent. Recovery steps are in docs/recovery.md.
	| { readonly kind: "interrupted"; readonly intentPath: string; readonly intent: Intent; readonly reason: string };

const IN_PROGRESS = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "sequencer"];

// Applies running in this process, by git dir: their intent files are live, not interrupted.
const inFlight = new Set<string>();

export function intentPath(repo: Repo): string {
	return join(repo.gitDir, "suonetar", "intent.json");
}

function privateIndexPath(repo: Repo): string {
	return join(repo.gitDir, "suonetar", "index.private");
}

function intentParse(text: string): Intent {
	const value = JSON.parse(text) as Record<string, unknown>;
	const phases: readonly string[] = ["locking", "locked", "worktree-updated", "ref-moved"];
	if (
		typeof value.branch !== "string" ||
		typeof value.oldTip !== "string" ||
		typeof value.newTip !== "string" ||
		typeof value.pid !== "number" ||
		!phases.includes(String(value.phase))
	) {
		throw new Error(`malformed Suonetar intent file: ${text}`);
	}
	return value as unknown as Intent;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ESRCH") {
			return false;
		}
		if ((err as NodeJS.ErrnoException).code === "EPERM") {
			return true;
		}
		throw err;
	}
}

// Classifies a leftover intent file. Only an apply that never got the lock can be cleared automatically; anything later may have touched the worktree, index, or branch.
export function intentCheck(repo: Repo): Extract<PublishResult, { kind: "busy" | "interrupted" }> | undefined {
	const path = intentPath(repo);
	if (!existsSync(path)) {
		return undefined;
	}
	const intent = intentParse(readFileSync(path, "utf8"));
	if (inFlight.has(repo.gitDir) || (intent.pid !== process.pid && pidAlive(intent.pid))) {
		return { kind: "busy" };
	}
	if (intent.phase === "locking" && !existsSync(join(repo.gitDir, "index.lock"))) {
		rmSync(path);
		rmSync(privateIndexPath(repo), { force: true });
		return undefined;
	}
	return { kind: "interrupted", intentPath: path, intent, reason: `a previous apply stopped in phase '${intent.phase}'` };
}

async function branchOrDetached(repo: Repo): Promise<string> {
	try {
		return await branchCurrent(repo);
	} catch (err) {
		if (err instanceof ErrorNotOnBranch) {
			return "a detached HEAD";
		}
		throw err;
	}
}

async function refOid(repo: Repo, ref: string): Promise<Oid> {
	return gitText(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

// HEAD still on the branch, and the branch still at oldTip.
async function positionCheck(repo: Repo, branch: string, oldTip: Oid): Promise<string | undefined> {
	const head = await branchOrDetached(repo);
	if (head !== branch) {
		return `HEAD switched to ${head}`;
	}
	const tip = await refOid(repo, branch);
	return tip === oldTip ? undefined : `${branch} moved to ${tip.slice(0, 12)}`;
}

// Everything that can be checked without the lock; done first so the lock is held as briefly as possible.
async function preflight(repo: Repo, branch: string, oldTip: Oid, newTip: Oid): Promise<PublishResult | undefined> {
	const moved = await positionCheck(repo, branch, oldTip);
	if (moved) {
		return { kind: "moved", reason: moved, unreverted: [] };
	}
	const markerPaths = (await gitText(repo, ["rev-parse", "--path-format=absolute", ...IN_PROGRESS.flatMap((m) => ["--git-path", m])])).split("\n");
	const present = markerPaths.findIndex((path) => existsSync(path));
	if (present >= 0) {
		return { kind: "refused", reason: `a git operation is in progress (${IN_PROGRESS[present]} exists); finish or abort it first` };
	}
	const here = realpathSync(repo.worktree);
	let worktreePath = "";
	for (const line of splitNul(await gitOk(repo, ["worktree", "list", "--porcelain", "-z"]))) {
		if (line.startsWith("worktree ")) {
			worktreePath = line.slice("worktree ".length);
		} else if (line === `branch ${branch}` && existsSync(worktreePath) && realpathSync(worktreePath) !== here) {
			return { kind: "refused", reason: `${branch} is also checked out in ${worktreePath}` };
		}
	}
	const inTheWay = await ignoredInTheWay(repo, oldTip, newTip);
	if (inTheWay.length > 0) {
		return { kind: "refused", reason: `ignored files would be overwritten: ${inTheWay.join(", ")}` };
	}
	return undefined;
}

// Ignored files, directories, or symlinks standing where the update writes a file (or where a directory it needs must go): read-tree would silently remove them.
async function ignoredInTheWay(repo: Repo, oldTip: Oid, newTip: Oid): Promise<string[]> {
	const added = splitNul(await gitOk(repo, ["diff-tree", "-r", "-z", "--no-renames", "--diff-filter=A", "--name-only", oldTip, newTip]));
	const candidates = new Set<string>();
	for (const path of added) {
		const parts = path.split("/");
		for (let i = 1; i <= parts.length; i++) {
			const prefix = parts.slice(0, i).join("/");
			const stat = lstatMaybe(join(repo.worktree, prefix));
			if (stat === undefined) {
				break;
			}
			if (i === parts.length || !stat.isDirectory()) {
				candidates.add(prefix);
			}
		}
	}
	if (candidates.size === 0) {
		return [];
	}
	return splitNul(await gitOk(repo, ["ls-files", "-z", "-o", "-i", "--exclude-standard", "--", ...[...candidates].map((p) => `:(literal)${p}`)]));
}

function lstatMaybe(path: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			return undefined;
		}
		throw err;
	}
}

class LockHeld {
	readonly path: string;
	readonly fd: number;
	readonly ino: number;
	readonly dev: number;
	#closed = false;

	constructor(path: string, fd: number) {
		this.path = path;
		this.fd = fd;
		const stat = fstatSync(fd);
		this.ino = stat.ino;
		this.dev = stat.dev;
	}

	// True while the lock file on disk is still the one we created: git's own error text invites people to delete stale locks by hand. The fd stays open until we are done, so the inode cannot be reused meanwhile.
	stillOurs(): boolean {
		const stat = lstatMaybe(this.path);
		return stat !== undefined && stat.ino === this.ino && stat.dev === this.dev;
	}

	// Installs `content` as the new index through git's lockfile protocol: write the lock, rename it over the index.
	install(content: Buffer, indexPath: string): void {
		writeFileSync(this.fd, content);
		renameSync(this.path, indexPath);
		this.close();
	}

	release(): void {
		if (this.stillOurs()) {
			unlinkSync(this.path);
		}
		this.close();
	}

	close(): void {
		if (!this.#closed) {
			this.#closed = true;
			closeSync(this.fd);
		}
	}
}

// Moves the checked-out branch from oldTip to newTip and brings the main worktree and index along, under git's own index lock (research §3.2).
export async function publish(repo: Repo, branch: string, oldTip: Oid, newTip: Oid, reflogMessage: string): Promise<PublishResult> {
	const pending = intentCheck(repo);
	if (pending) {
		return pending;
	}
	const blocked = await preflight(repo, branch, oldTip, newTip);
	if (blocked) {
		return blocked;
	}
	inFlight.add(repo.gitDir);
	try {
		return await publishLocked(repo, branch, oldTip, newTip, reflogMessage);
	} finally {
		inFlight.delete(repo.gitDir);
	}
}

async function publishLocked(repo: Repo, branch: string, oldTip: Oid, newTip: Oid, reflogMessage: string): Promise<PublishResult> {
	mkdirSync(join(repo.gitDir, "suonetar"), { recursive: true });
	const intentFile = intentPath(repo);
	const privateIndex = privateIndexPath(repo);
	const env = { GIT_INDEX_FILE: privateIndex };
	let intent: Intent = { branch, oldTip, newTip, pid: process.pid, time: new Date().toISOString(), phase: "locking" };
	writeFileSync(intentFile, JSON.stringify(intent, null, "\t"), { flag: "wx" });
	const phaseSet = (phase: Phase) => {
		intent = { ...intent, phase };
		writeFileSync(intentFile, JSON.stringify(intent, null, "\t"));
	};

	const lockPath = join(repo.gitDir, "index.lock");
	let lock: LockHeld;
	try {
		lock = new LockHeld(lockPath, openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o666));
	} catch (err) {
		rmSync(intentFile);
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			return { kind: "locked", lockPath, ageSeconds: lockAge(lockPath) };
		}
		throw err;
	}
	phaseSet("locked");

	const cleanUp = () => {
		lock.release();
		rmSync(privateIndex, { force: true });
		rmSync(intentFile);
	};
	const interrupted = (reason: string): PublishResult => {
		lock.close();
		return { kind: "interrupted", intentPath: intentFile, intent, reason };
	};
	// Undoes the worktree update. Files another process also changed keep its version and are reported; a failure to revert leaves everything in place for recovery.
	const backOut = async (result: (unreverted: string[]) => PublishResult, indexUpdated = true): Promise<PublishResult> => {
		let unreverted: string[];
		try {
			unreverted = await revertWorktree(repo, oldTip, newTip, env, indexUpdated);
		} catch (err) {
			return interrupted(`the worktree could not be put back: ${(err as Error).message}`);
		}
		cleanUp();
		return result(unreverted);
	};

	try {
		// Nothing that writes the index can run now, but ref-only commands (`reset --soft`, `switch -c`) still can.
		const movedEarly = await positionCheck(repo, branch, oldTip);
		if (movedEarly || !lock.stillOurs()) {
			cleanUp();
			return { kind: "moved", reason: movedEarly ?? "another process took over index.lock", unreverted: [] };
		}
		copyFileSync(join(repo.gitDir, "index"), privateIndex);
		await gitOk(repo, ["update-index", "-q", "--refresh"], { env });

		phaseSet("worktree-updated");
		const update = await repo.run(["read-tree", "-m", "-u", oldTip, newTip], { cwd: repo.worktree, env });
		if (update.code !== 0) {
			// read-tree checks before writing, but I/O errors (permissions, disk full) can stop it after some files were written.
			return backOut((unreverted) => ({ kind: "refused", reason: `the main worktree could not be updated: ${update.stderr.trim()}${unrevertedNote(unreverted)}` }), false);
		}

		const movedLate = await positionCheck(repo, branch, oldTip);
		if (movedLate || !lock.stillOurs()) {
			const reason = movedLate ?? "another process took over index.lock";
			return backOut((unreverted) => ({ kind: "moved", reason, unreverted }));
		}
		const transaction = `start\nupdate ${branch} ${newTip} ${oldTip}\nprepare\ncommit\n`;
		const moved = await repo.run(["update-ref", "--create-reflog", "-m", reflogMessage, "--stdin"], { cwd: repo.worktree, input: transaction });
		if (moved.code !== 0) {
			const actual = await refOid(repo, branch);
			return backOut((unreverted) => ({ kind: "moved", reason: `${branch} moved to ${actual.slice(0, 12)}`, unreverted }));
		}
		phaseSet("ref-moved");

		// `git switch -c` does not need the index lock: if HEAD switched branches during the transaction, the moved branch is not what the worktree shows.
		const head = await branchOrDetached(repo);
		if (head !== branch) {
			const back = await repo.run(["update-ref", "-m", `${reflogMessage} (rolled back)`, branch, oldTip, newTip], { cwd: repo.worktree });
			if (back.code !== 0) {
				return interrupted(`HEAD switched to ${head} and ${branch} could not be rolled back: ${back.stderr.trim()}`);
			}
			phaseSet("worktree-updated");
			return backOut((unreverted) => ({ kind: "moved", reason: `HEAD switched to ${head}`, unreverted }));
		}
		if (!lock.stillOurs()) {
			return interrupted("index.lock was removed by another process before the new index could be installed");
		}
		lock.install(readFileSync(privateIndex), join(repo.gitDir, "index"));
		rmSync(privateIndex);
		rmSync(intentFile);
		return { kind: "published" };
	} catch (err) {
		if (intent.phase === "locked") {
			cleanUp();
			throw err;
		}
		if (intent.phase === "worktree-updated") {
			const result = await backOut(() => ({ kind: "refused", reason: "" }));
			if (result.kind === "interrupted") {
				return { ...result, reason: `${(err as Error).message}; then ${result.reason}` };
			}
			throw err;
		}
		return interrupted(`failed after the branch moved: ${(err as Error).message}`);
	}
}

function unrevertedNote(unreverted: readonly string[]): string {
	return unreverted.length === 0 ? "" : `; these files were also changed by another process and keep its version: ${unreverted.join(", ")}`;
}

function lockAge(path: string): number {
	const stat = lstatMaybe(path);
	return stat === undefined ? 0 : (Date.now() - stat.mtimeMs) / 1000;
}

// Puts the worktree back to oldTip after it was (perhaps partly) moved to newTip. Only files that still hold exactly newTip's version are touched; anything else was changed by another process and is left alone and returned.
// `indexUpdated` says whether the private index reached newTip; after a failed forward update it did not, and only the per-file path can tell which files were written.
async function revertWorktree(repo: Repo, oldTip: Oid, newTip: Oid, env: Record<string, string>, indexUpdated: boolean): Promise<string[]> {
	if (indexUpdated) {
		const whole = await repo.run(["read-tree", "-m", "-u", newTip, oldTip], { cwd: repo.worktree, env });
		if (whole.code === 0) {
			return [];
		}
	}
	const changes = await treeDiffRaw(repo, oldTip, newTip);
	const unreverted: string[] = [];
	const removals: string[] = [];
	const restores: { path: string; side: { mode: string; oid: Oid } }[] = [];
	for (const change of changes) {
		const disk = await diskSide(repo, change.path);
		if (sameSide(disk, change.old)) {
			continue;
		}
		if (!sameSide(disk, change.new)) {
			unreverted.push(change.path);
			continue;
		}
		if (change.old === undefined) {
			removals.push(change.path);
		} else {
			restores.push({ path: change.path, side: change.old });
		}
	}
	// Deepest first, so a file that replaced a directory (or the reverse) is out of the way before its old occupant returns.
	for (const path of removals.sort((a, b) => b.split("/").length - a.split("/").length)) {
		unlinkSync(join(repo.worktree, path));
		directoriesPrune(repo.worktree, dirname(path));
	}
	if (restores.length > 0) {
		const lines = restores.map((r) => `${r.side.mode} ${r.side.oid}\t${r.path}`);
		await gitOk(repo, ["update-index", "-z", "--index-info"], { input: `${lines.join("\0")}\0`, env });
		await gitOk(repo, ["checkout-index", "-f", "-q", "-z", "--stdin"], { input: `${restores.map((r) => r.path).join("\0")}\0`, env });
	}
	return unreverted;
}

// A directory on disk matches no tree entry of a file path.
function sameSide(a: TreeSide | "directory", b: TreeSide): boolean {
	if (a === "directory") {
		return false;
	}
	return a === undefined ? b === undefined : b !== undefined && a.oid === b.oid && a.mode === b.mode;
}

// What the file at `path` would be as a tree entry, or undefined when there is none (absent, or a directory stands there).
async function diskSide(repo: Repo, path: string): Promise<TreeSide | "directory"> {
	const full = join(repo.worktree, path);
	const stat = lstatMaybe(full);
	if (stat === undefined) {
		return undefined;
	}
	if (stat.isDirectory()) {
		return "directory";
	}
	if (stat.isSymbolicLink()) {
		return { mode: "120000", oid: await gitText(repo, ["hash-object", "--stdin"], { input: readlinkSync(full) }) };
	}
	const mode = (stat.mode & 0o111) !== 0 ? "100755" : "100644";
	return { mode, oid: await gitText(repo, ["hash-object", `--path=${path}`, "--", full]) };
}

function directoriesPrune(root: string, dir: string): void {
	let current = dir;
	while (current !== "." && current !== "" && current !== "/") {
		const full = join(root, current);
		if (!existsSync(full) || readdirSync(full).length > 0) {
			return;
		}
		rmdirSync(full);
		current = dirname(current);
	}
}
