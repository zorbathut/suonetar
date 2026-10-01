import { ErrorNoBase, ErrorNotOnBranch } from "./errors.ts";
import { gitText, type Oid, type Repo } from "./git.ts";
import { type CatFile, commitRead, commitSubject } from "./objects.ts";

export type StackCommit = {
	readonly oid: Oid;
	readonly parent: Oid;
	readonly tree: Oid;
	readonly authorLine: string;
	readonly subject: string;
	readonly message: Buffer;
	readonly encoding: string | undefined;
	readonly signed: boolean;
	readonly published: boolean;
};

export type Stack = {
	readonly branch: string;
	readonly tipOid: Oid;
	readonly baseRef: string;
	// The parent of the first stack commit: the merge-base with the base ref, or the merge commit the stack was cut at.
	readonly baseOid: Oid;
	// Oldest first.
	readonly commits: readonly StackCommit[];
	// When set, the stack was cut at this merge commit: it and everything below it are not editable.
	readonly frozenBelow: Oid | undefined;
	// Other local branches containing stack commits: they are not rewritten, so they keep the old versions.
	readonly leftBehind: readonly string[];
	// Changes whenever the branch or its base moves; lets a UI detect that the OIDs it holds are stale.
	readonly generation: string;
};

const BASE_FALLBACKS = ["refs/heads/main", "refs/heads/master", "refs/remotes/origin/main", "refs/remotes/origin/master"];

async function revParse(repo: Repo, rev: string): Promise<Oid | undefined> {
	const result = await repo.run(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { cwd: repo.worktree });
	return result.code === 0 ? result.stdout.toString("utf8").trim() : undefined;
}

export async function configGet(repo: Repo, key: string): Promise<string | undefined> {
	const result = await repo.run(["config", "--get", key], { cwd: repo.worktree });
	if (result.code === 1) {
		return undefined;
	}
	if (result.code !== 0) {
		throw new Error(`git config --get ${key} failed: ${result.stderr}`);
	}
	return result.stdout.toString("utf8").trim();
}

async function isAncestor(repo: Repo, ancestor: Oid, descendant: Oid): Promise<boolean> {
	const result = await repo.run(["merge-base", "--is-ancestor", ancestor, descendant], { cwd: repo.worktree });
	if (result.code > 1) {
		throw new Error(`merge-base --is-ancestor failed: ${result.stderr}`);
	}
	return result.code === 0;
}

export async function branchCurrent(repo: Repo): Promise<string> {
	const result = await repo.run(["symbolic-ref", "-q", "HEAD"], { cwd: repo.worktree });
	if (result.code !== 0) {
		throw new ErrorNotOnBranch();
	}
	return result.stdout.toString("utf8").trim();
}

// The conventional names for the hosting remote, whose default branch can be a base and where a branch's same-named copy is looked for. Any other remote's HEAD (a laptop, a backup repository) may be a feature branch that already contains the tip, which would hide unmerged commits.
const BASE_REMOTES = ["origin", "upstream"];

// The default branch of origin and upstream (`refs/remotes/<remote>/HEAD`, set by clone and fetch) and its local counterpart, then `init.defaultBranch` for repositories without a remote, then main and master.
async function baseCandidates(repo: Repo, branch: string): Promise<string[]> {
	// for-each-ref skips a HEAD left dangling by a pruned default; base detection then falls back rather than failing.
	const heads = await gitText(repo, ["for-each-ref", "--format=%(symref)", ...BASE_REMOTES.map((r) => `refs/remotes/${r}/HEAD`)]);
	const remoteDefaults = heads
		.split("\n")
		.filter((ref) => ref !== "")
		.flatMap((ref) => [ref, ref.replace(/^refs\/remotes\/[^/]+\//, "refs/heads/")]);
	const defaultBranch = await configGet(repo, "init.defaultBranch");
	const configured = defaultBranch === undefined ? [] : [`refs/heads/${defaultBranch}`];
	return [...new Set([...remoteDefaults, ...configured, ...BASE_FALLBACKS])].filter((ref) => ref !== branch);
}

// The branch's own copies on the server: where `git push` sends it, and a same-named branch on the hosting remotes, which `git push origin <name>` without `-u` leaves. Not its upstream as such: a branch cut from `origin/dev` tracks `origin/dev`, a parent rather than its copy, and `push.default=simple` gives no push destination for it.
async function branchCopies(repo: Repo, branch: string): Promise<string[]> {
	// for-each-ref, unlike `rev-parse <branch>@{push}`, takes the full refname and prints nothing rather than failing when there is no destination.
	const push = (await gitText(repo, ["for-each-ref", "--format=%(push)", branch])).trim();
	const name = branch.replace(/^refs\/heads\//, "");
	const pushes = push.startsWith("refs/remotes/") ? [push] : [];
	return [...new Set([...pushes, ...BASE_REMOTES.map((remote) => `refs/remotes/${remote}/${name}`)])];
}

// The base whose merge-base with the tip is newest, competing the branch's own copies on the server, while it has commits they lack, against the default branch's; on a tie the copy wins. So a branch with unpushed work stacks just that work, and a fully pushed one shows everything since it left the default branch. After `git fetch && git rebase origin/main` with a stale local main or a stale copy, origin/main is the right base; on the default branch itself, its remote copy is, so the stack is the unpushed commits.
async function baseFind(repo: Repo, branch: string, tipOid: Oid): Promise<{ ref: string; mergeBase: Oid }> {
	const configured = await configGet(repo, "suonetar.base");
	const candidates =
		configured !== undefined
			? [{ ref: configured, copy: false }]
			: [...(await branchCopies(repo, branch)).map((ref) => ({ ref, copy: true })), ...(await baseCandidates(repo, branch)).map((ref) => ({ ref, copy: false }))];
	let best: { ref: string; mergeBase: Oid } | undefined;
	for (const { ref, copy } of candidates) {
		if ((await revParse(repo, ref)) === undefined) {
			continue;
		}
		const result = await repo.run(["merge-base", ref, tipOid], { cwd: repo.worktree });
		if (result.code !== 0) {
			continue;
		}
		const mergeBase = result.stdout.toString("utf8").trim();
		// A copy that already has every commit of the branch leaves nothing unpushed, so the default branch decides.
		if (copy && mergeBase === tipOid) {
			continue;
		}
		if (best === undefined || (mergeBase !== best.mergeBase && (await isAncestor(repo, best.mergeBase, mergeBase)))) {
			best = { ref, mergeBase };
		}
	}
	if (best === undefined) {
		throw new ErrorNoBase(branch.replace(/^refs\/heads\//, ""));
	}
	return best;
}

export async function stackRead(repo: Repo, cat: CatFile): Promise<Stack> {
	const branch = await branchCurrent(repo);
	const tipOid = await revParse(repo, branch);
	if (tipOid === undefined) {
		throw new ErrorNoBase(branch.replace(/^refs\/heads\//, ""));
	}
	const base = await baseFind(repo, branch, tipOid);

	const rows = (await gitText(repo, ["rev-list", "--first-parent", "--reverse", "--parents", `${base.mergeBase}..${tipOid}`])).split("\n").filter((row) => row !== "");
	let frozenBelow: Oid | undefined;
	let start = 0;
	rows.forEach((row, index) => {
		const [oid, ...parents] = row.split(" ");
		if (oid !== undefined && parents.length > 1) {
			frozenBelow = oid;
			start = index + 1;
		}
	});
	const oids = rows.slice(start).map((row) => row.split(" ")[0] as string);

	const unpublished = new Set((await gitText(repo, ["rev-list", tipOid, "--not", base.mergeBase, "--remotes"])).split("\n"));
	const commits: StackCommit[] = [];
	for (const oid of oids) {
		const info = await commitRead(cat, oid);
		const parent = info.parents[0];
		if (parent === undefined) {
			throw new Error(`stack commit ${oid} has no parent`);
		}
		commits.push({
			oid,
			parent,
			tree: info.tree,
			authorLine: info.authorLine,
			subject: commitSubject(info),
			message: info.message,
			encoding: info.encoding,
			signed: info.signed,
			published: !unpublished.has(oid),
		});
	}
	const baseOid = commits[0]?.parent ?? frozenBelow ?? base.mergeBase;
	const leftBehind = commits[0] === undefined ? [] : await branchesContaining(repo, commits[0].oid, branch);
	return { branch, tipOid, baseRef: base.ref, baseOid, commits, frozenBelow, leftBehind, generation: `${tipOid}:${baseOid}` };
}

async function branchesContaining(repo: Repo, oid: Oid, except: string): Promise<string[]> {
	const listed = await gitText(repo, ["for-each-ref", "--format=%(refname)", "--contains", oid, "refs/heads"]);
	return listed
		.split("\n")
		.filter((ref) => ref !== "" && ref !== except)
		.map((ref) => ref.replace(/^refs\/heads\//, ""));
}
