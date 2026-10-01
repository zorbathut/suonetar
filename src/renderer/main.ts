import "./style.css";
import type { PublishResult } from "../engine/apply.ts";
import type { HookChoice } from "../engine/session.ts";
import type { ApiValue, Wire } from "../shared/api.ts";
import { api, call, errorText } from "./api.ts";
import { Autosave } from "./autosave.ts";
import { CommitView, type CommitViewHost } from "./commit-view.ts";
import { ask, button, el } from "./dom.ts";
import { type HookSkip, type HookStop, hookSummary, hookViewCreate, progressText } from "./hook-view.ts";
import type { CommitIdentity } from "./reselect.ts";
import { type Report, ResolveView, type ResolveViewHost } from "./resolve-view.ts";
import { branchShort, type DraftStatus, draftPendingFor, type Ready, stackRender, stackSummary } from "./stack-view.ts";
import { type ViewDecision, type ViewShown, viewDecide } from "./view-decide.ts";

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
const stackEl = byId("stack");
const docEl = byId("doc");

type View =
	| { readonly kind: "none" }
	| { readonly kind: "commit"; readonly view: CommitView; readonly readOnly: boolean }
	| { readonly kind: "draft"; readonly against: string; readonly view: CommitView }
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
	if (view.kind === "commit" || view.kind === "draft" || view.kind === "resolve") {
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
		case "none":
		case "blocked":
		case "resolve":
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
	topRedraw();
	return state;
}

const commitHost: CommitViewHost = { autosave, scroller: docEl, op, reload: commitReload };

function stackRedraw(): void {
	if (ready === undefined) {
		stackEl.replaceChildren();
		return;
	}
	stackRender(stackEl, ready, selected?.oid, {
		select: (oid) => void op("Selecting", () => commitSelect(oid)),
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
	const edited = ready.drafts.filter((d) => d.kind === "current").length;
	const attention = ready.drafts.length - edited;
	draftsEl.textContent = [edited > 0 ? `${edited} edited` : "", attention > 0 ? `${attention} need a decision` : ""].filter((s) => s !== "").join(" · ");
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
	stackEl.inert = value;
	docEl.inert = value;
	if (applyEl instanceof HTMLButtonElement) {
		applyEl.disabled = value;
	}
	cancelEl.hidden = !value;
	undoButtonUpdate();
}

function bannersUpdate(): void {
	if (view.kind !== "commit" || ready === undefined) {
		return;
	}
	const oid = view.view.oid;
	const banners: HTMLElement[] = [];
	const pending = draftPendingFor(ready, oid);
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
	const index = ready.stack.commits.findIndex((c) => c.oid === oid);
	const below = new Set(ready.stack.commits.slice(0, Math.max(0, index)).map((c) => c.oid));
	if (ready.drafts.some((d) => d.kind === "current" && below.has(d.commit.oid))) {
		banners.push(el("div", { class: "banner" }, "Commits below this one have unapplied edits. This diff is against the current parent and does not include them yet."));
	}
	view.view.bannersSet(banners);
}

function blockedShow(message: string, details: readonly string[]): void {
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
	if (decision.kind === "empty" || ready === undefined) {
		const stack = ready?.stack;
		const where =
			stack === undefined ? "There are no commits between the base and the branch tip." : `${branchShort(stack.branch)} has no commits above ${branchShort(stack.baseRef)}.`;
		blockedShow("Nothing to edit", [
			where,
			"New commits show up here as they are made. To edit commits that are already pushed, set `git config suonetar.base <ref>` to an older base.",
		]);
		stackRedraw();
		return;
	}
	const index = ready.stack.commits.findIndex((c) => c.oid === decision.oid);
	const commit = ready.stack.commits[index];
	if (commit === undefined) {
		throw new Error(`commit ${decision.oid} is not in the stack`);
	}
	selected = { oid: commit.oid, authorLine: commit.authorLine, subject: commit.subject, index };
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
	await show(want(stackSummary(state)), reveal);
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
	const decision = viewDecide(stackSummary(state), viewShown(), selected);
	if (decision.kind !== "keep") {
		await leaveAndShow(followed, undefined);
		return;
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
	await leaveAndShow((summary) => (summary.commits.some((c) => c.oid === oid) ? { kind: "commit", oid, readOnly: summary.pending.has(oid) } : followed(summary)), undefined);
}

async function commitReload(path: string): Promise<void> {
	if (view.kind !== "commit") {
		return;
	}
	const oid = view.view.oid;
	await leaveAndShow((summary) => (summary.commits.some((c) => c.oid === oid) ? { kind: "commit", oid, readOnly: summary.pending.has(oid) } : followed(summary)), path);
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
	void ask("Discard this edit?", `The stored edit to “${status.draft.meta.subject}” is deleted. It stays in the store's reflog (refs/suonetar/drafts) for a year.`, [
		{ label: "Discard", value: "discard" },
		{ label: "Keep it", value: "keep", primary: true },
	]).then((answer) => {
		if (answer === "discard") {
			draftAct("Discarding", () => api.draftDiscard(status.draft.meta.against));
		}
	});
}

async function resolveShow(conflict: Report): Promise<void> {
	if (view.kind === "resolve" && view.view.sameMerge(conflict)) {
		view.view.update(conflict);
		return;
	}
	if (!(await viewLeave())) {
		return;
	}
	const rv = await ResolveView.create(resolveHost, conflict);
	docEl.replaceChildren(rv.root);
	docEl.scrollTop = 0;
	view = { kind: "resolve", view: rv };
	statusSet("A commit needs attention before the edits can be applied.", "error");
}

async function resolveDone(): Promise<void> {
	const preview = await call(api.preview());
	switch (preview.kind) {
		case "conflict":
			await resolveShow(preview);
			return;
		case "clean": {
			const rewrites = preview.steps.filter((s) => s.rewrite).length;
			statusSet(`Resolved. Apply will rewrite ${rewrites} commit${rewrites === 1 ? "" : "s"}.`, "ok");
			break;
		}
		case "drafts-need-attention":
			statusSet("Some edits need a decision first (listed under the stack).", "error");
			break;
		case "nothing":
			statusSet("Nothing to apply.", "info");
			break;
		default: {
			const never: never = preview;
			throw new Error(`unknown preview ${String(never)}`);
		}
	}
	await leaveAndShow(followed, undefined);
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

function commitStep(dir: 1 | -1): void {
	void op("Selecting", async () => {
		const commits = ready?.stack.commits ?? [];
		const index = commits.findIndex((c) => c.oid === selected?.oid);
		const target = index === -1 ? undefined : commits[index + dir];
		if (target !== undefined) {
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
		const docView = view.kind === "commit" || view.kind === "draft" ? view.view : undefined;
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
window.addEventListener("beforeunload", (event) => {
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
		statusSet("An apply or a merge tool is running; close the window once it has finished, or cancel it.", "error");
		return false;
	}
	let ok = false;
	// Queued like any action, so an operation in progress finishes first.
	await op("Closing", async () => {
		if (view.kind === "resolve" && view.view.dirty()) {
			const answer = await ask("Close with an unsaved resolution?", "Choices and edits not saved with “Save resolution” are lost.", [
				{ label: "Close", value: "close" },
				{ label: "Stay", value: "stay", primary: true },
			]);
			if (answer !== "close") {
				return;
			}
		}
		ok = await flushOrAsk(true);
	});
	return ok;
});

async function poll(): Promise<void> {
	try {
		if (!busy && !opRunning && document.querySelector(".modal-backdrop") === null) {
			const generation = await call(api.generation());
			if (generation !== generationSeen) {
				await op("Refreshing", refresh);
			}
		}
	} catch (err) {
		report("Checking the repository failed", err);
	}
	window.setTimeout(() => void poll(), 1000);
}

void op("Starting", refresh).then(() => poll());
