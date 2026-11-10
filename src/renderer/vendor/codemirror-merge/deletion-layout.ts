// Suonetar's own, not upstream's (see VENDOR.md): how the unified merge view lays out a deletion's lines, in groups laid out only near the viewport.

// Deleted lines per `.cm-deletedGroup`.
export const DELETED_GROUP_LINES = 200;

// A full group of deleted lines is laid out only near the viewport (content-visibility), so a deletion of many thousands of lines lays out like one screenful. Only full groups: the last, however short, is always laid out, since an estimate of 200 lines for a deletion of a few would swing the page's height by thousands of pixels each time CodeMirror drew it near the viewport. The estimate gives a height only; a width would hold the content open past the editor and stop lines wrapping.
export function deletedGroupLazy(group: HTMLElement): void {
	group.style.contentVisibility = "auto";
	group.style.containIntrinsicSize = `none auto calc(${DELETED_GROUP_LINES} * 1lh)`;
}

// Once CodeMirror has taken a deletion's widget out of the page, the browser forgets its groups' laid-out heights, and drawing it again would bring back the estimate and swing the page's height. So a group's height as it scrolls out of the browser's reach goes into its own style, which the widget's DOM keeps; a group still on screen when a jump drops the whole widget is estimated once more. Only groups that have been laid out: every offscreen group reports being skipped as its widget is first drawn, and reading its height then would force a layout per group for an estimate already known.
export function deletedGroupHeightsKeep(dom: HTMLElement): void {
	const shown = new WeakSet<HTMLElement>();
	dom.addEventListener("contentvisibilityautostatechange", (e) => {
		const group = e.target;
		if (!(e instanceof ContentVisibilityAutoStateChangeEvent && group instanceof HTMLElement && group.classList.contains("cm-deletedGroup"))) {
			return;
		}
		if (!e.skipped) {
			shown.add(group);
		} else if (shown.has(group)) {
			group.style.containIntrinsicSize = `none auto ${group.getBoundingClientRect().height}px`;
		}
	});
}
