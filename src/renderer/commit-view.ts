import { getChunks } from "@codemirror/merge";
import { EditorView } from "@codemirror/view";
import type { CommitDocument, DocumentFile } from "../engine/session.ts";
import type { Wire } from "../shared/api.ts";
import { api, call, errorText } from "./api.ts";
import type { Autosave, AutosaveStatus } from "./autosave.ts";
import { bytesEqual, type TextCodec, textDecode, textShow } from "./codec.ts";
import { button, el } from "./dom.ts";
import { editorCreate } from "./editor.ts";
import { saveBytesFile, saveBytesMessage } from "./save-bytes.ts";

type Doc = Wire<CommitDocument>;
type File = Wire<DocumentFile>;

export type CommitViewSource =
	// `readOnly` explains why a commit's document cannot be edited right now, such as a draft waiting for a decision.
	| { readonly kind: "commit"; readonly oid: string; readonly readOnly: string | undefined }
	// A stored draft's own changes, shown read-only.
	| { readonly kind: "draft"; readonly against: string };

export type CommitViewHost = {
	readonly autosave: Autosave<number>;
	// The scrolling pane the document lives in.
	readonly scroller: HTMLElement;
	// Runs an action in the app's operation queue, which reports its failure.
	readonly op: (what: string, fn: () => Promise<void>) => Promise<void>;
	// Replaces this view with a fresh one read from disk, scrolled to `path`; called with every save flushed.
	readonly reload: (path: string) => Promise<void>;
};

type Section = {
	readonly file: File;
	readonly root: HTMLElement;
	readonly body: HTMLElement;
	readonly badges: HTMLElement;
	readonly actions: HTMLElement;
	readonly saveState: HTMLElement;
	// Binary content, or too large to show: never gets an editor.
	readonly opaque: boolean;
	editor: EditorView | undefined;
	expanded: boolean;
	// Diff against the commit instead of its parent, showing only the draft's edits.
	mine: boolean;
	// The editor's text differs from the commit's version; updated as saves land.
	edited: boolean;
	commitText: string | undefined;
};

const LARGE_LINES = 5000;
const LOCKFILE =
	/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum|flake\.lock|packages\.lock\.json)$/;

export function saveKeyFile(oid: string, path: string): string {
	return `${oid}\0${path}`;
}

export function saveKeyMessage(oid: string): string {
	return `${oid}\0`;
}

function newlines(bytes: Uint8Array | undefined): number {
	let count = 0;
	for (const b of bytes ?? []) {
		if (b === 10) {
			count++;
		}
	}
	return count;
}

function statusLabel(status: File["status"]): string {
	switch (status) {
		case "A":
			return "added";
		case "M":
			return "modified";
		case "D":
			return "deleted";
		case "T":
			return "type changed";
		case "=":
			return "unchanged by this commit";
		default: {
			const never: never = status;
			throw new Error(`unknown status ${String(never)}`);
		}
	}
}

// One commit as a single scrolling document: its message, then every changed file as an inline diff against the parent, editable in place.
export class CommitView {
	readonly root: HTMLElement;
	readonly #host: CommitViewHost;
	readonly #source: CommitViewSource;
	readonly #banners: HTMLElement;
	readonly #sections: Section[] = [];
	readonly #observer: IntersectionObserver;
	readonly #doc: Doc;
	#messageState: HTMLElement | undefined;

	private constructor(host: CommitViewHost, source: CommitViewSource, doc: Doc) {
		this.#host = host;
		this.#source = source;
		this.#doc = doc;
		this.#banners = el("div", { class: "banners" });
		this.root = el("div", { class: "commit-view" }, this.#banners);
		this.#observer = new IntersectionObserver((entries) => this.#onVisible(entries), { root: host.scroller, rootMargin: "1500px 0px" });
		this.#render();
	}

	static async create(host: CommitViewHost, source: CommitViewSource): Promise<CommitView> {
		const doc = await call(source.kind === "commit" ? api.commitDocument(source.oid) : api.draftDocument(source.against));
		return new CommitView(host, source, doc);
	}

	get oid(): string {
		return this.#doc.oid;
	}

	get #editable(): boolean {
		return this.#source.kind === "commit" && this.#source.readOnly === undefined;
	}

	bannersSet(nodes: readonly Node[]): void {
		this.#banners.replaceChildren(...nodes);
	}

	// Callers flush pending saves first. A save still pending reads its destroyed editor's final text, so even then nothing is lost.
	destroy(): void {
		this.#observer.disconnect();
		for (const s of this.#sections) {
			s.editor?.destroy();
		}
		this.root.remove();
	}

	saveStatus(key: string, status: AutosaveStatus, error: unknown): void {
		const target = key === saveKeyMessage(this.#doc.oid) ? this.#messageState : this.#sections.find((s) => saveKeyFile(this.#doc.oid, s.file.path) === key)?.saveState;
		if (target === undefined) {
			return;
		}
		target.className = `save-state save-${status}`;
		target.textContent = status === "failed" ? `save failed: ${errorText(error)} (retrying)` : status === "saved" ? "" : status === "pending" ? "unsaved" : "saving…";
	}

	sectionReveal(path: string): void {
		const section = this.#sections.find((s) => s.file.path === path);
		if (section !== undefined) {
			this.#sectionShow(section, false);
		}
	}

	#render(): void {
		const doc = this.#doc;
		const title = el("h1", { class: "commit-title" }, el("span", { class: "oid", text: doc.oid.slice(0, 10) }), " ", doc.subject);
		const list = el("ul", { class: "file-list" });
		this.root.append(title);
		if (this.#source.kind === "commit" && this.#source.readOnly !== undefined) {
			this.root.append(el("div", { class: "note", text: this.#source.readOnly }));
		}
		this.root.append(this.#messageRender(), list);
		if (doc.files.length === 0) {
			this.root.append(el("div", { class: "note", text: "No files changed." }));
		}
		for (const file of doc.files) {
			const section = this.#sectionCreate(file);
			this.#sections.push(section);
			this.root.append(section.root);
			list.append(el("li", { onclick: () => this.#sectionShow(section, true) }, el("span", { class: `status status-${file.status}`, text: file.status }), " ", file.path));
			this.#observer.observe(section.body);
		}
	}

	#messageRender(): HTMLElement {
		const doc = this.#doc;
		const state = el("span", { class: "save-state" });
		this.#messageState = state;
		const header = el("div", { class: "section-header" }, el("span", { class: "path", text: "Commit message" }), state);
		if (this.#source.kind === "draft" && doc.draftMessage === undefined) {
			return el("section", { class: "file message-section" }, header, el("div", { class: "note", text: "This edit leaves the message unchanged." }));
		}
		const original = doc.message;
		const decoded = textDecode(doc.draftMessage ?? original);
		const area = el("textarea", { class: "message" });
		area.spellcheck = false;
		if (decoded.kind === "binary") {
			area.value = "(the message contains NUL bytes and cannot be shown)";
			area.readOnly = true;
		} else {
			area.value = decoded.text;
			area.readOnly = !this.#editable || decoded.kind !== "text";
			if (decoded.kind === "readonly") {
				header.append(el("span", { class: "note-inline", text: `read-only: the message ${decoded.reason}` }));
			}
		}
		area.rows = Math.min(30, Math.max(3, area.value.split("\n").length + 1));
		if (decoded.kind === "text" && this.#editable) {
			const codec = decoded.codec;
			const oid = doc.oid;
			area.addEventListener("input", () => {
				area.rows = Math.min(30, Math.max(3, area.value.split("\n").length + 1));
				this.#host.autosave.schedule(saveKeyMessage(oid), async () => {
					await call(api.draftSetMessage(oid, saveBytesMessage(area.value, codec, original)));
				});
			});
		}
		return el("section", { class: "file message-section" }, header, area);
	}

	#sectionCreate(file: File): Section {
		const badges = el("span", { class: "badges" });
		const actions = el("span", { class: "actions" });
		const saveState = el("span", { class: "save-state" });
		const header = el(
			"div",
			{ class: "section-header" },
			el("span", { class: `status status-${file.status}`, text: file.status, title: statusLabel(file.status) }),
			el("span", { class: "path", text: file.path }),
			badges,
			saveState,
			actions,
		);
		const body = el("div", { class: "section-body" });
		const root = el("section", { class: "file" }, header, body);
		const large = LOCKFILE.test(file.path) || newlines(file.parent) + newlines(file.draft) > LARGE_LINES;
		const opaque = file.tooLarge || file.binary || (file.draft !== undefined && textDecode(file.draft).kind === "binary");
		const section: Section = {
			file,
			root,
			body,
			badges,
			actions,
			saveState,
			opaque,
			editor: undefined,
			expanded: !large,
			mine: false,
			edited: !bytesEqual(file.draft, file.commit),
			commitText: undefined,
		};
		header.addEventListener("click", () => {
			if (!section.expanded) {
				section.expanded = true;
				this.#bodyBuild(section, undefined);
				this.#editorBuild(section, undefined);
			}
		});
		this.#bodyBuild(section, undefined);
		return section;
	}

	#editorPossible(s: Section): boolean {
		return s.expanded && !s.opaque;
	}

	#onVisible(entries: readonly IntersectionObserverEntry[]): void {
		for (const entry of entries) {
			if (!entry.isIntersecting) {
				continue;
			}
			const section = this.#sections.find((s) => s.body === entry.target);
			if (section !== undefined && section.editor === undefined) {
				this.#editorBuild(section, undefined);
			}
		}
	}

	// The section's header and the placeholder its editor is created into once it scrolls near the viewport; with `docText`, the editor is created right away with that text.
	#bodyBuild(s: Section, docText: string | undefined): void {
		const f = s.file;
		s.editor?.destroy();
		s.editor = undefined;
		s.body.replaceChildren();
		s.body.style.minHeight = "";
		this.#headerUpdate(s);
		if (f.tooLarge) {
			s.body.append(el("div", { class: "note", text: "Too large to show here (over 4 MiB)." }));
		} else if (s.opaque) {
			s.body.append(el("div", { class: "note", text: "Binary file; not editable here." }));
		} else if (!s.expanded) {
			s.body.append(el("div", { class: "note clickable", text: "Large or generated file, collapsed. Click the header to show it." }));
		} else if (docText !== undefined) {
			this.#editorBuild(s, docText);
		} else {
			s.body.style.minHeight = "80px";
		}
	}

	#commitText(s: Section): string {
		s.commitText ??= textShow(s.file.commit);
		return s.commitText;
	}

	#editorBuild(s: Section, docText: string | undefined): void {
		if (!this.#editorPossible(s) || s.editor !== undefined) {
			return;
		}
		const f = s.file;
		s.body.style.minHeight = "";
		const original = s.mine ? this.#commitText(s) : textShow(f.parent);
		const decoded = f.draft === undefined ? undefined : textDecode(f.draft);
		let doc = "";
		let codec: TextCodec | undefined;
		let note: string | undefined;
		if (decoded === undefined) {
			note = f.commit === undefined ? "Deleted in this commit." : "Deleted by your edit.";
		} else if (decoded.kind === "readonly") {
			doc = decoded.text;
			note = `Read-only: the file ${decoded.reason}.`;
		} else if (decoded.kind === "text") {
			doc = docText ?? decoded.text;
			if (f.refusal !== undefined) {
				note = `Read-only: ${f.refusal}.`;
			} else if (this.#editable) {
				codec = decoded.codec;
			}
		}
		if (note !== undefined) {
			s.body.append(el("div", { class: "note", text: note }));
		}
		const onChange = codec === undefined ? undefined : this.#onChange(s, codec);
		s.editor = editorCreate(s.body, { path: f.path, doc, original, editable: codec !== undefined, onChange, extensions: [] });
		this.#headerUpdate(s);
	}

	#onChange(s: Section, codec: TextCodec): () => void {
		const oid = this.#doc.oid;
		const f = s.file;
		const key = saveKeyFile(oid, f.path);
		return () => {
			const view = s.editor;
			if (view === undefined) {
				return;
			}
			if (!s.edited) {
				s.edited = true;
				this.#headerUpdate(s);
			}
			this.#host.autosave.schedule(key, async () => {
				// A section rebuilt since then (always after a flush) saves through its new editor.
				if (s.editor !== view && s.editor !== undefined) {
					return;
				}
				const text = view.state.doc.toString();
				await call(api.draftSetFile(oid, f.path, saveBytesFile(text, codec, f)));
				const edited = text !== this.#commitText(s);
				if (edited !== s.edited) {
					s.edited = edited;
					this.#headerUpdate(s);
				}
			});
		};
	}

	#headerUpdate(s: Section): void {
		const f = s.file;
		s.badges.replaceChildren();
		if (s.edited) {
			s.badges.append(el("span", { class: "badge badge-draft", text: "edited" }));
		}
		if (f.refusal !== undefined) {
			s.badges.append(el("span", { class: "badge", text: "read-only" }));
		}
		s.actions.replaceChildren();
		if (!this.#editable || s.opaque) {
			return;
		}
		if ((s.edited || s.mine) && s.editor !== undefined && f.draft !== undefined && f.commit !== undefined) {
			s.actions.append(
				button(s.mine ? "Show whole change" : "Show my edits", () =>
					this.#rework("Switching the diff", async () => {
						s.mine = !s.mine;
						this.#bodyBuild(s, s.editor?.state.doc.toString());
					}),
				),
			);
		}
		if (s.edited) {
			s.actions.append(button("Revert my edits", () => this.#fileRestore(s, "commit")));
		}
		if (f.draft === undefined && (f.commit !== undefined || f.parent !== undefined)) {
			s.actions.append(button("Restore file", () => this.#fileRestore(s, f.commit !== undefined ? "commit" : "parent")));
		}
	}

	// Changes that replace editors run with the view inert and every pending save flushed, so no keystroke lands in an editor about to go away.
	#rework(what: string, fn: () => Promise<void>): void {
		void this.#host.op(what, async () => {
			this.root.inert = true;
			try {
				if (!(await this.#host.autosave.flush())) {
					throw new Error("pending edits could not be saved; nothing was changed");
				}
				await fn();
			} finally {
				this.root.inert = false;
			}
		});
	}

	// Puts the file back as it is in the commit or its parent, then rebuilds the view: restoring can change what other sections show.
	#fileRestore(s: Section, from: "commit" | "parent"): void {
		const oid = this.#doc.oid;
		const path = s.file.path;
		this.#rework("Restoring the file", async () => {
			await call(api.draftRestore(oid, path, from));
			await this.#host.reload(path);
		});
	}

	#sectionShow(s: Section, focus: boolean): void {
		this.#editorBuild(s, undefined);
		s.root.scrollIntoView({ block: "start" });
		if (focus) {
			s.editor?.focus();
		}
	}

	// The section holding focus, else the first one reaching into the viewport.
	#sectionCurrent(): number {
		const active = document.activeElement;
		const focused = this.#sections.findIndex((s) => active !== null && s.root.contains(active));
		if (focused !== -1) {
			return focused;
		}
		const top = this.#host.scroller.getBoundingClientRect().top;
		const visible = this.#sections.findIndex((s) => s.root.getBoundingClientRect().bottom > top + 1);
		return visible === -1 ? 0 : visible;
	}

	fileGo(dir: 1 | -1): void {
		const target = this.#sections[this.#sectionCurrent() + dir];
		if (target !== undefined) {
			this.#sectionShow(target, true);
		}
	}

	// Next or previous changed chunk across the whole document, continuing into the following sections.
	chunkGo(dir: 1 | -1): void {
		const start = this.#sectionCurrent();
		const current = this.#sections[start];
		const fromCursor = current !== undefined && document.activeElement !== null && current.root.contains(document.activeElement);
		for (let i = start; i >= 0 && i < this.#sections.length; i += dir) {
			const s = this.#sections[i];
			if (s === undefined) {
				continue;
			}
			this.#editorBuild(s, undefined);
			const view = s.editor;
			const chunks = view === undefined ? undefined : getChunks(view.state)?.chunks;
			if (view === undefined || chunks === undefined || chunks.length === 0) {
				continue;
			}
			const head = i === start && fromCursor ? view.state.selection.main.head : dir > 0 ? -1 : view.state.doc.length + 1;
			const target = dir > 0 ? chunks.find((c) => c.fromB > head) : chunks.findLast((c) => c.fromB < head);
			if (target !== undefined) {
				view.focus();
				view.dispatch({ selection: { anchor: target.fromB }, effects: EditorView.scrollIntoView(target.fromB, { y: "center" }) });
				return;
			}
		}
	}
}
