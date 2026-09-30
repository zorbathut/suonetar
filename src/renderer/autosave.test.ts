import { describe, expect, it } from "vitest";
import { Autosave, type AutosaveStatus } from "./autosave.ts";

// Manually driven timers: `advance` fires everything due, in order.
function timersFake() {
	let now = 0;
	let next = 0;
	const pending = new Map<number, { at: number; fn: () => void }>();
	return {
		timers: {
			set: (fn: () => void, ms: number) => {
				pending.set(++next, { at: now + ms, fn });
				return next;
			},
			clear: (handle: number) => {
				pending.delete(handle);
			},
		},
		async advance(ms: number) {
			const until = now + ms;
			for (;;) {
				const due = [...pending].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
				if (due === undefined) {
					break;
				}
				pending.delete(due[0]);
				now = due[1].at;
				due[1].fn();
				await settle();
			}
			now = until;
			await settle();
		},
	};
}

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
	}
}

function harness() {
	const fake = timersFake();
	const statuses: [string, AutosaveStatus][] = [];
	const autosave = new Autosave(fake.timers, 500, 2000, (key, status) => statuses.push([key, status]));
	return { fake, autosave, statuses };
}

function deferred() {
	let resolve = () => {};
	let reject = (_err: unknown) => {};
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("Autosave", () => {
	it("debounces: one save 500 ms after the last change, with the latest content", async () => {
		const { fake, autosave } = harness();
		const saved: string[] = [];
		let content = "a";
		const save = async () => {
			saved.push(content);
		};
		autosave.schedule("f", save);
		await fake.advance(300);
		content = "ab";
		autosave.schedule("f", save);
		await fake.advance(300);
		expect(saved).toEqual([]);
		expect(autosave.status("f")).toBe("pending");
		await fake.advance(200);
		expect(saved).toEqual(["ab"]);
		expect(autosave.status("f")).toBe("saved");
	});

	it("saves again after a change made while a save was in flight", async () => {
		const { fake, autosave } = harness();
		const saved: string[] = [];
		let content = "1";
		const gate = deferred();
		let first = true;
		const save = async () => {
			const snapshot = content;
			if (first) {
				first = false;
				await gate.promise;
			}
			saved.push(snapshot);
		};
		autosave.schedule("f", save);
		await fake.advance(500);
		expect(autosave.status("f")).toBe("saving");
		content = "2";
		autosave.schedule("f", save);
		await fake.advance(500);
		gate.resolve();
		await settle();
		expect(saved).toEqual(["1", "2"]);
		expect(autosave.status("f")).toBe("saved");
	});

	it("flush saves pending keys immediately and waits for in-flight saves", async () => {
		const { autosave } = harness();
		const saved: string[] = [];
		autosave.schedule("a", async () => {
			saved.push("a");
		});
		autosave.schedule("b", async () => {
			saved.push("b");
		});
		expect(await autosave.flush()).toBe(true);
		expect(saved.sort()).toEqual(["a", "b"]);
	});

	it("keeps a failed save dirty, reports it, and retries", async () => {
		const { fake, autosave, statuses } = harness();
		let fail = true;
		const saved: string[] = [];
		autosave.schedule("f", async () => {
			if (fail) {
				throw new Error("disk on fire");
			}
			saved.push("f");
		});
		await fake.advance(500);
		expect(autosave.status("f")).toBe("failed");
		expect(statuses.at(-1)).toEqual(["f", "failed"]);
		expect(autosave.failures().map((f) => f.key)).toEqual(["f"]);
		fail = false;
		await fake.advance(2000);
		expect(saved).toEqual(["f"]);
		expect(autosave.status("f")).toBe("saved");
	});

	it("flush reports false while a save keeps failing, and retries on the next flush", async () => {
		const { autosave } = harness();
		let fail = true;
		autosave.schedule("f", async () => {
			if (fail) {
				throw new Error("no");
			}
		});
		expect(await autosave.flush()).toBe(false);
		fail = false;
		expect(await autosave.flush()).toBe(true);
	});

	it("discard drops unsaved state", async () => {
		const { fake, autosave } = harness();
		const saved: string[] = [];
		autosave.schedule("f", async () => {
			saved.push("f");
		});
		autosave.discard("f");
		await fake.advance(1000);
		expect(saved).toEqual([]);
		expect(await autosave.flush()).toBe(true);
	});

	it("discard during an in-flight save forgets the key for good", async () => {
		const { fake, autosave } = harness();
		const gate = deferred();
		autosave.schedule("f", async () => {
			await gate.promise;
			throw new Error("fails after discard");
		});
		await fake.advance(500);
		expect(autosave.status("f")).toBe("saving");
		autosave.discard("f");
		expect(autosave.unsaved()).toBe(false);
		gate.resolve();
		await settle();
		await fake.advance(10000);
		expect(autosave.unsaved()).toBe(false);
		expect(autosave.failures()).toEqual([]);
		expect(await autosave.flush()).toBe(true);
	});

	it("hold stops retries until released", async () => {
		const { fake, autosave } = harness();
		let attempts = 0;
		autosave.schedule("f", async () => {
			attempts++;
			throw new Error("no");
		});
		expect(await autosave.flush()).toBe(false);
		autosave.hold();
		const before = attempts;
		await fake.advance(10000);
		expect(attempts).toBe(before);
		autosave.release();
		await fake.advance(3000);
		expect(attempts).toBeGreaterThan(before);
	});

	it("a change scheduled during a flush is saved by that flush", async () => {
		const { autosave } = harness();
		const saved: string[] = [];
		let content = "1";
		autosave.schedule("f", async () => {
			const snapshot = content;
			if (snapshot === "1") {
				content = "2";
				autosave.schedule("f", async () => {
					saved.push(content);
				});
			}
			saved.push(snapshot);
		});
		expect(await autosave.flush()).toBe(true);
		expect(saved).toEqual(["1", "2"]);
	});
});
