import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { envGit, gitOk, type Oid, type Repo, splitNul } from "./git.ts";

export type ObjectType = "blob" | "tree" | "commit" | "tag";
export type GitObject = { readonly type: ObjectType; readonly data: Buffer };

type Pending = { readonly oid: string; readonly resolve: (obj: GitObject | undefined) => void; readonly reject: (err: Error) => void };

// One long-lived `git cat-file --batch` per repo: object reads are the scrubbing hot path.
export class CatFile {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #queue: Pending[] = [];
	// Unconsumed output as a list of chunks, concatenated only once a whole object has arrived: large blobs arrive in many chunks.
	#chunks: Buffer[] = [];
	#buffered = 0;
	#failure: Error | undefined;

	constructor(repo: Repo) {
		this.#child = spawn("git", ["cat-file", "--batch"], { cwd: repo.worktree, env: envGit(repo.envExtra) });
		this.#child.stdout.on("data", (chunk: Buffer) => {
			this.#chunks.push(chunk);
			this.#buffered += chunk.length;
			this.#drain();
		});
		const stderr: Buffer[] = [];
		this.#child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		this.#child.on("close", (code) => this.#fail(new Error(`git cat-file --batch exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`)));
		this.#child.on("error", (err) => this.#fail(err));
		this.#child.stdin.on("error", (err) => this.#fail(err));
	}

	// Resolves to undefined when the object does not exist.
	read(oid: string): Promise<GitObject | undefined> {
		if (this.#failure) {
			return Promise.reject(this.#failure);
		}
		if (/[\n\r]/.test(oid)) {
			return Promise.reject(new Error(`object name contains a line break: ${JSON.stringify(oid)}`));
		}
		return new Promise((resolve, reject) => {
			this.#queue.push({ oid, resolve, reject });
			this.#child.stdin.write(`${oid}\n`);
		});
	}

	async readType(oid: string, type: ObjectType): Promise<Buffer> {
		const obj = await this.read(oid);
		if (obj === undefined) {
			throw new Error(`object ${oid} not found`);
		}
		if (obj.type !== type) {
			throw new Error(`object ${oid} is a ${obj.type}, expected ${type}`);
		}
		return obj.data;
	}

	close(): void {
		this.#failure = new Error("CatFile closed");
		for (const pending of this.#queue.splice(0)) {
			pending.reject(this.#failure);
		}
		this.#child.stdin.end();
	}

	#drain(): void {
		for (;;) {
			const pending = this.#queue[0];
			if (pending === undefined || this.#buffered === 0) {
				return;
			}
			const head = this.#headerTake();
			if (head === undefined) {
				return;
			}
			const { header, headerLength } = head;
			if (header.endsWith(" missing") || header.endsWith(" ambiguous")) {
				this.#consume(headerLength);
				this.#queue.shift();
				pending.resolve(undefined);
				continue;
			}
			const [, type, sizeText] = header.split(" ");
			const size = Number(sizeText);
			if (!Number.isInteger(size)) {
				this.#fail(new Error(`unparseable cat-file header: ${header}`));
				return;
			}
			if (this.#buffered < headerLength + size + 1) {
				return;
			}
			const all = this.#consume(headerLength + size + 1);
			this.#queue.shift();
			pending.resolve({ type: type as ObjectType, data: all.subarray(headerLength, headerLength + size) });
		}
	}

	// The header line, if a complete one has arrived; headers are short, so only the first chunks are joined to find it.
	#headerTake(): { header: string; headerLength: number } | undefined {
		let joined = this.#chunks[0] as Buffer;
		let index = 1;
		for (;;) {
			const newline = joined.indexOf(0x0a);
			if (newline >= 0) {
				return { header: joined.subarray(0, newline).toString("utf8"), headerLength: newline + 1 };
			}
			const next = this.#chunks[index++];
			if (next === undefined) {
				return undefined;
			}
			joined = Buffer.concat([joined, next]);
		}
	}

	#consume(length: number): Buffer {
		const all = this.#chunks.length === 1 ? (this.#chunks[0] as Buffer) : Buffer.concat(this.#chunks);
		const taken = Buffer.from(all.subarray(0, length));
		const rest = all.subarray(length);
		this.#chunks = rest.length > 0 ? [rest] : [];
		this.#buffered = rest.length;
		return taken;
	}

	#fail(err: Error): void {
		if (this.#failure) {
			return;
		}
		this.#failure = err;
		for (const pending of this.#queue.splice(0)) {
			pending.reject(err);
		}
	}
}

export type CommitInfo = {
	readonly oid: Oid;
	readonly tree: Oid;
	readonly parents: readonly Oid[];
	// Verbatim `Name <email> timestamp tz`: preserved on rewrite and used as the commit's identity across external rewrites.
	readonly authorLine: string;
	readonly committerLine: string;
	readonly encoding: string | undefined;
	readonly signed: boolean;
	readonly message: Buffer;
};

export function commitParse(oid: Oid, data: Buffer): CommitInfo {
	const split = data.indexOf("\n\n");
	// Latin-1 maps every byte to one character, so header lines round-trip byte for byte whatever their encoding.
	const headerText = (split < 0 ? data : data.subarray(0, split)).toString("latin1");
	const message = split < 0 ? Buffer.alloc(0) : Buffer.from(data.subarray(split + 2));
	let tree: string | undefined;
	const parents: string[] = [];
	let authorLine: string | undefined;
	let committerLine: string | undefined;
	let encoding: string | undefined;
	let signed = false;
	for (const line of headerText.split("\n")) {
		// Continuation lines (a leading space) belong to multi-line headers such as gpgsig; none of them are needed.
		if (line.startsWith(" ")) {
			continue;
		}
		const space = line.indexOf(" ");
		const key = line.slice(0, space);
		const value = line.slice(space + 1);
		if (key === "tree") {
			tree = value;
		} else if (key === "parent") {
			parents.push(value);
		} else if (key === "author") {
			authorLine = value;
		} else if (key === "committer") {
			committerLine = value;
		} else if (key === "encoding") {
			encoding = value;
		} else if (key === "gpgsig" || key === "gpgsig-sha256") {
			signed = true;
		}
	}
	if (tree === undefined || authorLine === undefined || committerLine === undefined) {
		throw new Error(`commit ${oid} is missing a required header`);
	}
	return { oid, tree, parents, authorLine, committerLine, encoding, signed, message };
}

export function commitSubject(info: CommitInfo): string {
	const text = info.message.toString("utf8");
	const end = text.indexOf("\n");
	return (end < 0 ? text : text.slice(0, end)).trim();
}

export async function commitRead(cat: CatFile, oid: Oid): Promise<CommitInfo> {
	return commitParse(oid, await cat.readType(oid, "commit"));
}

export type TreeEntry = { readonly mode: string; readonly type: "blob" | "tree" | "commit"; readonly oid: Oid; readonly path: string };

export async function treeList(repo: Repo, treeish: string, opts: { recursive: boolean; paths?: readonly string[] }): Promise<TreeEntry[]> {
	const args = ["ls-tree", "-z", "--full-tree", ...(opts.recursive ? ["-r"] : []), treeish, ...(opts.paths && opts.paths.length > 0 ? ["--", ...opts.paths] : [])];
	return splitNul(await gitOk(repo, args)).map((record) => {
		const tab = record.indexOf("\t");
		const [mode, type, oid] = record.slice(0, tab).split(" ");
		if (mode === undefined || oid === undefined || (type !== "blob" && type !== "tree" && type !== "commit")) {
			throw new Error(`unparseable ls-tree record: ${record}`);
		}
		return { mode, type, oid, path: record.slice(tab + 1) };
	});
}

export type FileChange = {
	readonly path: string;
	readonly status: "A" | "M" | "D" | "T";
	readonly binary: boolean;
	readonly added: number;
	readonly removed: number;
};

// Changes between two trees, without rename detection: a rename shows as a delete plus an add, which is what an editor of per-path contents wants.
export async function treeDiff(repo: Repo, from: Oid, to: Oid): Promise<FileChange[]> {
	const status = splitNul(await gitOk(repo, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", from, to]));
	const numstat = splitNul(await gitOk(repo, ["diff-tree", "-r", "-z", "--no-renames", "--numstat", from, to]));
	const counts = new Map<string, { added: number; removed: number; binary: boolean }>();
	for (const record of numstat) {
		const [added, removed, path] = record.split("\t");
		if (path === undefined) {
			throw new Error(`unparseable numstat record: ${record}`);
		}
		const binary = added === "-";
		counts.set(path, { added: binary ? 0 : Number(added), removed: binary ? 0 : Number(removed), binary });
	}
	const changes: FileChange[] = [];
	for (let i = 0; i + 1 < status.length; i += 2) {
		const code = status[i];
		const path = status[i + 1];
		if (path === undefined || (code !== "A" && code !== "M" && code !== "D" && code !== "T")) {
			throw new Error(`unexpected diff-tree status ${code} for ${path}`);
		}
		const count = counts.get(path) ?? { added: 0, removed: 0, binary: false };
		changes.push({ path, status: code, ...count });
	}
	return changes;
}

export type TreeObjectEntry = { readonly mode: string; readonly name: string; readonly oid: Oid };

// Parses a raw tree object (`<mode> <name>\0<binary oid>` repeated); used where spawning ls-tree per tree would be wasteful.
export async function treeRead(cat: CatFile, oid: Oid): Promise<TreeObjectEntry[]> {
	const data = await cat.readType(oid, "tree");
	const oidBytes = oid.length / 2;
	const entries: TreeObjectEntry[] = [];
	let i = 0;
	while (i < data.length) {
		const space = data.indexOf(0x20, i);
		const nul = data.indexOf(0, space);
		if (space < 0 || nul < 0) {
			throw new Error(`malformed tree object ${oid}`);
		}
		const mode = data.subarray(i, space).toString("latin1");
		entries.push({
			mode: mode.length === 5 ? `0${mode}` : mode,
			name: data.subarray(space + 1, nul).toString("utf8"),
			oid: data.subarray(nul + 1, nul + 1 + oidBytes).toString("hex"),
		});
		i = nul + 1 + oidBytes;
	}
	return entries;
}
