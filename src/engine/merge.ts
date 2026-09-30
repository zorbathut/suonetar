import { createHash } from "node:crypto";
import { ErrorGit } from "./errors.ts";
import { type Oid, type Repo, splitNul } from "./git.ts";

export type ConflictStage = { readonly stage: 1 | 2 | 3; readonly mode: string; readonly oid: Oid };

export type Conflict = {
	// `content` conflicts have markers in the result tree and can be edited as text; everything else (binary, modify/delete, rename, directory/file, mode) needs a per-path choice.
	readonly kind: "content" | "structural";
	// merge-tree's own type string, such as `CONFLICT (modify/delete)`.
	readonly type: string;
	readonly message: string;
	readonly paths: readonly string[];
	readonly stages: Readonly<Record<string, readonly ConflictStage[]>>;
	// Identifies this conflict by its type, paths, and the exact blobs involved, like rerere: a resolution recorded under it applies wherever the same conflict recurs, and nowhere else.
	readonly key: string;
};

export type MergeResult = { readonly kind: "clean"; readonly tree: Oid } | { readonly kind: "conflict"; readonly markerTree: Oid; readonly conflicts: readonly Conflict[] };

// Three-way merge of trees, entirely in the object database. `--attr-source` makes the merged content's own .gitattributes (merge drivers) apply, rather than whatever the main worktree has checked out.
export async function mergeTrees(repo: Repo, base: Oid, ours: Oid, theirs: Oid): Promise<MergeResult> {
	const args = [`--attr-source=${theirs}`, "merge-tree", "--write-tree", "-z", "--messages", `--merge-base=${base}`, ours, theirs];
	const result = await repo.run(args, { cwd: repo.worktree });
	if (result.code !== 0 && result.code !== 1) {
		throw new ErrorGit(args, result.code, result.stderr);
	}
	const fields = splitNul(result.stdout);
	const tree = fields[0];
	if (tree === undefined) {
		throw new Error("merge-tree printed no tree");
	}
	if (result.code === 0) {
		return { kind: "clean", tree };
	}
	return { kind: "conflict", markerTree: tree, conflicts: conflictsParse(fields.slice(1)) };
}

// After the tree: stage records until an empty field, then message records `<n> <path>×n <type> <message>`.
function conflictsParse(fields: readonly string[]): Conflict[] {
	const stages: Record<string, ConflictStage[]> = {};
	let i = 0;
	for (; i < fields.length && fields[i] !== ""; i++) {
		const record = fields[i] as string;
		const tab = record.indexOf("\t");
		const [mode, oid, stage] = record.slice(0, tab).split(" ");
		const path = record.slice(tab + 1);
		if (mode === undefined || oid === undefined || (stage !== "1" && stage !== "2" && stage !== "3")) {
			throw new Error(`unparseable merge-tree stage record: ${record}`);
		}
		stages[path] ??= [];
		stages[path].push({ stage: Number(stage) as 1 | 2 | 3, mode, oid });
	}
	i++;
	const conflicts: Conflict[] = [];
	while (i < fields.length) {
		const count = Number(fields[i]);
		if (!Number.isInteger(count)) {
			throw new Error(`unparseable merge-tree message record at ${fields[i]}`);
		}
		const paths = fields.slice(i + 1, i + 1 + count);
		const type = fields[i + 1 + count] ?? "";
		const message = (fields[i + 2 + count] ?? "").trim();
		i += count + 3;
		if (!type.startsWith("CONFLICT")) {
			continue;
		}
		const pathStages: Record<string, readonly ConflictStage[]> = {};
		for (const path of paths) {
			pathStages[path] = stages[path] ?? [];
		}
		// A "content" conflict on a symlink or submodule has no markers to edit: its tree entry is simply one side's.
		const special = Object.values(pathStages).some((list) => list.some((stage) => stage.mode === "120000" || stage.mode === "160000"));
		const kind = type === "CONFLICT (contents)" && !special ? "content" : "structural";
		conflicts.push({ kind, type, message, paths, stages: pathStages, key: conflictKey(type, paths, pathStages) });
	}
	// A binary path gets both a `CONFLICT (binary)` and a `CONFLICT (contents)` record; any structural record for a path wins.
	const structuralPaths = new Set(conflicts.filter((c) => c.kind === "structural").flatMap((c) => c.paths));
	const deduped = conflicts.filter((c) => c.kind === "structural" || !c.paths.some((path) => structuralPaths.has(path)));
	conflicts.length = 0;
	conflicts.push(...deduped);
	// Every conflicted path must be covered by some message; if git's message format ever changes, fail loudly instead of hiding a conflict.
	const covered = new Set(conflicts.flatMap((c) => c.paths));
	const uncovered = Object.keys(stages).filter((path) => !covered.has(path));
	if (uncovered.length > 0) {
		const uncoveredStages = Object.fromEntries(uncovered.map((path) => [path, stages[path] ?? []]));
		const type = "CONFLICT (unclassified)";
		conflicts.push({
			kind: "structural",
			type,
			message: "conflicted paths without a message",
			paths: uncovered,
			stages: uncoveredStages,
			key: conflictKey(type, uncovered, uncoveredStages),
		});
	}
	return conflicts;
}

function conflictKey(type: string, paths: readonly string[], stages: Readonly<Record<string, readonly ConflictStage[]>>): string {
	return createHash("sha1").update(JSON.stringify({ type, paths, stages })).digest("hex");
}
