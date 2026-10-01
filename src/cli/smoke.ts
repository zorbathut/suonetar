// Throwaway manual harness for the engine: `npm run smoke -- <repo> <command> [...]`. Not a product.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Session } from "../engine/session.ts";

const [repoPath, command, ...rest] = process.argv.slice(2);
if (repoPath === undefined || command === undefined) {
	console.error("usage: smoke <repo> stack | files <n> | edit <n> <path> | preview | apply");
	process.exit(2);
}

const session = await Session.open(repoPath);
try {
	const state = await session.state();
	if (state.kind !== "ready") {
		console.log(JSON.stringify(state, null, 2));
		process.exit(1);
	}
	const commitAt = (n: string | undefined) => {
		const commit = state.stack.commits[Number(n) - 1];
		if (commit === undefined) {
			throw new Error(`no commit ${n}; the stack has ${state.stack.commits.length}`);
		}
		return commit;
	};
	if (command === "stack") {
		console.log(`${state.stack.branch} on ${state.stack.baseRef}${state.stack.frozenBelow ? ` (cut at merge ${state.stack.frozenBelow.slice(0, 10)})` : ""}`);
		state.stack.commits.forEach((c, i) => {
			const draft = state.drafts.find((d) => "commit" in d && d.commit.oid === c.oid);
			console.log(`${String(i + 1).padStart(3)} ${c.oid.slice(0, 10)} ${c.published ? "P" : " "}${draft ? "D" : " "} ${c.subject}`);
		});
		for (const d of state.drafts.filter((d) => d.kind !== "current")) {
			console.log(`draft ${d.draft.meta.against.slice(0, 10)}: ${d.kind}${d.kind === "conflict" ? ` (${d.reason})` : ""}`);
		}
		if (state.stack.leftBehind.length > 0) {
			console.log(`left behind: ${state.stack.leftBehind.join(", ")}`);
		}
	} else if (command === "files") {
		for (const f of (await session.commitDocument(commitAt(rest[0]).oid)).files) {
			console.log(`${f.status} ${f.binary ? "bin" : "   "} ${f.refusal ? "ro " : "   "}\t${f.path}`);
		}
	} else if (command === "edit") {
		const commit = commitAt(rest[0]);
		const path = rest[1] ?? "";
		const versions = (await session.commitDocument(commit.oid)).files.find((f) => f.path === path) ?? { draft: undefined };
		const dir = mkdtempSync(join(tmpdir(), "suonetar-smoke-"));
		const file = join(dir, basename(path));
		writeFileSync(file, versions.draft ?? "");
		// $EDITOR may carry arguments (`code --wait`), so it goes through the shell, with the file passed as a positional parameter.
		const editor = spawnSync("sh", ["-c", `${process.env.VISUAL ?? process.env.EDITOR ?? "vi"} "$1"`, "--", file], { stdio: "inherit" });
		if (editor.status !== 0) {
			throw new Error(`editor exited ${editor.status}`);
		}
		await session.draftSetFile(commit.oid, path, readFileSync(file));
		rmSync(dir, { recursive: true });
		console.log("draft saved");
	} else if (command === "preview" || command === "apply") {
		console.log(
			JSON.stringify(
				command === "preview" ? await session.preview() : await session.apply({ kind: "run", skip: [] }, () => undefined),
				(_k, v) => (v?.type === "Buffer" ? "<buffer>" : v),
				2,
			),
		);
	} else {
		throw new Error(`unknown command ${command}`);
	}
} finally {
	session.close();
}
