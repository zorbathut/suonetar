import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CatFile, commitRead, commitSubject, treeDiff, treeList } from "./objects.ts";
import { type Fixture, repoFixture } from "./test-support/repo.ts";

describe("objects", () => {
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

	test("reads blobs, including binary content and missing objects", async () => {
		const binary = Buffer.from([0, 1, 2, 10, 255, 10, 10]);
		const binaryOid = (await fx.repo.run(["hash-object", "-w", "--stdin"], { cwd: fx.dir, input: binary })).stdout.toString().trim();
		const [a, missing, b] = await Promise.all([cat.read(binaryOid), cat.read("0".repeat(40)), cat.read(binaryOid)]);
		expect(a?.type).toBe("blob");
		expect(a?.data.equals(binary)).toBe(true);
		expect(missing).toBeUndefined();
		expect(b?.data.equals(binary)).toBe(true);
	});

	test("parses commits, keeping the author line and message bytes verbatim", async () => {
		fx.commit("base", { "a.txt": "a\n" });
		const oid = fx.commit("subject line\n\nbody  \n# kept\n", { "a.txt": "b\n" });
		const info = await commitRead(cat, oid);
		expect(info.parents).toHaveLength(1);
		expect(info.authorLine).toMatch(/^Author <author@example.com> \d+ \+0000$/);
		expect(commitSubject(info)).toBe("subject line");
		expect(info.message.toString()).toBe(`${fx.git("cat-file", "commit", oid).split("\n\n").slice(1).join("\n\n")}\n`);
	});

	test("lists trees and diffs them, flagging binaries", async () => {
		const c1 = fx.commit("base", { "a.txt": "a\n", "dir/b.txt": "b\n", "bin.dat": "x" });
		fx.write("bin.dat", "\0\x01binary");
		fx.git("add", "bin.dat");
		const c2 = fx.commit("change", { "a.txt": "a2\n", "dir/b.txt": null, "c.txt": "c\n" });
		const entries = await treeList(fx.repo, c2, { recursive: true });
		expect(entries.map((e) => e.path).sort()).toEqual(["a.txt", "bin.dat", "c.txt"]);
		const diff = await treeDiff(fx.repo, c1, c2);
		expect(Object.fromEntries(diff.map((d) => [d.path, d.status]))).toEqual({ "a.txt": "M", "bin.dat": "M", "c.txt": "A", "dir/b.txt": "D" });
		expect(diff.find((d) => d.path === "bin.dat")?.binary).toBe(true);
	});
});
