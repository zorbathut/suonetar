import { el } from "./dom.ts";

// What the edited text has in a change against the text it is diffed against: lines that text lacks, none of its lines, or lines of its own.
export type ChangeKind = "added" | "removed" | "modified";

// A tick's kind: a change to the shown diff, or (`edit`) the user's own edit, which has a lane of its own.
export type OverviewKind = ChangeKind | "edit";

// A change in an editor, in viewport pixels, and the editor position it starts at.
export type OverviewChange = { readonly top: number; readonly bottom: number; readonly pos: number; readonly kind: ChangeKind };

// A change in viewport pixels, as an editor or an element reports its place.
export type OverviewMark<T> = { readonly top: number; readonly bottom: number; readonly kind: OverviewKind; readonly target: T };

export type OverviewTick<T> = { readonly y: number; readonly height: number; readonly kind: OverviewKind; readonly target: T };

// What a view shows on the strip: its marks, measured whenever the strip redraws, what a click on a tick does, and a tick's tooltip.
export type OverviewSource<T> = { readonly marks: () => readonly OverviewMark<T>[]; readonly jump: (target: T) => void; readonly title: (target: T) => string };

const TICK_MIN_PX = 3;
// Redrawing measures the whole document, so it waits at least this long after the last.
const REDRAW_INTERVAL_MS = 100;

// A change's kind from which sides of it are empty; undefined when both are, as where an edit takes out lines its commit added.
export function changeKind(aEmpty: boolean, bEmpty: boolean): ChangeKind | undefined {
	if (aEmpty && bEmpty) {
		return undefined;
	}
	return aEmpty ? "added" : bEmpty ? "removed" : "modified";
}

// The marks, measured from the scroller's content top at `origin` (in the marks' viewport pixels), scaled from content `contentHeight` tall onto a track `trackHeight` tall, each at least `minPx` tall and kept within the track. Ticks of one kind that overlap merge into one, which jumps to its first mark's target.
export function overviewTicks<T>(marks: readonly OverviewMark<T>[], origin: number, contentHeight: number, trackHeight: number, minPx: number): OverviewTick<T>[] {
	if (contentHeight <= 0 || trackHeight <= 0) {
		return [];
	}
	const scale = trackHeight / contentHeight;
	const ticks: OverviewTick<T>[] = [];
	const last = new Map<OverviewKind, number>();
	for (const m of [...marks].sort((a, b) => a.top - b.top)) {
		const height = Math.min(trackHeight, Math.max(minPx, (m.bottom - m.top) * scale));
		const y = Math.min(Math.max(0, (m.top - origin) * scale), trackHeight - height);
		const index = last.get(m.kind);
		const before = index === undefined ? undefined : ticks[index];
		if (index !== undefined && before !== undefined && y <= before.y + before.height) {
			ticks[index] = { ...before, height: Math.max(before.height, y + height - before.y) };
		} else {
			last.set(m.kind, ticks.length);
			ticks.push({ y, height, kind: m.kind, target: m.target });
		}
	}
	return ticks.sort((a, b) => a.y - b.y);
}

// The strip of ticks beside a scroller's scrollbar, showing one view's changes at a time and redrawn as the view's content or the scroller resizes.
export class Overview {
	readonly #root: HTMLElement;
	readonly #scroller: HTMLElement;
	readonly #resizes = new ResizeObserver(() => this.changed());
	#content: HTMLElement | undefined;
	#draw: (() => void) | undefined;
	#pending = false;
	#last = 0;
	// What the ticks were last drawn from, so that a redraw that moves none leaves them (and a tooltip being read) alone.
	#drawn = "";
	// What a click on each drawn tick does, kept current by every redraw.
	#jumps: (() => void)[] = [];

	constructor(root: HTMLElement, scroller: HTMLElement) {
		this.#root = root;
		this.#scroller = scroller;
		this.#resizes.observe(scroller);
		// The ticks are outside the scroller, so the wheel over one scrolls it from here.
		root.addEventListener("wheel", (e) => scroller.scrollBy({ top: e.deltaY, left: e.deltaX }), { passive: true });
	}

	// Shows the changes of the view whose page is `content`, until `hide` is called with it.
	show<T>(content: HTMLElement, source: OverviewSource<T>): void {
		if (this.#content !== undefined) {
			this.hide(this.#content);
		}
		this.#content = content;
		this.#resizes.observe(content);
		this.#draw = () => this.#render(source);
		this.changed();
	}

	// Clears the strip if it shows `content`'s changes, so that a view replaced after its successor was shown leaves the successor's ticks.
	hide(content: HTMLElement): void {
		if (this.#content !== content) {
			return;
		}
		this.#resizes.unobserve(content);
		this.#content = undefined;
		this.#draw = undefined;
		this.#drawn = "";
		this.#jumps = [];
		this.#root.replaceChildren();
	}

	// Redraws within a frame, and no sooner than REDRAW_INTERVAL_MS after the last redraw.
	changed(): void {
		if (this.#pending || this.#draw === undefined) {
			return;
		}
		this.#pending = true;
		setTimeout(
			() =>
				requestAnimationFrame(() => {
					this.#pending = false;
					this.#last = performance.now();
					this.#draw?.();
				}),
			Math.max(0, this.#last + REDRAW_INTERVAL_MS - performance.now()),
		);
	}

	#render<T>(source: OverviewSource<T>): void {
		const scroller = this.#scroller;
		this.#root.style.right = `${scroller.offsetWidth - scroller.clientWidth}px`;
		const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
		const ticks = overviewTicks(source.marks(), origin, scroller.scrollHeight, scroller.clientHeight, TICK_MIN_PX).map((t) => ({ ...t, title: source.title(t.target) }));
		this.#jumps = ticks.map((t) => () => source.jump(t.target));
		const drawn = JSON.stringify(ticks.map((t) => [t.y, t.height, t.kind, t.title]));
		if (drawn === this.#drawn) {
			return;
		}
		this.#drawn = drawn;
		this.#root.replaceChildren(
			...ticks.map((t, i) => {
				const node = el("div", { class: `overview-tick overview-${t.kind}`, title: t.title, onclick: () => this.#jumps[i]?.() });
				node.style.top = `${t.y}px`;
				node.style.height = `${t.height}px`;
				return node;
			}),
		);
	}
}
