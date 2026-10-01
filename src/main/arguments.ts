import { resolve } from "node:path";

export type Arguments = { readonly repo: string | undefined; readonly base: string | undefined };

// The repository and the base from the command line: the first two arguments after the app's own that are not flags (Chromium's, and the `--no-sandbox` an AppImage adds). Unpackaged, a relative repository resolves against where `npm run` was invoked, since npm runs scripts from the package root; a packaged build ignores an `INIT_CWD` it merely inherited.
export function argumentsRead(argv: readonly string[], packaged: boolean, initCwd: string | undefined, cwd: string): Arguments {
	const [repo, base] = argv.slice(packaged ? 1 : 2).filter((a) => !a.startsWith("-"));
	return { repo: repo === undefined ? undefined : resolve(packaged ? cwd : (initCwd ?? cwd), repo), base };
}
