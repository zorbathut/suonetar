export type AutosaveTimers<H> = { readonly set: (fn: () => void, ms: number) => H; readonly clear: (handle: H) => void };

export type AutosaveStatus = "saved" | "pending" | "saving" | "failed";

type Entry<H> = {
	save: () => Promise<void>;
	timer: H | undefined;
	// Changed since the last save started.
	dirty: boolean;
	saving: Promise<void> | undefined;
	error: unknown;
	// Dropped while its save was running: whatever that save does is no longer tracked.
	discarded: boolean;
};

// Debounced per-key saving. A save reads the editor's current content when it runs, so only the latest state is ever written; a failed save keeps the key dirty and retries.
export class Autosave<H> {
	readonly #timers: AutosaveTimers<H>;
	readonly #delayMs: number;
	readonly #retryMs: number;
	readonly #onStatus: (key: string, status: AutosaveStatus, error: unknown) => void;
	readonly #entries = new Map<string, Entry<H>>();
	// While held, timers do not start saves; a flush or `release` picks the work up.
	#held = false;

	constructor(timers: AutosaveTimers<H>, delayMs: number, retryMs: number, onStatus: (key: string, status: AutosaveStatus, error: unknown) => void) {
		this.#timers = timers;
		this.#delayMs = delayMs;
		this.#retryMs = retryMs;
		this.#onStatus = onStatus;
	}

	// Records that `key` changed; `save` writes its current content.
	schedule(key: string, save: () => Promise<void>): void {
		let entry = this.#entries.get(key);
		if (entry === undefined) {
			entry = { save, timer: undefined, dirty: false, saving: undefined, error: undefined, discarded: false };
			this.#entries.set(key, entry);
		}
		entry.save = save;
		entry.dirty = true;
		this.#timerSet(key, entry, this.#delayMs);
		this.#report(key, entry);
	}

	status(key: string): AutosaveStatus {
		const entry = this.#entries.get(key);
		if (entry === undefined) {
			return "saved";
		}
		if (entry.error !== undefined) {
			return "failed";
		}
		if (entry.saving !== undefined) {
			return "saving";
		}
		return entry.dirty ? "pending" : "saved";
	}

	// Anything not yet on disk, including failed saves.
	unsaved(): boolean {
		return this.#entries.size > 0;
	}

	failures(): { key: string; error: unknown }[] {
		return [...this.#entries].filter(([, e]) => e.error !== undefined).map(([key, e]) => ({ key, error: e.error }));
	}

	// Saves everything outstanding now, retrying failed keys once, and waits; true when every key is saved.
	async flush(): Promise<boolean> {
		for (const entry of this.#entries.values()) {
			entry.error = undefined;
		}
		for (;;) {
			const waits: Promise<void>[] = [];
			for (const [key, entry] of this.#entries) {
				if (entry.saving === undefined && entry.dirty && entry.error === undefined) {
					this.#start(key, entry);
				}
				if (entry.saving !== undefined) {
					waits.push(entry.saving);
				}
			}
			if (waits.length === 0) {
				break;
			}
			await Promise.all(waits);
		}
		return [...this.#entries.keys()].every((key) => this.status(key) === "saved");
	}

	// Stops background saves and retries, so the outcome of a flush stays put while the user decides what to do about it.
	hold(): void {
		this.#held = true;
	}

	release(): void {
		this.#held = false;
		for (const [key, entry] of this.#entries) {
			if (entry.dirty && entry.saving === undefined && entry.timer === undefined) {
				this.#timerSet(key, entry, entry.error === undefined ? this.#delayMs : this.#retryMs);
			}
		}
	}

	// Forgets a key's unsaved state; a save already running is left to finish but no longer counts.
	discard(key: string): void {
		const entry = this.#entries.get(key);
		if (entry !== undefined) {
			this.#timerClear(entry);
			entry.discarded = true;
			this.#entries.delete(key);
			this.#onStatus(key, "saved", undefined);
		}
	}

	#timerSet(key: string, entry: Entry<H>, ms: number): void {
		this.#timerClear(entry);
		entry.timer = this.#timers.set(() => {
			entry.timer = undefined;
			// A save already running picks the change up when it finishes.
			if (entry.saving === undefined && !this.#held) {
				this.#start(key, entry);
			}
		}, ms);
	}

	#timerClear(entry: Entry<H>): void {
		if (entry.timer !== undefined) {
			this.#timers.clear(entry.timer);
			entry.timer = undefined;
		}
	}

	#start(key: string, entry: Entry<H>): void {
		this.#timerClear(entry);
		entry.dirty = false;
		entry.saving = this.#run(key, entry);
		this.#report(key, entry);
	}

	async #run(key: string, entry: Entry<H>): Promise<void> {
		try {
			await entry.save();
			entry.error = undefined;
		} catch (err) {
			entry.error = err;
			entry.dirty = true;
		}
		entry.saving = undefined;
		if (entry.discarded) {
			return;
		}
		if (entry.error !== undefined) {
			this.#timerSet(key, entry, this.#retryMs);
		} else if (entry.dirty && entry.timer === undefined && !this.#held) {
			this.#start(key, entry);
			return;
		}
		if (!entry.dirty && entry.error === undefined) {
			this.#entries.delete(key);
		}
		this.#report(key, entry);
	}

	#report(key: string, entry: Entry<H>): void {
		this.#onStatus(key, this.status(key), entry.error);
	}
}
