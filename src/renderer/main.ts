import "./style.css";
import type { PublishResult } from "../engine/apply.ts";
import type { HookChoice } from "../engine/session.ts";
import type { WorktreeSide } from "../engine/worktree-changes.ts";
import type { ApiValue, Wire } from "../shared/api.ts";
import { api, call, errorText } from "./api.ts";
import { Autosave } from "./autosave.ts";
import { CommitView, type CommitViewHost } from "./commit-view.ts";
import { ask, button, el } from "./dom.ts";
import { type HookSkip, type HookStop, hookSummary, hookViewCreate, progressText } from "./hook-view.ts";
import type { CommitIdentity } from "./reselect.ts";
import { type Report, ResolveView, type ResolveViewHost } from "./resolve-view.ts";
import { branchShort, commitStatusFor, type DraftStatus, draftPendingFor, type Ready, stackRender, stackSummary, type Worktree } from "./stack-view.ts";
import { commitShow, type ViewDecision, type ViewShown, viewDecide, worktreePollAction } from "./view-decide.ts";

function byId(id: string): HTMLElement {
	const node = document.getElementById(id);
	if (node === null) {
		throw new Error(`index.html lacks #${id}`);
	}
	return node;
}

const whereEl = byId("where");
const draftsEl = byId("drafts");
const undoEl = byId("undo");
const applyEl = byId("apply");
const cancelEl = byId("cancel");
const statusEl = byId("status");
const sideEl = byId("side");
const stackEl = byId("stack");
// The changed-files pane: commit views fill it; every other view hides it, giving the stack the whole sidebar.
const filesEl = byId("files");
const docEl = byId("doc");

type View =
	| { readonly kind: "none" }
	| { readonly kind: "commit"; readonly view: CommitView; readonly readOnly: boolean }
	| { readonly kind: "draft"; readonly against: string; readonly view: CommitView }
	// `print` is the side's print the view was built from; a different one means it is out of date.
	| { readonly kind: "worktree"; readonly side: WorktreeSide; readonly print: string; readonly view: CommitView }
	| { readonly kind: "resolve"; readonly view: ResolveView }
	| { readonly kind: "hook"; readonly stop: HookStop }
	// Interrupted, unavailable, or an empty stack: a message instead of a document.
	| { readonly kind: "blocked" };

type SessionState = ApiValue<"state">;
type PublishFailure = Wire<Exclude<PublishResult, { kind: "published" }>>;

let ready: Ready | undefined;
let generationSeen: string | undefined;
let selected: (CommitIdentity & { readonly index: number }) | undefined;
let view: View = { kind: "none" };
let worktree: Worktree = { staged: 0, unstaged: 0, conflicted: false, stagedPrint: "", unstagedPrint: "" };
// When a shown uncommitted-changes view was last rebuilt; rebuilds are spaced out while an agent keeps writing.
let worktreeRebuilt = 0;
let busy = false;
let opRunning = false;
let opChain: Promise<void> = Promise.resolve();
let saveFailureShown: string | undefined;
// Commits the user chose to apply without their hook, from the hook view; listed there, and dropped once the hook view is left or Apply is pressed afresh.
let hookSkips: readonly HookSkip[] = [];

function statusSet(text: string, kind: "info" | "ok" | "error", detail = ""): void {
	statusEl.textContent = text;
	statusEl.title = detail;
	statusEl.className = `status-${kind}`;
	saveFailureShown = undefined;
}

function report(what: string, err: unknown): void {
	console.error(`suonetar: ${what}:`, err);
	statusSet(`${what}: ${errorText(err)}`, "error");
}

// User actions and refreshes run one at a time, so a refresh never lands in the middle of a commit switch or an apply. Never rejects: a failure is reported here, under `what`.
function op(what: string, fn: () => Promise<void>): Promise<void> {
	const run = opChain.then(async () => {
		opRunning = true;
		try {
			await fn();
		} catch (err) {
			report(`${what} failed`, err);
		} finally {
			opRunning = false;
		}
	});
	opChain = run;
	return run;
}

function saveKeyDescribe(key: string): string {
	const [oid = "", path = ""] = key.split("\0");
	return `${path === "" ? "the message" : path} of ${oid.slice(0, 7)}`;
}

const autosave = new Autosave({ set: (fn, ms) => window.setTimeout(fn, ms), clear: (handle) => window.clearTimeout(handle) }, 500, 3000, (key, status, error) => {
	if (view.kind === "commit") {
		view.view.saveStatus(key, status, error);
	}
	if (status === "failed") {
		report(`Saving ${saveKeyDescribe(key)} failed (retrying)`, error);
		saveFailureShown = key;
	} else if (status === "saved" && saveFailureShown === key) {
		statusSet(`Saved ${saveKeyDescribe(key)}.`, "ok");
	}
});

// Every pending save reaches disk before anything depends on it. When some cannot, the user may drop them only where the view is being left anyway (`discardable`), so nothing on screen goes out of step with the disk.
async function flushOrAsk(discardable: boolean): Promise<boolean> {
	if (await autosave.flush()) {
		return true;
	}
	autosave.hold();
	try {
		const failures = autosave.failures();
		const detail = failures.map((f) => `${saveKeyDescribe(f.key)}: ${errorText(f.error)}`).join("\n");
		if (!discardable) {
			await ask("Some edits could not be saved", `${detail}\n\nNothing was done. Fix the problem and try again.`, [{ label: "OK", value: "ok", primary: true }]);
			return false;
		}
		const answer = await ask("Some edits could not be saved", detail, [
			{ label: "Discard those edits", value: "discard" },
			{ label: "Stay here", value: "stay", primary: true },
		]);
		if (answer !== "discard") {
			return false;
		}
		for (const f of failures) {
			autosave.discard(f.key);
		}
		return true;
	} finally {
		autosave.release();
	}
}

async function viewLeave(): Promise<boolean> {
	if (view.kind === "resolve" && view.view.dirty()) {
		const answer = await ask("Leave the unsaved resolution?", "Choices and edits not saved with “Save resolution” are lost.", [
			{ label: "Leave", value: "leave" },
			{ label: "Stay here", value: "stay", primary: true },
		]);
		if (answer !== "leave") {
			return false;
		}
	}
	if (!(await flushOrAsk(true))) {
		return false;
	}
	if (view.kind === "commit" || view.kind === "draft" || view.kind === "resolve" || view.kind === "worktree") {
		view.view.destroy();
	}
	if (view.kind === "hook") {
		hookSkips = [];
	}
	docEl.replaceChildren();
	view = { kind: "none" };
	return true;
}

function viewShown(): ViewShown {
	switch (view.kind) {
		case "commit":
			return { kind: "commit", oid: view.view.oid, readOnly: view.readOnly };
		case "draft":
			return { kind: "draft", against: view.against };
		case "worktree":
			return { kind: "worktree", side: view.side };
		case "resolve":
			return { kind: "resolve", oid: view.view.oid };
		case "none":
		case "blocked":
		case "hook":
			return { kind: view.kind };
		default: {
			const never: never = view;
			throw new Error(`unknown view ${String(never)}`);
		}
	}
}

async function stateRead(): Promise<SessionState> {
	const generation = await call(api.generation());
	const state = await call(api.state());
	generationSeen = generation;
	ready = state.kind === "ready" ? state : undefined;
	// A failure here (git status on a damaged index) must not stop the state, a blocked message included, from showing.
	try {
		worktree = await call(api.worktreeStatus());
	} catch (err) {
		report("Reading the uncommitted changes failed", err);
	}
	topRedraw();
	return state;
}

const commitHost: CommitViewHost = { autosave, scroller: docEl, op, reload: commitReload, files: filesEl, collapsed: new Set() };

function stackRedraw(): void {
	if (ready === undefined) {
		stackEl.replaceChildren();
		return;
	}
	const selection = view.kind === "worktree" ? { side: view.side } : selected === undefined ? undefined : { oid: selected.oid };
	stackRender(stackEl, ready, worktree, selection, {
		select: (oid) => void op("Selecting", () => commitSelect(oid)),
		worktreeSelect: (side) => void op("Selecting", () => worktreeSelect(side)),
		draftView: (status) => void op("Showing the edit", () => draftShow(status)),
		draftConfirm: (status) => draftAct("Confirming", () => api.draftConfirm(status.draft.meta.against)),
		draftAdopt: (status) => draftAct("Adopting", () => api.draftAdopt(status.draft.meta.against)),
		draftDiscard: (status) => draftDiscard(status),
	});
}

function topRedraw(): void {
	undoButtonUpdate();
	if (ready === undefined) {
		whereEl.textContent = "";
		draftsEl.textContent = "";
		return;
	}
	const stack = ready.stack;
	whereEl.textContent = `${branchShort(stack.branch)} · ${stack.commits.length} commit${stack.commits.length === 1 ? "" : "s"}`;
	const edited = ready.commits.filter((c) => c.kind === "edited").length;
	const conflicts = ready.commits.filter((c) => c.kind === "conflict").length;
	const attention = ready.drafts.filter((d) => d.kind !== "current").length;
	draftsEl.textContent = [
		edited > 0 ? `${edited} edited` : "",
		conflicts > 0 ? `${conflicts} conflict${conflicts === 1 ? "" : "s"}` : "",
		attention > 0 ? `${attention} need a decision` : "",
	]
		.filter((s) => s !== "")
		.join(" · ");
}

function undoButtonUpdate(): void {
	const info = ready?.undo;
	undoEl.hidden = info === undefined;
	if (info === undefined || !(undoEl instanceof HTMLButtonElement)) {
		return;
	}
	undoEl.textContent = info.verb === "undo" ? "Undo apply" : "Redo apply";
	undoEl.disabled = busy || info.kind === "unavailable";
	undoEl.title =
		info.kind === "unavailable"
			? `Not available: ${info.reason}.`
			: `${info.verb === "undo" ? "Undo" : "Redo"} the last apply (${info.commits} commit${info.commits === 1 ? "" : "s"})${info.kind === "edits" ? ", as edits to review: commits were made on top of it" : ""}.`;
}

function busySet(value: boolean): void {
	busy = value;
	document.body.classList.toggle("busy", value);
	sideEl.inert = value;
	docEl.inert = value;
	if (applyEl instanceof HTMLButtonElement) {
		applyEl.disabled = value;
	}
	cancelEl.hidden = !value;
	undoButtonUpdate();
}

function bannersUpdate(): void {
	if ((view.kind !== "commit" && view.kind !== "resolve") || ready === undefined) {
		return;
	}
	const oid = view.view.oid;
	const banners: HTMLElement[] = [];
	const pending = view.kind === "commit" ? draftPendingFor(ready, oid) : undefined;
	if (pending !== undefined) {
		const actions = el(
			"span",
			{ class: "banner-actions" },
			button("View the edit", () => void op("Showing the edit", () => draftShow(pending))),
		);
		if (pending.kind === "rebased") {
			actions.append(button("Confirm", () => draftAct("Confirming", () => api.draftConfirm(pending.draft.meta.against)), "primary"));
		}
		if (pending.kind === "elsewhere") {
			actions.append(button("Adopt here", () => draftAct("Adopting", () => api.draftAdopt(pending.draft.meta.against)), "primary"));
		}
		actions.append(button("Discard…", () => draftDiscard(pending), "danger"));
		const text =
			pending.kind === "elsewhere"
				? `An edit to this commit made on branch ${branchShort(pending.draft.meta.branch)} is stored; this commit is read-only here until it is adopted or discarded.`
				: "An edit made before this commit was rewritten is waiting for a decision; this commit is read-only until then.";
		banners.push(el("div", { class: "banner banner-warn" }, text, actions));
	}
	const conflictBelow = commitStatusFor(ready, oid)?.conflictBelow;
	const conflicted = conflictBelow === undefined ? undefined : ready.stack.commits.find((c) => c.oid === conflictBelow);
	if (conflicted !== undefined) {
		banners.push(
			el(
				"div",
				{ class: "banner banner-warn" },
				view.kind === "resolve"
					? `The conflict in “${conflicted.subject}” below is not resolved yet, so “below” here lacks the edits beneath it in the files that conflict touches; resolving that one first may change this one.`
					: `The conflict in “${conflicted.subject}” below is not resolved yet, so the files it touches are shown here without the edits below it.`,
				el(
					"span",
					{ class: "banner-actions" },
					button("Go to the conflict", () => void op("Selecting", () => commitSelect(conflicted.oid))),
				),
			),
		);
	}
	view.view.bannersSet(banners);
}

function blockedShow(message: string, details: readonly string[]): void {
	filesEl.hidden = true;
	docEl.replaceChildren(el("div", { class: "blocked" }, el("h1", { text: message }), ...details.map((d) => el("p", { text: d }))));
	view = { kind: "blocked" };
}

function blockedFor(state: Exclude<SessionState, Ready>): void {
	if (state.kind === "interrupted") {
		const intent = state.intent;
		blockedShow("An update of the branch was interrupted", [
			state.reason,
			`It was moving ${intent.branch} from ${intent.oldTip.slice(0, 10)} to ${intent.newTip.slice(0, 10)} and stopped in phase “${intent.phase}”.`,
			`Intent file: ${state.intentPath}`,
			"docs/recovery.md in the suonetar repository explains how to finish or undo it. This window re-checks every second.",
		]);
	} else {
		blockedShow("Nothing to edit here", [state.reason, "This window re-checks every second."]);
	}
	stackRedraw();
}

// Builds the view a decision asks for; the previous view is already gone.
async function show(decision: Exclude<ViewDecision, { kind: "keep" }>, reveal: string | undefined): Promise<void> {
	if (decision.kind === "worktree") {
		await worktreeShow(decision.side);
		return;
	}
	if (decision.kind === "empty" || ready === undefined) {
		const stack = ready?.stack;
		const where =
			stack === undefined ? "There are no commits between the base and the branch tip." : `${branchShort(stack.branch)} has no commits above ${branchShort(stack.baseRef)}.`;
		blockedShow("Nothing to edit", [
			where,
			"New commits show up here as they are made. To edit commits that are already pushed, give an older base after the repository on the command line, or set `git config suonetar.base <ref>`.",
		]);
		stackRedraw();
		return;
	}
	if (decision.kind === "resolve") {
		await resolveShow(await call(api.commitConflict(decision.oid)));
		return;
	}
	const index = ready.stack.commits.findIndex((c) => c.oid === decision.oid);
	const commit = ready.stack.commits[index];
	if (commit === undefined) {
		throw new Error(`commit ${decision.oid} is not in the stack`);
	}
	selected = { oid: commit.oid, authorLine: commit.authorLine, subject: commit.subject, index };
	// Shown before the stack scrolls its selection into view, since showing it shrinks the stack pane.
	filesEl.hidden = false;
	stackRedraw();
	const cv = await CommitView.create(commitHost, { kind: "commit", oid: commit.oid, readOnly: decision.readOnly ? "Read-only until the waiting edit is decided on." : undefined });
	docEl.replaceChildren(cv.root);
	docEl.scrollTop = 0;
	view = { kind: "commit", view: cv, readOnly: decision.readOnly };
	bannersUpdate();
	if (reveal !== undefined) {
		cv.sectionReveal(reveal);
	}
}

// Shows a side of the uncommitted changes, unless it emptied meanwhile (an agent committed), in which case the view follows as for any change.
async function worktreeSelect(side: WorktreeSide): Promise<void> {
	await leaveAndShow((summary) => (summary.worktree[side] > 0 ? { kind: "worktree", side } : followed(summary)), undefined);
}

function worktreePrint(side: WorktreeSide): string {
	return side === "staged" ? worktree.stagedPrint : worktree.unstagedPrint;
}

// Shows one side of the uncommitted changes, read-only; the previous view is already gone.
async function worktreeShow(side: WorktreeSide): Promise<void> {
	const print = worktreePrint(side);
	const loaded = await CommitView.load({ kind: "worktree", side });
	filesEl.hidden = false;
	const cv = CommitView.build(commitHost, { kind: "worktree", side }, loaded);
	docEl.replaceChildren(cv.root);
	docEl.scrollTop = 0;
	view = { kind: "worktree", side, print, view: cv };
	worktreeRebuilt = Date.now();
	stackRedraw();
}

// Rebuilds a shown uncommitted-changes view whose files changed, in place: the new contents are read first and swapped in at once, returning to the same place in the same file, since the reader is likely mid-file while an agent writes.
async function worktreeRefresh(): Promise<void> {
	if (view.kind !== "worktree" || view.print === worktreePrint(view.side)) {
		return;
	}
	const { side } = view;
	const print = worktreePrint(side);
	const loaded = await CommitView.load({ kind: "worktree", side });
	if (view.kind !== "worktree" || view.side !== side) {
		return;
	}
	const carry = view.view.carry();
	view.view.destroy();
	const cv = CommitView.build(commitHost, { kind: "worktree", side }, loaded);
	docEl.replaceChildren(cv.root);
	docEl.scrollTop = 0;
	cv.carryRestore(carry);
	view = { kind: "worktree", side, print, view: cv };
	worktreeRebuilt = Date.now();
	stackRedraw();
}

// Leaves the current view (flushing its saves), then decides again on the state as it is after that flush.
async function leaveAndShow(want: (summary: ReturnType<typeof stackSummary>) => Exclude<ViewDecision, { kind: "keep" }>, reveal: string | undefined): Promise<void> {
	if (!(await viewLeave())) {
		return;
	}
	const state = await stateRead();
	if (state.kind !== "ready") {
		blockedFor(state);
		return;
	}
	await show(want(stackSummary(state, worktree)), reveal);
}

function followed(summary: ReturnType<typeof stackSummary>): Exclude<ViewDecision, { kind: "keep" }> {
	const decision = viewDecide(summary, { kind: "none" }, selected);
	if (decision.kind === "keep") {
		throw new Error("a fresh view cannot be kept");
	}
	return decision;
}

async function refresh(): Promise<void> {
	const state = await stateRead();
	if (state.kind !== "ready") {
		if (await viewLeave()) {
			blockedFor(state);
		}
		return;
	}
	const shown = viewShown();
	const decision = viewDecide(stackSummary(state, worktree), shown, selected);
	if (decision.kind !== "keep") {
		// Decided again once the view is left and its saves flushed, still from the view that was shown: an emptied uncommitted-changes view moves on to the newest commit, not back to the last selected one.
		await leaveAndShow((summary) => {
			const again = viewDecide(summary, shown, selected);
			if (again.kind !== "keep") {
				return again;
			}
			// The side refilled between the poll and this read: show it again.
			return shown.kind === "worktree" ? { kind: "worktree", side: shown.side } : followed(summary);
		}, undefined);
		return;
	}
	// The same conflict, but its merge changed (an edit below, made elsewhere): shown afresh, asking first if there is unsaved work.
	if (view.kind === "resolve") {
		const report = await call(api.commitConflict(view.view.oid));
		if (!view.view.sameMerge(report)) {
			await resolveShow(report);
			return;
		}
	}
	// Same view: only the surroundings changed (often just our own save), so the editors are left alone.
	if (view.kind === "commit") {
		const oid = view.view.oid;
		const index = state.stack.commits.findIndex((c) => c.oid === oid);
		const commit = state.stack.commits[index];
		if (commit !== undefined) {
			selected = { oid, authorLine: commit.authorLine, subject: commit.subject, index };
		}
	}
	stackRedraw();
	bannersUpdate();
}

async function commitSelect(oid: string): Promise<void> {
	await leaveAndShow((summary) => (summary.commits.some((c) => c.oid === oid) ? commitShow(summary, oid) : followed(summary)), undefined);
}

async function commitReload(path: string): Promise<void> {
	if (view.kind !== "commit") {
		return;
	}
	const oid = view.view.oid;
	await leaveAndShow((summary) => (summary.commits.some((c) => c.oid === oid) ? commitShow(summary, oid) : followed(summary)), path);
}

async function draftShow(status: DraftStatus): Promise<void> {
	if (!(await viewLeave())) {
		return;
	}
	const against = status.draft.meta.against;
	const cv = await CommitView.create(commitHost, { kind: "draft", against });
	docEl.replaceChildren(cv.root);
	docEl.scrollTop = 0;
	view = { kind: "draft", against, view: cv };
	const actions = el("span", { class: "banner-actions" });
	if (status.kind === "rebased") {
		actions.append(button("Confirm", () => draftAct("Confirming", () => api.draftConfirm(against)), "primary"));
	}
	if (status.kind === "elsewhere") {
		actions.append(button("Adopt here", () => draftAct("Adopting", () => api.draftAdopt(against))));
	}
	actions.append(button("Discard…", () => draftDiscard(status), "danger"));
	actions.append(button("Back to the stack", () => void op("Returning", () => leaveAndShow(followed, undefined))));
	cv.bannersSet([
		el(
			"div",
			{ class: "banner banner-warn" },
			`A stored edit, made on branch ${branchShort(status.draft.meta.branch)}, shown against the commit it was made on (read-only).`,
			actions,
		),
	]);
}

function draftAct(what: string, fn: () => ReturnType<typeof api.draftConfirm>): void {
	void op(what, async () => {
		if (!(await viewLeave())) {
			return;
		}
		await call(fn());
		await refresh();
	});
}

function draftDiscard(status: DraftStatus): void {
	void ask("Discard this edit?", `The stored edit to “${status.draft.meta.subject}” is deleted. It stays in the store's reflog (refs/suonetar/drafts) for 30 days by default.`, [
		{ label: "Discard", value: "discard" },
		{ label: "Keep it", value: "keep", primary: true },
	]).then((answer) => {
		if (answer === "discard") {
			draftAct("Discarding", () => api.draftDiscard(status.draft.meta.against));
		}
	});
}

// Shows a commit's conflict, selecting the commit; the same merge already shown is updated in place, keeping unsaved work in its other records.
async function resolveShow(conflict: Report): Promise<void> {
	if (view.kind === "resolve" && view.view.sameMerge(conflict)) {
		view.view.update(conflict);
		return;
	}
	if (!(await viewLeave())) {
		return;
	}
	const index = ready?.stack.commits.findIndex((c) => c.oid === conflict.commit.oid) ?? -1;
	const commit = ready?.stack.commits[index];
	if (commit !== undefined) {
		selected = { oid: commit.oid, authorLine: commit.authorLine, subject: commit.subject, index };
	}
	const rv = await ResolveView.create(resolveHost, conflict);
	filesEl.hidden = true;
	docEl.replaceChildren(rv.root);
	docEl.scrollTop = 0;
	view = { kind: "resolve", view: rv };
	stackRedraw();
	bannersUpdate();
}

// After a resolution was saved: the commit's conflict again if parts of it remain, else the commit itself.
async function resolveDone(): Promise<void> {
	if (view.kind !== "resolve") {
		return;
	}
	const oid = view.view.oid;
	const state = await stateRead();
	if (state.kind === "ready" && commitStatusFor(state, oid)?.kind === "conflict") {
		await resolveShow(await call(api.commitConflict(oid)));
		return;
	}
	const conflicts = state.kind === "ready" ? state.commits.filter((c) => c.kind === "conflict").length : 0;
	statusSet(conflicts === 0 ? "Resolved." : `Resolved; ${conflicts} more conflict${conflicts === 1 ? "" : "s"} in the stack.`, "ok");
	await leaveAndShow((summary) => (summary.commits.some((c) => c.oid === oid) ? commitShow(summary, oid) : followed(summary)), undefined);
}

const resolveHost: ResolveViewHost = {
	op,
	onResolved: resolveDone,
	busy: (on, message) => {
		busySet(on);
		statusSet(message, "info");
	},
};

// What the user should agree to before an apply that cannot be taken back without the reflog.
function applyWarnings(steps: readonly { readonly oid: string; readonly rewrite: boolean; readonly dropsSignature: boolean }[]): string[] {
	const rewritten = steps.filter((s) => s.rewrite);
	const published = new Set(ready?.stack.commits.filter((c) => c.published).map((c) => c.oid));
	const pushed = rewritten.filter((s) => published.has(s.oid)).length;
	const unsigned = rewritten.filter((s) => s.dropsSignature).length;
	return [
		pushed > 0 ? `${pushed} of them ${pushed === 1 ? "is" : "are"} already pushed; the remote branch will need a force-push.` : "",
		unsigned > 0 ? `${unsigned} signature${unsigned === 1 ? "" : "s"} will be dropped (commit signing is not configured).` : "",
	].filter((w) => w !== "");
}

// Reports a branch move that did not happen; `what` says what was attempted ("Not applied").
async function publishFailureShow(outcome: PublishFailure, what: string): Promise<void> {
	switch (outcome.kind) {
		case "refused":
			statusSet(`${what}: ${outcome.reason}`, "error");
			return;
		case "locked":
			statusSet(`${what}: the index is locked (${outcome.lockPath}, ${Math.round(outcome.ageSeconds)} s old). Another git command may be running; try again.`, "error");
			return;
		case "moved": {
			const files = outcome.unreverted.length === 0 ? "" : ` These files have changes suonetar did not make and were left as they are: ${outcome.unreverted.join(", ")}.`;
			statusSet(`${what}: ${outcome.reason}.${files}`, "error");
			await refresh();
			return;
		}
		case "busy":
			statusSet(`${what}: another apply is running on this repository.`, "error");
			return;
		case "interrupted":
			await refresh();
			return;
		default: {
			const never: never = outcome;
			throw new Error(`unknown publish result ${String(never)}`);
		}
	}
}

// Undoes (or redoes) the branch's last Suonetar move, after confirming what it will do as the state stands once the current view is left.
async function undoRun(): Promise<void> {
	if (!(await viewLeave())) {
		return;
	}
	const state = await stateRead();
	const info = state.kind === "ready" ? state.undo : undefined;
	if (info === undefined || info.kind === "unavailable") {
		statusSet(info === undefined ? "There is nothing to undo." : `Not available: ${info.reason}.`, "error");
		await refresh();
		return;
	}
	const undoing = info.verb === "undo";
	const n = `${info.commits} commit${info.commits === 1 ? "" : "s"}`;
	const details =
		info.kind === "exact"
			? [
					undoing
						? `The branch goes back to exactly the ${n} it had before the last apply. “Redo apply” puts the applied commits back, until the next apply.`
						: `The branch goes back to the ${n} the undone apply made. “Undo apply” undoes it again.`,
					info.pushed > 0 ? `${info.pushed} of the commits being replaced ${info.pushed === 1 ? "is" : "are"} already pushed; the remote branch will need a force-push.` : "",
				]
			: [
					"Commits were made on the branch since, so it cannot simply be moved back.",
					`Instead, edits that restore the ${n} as ${undoing ? "they were before the apply" : "the apply made them"} are prepared on the commits that need them; review them, then Apply. Later commits that build on the change will likely need resolving then.`,
				];
	const label = undoing ? "Undo apply" : "Redo apply";
	const answer = await ask(`${label}?`, details.filter((d) => d !== "").join("\n"), [
		{ label, value: "go" },
		{ label: "Cancel", value: "cancel", primary: true },
	]);
	if (answer !== "go") {
		await refresh();
		return;
	}
	const outcome = await call(api.undo(info.old, info.new, info.kind));
	switch (outcome.kind) {
		case "published":
			statusSet(undoing ? "Undone." : "Redone.", "ok");
			break;
		case "drafted":
			statusSet(`Prepared the ${info.verb} as edits on ${outcome.drafts} commit${outcome.drafts === 1 ? "" : "s"}; review them, then Apply.`, "ok");
			break;
		case "unavailable":
			statusSet(`Not ${undoing ? "undone" : "redone"}: ${outcome.reason}.`, "error");
			break;
		case "stale":
			statusSet("The branch changed meanwhile, so nothing was done; check again.", "error");
			break;
		case "refused":
		case "locked":
		case "moved":
		case "busy":
		case "interrupted":
			await publishFailureShow(outcome, undoing ? "Not undone" : "Not redone");
			break;
		default: {
			const never: never = outcome;
			throw new Error(`unknown undo result ${String(never)}`);
		}
	}
	await refresh();
}

async function hookShow(stop: HookStop): Promise<void> {
	const message = stop.kind === "hook-failed" ? "pre-commit stopped the apply; nothing was changed." : `pre-commit could not be run; nothing was changed: ${stop.message}`;
	// Leaving the previous hook view would forget the skips this retry was made with.
	const skips = hookSkips;
	if (!(await viewLeave())) {
		statusSet(message, "error");
		return;
	}
	hookSkips = skips;
	filesEl.hidden = true;
	docEl.replaceChildren(hookViewCreate(hookHost, stop, hookSkips));
	docEl.scrollTop = 0;
	view = { kind: "hook", stop };
	statusSet(message, "error");
}

function hookSkipIds(): string[] {
	return hookSkips.map((s) => s.oid);
}

const hookHost = {
	edit: (oid: string) => void op("Selecting", () => commitSelect(oid)),
	applyAgain: () => void op("Apply", () => applyRun({ kind: "run", skip: hookSkipIds() })),
	applySkippingThis: (oid: string, subject: string) => {
		hookSkips = [...hookSkips, { oid, subject }];
		void op("Apply", () => applyRun({ kind: "run", skip: hookSkipIds() }));
	},
	applyWithoutHooks: () =>
		void op("Apply", async () => {
			const answer = await ask("Apply without running pre-commit?", "No commit is checked by the hook, and nothing it would have fixed (formatting, say) is fixed.", [
				{ label: "Apply without hooks", value: "apply" },
				{ label: "Cancel", value: "cancel", primary: true },
			]);
			if (answer === "apply") {
				await applyRun({ kind: "skip" });
			}
		}),
};

async function applyRun(hooks: HookChoice): Promise<void> {
	if (view.kind === "resolve" && view.view.dirty()) {
		statusSet("Save or leave the resolution first.", "error");
		return;
	}
	if (!(await flushOrAsk(false))) {
		return;
	}
	const preview = await call(api.preview());
	switch (preview.kind) {
		case "conflict":
			statusSet("Resolve the conflicts in the stack first.", "error");
			await resolveShow(preview);
			return;
		case "nothing":
			statusSet("Nothing to apply.", "info");
			return;
		case "drafts-need-attention":
			statusSet("Some edits need a decision first (listed under the stack).", "error");
			return;
		case "clean":
			break;
		default: {
			const never: never = preview;
			throw new Error(`unknown preview ${String(never)}`);
		}
	}
	const warnings = applyWarnings(preview.steps);
	if (warnings.length > 0) {
		const rewrites = preview.steps.filter((s) => s.rewrite).length;
		const answer = await ask(`Apply will rewrite ${rewrites} commit${rewrites === 1 ? "" : "s"}`, warnings.join("\n"), [
			{ label: "Apply", value: "apply" },
			{ label: "Cancel", value: "cancel", primary: true },
		]);
		if (answer !== "apply") {
			return;
		}
	}
	busySet(true);
	statusSet("Applying…", "info");
	let outcome: ApiValue<"apply">;
	try {
		outcome = await call(api.apply(hooks));
	} finally {
		busySet(false);
	}
	// A hook view describes the last failure; any other outcome makes it stale.
	if (outcome.kind !== "hook-failed" && outcome.kind !== "hook-error") {
		hookSkips = [];
		if (view.kind === "hook") {
			await leaveAndShow(followed, undefined);
		}
	}
	switch (outcome.kind) {
		case "published": {
			const hooksDid = hookSummary(outcome.hookChanges, outcome.hookless);
			const text = outcome.warning === undefined ? `Applied. ${hooksDid.text}` : `Applied, with a problem: ${outcome.warning} ${hooksDid.text}`;
			statusSet(text.trim(), outcome.warning === undefined ? "ok" : "error", hooksDid.detail);
			await refresh();
			return;
		}
		case "hook-reverted": {
			const hooksDid = hookSummary(outcome.hookChanges, []);
			statusSet(`pre-commit undid every edit, so there was nothing to apply; the edits were cleared. ${hooksDid.text}`, "info", hooksDid.detail);
			await refresh();
			return;
		}
		case "hook-failed":
		case "hook-error":
			await hookShow(outcome);
			return;
		case "cancelled":
			statusSet("Apply cancelled; nothing was changed.", "info");
			return;
		case "nothing":
			statusSet("Nothing to apply.", "info");
			return;
		case "refused":
		case "locked":
		case "moved":
		case "busy":
		case "interrupted":
			await publishFailureShow(outcome, "Not applied");
			return;
		case "drafts-need-attention":
			statusSet("Some edits need a decision first (listed under the stack).", "error");
			await refresh();
			return;
		case "conflict":
			await resolveShow(outcome);
			return;
		default: {
			const never: never = outcome;
			throw new Error(`unknown apply result ${String(never)}`);
		}
	}
}

applyEl.addEventListener(
	"click",
	() =>
		void op("Apply", () => {
			hookSkips = [];
			return applyRun({ kind: "run", skip: [] });
		}),
);
undoEl.addEventListener("click", () => void op("Undo", undoRun));
// Outside the operation queue, which the running apply holds.
cancelEl.addEventListener("click", () => {
	statusSet("Cancelling…", "info");
	call(api.cancel()).catch((err: unknown) => report("Cancelling failed", err));
});
window.suonetarShell.onApplyProgress((progress) => {
	if (busy) {
		statusSet(progressText(progress), "info");
		// Publishing is not interruptible.
		cancelEl.hidden = progress.step === "write" || progress.step === "publish";
	}
});

// Steps through the uncommitted changes and the commits as the stack lists them, newest first: 1 moves down the list, to older.
function commitStep(dir: 1 | -1): void {
	void op("Selecting", async () => {
		const items: ({ readonly oid: string } | { readonly side: WorktreeSide })[] = [
			...(["unstaged", "staged"] as const).filter((side) => worktree[side] > 0).map((side) => ({ side })),
			...[...(ready?.stack.commits ?? [])].reverse().map((c) => ({ oid: c.oid })),
		];
		const shownSide = view.kind === "worktree" ? view.side : undefined;
		const index = items.findIndex((item) => ("side" in item ? item.side === shownSide : shownSide === undefined && item.oid === selected?.oid));
		// Nothing current (an empty stack): start from the end being stepped towards.
		const target = index === -1 ? items[dir === 1 ? 0 : items.length - 1] : items[index + dir];
		if (target === undefined) {
			return;
		}
		if ("side" in target) {
			await worktreeSelect(target.side);
		} else {
			await commitSelect(target.oid);
		}
	});
}

// Window-level keys, in the capture phase so they win over the editor's; chosen not to collide with CodeMirror's default keymap.
window.addEventListener(
	"keydown",
	(event) => {
		if (document.querySelector(".modal-backdrop") !== null) {
			return;
		}
		if (busy) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		const page = event.key === "PageUp" ? -1 : event.key === "PageDown" ? 1 : 0;
		const docView = view.kind === "commit" || view.kind === "draft" || view.kind === "worktree" ? view.view : undefined;
		if (page !== 0 && event.altKey && !event.ctrlKey && !event.shiftKey) {
			commitStep(page);
		} else if (page !== 0 && event.altKey && event.ctrlKey) {
			docView?.fileGo(page);
		} else if (event.key === "F7" && !event.ctrlKey && !event.altKey) {
			docView?.chunkGo(event.shiftKey ? -1 : 1);
		} else if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === "r") {
			void op("Reloading", async () => {
				if (await viewLeave()) {
					window.location.reload();
				}
			});
		} else if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === "s") {
			void op("Saving", async () => {
				if (await autosave.flush()) {
					statusSet("Saved.", "ok");
				}
			});
		} else {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
	},
	true,
);

// Anything unloading the page without going through the flush (a page-initiated close, a devtools reload) is cancelled while work is unsaved.
// Set once the page has answered a close or a repository switch with yes: the window is about to close or reload, so it stops polling and saving, and lets the unload through.
let released = false;

window.addEventListener("beforeunload", (event) => {
	if (released) {
		return;
	}
	if (autosave.unsaved() || (view.kind === "resolve" && view.view.dirty())) {
		event.preventDefault();
		void op("Saving", async () => {
			await autosave.flush();
		});
		statusSet("Unsaved work is still open; try again once it is saved.", "error");
	}
});

// Dropping a file on the window must not navigate away from unsaved edits.
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());

window.suonetarShell.onCloseRequest(async () => {
	if (busy) {
		statusSet("An apply or a merge tool is running; close the window or open another repository once it has finished, or cancel it.", "error");
		return false;
	}
	let ok = false;
	// Queued like any action, so an operation in progress finishes first.
	await op("Closing", async () => {
		if (view.kind === "resolve" && view.view.dirty()) {
			const answer = await ask("Leave the resolution unsaved?", "Choices and edits not saved with “Save resolution” are lost.", [
				{ label: "Leave", value: "leave" },
				{ label: "Stay", value: "stay", primary: true },
			]);
			if (answer !== "leave") {
				return;
			}
		}
		ok = await flushOrAsk(true);
	});
	if (ok) {
		released = true;
		autosave.hold();
	}
	return ok;
});

async function poll(): Promise<void> {
	if (released) {
		return;
	}
	try {
		if (!busy && !opRunning && document.querySelector(".modal-backdrop") === null) {
			const generation = await call(api.generation());
			if (generation !== generationSeen) {
				await op("Refreshing", refresh);
			}
			// The working tree moves without any ref moving; only its rows and an open view of it follow, never the rest of the state.
			const status = await call(api.worktreeStatus());
			const countsChanged = status.staged !== worktree.staged || status.unstaged !== worktree.unstaged || status.conflicted !== worktree.conflicted;
			worktree = status;
			const printStale = view.kind === "worktree" && view.print !== worktreePrint(view.side);
			const holding = view.kind === "worktree" && view.view.holding();
			switch (worktreePollAction(countsChanged, worktree, viewShown(), printStale, Date.now() - worktreeRebuilt, holding)) {
				case "redraw":
					stackRedraw();
					break;
				case "redecide":
					await op("Refreshing", refresh);
					break;
				case "rebuild":
					await op("Refreshing", worktreeRefresh);
					break;
				case "none":
					break;
			}
		}
	} catch (err) {
		report("Checking the repository failed", err);
	}
	window.setTimeout(() => void poll(), 1000);
}

// Started with no repository, the window offers to open one; File › Open Repository… then reloads the page onto it.
function welcomeShow(): void {
	filesEl.hidden = true;
	applyEl.hidden = true;
	docEl.replaceChildren(
		el(
			"div",
			{ class: "blocked" },
			el("h1", { text: "No repository open" }),
			el("p", {
				text: "Open one with File › Open Repository… (Ctrl+O), or start Suonetar inside a repository or with its path, and optionally the base for its stack: suonetar [<repository> [<base>]].",
			}),
			button("Open Repository…", () => window.suonetarShell.open(), "primary"),
		),
	);
}

void window.suonetarShell.repository().then(
	(repository) => {
		if (repository === undefined) {
			welcomeShow();
			return;
		}
		void op("Starting", refresh).then(() => poll());
	},
	(err: unknown) => report("Starting failed", err),
);
