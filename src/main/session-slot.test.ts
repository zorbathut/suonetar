import { describe, expect, test } from "vitest";
import { SessionSlot } from "./session-slot.ts";

type Fake = { readonly name: string; readonly cancel: () => void; readonly closeWhenIdle: () => Promise<void>; readonly close: () => void };

function harness(initial: string | undefined) {
	const events: string[] = [];
	const fake = (name: string): Fake => ({
		name,
		cancel: () => events.push(`cancel ${name}`),
		closeWhenIdle: async () => {
			events.push(`closeWhenIdle ${name}`);
		},
		close: () => events.push(`close ${name}`),
	});
	let answer: (ok: boolean) => void = () => undefined;
	const slot = new SessionSlot<Fake>(initial === undefined ? undefined : fake(initial), {
		release: () => {
			events.push("release");
			return new Promise((resolve) => {
				answer = resolve;
			});
		},
		show: (session) => events.push(`show ${session.name}`),
	});
	// Lets the pending release question reach the effects before the test answers it.
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
	return { slot, events, fake, answer: (ok: boolean) => answer(ok), settle };
}

describe("SessionSlot", () => {
	test("with no repository, a call is refused", () => {
		const { slot } = harness(undefined);
		expect(() => slot.current()).toThrow(/No repository/);
	});

	test("a switch the page accepts shows the new session, ends the old one, and refuses calls until the new page loads", async () => {
		const { slot, events, fake, answer, settle } = harness("a");
		const switched = slot.switchTo(async () => fake("b"));
		await settle();
		answer(true);
		await switched;
		expect(events).toEqual(["release", "show b", "cancel a", "closeWhenIdle a"]);
		expect(() => slot.current()).toThrow(/switching/);
		slot.pageLoaded();
		expect(slot.current().name).toBe("b");
	});

	test("a switch the page refuses closes the new session and keeps the old", async () => {
		const { slot, events, fake, answer, settle } = harness("a");
		const switched = slot.switchTo(async () => fake("b"));
		await settle();
		answer(false);
		await switched;
		expect(events).toEqual(["release", "close b"]);
		expect(slot.current().name).toBe("a");
	});

	test("a second switch while one is under way is ignored, and nothing chosen changes nothing", async () => {
		const { slot, events, fake, answer, settle } = harness("a");
		let chosen = 0;
		const first = slot.switchTo(async () => {
			chosen++;
			return fake("b");
		});
		await slot.switchTo(async () => {
			chosen++;
			return fake("c");
		});
		await settle();
		answer(true);
		await first;
		expect(chosen).toBe(1);
		slot.pageLoaded();
		await slot.switchTo(async () => undefined);
		expect(events).toEqual(["release", "show b", "cancel a", "closeWhenIdle a"]);
	});

	test("a close asked for during a switch takes over, and the switch stands down", async () => {
		const { slot, events, fake, answer, settle } = harness("a");
		const switched = slot.switchTo(async () => fake("b"));
		await settle();
		expect(slot.closeBegin()).toBe(true);
		answer(true);
		await switched;
		expect(events).toEqual(["release", "close b"]);
		expect(slot.current().name).toBe("a");
		expect(slot.closeBegin()).toBe(false);
	});

	test("an abandoned close lets the next close or switch start", async () => {
		const { slot, events, fake } = harness("a");
		expect(slot.closeBegin()).toBe(true);
		await slot.switchTo(async () => fake("b"));
		expect(events).toEqual([]);
		slot.closeAbandoned();
		expect(slot.closeBegin()).toBe(true);
	});
});
