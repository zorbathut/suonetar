import type { SessionState } from "../engine/session.ts";
import type { Wire } from "../shared/api.ts";
import { button, el } from "./dom.ts";
import type { StackSummary } from "./view-decide.ts";

export type Ready = Extract<Wire<SessionState>, { kind: "ready" }>;
export type DraftStatus = Ready["drafts"][number];

export type StackViewHandlers = {
	readonly select: (oid: string) => void;
	readonly draftView: (status: DraftStatus) => void;
	readonly draftConfirm: (status: DraftStatus) => void;
	readonly draftAdopt: (status: DraftStatus) => void;
	readonly draftDiscard: (status: DraftStatus) => void;
};

// A stored draft waiting for a decision that concerns this commit: carried onto it from a rewritten commit, or made on it from another branch.
export function draftPendingFor(ready: Ready, oid: string): DraftStatus | undefined {
	return ready.drafts.find((d) => ((d.kind === "rebased" || d.kind === "conflict") && d.commit.oid === oid) || (d.kind === "elsewhere" && d.draft.meta.against === oid));
}

export function stackSummary(ready: Ready): StackSummary {
	const commits = ready.stack.commits;
	return {
		commits,
		pending: new Set(commits.filter((c) => draftPendingFor(ready, c.oid) !== undefined).map((c) => c.oid)),
		drafts: new Set(ready.drafts.map((d) => d.draft.meta.against)),
	};
}

export function branchShort(ref: string): string {
	return ref.replace(/^refs\/(heads|remotes)\//, "");
}

function draftDescribe(status: DraftStatus): string {
	const subject = status.draft.meta.subject;
	switch (status.kind) {
		case "current":
			return subject;
		case "rebased":
			return `“${subject}” was rewritten by something else; this edit was carried onto the new version and needs your confirmation.`;
		case "conflict":
			return `“${subject}” was rewritten and this edit no longer applies to it: ${status.reason}`;
		case "orphan":
			return `“${subject}” is no longer in the stack: it was dropped, or pushed or merged below the base. To edit pushed commits, set \`git config suonetar.base <ref>\` to an older base.`;
		case "elsewhere":
			return `“${subject}”, made on branch ${branchShort(status.draft.meta.branch)}.`;
		default: {
			const never: never = status;
			throw new Error(`unknown draft status ${String(never)}`);
		}
	}
}

// The stack, oldest commit at the top as `rebase -i` lists it, followed by drafts that need a decision.
export function stackRender(container: HTMLElement, ready: Ready, selected: string | undefined, handlers: StackViewHandlers): void {
	const stack = ready.stack;
	const edited = new Set(ready.drafts.flatMap((d) => (d.kind === "current" ? [d.commit.oid] : [])));
	const rows = el("div", { class: "commit-rows" });
	for (const commit of stack.commits) {
		const badges = el("span", { class: "badges" });
		if (edited.has(commit.oid)) {
			badges.append(el("span", { class: "badge badge-draft", text: "edited", title: "Has edits not yet applied" }));
		}
		if (draftPendingFor(ready, commit.oid) !== undefined) {
			badges.append(el("span", { class: "badge badge-warn", text: "pending", title: "An edit waits for confirmation" }));
		}
		if (commit.published) {
			badges.append(el("span", { class: "badge", text: "pushed", title: "Already on a remote; editing it means force-pushing later" }));
		}
		if (commit.signed) {
			badges.append(el("span", { class: "badge", text: "signed", title: "Rewriting it drops the signature unless commit signing is configured" }));
		}
		const row = el(
			"div",
			{ class: `commit-row${commit.oid === selected ? " selected" : ""}`, title: commit.authorLine.replace(/ \d+ [+-]\d{4}$/, ""), onclick: () => handlers.select(commit.oid) },
			el("span", { class: "oid", text: commit.oid.slice(0, 7) }),
			el("span", { class: "subject", text: commit.subject }),
			badges,
		);
		rows.append(row);
	}
	const base = el("div", { class: "stack-base", text: `on ${branchShort(stack.baseRef)} at ${stack.baseOid.slice(0, 7)}` });
	const parts: HTMLElement[] = [base, rows];
	if (stack.frozenBelow !== undefined) {
		parts.unshift(el("div", { class: "note", text: `The stack starts above merge ${stack.frozenBelow.slice(0, 7)}; commits below it are not editable.` }));
	}
	if (stack.leftBehind.length > 0) {
		parts.push(el("div", { class: "note", text: `Also on ${stack.leftBehind.join(", ")}: those branches keep the old commits when this stack is rewritten.` }));
	}
	const attention = ready.drafts.filter((d) => d.kind !== "current");
	if (attention.length > 0) {
		const list = el("div", { class: "drafts" }, el("h2", { text: "Edits needing a decision" }));
		for (const status of attention) {
			const actions = el(
				"div",
				{ class: "draft-actions" },
				button("View", () => handlers.draftView(status)),
			);
			if (status.kind === "rebased") {
				actions.append(button("Confirm", () => handlers.draftConfirm(status), "primary"));
			}
			if (status.kind === "elsewhere") {
				actions.append(button("Adopt here", () => handlers.draftAdopt(status)));
			}
			actions.append(button("Discard…", () => handlers.draftDiscard(status), "danger"));
			list.append(el("div", { class: `draft draft-${status.kind}` }, el("div", { text: draftDescribe(status) }), actions));
		}
		parts.push(list);
	}
	const scroll = container.scrollTop;
	container.replaceChildren(...parts);
	container.scrollTop = scroll;
	// Scrolled to only when the selection moved, so a refresh does not fight the user's scrolling.
	if (container.dataset.selected !== selected) {
		container.dataset.selected = selected ?? "";
		container.querySelector(".commit-row.selected")?.scrollIntoView({ block: "nearest" });
	}
}
