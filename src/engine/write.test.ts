import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CatFile, commitRead } from "./objects.ts";
import { type Fixture, repoFixture } from "./test-support/repo.ts";
import { commitWrite } from "./write.ts";

describe("commitWrite", () => {
	let fx: Fixture;
	let cat: CatFile;

	beforeEach(async () => {
		fx = await repoFixture();
		cat = new CatFile(fx.repo);
	});

	afterEach(async () => {
		cat.close();
		await fx.cleanup();
	});

	test("keeps a Latin-1 author line, the encoding header, and the message bytes exactly", async () => {
		const base = fx.commit("base", { "a.txt": "a\n" });
		const tree = fx.git("rev-parse", `${base}^{tree}`);
		const message = Buffer.from("r\xe9sum\xe9\n\n# kept  \n", "latin1");
		const original = Buffer.concat([
			Buffer.from(`tree ${tree}\nparent ${base}\nauthor Jos\xe9 <j@example.com> 1700000000 +0100\ncommitter C <c@example.com> 1700000000 +0100\nencoding ISO-8859-1\n\n`, "latin1"),
			message,
		]);
		const oid = (await fx.repo.run(["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: fx.dir, input: original })).stdout.toString().trim();
		const info = await commitRead(cat, oid);
		const rewritten = await commitWrite(fx.repo, { tree: info.tree, parent: base, authorLine: info.authorLine, message: info.message, encoding: info.encoding }, false);
		const raw = (await cat.readType(rewritten, "commit")).toString("latin1");
		expect(raw).toContain("author Jos\xe9 <j@example.com> 1700000000 +0100\n");
		expect(raw).toContain("\nencoding ISO-8859-1\n");
		expect((await commitRead(cat, rewritten)).message.equals(message)).toBe(true);
	});
});
