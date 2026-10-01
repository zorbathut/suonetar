import { createHash } from "node:crypto";
import { dirname, join, posix } from "node:path";
import { type ECFile, type ProcessedFileConfig, type Props, parseBuffer, parseFromFilesSync } from "editorconfig";
import type { Oid, Repo } from "./git.ts";
import { type CatFile, treeList } from "./objects.ts";
import { reportOnce } from "./report.ts";

// A file's indentation as EditorConfig sets it; undefined where nothing does. `size` is in columns, and for tab indentation it is how wide one level shows.
export type Indentation = { readonly style: "space" | "tab" | undefined; readonly size: number | undefined; readonly tabWidth: number | undefined };

const CONFIG = ".editorconfig";
// Wider than any real indentation; anything beyond is a mistake in the config.
const WIDTH_MAX = 16;

function width(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= WIDTH_MAX ? value : undefined;
}

// Validates the library's result: it passes through whatever text a config holds.
function indentationOf(props: Props): Indentation {
	const declared = props.indent_style;
	const style = declared === "space" ? "space" : declared === "tab" ? "tab" : undefined;
	return { style, size: width(props.indent_size), tabWidth: width(props.tab_width) };
}

// The config, unless it cannot be parsed (not UTF-8, say): then it is reported and left out, as an editor would ignore it, rather than failing every document it applies to.
function configParsed(name: string, contents: Buffer): ECFile | undefined {
	try {
		parseBuffer(contents);
		return { name, contents };
	} catch (err) {
		reportOnce(`${name}\0${createHash("sha1").update(contents).digest("hex")}`, `${name} cannot be parsed, so it is ignored`, err);
		return undefined;
	}
}

const MODE_SYMLINK = "120000";

function modeRegular(mode: string): boolean {
	return mode === "100644" || mode === "100755";
}

// The tree's configs by directory ("" for the top). A symlinked config is followed within the tree, as a checkout would; one pointing out of the tree, or at something that is not a file, is left out.
async function configsInTree(repo: Repo, cat: CatFile, tree: Oid): Promise<Map<string, ECFile>> {
	const configs = new Map<string, ECFile>();
	for (const entry of await treeList(repo, tree, { recursive: true })) {
		if (posix.basename(entry.path) !== CONFIG) {
			continue;
		}
		const dir = posix.dirname(entry.path) === "." ? "" : posix.dirname(entry.path);
		const name = join(repo.worktree, dir, CONFIG);
		let blob: Oid | undefined = modeRegular(entry.mode) ? entry.oid : undefined;
		if (entry.mode === MODE_SYMLINK) {
			const link = (await cat.readType(entry.oid, "blob")).toString("utf8");
			const target = posix.normalize(posix.join(dir, link));
			const [found] = posix.isAbsolute(link) || target === ".." || target.startsWith("../") ? [] : await treeList(repo, tree, { recursive: false, paths: [target] });
			blob = found !== undefined && modeRegular(found.mode) ? found.oid : undefined;
			if (blob === undefined) {
				reportOnce(`${name}\0${link}`, `${name} links to ${link}, which is not a file in the repository, so it is ignored`, undefined);
			}
		}
		const config = blob === undefined ? undefined : configParsed(name, await cat.readType(blob, "blob"));
		if (config !== undefined) {
			configs.set(dir, config);
		}
	}
	return configs;
}

// Each path's indentation from the `.editorconfig` files in `tree` along its directories, then those above the worktree on disk, nearest first and stopping at `root = true`, as an editor opening the file in a checkout of `tree` would see it.
export async function indentationFor(repo: Repo, cat: CatFile, tree: Oid, paths: readonly string[]): Promise<Map<string, Indentation>> {
	const above: ECFile[] = [];
	for (let dir = dirname(repo.worktree); ; dir = dirname(dir)) {
		const name = join(dir, CONFIG);
		const contents = await repo.readOutside(name);
		const config = contents === undefined ? undefined : configParsed(name, contents);
		if (config !== undefined) {
			above.push(config);
		}
		if (dirname(dir) === dir) {
			break;
		}
	}
	const inTree = await configsInTree(repo, cat, tree);
	// Parsed configs by name, shared across the paths: parsing and compiling a config's globs is most of the cost.
	const cache = new Map<string, ProcessedFileConfig>();
	const result = new Map<string, Indentation>();
	for (const path of paths) {
		const files: ECFile[] = [];
		const parts = path.split("/").slice(0, -1);
		for (let depth = parts.length; depth >= 0; depth--) {
			const config = inTree.get(parts.slice(0, depth).join("/"));
			if (config !== undefined) {
				files.push(config);
			}
		}
		// The library's deprecated low-level entry point is the one that takes configs as contents rather than reading them from disk, which a commit's tree needs.
		result.set(path, indentationOf(parseFromFilesSync(join(repo.worktree, path), [...files, ...above], { cache, unset: true })));
	}
	return result;
}
