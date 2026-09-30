import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gitOk, gitText, type Oid, type Repo } from "./git.ts";

export type CommitSpec = {
	readonly tree: Oid;
	readonly parent: Oid;
	// Verbatim `Name <email> timestamp tz` from the original commit.
	readonly authorLine: string;
	readonly message: Buffer;
	readonly encoding: string | undefined;
};

export async function blobWrite(repo: Repo, content: Buffer): Promise<Oid> {
	return gitText(repo, ["hash-object", "-w", "--stdin"], { input: content });
}

export async function signingWanted(repo: Repo): Promise<boolean> {
	const result = await repo.run(["config", "--type=bool", "--get", "commit.gpgSign"], { cwd: repo.worktree });
	if (result.code === 1) {
		return false;
	}
	if (result.code !== 0) {
		throw new Error(`reading commit.gpgSign failed: ${result.stderr}`);
	}
	return result.stdout.toString("utf8").trim() === "true";
}

// Unsigned commits are built byte for byte, so the author line, encoding, and message survive exactly; signed ones go through commit-tree, the only way to reach the user's signing setup.
export async function commitWrite(repo: Repo, spec: CommitSpec, sign: boolean): Promise<Oid> {
	if (sign) {
		return commitWriteSigned(repo, spec);
	}
	const committer = await gitText(repo, ["var", "GIT_COMMITTER_IDENT"]);
	// The author line was decoded as Latin-1, so encoding it back the same way restores the original bytes; the committer comes from git as UTF-8.
	const raw = Buffer.concat([
		Buffer.from(`tree ${spec.tree}\nparent ${spec.parent}\nauthor ${spec.authorLine}\n`, "latin1"),
		Buffer.from(`committer ${committer}\n`, "utf8"),
		Buffer.from(spec.encoding ? `encoding ${spec.encoding}\n` : "", "latin1"),
		Buffer.from("\n"),
		spec.message,
	]);
	return gitText(repo, ["hash-object", "-t", "commit", "-w", "--stdin"], { input: raw });
}

async function commitWriteSigned(repo: Repo, spec: CommitSpec): Promise<Oid> {
	const match = /^(.*) <(.*)> (\d+ [+-]\d{4})$/.exec(spec.authorLine);
	if (!match) {
		throw new Error(`unparseable author line: ${spec.authorLine}`);
	}
	const [, nameLatin1, emailLatin1, date] = match as unknown as [string, string, string, string];
	const name = Buffer.from(nameLatin1, "latin1").toString("utf8");
	const email = Buffer.from(emailLatin1, "latin1").toString("utf8");
	const encodingArgs = spec.encoding ? ["-c", `i18n.commitEncoding=${spec.encoding}`] : [];
	return gitText(repo, [...encodingArgs, "commit-tree", "-S", "-p", spec.parent, "-F", "-", spec.tree], {
		input: spec.message,
		env: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: `@${date}` },
	});
}

export type TreeChange = { readonly path: string; readonly mode: string; readonly oid: Oid } | { readonly path: string; readonly delete: "file" | "directory" };

// Applies changes to a tree through a throwaway index. Directory deletions go first, so a change can replace a directory with a file; modes come from the caller, never a hardcoded 100644.
export async function treeWithChanges(repo: Repo, baseTree: Oid, changes: readonly TreeChange[]): Promise<Oid> {
	const dir = join(repo.gitDir, "suonetar", "tmp");
	mkdirSync(dir, { recursive: true });
	const indexPath = join(dir, `index.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`);
	const env = { GIT_INDEX_FILE: indexPath };
	try {
		await gitOk(repo, ["read-tree", baseTree], { env });
		const directories = changes.flatMap((change) => ("delete" in change && change.delete === "directory" ? [`:(literal)${change.path}`] : []));
		if (directories.length > 0) {
			await gitOk(repo, ["rm", "-r", "-q", "-f", "--cached", "--ignore-unmatch", "--", ...directories], { env });
		}
		const nullOid = "0".repeat(baseTree.length);
		const lines = changes.flatMap((change) => {
			if (!("delete" in change)) {
				return [`${change.mode} ${change.oid}\t${change.path}`];
			}
			return change.delete === "file" ? [`0 ${nullOid}\t${change.path}`] : [];
		});
		if (lines.length > 0) {
			await gitOk(repo, ["update-index", "-z", "--index-info"], { input: `${lines.join("\0")}\0`, env });
		}
		return await gitText(repo, ["write-tree"], { env });
	} finally {
		rmSync(indexPath, { force: true });
	}
}
