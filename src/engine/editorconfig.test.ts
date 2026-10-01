import { symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { indentationFor } from "./editorconfig.ts";
import { CatFile } from "./objects.ts";
import { type Fixture, repoFixture } from "./test-support/repo.ts";

describe("indentationFor", () => {
	let fx: Fixture;
	let cat: CatFile;

	beforeEach(async () => {
		fx = await repoFixture();
		cat = new CatFile(fx.repo);
	});

	afterEach(() => {
		cat.close();
		fx.cleanup();
	});

	async function indentation(files: Readonly<Record<string, string>>, paths: readonly string[]) {
		const commit = fx.commit("configs", files);
		return Object.fromEntries(await indentationFor(fx.repo, cat, fx.git("rev-parse", `${commit}^{tree}`), paths));
	}

	const spaces = (size: number) => ({ style: "space", size, tabWidth: size });
	const none = { style: undefined, size: undefined, tabWidth: undefined };

	test("applies the repository's root config by section, nearest config winning", async () => {
		const found = await indentation(
			{
				".editorconfig": "root = true\n[*]\nindent_style = space\nindent_size = 4\n[*.yaml]\nindent_size = 2\n",
				"sub/.editorconfig": "[*.cs]\nindent_size = 3\n",
				"sub/deeper/x.cs": "",
			},
			["a.cs", "conf.yaml", "sub/b.cs", "sub/deeper/x.cs", "sub/c.yaml"],
		);
		expect(found).toEqual({ "a.cs": spaces(4), "conf.yaml": spaces(2), "sub/b.cs": spaces(3), "sub/deeper/x.cs": spaces(3), "sub/c.yaml": spaces(2) });
	});

	test("anchors a nested config's slash globs at its own directory", async () => {
		const found = await indentation({ "sub/.editorconfig": "[inner/*.cs]\nindent_size = 6\n", "sub/inner/x.cs": "" }, ["sub/inner/x.cs", "inner/x.cs"]);
		expect(found).toEqual({ "sub/inner/x.cs": { style: undefined, size: 6, tabWidth: 6 }, "inner/x.cs": none });
	});

	test("stops at root = true, in the tree or at its top, ignoring configs above", async () => {
		fx.outside.set(join(dirname(fx.dir), ".editorconfig"), "[*]\nindent_size = 7\n");
		const found = await indentation({ ".editorconfig": "[*]\nindent_size = 4\n", "sub/.editorconfig": "root = true\n[*]\nindent_style = tab\n" }, ["a.txt", "sub/b.txt"]);
		expect(found["sub/b.txt"]).toEqual({ style: "tab", size: undefined, tabWidth: undefined });
		// The repository's own config is not root, so the one above it on disk applies too, beneath it.
		expect(found["a.txt"]).toEqual({ style: undefined, size: 4, tabWidth: 4 });
		const rooted = await indentation({ ".editorconfig": "root = true\n[*.md]\nindent_size = 2\n" }, ["c.txt"]);
		expect(rooted["c.txt"]).toEqual(none);
	});

	test("reads configs above the repository, which apply where the repository's do not", async () => {
		fx.outside.set(join(dirname(fx.dir), ".editorconfig"), "[*]\nindent_style = space\nindent_size = 5\n");
		const found = await indentation({ ".editorconfig": "[*.md]\nindent_size = 2\n" }, ["a.txt", "b.md"]);
		expect(found).toEqual({ "a.txt": spaces(5), "b.md": { style: "space", size: 2, tabWidth: 2 } });
	});

	test("follows the spec for tabs and their width", async () => {
		const found = await indentation(
			{ ".editorconfig": "[*.a]\nindent_style = tab\ntab_width = 8\n[*.b]\nindent_style = tab\nindent_size = tab\n[*.c]\nindent_size = tab\ntab_width = 3\n" },
			["x.a", "x.b", "x.c"],
		);
		expect(found).toEqual({
			"x.a": { style: "tab", size: 8, tabWidth: 8 },
			"x.b": { style: "tab", size: undefined, tabWidth: undefined },
			"x.c": { style: undefined, size: 3, tabWidth: 3 },
		});
	});

	test("skips a config that cannot be parsed, reporting it, while the others still apply", async () => {
		const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
		fx.outside.set(join(dirname(fx.dir), ".editorconfig"), Buffer.from("[*]\nindent_size = 7\n# \xff\xfe\n", "latin1"));
		writeFileSync(join(fx.dir, "sub.editorconfig"), Buffer.from("# R\xe9glages\n[*]\nindent_size = 3\n", "latin1"));
		fx.git("add", "sub.editorconfig");
		fx.git("mv", "sub.editorconfig", ".editorconfig");
		const found = await indentation({ "sub/.editorconfig": "[*]\nindent_size = 2\n" }, ["a.txt", "sub/b.txt"]);
		expect(found).toEqual({ "a.txt": none, "sub/b.txt": { style: undefined, size: 2, tabWidth: 2 } });
		expect(reported).toHaveBeenCalledTimes(2);
		reported.mockRestore();
	});

	test("follows a symlinked config within the tree, and ignores one pointing out of it", async () => {
		const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
		fx.write("shared/ec", "[*]\nindent_size = 3\n");
		symlinkSync("shared/ec", join(fx.dir, ".editorconfig"));
		symlinkSync("../../elsewhere", join(fx.dir, "shared", ".editorconfig"));
		fx.git("add", ".editorconfig", "shared");
		const found = await indentation({}, ["a.txt", "shared/b.txt"]);
		expect(found).toEqual({ "a.txt": { style: undefined, size: 3, tabWidth: 3 }, "shared/b.txt": { style: undefined, size: 3, tabWidth: 3 } });
		expect(reported).toHaveBeenCalledTimes(1);
		reported.mockRestore();
	});

	test("drops values that make no sense, and knows nothing without a config", async () => {
		const found = await indentation({ ".editorconfig": "[*.a]\nindent_style = sideways\nindent_size = huge\ntab_width = 0\n", "x.a": "" }, ["x.a", "y.b"]);
		expect(found).toEqual({ "x.a": none, "y.b": none });
	});
});
