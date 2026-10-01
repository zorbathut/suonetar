// What the slot needs of a session: the parts that end it.
export type SlotSession = {
	readonly cancel: () => void;
	readonly closeWhenIdle: () => Promise<void>;
	readonly close: () => void;
};

export type SlotEffects<S> = {
	// Asks the page to save everything it holds; true once it has, after which it makes no further calls.
	readonly release: () => Promise<boolean>;
	// Retitles the window for the session and reloads the page onto it.
	readonly show: (session: S) => void;
};

// The window's open repository, if any, and whether it is being switched or closed. Switching and closing both start by asking the page to release, and only one of them can be under way: a close requested mid-switch takes over, and the switch stands down.
export class SessionSlot<S extends SlotSession> {
	readonly #effects: SlotEffects<S>;
	#session: S | undefined;
	#phase: "idle" | "switching" | "closing" = "idle";
	// Whether the page now loaded was loaded for the current session; between a switch and the new page announcing itself, calls are refused, so a late call from the old page cannot reach the new repository.
	#pageCurrent = true;

	constructor(session: S | undefined, effects: SlotEffects<S>) {
		this.#session = session;
		this.#effects = effects;
	}

	get session(): S | undefined {
		return this.#session;
	}

	// The session for a call from the page.
	current(): S {
		if (this.#session === undefined) {
			throw new Error("No repository is open");
		}
		if (!this.#pageCurrent) {
			throw new Error("The window is switching repositories");
		}
		return this.#session;
	}

	// The page loaded for the current session is listening.
	pageLoaded(): void {
		this.#pageCurrent = true;
	}

	// Moves to the repository `choose` opens (undefined when the user cancelled or it could not be opened), once the page has released the current one.
	async switchTo(choose: () => Promise<S | undefined>): Promise<void> {
		if (this.#phase !== "idle") {
			return;
		}
		this.#phase = "switching";
		try {
			const next = await choose();
			if (next === undefined) {
				return;
			}
			if (!(await this.#effects.release()) || this.#phase !== "switching") {
				next.close();
				return;
			}
			const previous = this.#session;
			this.#session = next;
			this.#pageCurrent = false;
			this.#effects.show(next);
			if (previous !== undefined) {
				previous.cancel();
				await previous.closeWhenIdle();
			}
		} finally {
			if (this.#phase === "switching") {
				this.#phase = "idle";
			}
		}
	}

	// A close was asked for: true when this is the first ask, false when one is already waiting on the page.
	closeBegin(): boolean {
		if (this.#phase === "closing") {
			return false;
		}
		this.#phase = "closing";
		return true;
	}

	// The page refused to release, so the window stays open.
	closeAbandoned(): void {
		this.#phase = "idle";
	}
}
