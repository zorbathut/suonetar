import { ErrorNotOnBranch, ErrorStale } from "../errors.ts";
import { gitText, type Oid } from "../git.ts";
import type { Session } from "../session.ts";

// The parent tree and file a save names, as the editor has them from the document it shows. A commit no longer in the stack (or with no stack, HEAD detached) is taken as shown on its own parent, as a document opened before that showed it.
async function shownFor(session: Session, oid: Oid, path: string): Promise<{ parentTree: Oid; blob: Oid | null }> {
	try {
		const doc = await session.commitDocument(oid);
		const content = await session.blobAt(doc.tree, path);
		return { parentTree: doc.parentTree, blob: content === undefined ? null : await gitText(session.repo, ["hash-object", "--stdin"], { input: content }) };
	} catch (err) {
		if (!(err instanceof ErrorStale || err instanceof ErrorNotOnBranch)) {
			throw err;
		}
		const parentTree = await gitText(session.repo, ["rev-parse", `${oid}^^{tree}`]);
		// The draft's version of the file if there is one, as the document showed it.
		let tree = await gitText(session.repo, ["rev-parse", `${oid}^{tree}`]);
		try {
			tree = (await session.draftDocument(oid)).tree;
		} catch (missing) {
			if (!(missing instanceof ErrorStale)) {
				throw missing;
			}
		}
		const found = await session.repo.run(["rev-parse", "--verify", "--quiet", `${tree}:${path}`], { cwd: session.repo.worktree });
		return { parentTree, blob: found.code === 0 ? found.stdout.toString("utf8").trim() : null };
	}
}

// Saves one file of a commit's draft as the editor does.
export async function draftFile(session: Session, oid: Oid, path: string, content: Buffer | null): Promise<void> {
	const shown = await shownFor(session, oid, path);
	await session.draftSetFile(oid, shown.parentTree, path, shown.blob, content);
}

// Restores one file of a commit's draft as the editor's buttons do.
export async function draftFileRestore(session: Session, oid: Oid, path: string, from: "commit" | "parent"): Promise<void> {
	const shown = await shownFor(session, oid, path);
	await session.draftRestore(oid, shown.parentTree, path, from);
}
