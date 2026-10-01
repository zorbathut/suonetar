import type { ApplyProgress } from "../engine/session.ts";
import type { ApiValue } from "../shared/api.ts";
import { button, el } from "./dom.ts";

export type HookFailure = Extract<ApiValue<"apply">, { kind: "hook-failed" }>;
// Why an apply stopped at the hook stage: the hook failed, or running it at all did.
export type HookStop = HookFailure | Extract<ApiValue<"apply">, { kind: "hook-error" }>;
type HookChanges = Extract<ApiValue<"apply">, { kind: "published" }>["hookChanges"];
type Hookless = Extract<ApiValue<"apply">, { kind: "published" }>["hookless"];
export type HookSkip = { readonly oid: string; readonly subject: string };

export type HookViewHost = {
	readonly edit: (oid: string) => void;
	readonly applyAgain: () => void;
	readonly applySkippingThis: (oid: string, subject: string) => void;
	readonly applyWithoutHooks: () => void;
};

// Colour and cursor sequences, which some hooks print even without a terminal.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");

export function progressText(progress: ApplyProgress): string {
	switch (progress.step) {
		case "prepare":
			return "Preparing the worktree for pre-commit…";
		case "hook":
			return `Running pre-commit on ${progress.index} of ${progress.total}: ${progress.subject}`;
		case "write":
			return "Writing commits…";
		case "publish":
			return "Updating the branch and worktree…";
		default: {
			const never: never = progress;
			throw new Error(`unknown progress ${String(never)}`);
		}
	}
}

// What the hook did during a successful apply, short enough for the status line, with the full list as `detail`; "" when it did nothing worth mentioning.
export function hookSummary(changes: HookChanges, hookless: Hookless): { text: string; detail: string } {
	const parts: string[] = [];
	if (changes.length > 0) {
		const files = changes.reduce((n, c) => n + c.paths.length, 0);
		parts.push(`pre-commit changed ${files} file${files === 1 ? "" : "s"} in ${changes.length} commit${changes.length === 1 ? "" : "s"}.`);
	}
	if (hookless.length > 0) {
		parts.push(`${hookless.length} commit${hookless.length === 1 ? " has" : "s have"} no pre-commit hook.`);
	}
	const detail = [...changes.map((c) => `${c.subject}: ${c.paths.join(", ")}`), ...hookless.map((c) => `${c.subject}: no pre-commit hook`)].join("\n");
	return { text: parts.join(" "), detail };
}

function headline(stop: HookStop): string {
	if (stop.kind === "hook-error") {
		return "pre-commit could not be run";
	}
	const failure = stop;
	switch (failure.failure) {
		case "exit":
			return `pre-commit failed on “${failure.commit.subject}”${failure.code === null ? " (killed)" : ` (exit code ${failure.code})`}`;
		case "unsettled":
			return `pre-commit kept changing files in “${failure.commit.subject}”`;
		case "collision":
			return `“${failure.commit.subject}” collides with what pre-commit changed below it`;
		default: {
			const never: never = failure.failure;
			throw new Error(`unknown hook failure ${String(never)}`);
		}
	}
}

function explanation(stop: HookStop): string {
	if (stop.kind === "hook-error") {
		return stop.message;
	}
	const failure = stop;
	switch (failure.failure) {
		case "exit":
			return failure.changed.length > 0 ? `Before failing it changed ${failure.changed.join(", ")}; those changes were not kept.` : "";
		case "unsettled":
			return `It changed ${failure.changed.join(", ")} on each of three runs, so its result never settled.`;
		case "collision":
			return `Laying this commit's change over the hook's result would drop ${failure.changed.join(", ")}.`;
		default: {
			const never: never = failure.failure;
			throw new Error(`unknown hook failure ${String(never)}`);
		}
	}
}

// The commit pre-commit stopped on, its output, and the ways forward. Nothing here is editable, so leaving it never loses anything.
export function hookViewCreate(host: HookViewHost, stop: HookStop, skips: readonly HookSkip[]): HTMLElement {
	const actions = el("div", { class: "actions" });
	if (stop.kind === "hook-failed") {
		const oid = stop.commit.oid;
		actions.append(
			button("Edit this commit", () => host.edit(oid), "primary"),
			button("Apply again", () => host.applyAgain()),
			button("Apply, skipping the hook for this commit", () => host.applySkippingThis(oid, stop.commit.subject)),
		);
	} else {
		actions.append(button("Apply again", () => host.applyAgain(), "primary"));
	}
	actions.append(button("Apply without hooks…", () => host.applyWithoutHooks(), "danger"));
	const output = stop.kind === "hook-failed" ? stop.output.replace(ANSI, "").trimEnd() : "";
	const notes = [explanation(stop), skips.length === 0 ? "" : `The hook is being skipped for: ${skips.map((s) => `“${s.subject}”`).join(", ")}.`];
	return el(
		"div",
		{ class: "hook-view" },
		el("h1", { class: "commit-title", text: headline(stop) }),
		el("p", { text: "Nothing was applied, and your edits are kept. Fix the commit and apply again, or apply without running the hook on it." }),
		...notes.filter((t) => t !== "").map((t) => el("p", { text: t })),
		actions,
		stop.kind === "hook-error" ? el("span", {}) : output === "" ? el("p", { class: "note", text: "The hook printed nothing." }) : el("pre", { class: "hook-output", text: output }),
	);
}
