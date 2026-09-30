import type { GitRunner, Repo } from "../git.ts";

// A repo whose runner performs `action` (playing the other process, e.g. Claude Code) once, just before the first git call matching `predicate`.
export function repoInterleaved(repo: Repo, predicate: (args: readonly string[]) => boolean, action: () => void | Promise<void>): Repo {
	let fired = false;
	const run: GitRunner = async (args, opts) => {
		if (!fired && predicate(args)) {
			fired = true;
			await action();
		}
		return repo.run(args, opts);
	};
	return { ...repo, run };
}

export const beforeReadTree = (args: readonly string[]) => args[0] === "read-tree" && args.includes("-u");
export const beforeRefTransaction = (args: readonly string[]) => args[0] === "update-ref" && args.includes("--stdin");
