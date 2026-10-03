import { getChunks } from "@codemirror/merge";
import { EditorView } from "@codemirror/view";
import type { CommitDocument, DocumentFile } from "../engine/session.ts";
import type { WorktreeSide } from "../engine/worktree-changes.ts";
import type { Layout, Wire } from "../shared/api.ts";
import { api, call, errorText } from "./api.ts";
import type { Autosave, AutosaveStatus } from "./autosave.ts";
import { bytesEqual, type TextCodec, textDecode, textShow } from "./codec.ts";
import { button, el } from "./dom.ts";
import { editorCreate, editorDiffInline, editorDiffSet } from "./editor.ts";
import { statusClass, statusLabel } from "./file-status.ts";
import { fileTree, fileTreeHighlight, fileTreeOrder, fileTreeRender, sectionCurrentForView, type TreeNode } from "./file-tree.ts";
import { imageCompare, imagePanes } from "./image.ts";
import { PanesThree, type PanesThreeSpec } from "./panes-three.ts";
import { saveBytesFile, saveBytesMessage } from "./save-bytes.ts";
import { worktreeLabel } from "./stack-view.ts";

type Doc = Wire<CommitDocument>;
type File = Wire<DocumentFile>;

export type CommitViewSource =
	// `readOnly` explains why a commit's document cannot be edited right now, such as a draft waiting for a decision.
	| { readonly kind: "commit"; readonly oid: string; readonly readOnly: string | undefined }
	// A stored draft's own changes, shown read-only.
	| { readonly kind: "draft"; readonly against: string }
	// The working tree's staged or unstaged changes, shown read-only.
	| { readonly kind: "worktree"; readonly side: WorktreeSide };

// A view's contents, read ahead of building it so a refresh can swap views without a blank moment; `notes` are shown under the title.
export type CommitViewLoaded = { readonly doc: Doc; readonly notes: readonly string[] };

export type Carry = {
	readonly anchor: { readonly path: string; readonly index: number; readonly offset: number } | undefined;
	readonly expanded: readonly string[];
	readonly cursor: { readonly path: string; readonly head: number } | undefined;
};

export type CommitViewHost = {
	readonly autosave: Autosave<number>;
	// The scrolling pane the document lives in.
	readonly scroller: HTMLElement;
	// Runs an action in the app's operation queue, which reports its failure.
	readonly op: (what: string, fn: () => Promise<void>) => Promise<void>;
	// Replaces this view with a fresh one read from disk, scrolled to `path`; called with every save flushed.
	readonly reload: (path: string) => Promise<void>;
	// The sidebar pane the view draws its changed-files tree into while it exists.
	readonly files: HTMLElement;
	// Collapsed directories in that tree, by path; kept by the host so they survive switching commits.
	readonly collapsed: Set<string>;
	// The layout a new view starts in.
	readonly layout: () => Layout;
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
	// The editor holding the file's text, which saves go from; in three panes, the right one.
	editor: EditorView | undefined;
	panes: PanesThree | undefined;
	// Where the editor, or the panes holding it, sit in the section's body.
	slot: HTMLElement | undefined;
	// The editor's text is saved when edited.
	writable: boolean;
	// Built in the other layout, to be switched once it comes near the viewport.
	layoutStale: boolean;
	// Says why the file is inline while the view is in three panes; only for files that have to be.
	layoutNote: HTMLElement | undefined;
	expanded: boolean;
	// Collapsed when the view was built (large or generated), so expanding it was the reader's choice.
	readonly collapsedAtFirst: boolean;
	// Diff against the commit instead of its parent, showing only the draft's edits.
	mine: boolean;
	// The editor's text differs from the commit's version; updated as saves land.
	edited: boolean;
	commitText: string | undefined;
	// The blob a save is laid onto, which the engine checks is still there: the file as shown, then as last saved.
	shownOid: string | undefined;
};

// A line of a file the reader is at, and how far below the top of the view its text starts.
type Place = { readonly section: Section; readonly pos: number; readonly offset: number };

const LARGE_LINES = 5000;
// Frames the reader's place is held for after a layout switch, while the switched sections lay out, fold and line up (each takes a frame or two, and the sections switched as they come near take their own).
const PLACE_HOLD_FRAMES = 30;
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
	readonly #tree: readonly TreeNode[];
	readonly #notes: readonly string[];
	#destroyed = false;
	#layout: Layout;
	#placeFrame: number | undefined;
	#pointerDown = false;
	readonly #pointerUp = () => {
		this.#pointerDown = false;
	};
	#highlightFrame: number | undefined;
	readonly #highlightSchedule = () => {
		if (this.#highlightFrame === undefined) {
			this.#highlightFrame = requestAnimationFrame(() => {
				this.#highlightFrame = undefined;
				this.#highlight();
			});
		}
	};

	private constructor(host: CommitViewHost, source: CommitViewSource, doc: Doc, notes: readonly string[]) {
		this.#host = host;
		this.#source = source;
		this.#doc = doc;
		this.#notes = notes;
		this.#layout = host.layout();
		this.#banners = el("div", { class: "banners" });
		this.root = el("div", { class: "commit-view" }, this.#banners);
		this.#observer = new IntersectionObserver((entries) => this.#onVisible(entries), { root: host.scroller, rootMargin: "1500px 0px" });
		this.#tree = fileTree(doc.files);
		this.#render();
		this.#treeRender();
		host.files.hidden = false;
		host.scroller.addEventListener("scroll", this.#highlightSchedule, { passive: true });
		this.root.addEventListener("focusin", this.#highlightSchedule);
		this.root.addEventListener("pointerdown", () => {
			this.#pointerDown = true;
		});
		window.addEventListener("pointerup", this.#pointerUp);
		this.#highlightSchedule();
	}

	static async create(host: CommitViewHost, source: CommitViewSource): Promise<CommitView> {
		return CommitView.build(host, source, await CommitView.load(source));
	}

	static async load(source: CommitViewSource): Promise<CommitViewLoaded> {
		switch (source.kind) {
			case "commit":
				return { doc: await call(api.commitDocument(source.oid)), notes: [] };
			case "draft":
				return { doc: await call(api.draftDocument(source.against)), notes: [] };
			case "worktree": {
				const worktree = await call(api.worktreeDocument(source.side));
				const notes = [
					worktree.conflicted ? "The index has unresolved conflicts (a merge or rebase stopped); conflicted files are shown against our side." : "",
					worktree.omitted > 0 ? `${worktree.omitted} more file${worktree.omitted === 1 ? " is" : "s are"} not shown.` : "",
				].filter((n) => n !== "");
				const doc: Doc = {
					oid: "",
					parent: "",
					parentTree: "",
					tree: "",
					subject: worktreeLabel(source.side),
					message: new Uint8Array(),
					draftMessage: undefined,
					hasDraft: false,
					files: worktree.files,
				};
				return { doc, notes };
			}
			default: {
				const never: never = source;
				throw new Error(`unknown view source ${String(never)}`);
			}
		}
	}

	static build(host: CommitViewHost, source: CommitViewSource, loaded: CommitViewLoaded): CommitView {
		return new CommitView(host, source, loaded.doc, loaded.notes);
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
		this.#destroyed = true;
		this.#host.scroller.removeEventListener("scroll", this.#highlightSchedule);
		this.root.removeEventListener("focusin", this.#highlightSchedule);
		window.removeEventListener("pointerup", this.#pointerUp);
		if (this.#highlightFrame !== undefined) {
			cancelAnimationFrame(this.#highlightFrame);
		}
		this.#placeRelease();
		// Emptied but left shown: the next commit view fills it, and hiding it in between would resize the stack pane under its own scrolling. Views without files hide it.
		this.#host.files.replaceChildren();
		this.#observer.disconnect();
		for (const s of this.#sections) {
			this.#editorDestroy(s);
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

	// The reader's place, for a rebuilt view of the same document to return to: the file at the top of the view and how far into it (with its position, should that file be gone), sections they expanded, and the focused editor's cursor.
	carry(): Carry {
		const current = this.#sectionCurrent();
		const section = this.#sections[current];
		const anchor =
			section === undefined
				? undefined
				: { path: section.file.path, index: current, offset: this.#host.scroller.getBoundingClientRect().top - section.root.getBoundingClientRect().top };
		const expanded = this.#sections.filter((s) => s.expanded && s.collapsedAtFirst).map((s) => s.file.path);
		const active = document.activeElement;
		const focused = this.#sections.find((s) => s.editor !== undefined && active !== null && s.editor.dom.contains(active));
		const cursor = focused?.editor === undefined ? undefined : { path: focused.file.path, head: focused.editor.state.selection.main.head };
		return { anchor, expanded, cursor };
	}

	carryRestore(carry: Carry): void {
		for (const s of this.#sections) {
			if (carry.expanded.includes(s.file.path) && !s.expanded) {
				s.expanded = true;
				this.#bodyBuild(s, undefined);
			}
		}
		const anchor = carry.anchor;
		const section =
			anchor === undefined ? undefined : (this.#sections.find((s) => s.file.path === anchor.path) ?? this.#sections[Math.min(anchor.index, this.#sections.length - 1)]);
		if (anchor !== undefined && section !== undefined) {
			this.#editorBuild(section, undefined);
			const scroller = this.#host.scroller;
			const offset = section.file.path === anchor.path ? anchor.offset : 0;
			scroller.scrollTop += section.root.getBoundingClientRect().top - scroller.getBoundingClientRect().top + offset;
		}
		const cursor = carry.cursor;
		const focused = cursor === undefined ? undefined : this.#sections.find((s) => s.file.path === cursor.path);
		if (cursor !== undefined && focused !== undefined) {
			this.#editorBuild(focused, undefined);
			const editor = focused.editor;
			if (editor !== undefined) {
				editor.dispatch({ selection: { anchor: Math.min(cursor.head, editor.state.doc.length) } });
				editor.contentDOM.focus({ preventScroll: true });
			}
		}
	}

	// Whether the reader is in the middle of something a rebuild would undo: pressing the mouse, or holding a selection in the focused editor.
	holding(): boolean {
		const active = document.activeElement;
		return this.#pointerDown || this.#sections.some((s) => s.editor !== undefined && active !== null && s.editor.dom.contains(active) && !s.editor.state.selection.main.empty);
	}

	sectionReveal(path: string): void {
		const section = this.#sections.find((s) => s.file.path === path);
		if (section !== undefined) {
			this.#sectionShow(section, false);
		}
	}

	#render(): void {
		const doc = this.#doc;
		const worktree = this.#source.kind === "worktree";
		const title = worktree
			? el("h1", { class: "commit-title worktree-title", text: doc.subject })
			: el("h1", { class: "commit-title" }, el("span", { class: "oid", text: doc.oid.slice(0, 10) }), " ", doc.subject);
		this.root.append(title);
		if (this.#source.kind === "commit" && this.#source.readOnly !== undefined) {
			this.root.append(el("div", { class: "note", text: this.#source.readOnly }));
		}
		for (const note of this.#notes) {
			this.root.append(el("div", { class: "note", text: note }));
		}
		// Uncommitted changes have no message.
		if (!worktree) {
			this.root.append(this.#messageRender());
		}
		if (doc.files.length === 0) {
			this.root.append(el("div", { class: "note", text: "No files changed." }));
		}
		// In the tree's order, so reading down the document walks down the tree.
		const byPath = new Map(doc.files.map((file) => [file.path, file]));
		for (const path of fileTreeOrder(this.#tree)) {
			const file = byPath.get(path);
			if (file === undefined) {
				throw new Error(`${path} is in the file tree but not in the document`);
			}
			const section = this.#sectionCreate(file);
			this.#sections.push(section);
			this.root.append(section.root);
			this.#observer.observe(section.body);
		}
	}

	#treeRender(): void {
		fileTreeRender(this.#host.files, this.#tree, this.#host.collapsed, {
			// Queued like other navigation; by its turn this view may have been replaced, and then the click is moot.
			reveal: (path) =>
				void this.#host.op("Showing the file", async () => {
					const section = this.#sections.find((s) => s.file.path === path);
					if (!this.#destroyed && section !== undefined) {
						this.#sectionShow(section, true);
					}
				}),
			toggled: () => this.#highlight(),
		});
	}

	// Marks the file the reader is at in the tree, keeping its row in sight.
	#highlight(): void {
		const moved = fileTreeHighlight(this.#host.files, this.#sections[this.#sectionCurrent()]?.file.path);
		moved?.scrollIntoView({ block: "nearest" });
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
			el("span", { class: statusClass(file.status), text: file.status, title: statusLabel(file.status) }),
			el("span", { class: "path", text: file.path }),
			badges,
			saveState,
			actions,
		);
		const body = el("div", { class: "section-body" });
		const root = el("section", { class: "file" }, header, body);
		const opaque = file.tooLarge || file.binary || (file.draft !== undefined && textDecode(file.draft).kind === "binary");
		// Collapsing is for long text; an opaque file is shown whole (or as a note) either way.
		const large = !opaque && (LOCKFILE.test(file.path) || newlines(file.parent) + newlines(file.draft) > LARGE_LINES);
		const section: Section = {
			file,
			root,
			body,
			badges,
			actions,
			saveState,
			opaque,
			editor: undefined,
			panes: undefined,
			slot: undefined,
			writable: false,
			layoutStale: false,
			layoutNote: undefined,
			expanded: !large,
			collapsedAtFirst: large,
			mine: false,
			// Where the commit's own version is unknown (restacking it conflicts), the user's edits cannot be told apart.
			edited: !file.mineUnknown && !bytesEqual(file.draft, file.commit),
			commitText: undefined,
			shownOid: file.draftOid,
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
			} else if (section?.layoutStale) {
				this.#layoutApply(section);
			}
		}
	}

	// The section's header and the placeholder its editor is created into once it scrolls near the viewport; with `docText`, the editor is created right away with that text.
	#bodyBuild(s: Section, docText: string | undefined): void {
		const f = s.file;
		this.#editorDestroy(s);
		s.body.replaceChildren();
		s.body.style.minHeight = "";
		this.#headerUpdate(s);
		if (f.tooLarge) {
			s.body.append(el("div", { class: "note", text: "Too large to show here (over 4 MiB)." }));
		} else if (s.opaque) {
			const panes = imagePanes(f);
			s.body.append(panes === undefined ? el("div", { class: "note", text: "Binary file; not editable here." }) : imageCompare(panes));
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
			note = this.#source.kind === "worktree" ? "Deleted." : f.commit === undefined ? "Deleted in this commit." : "Deleted by your edit.";
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
		if (this.#source.kind === "commit" && f.mineUnknown) {
			s.layoutNote = el("div", {
				class: "note",
				text: "Shown inline: this commit's original change to the file conflicts with the edits below it, so there is no version without your edits to show beside them.",
			});
			s.body.append(s.layoutNote);
		}
		const onChange = codec === undefined ? undefined : this.#onChange(s, codec);
		s.writable = codec !== undefined;
		const panes = this.#panesWanted(s);
		s.slot = el("div", {});
		s.body.append(s.slot);
		s.editor = editorCreate(s.slot, {
			path: f.path,
			doc,
			original: panes ? undefined : original,
			editable: s.writable,
			onChange,
			extensions: [],
			indentation: f.indentation,
		});
		if (panes) {
			s.panes = new PanesThree(s.editor, this.#panesSpec(s));
			s.slot.replaceChildren(s.panes.root);
		}
		this.#layoutNoteUpdate(s);
		this.#headerUpdate(s);
	}

	#editorDestroy(s: Section): void {
		s.panes?.destroy();
		s.panes = undefined;
		s.editor?.destroy();
		s.editor = undefined;
		s.slot = undefined;
		s.layoutNote = undefined;
		s.layoutStale = false;
	}

	#panesWanted(s: Section): boolean {
		return this.#layout === "three" && this.#source.kind === "commit" && !s.file.mineUnknown;
	}

	#panesSpec(s: Section): PanesThreeSpec {
		const f = s.file;
		return {
			path: f.path,
			parent: f.parent === undefined ? undefined : textShow(f.parent),
			commit: f.commit === undefined ? undefined : this.#commitText(s),
			revertable: s.writable,
			indentation: f.indentation,
		};
	}

	#layoutNoteUpdate(s: Section): void {
		if (s.layoutNote !== undefined) {
			s.layoutNote.hidden = this.#layout !== "three";
		}
	}

	// Switches a built section to the view's layout, keeping its editor (and so its undo history and unsaved text).
	#layoutApply(s: Section): void {
		s.layoutStale = false;
		const editor = s.editor;
		const slot = s.slot;
		if (editor === undefined || slot === undefined) {
			return;
		}
		const wanted = this.#panesWanted(s);
		// Moving the editor's DOM in or out of the panes takes the focus from it, or from whichever pane had it.
		const active = document.activeElement;
		const focused = editor.hasFocus || (active !== null && s.panes?.root.contains(active) === true);
		if (wanted && s.panes === undefined) {
			s.mine = false;
			s.panes = new PanesThree(editor, this.#panesSpec(s));
			slot.replaceChildren(s.panes.root);
		} else if (!wanted && s.panes !== undefined) {
			s.panes.destroy();
			s.panes = undefined;
			slot.replaceChildren(editor.dom);
			editorDiffSet(editor, editorDiffInline(s.mine ? this.#commitText(s) : textShow(s.file.parent), s.writable));
		}
		if (focused && !editor.hasFocus) {
			editor.focus();
		}
		this.#layoutNoteUpdate(s);
		this.#headerUpdate(s);
	}

	// Changes the layout in place: every built section is marked to switch, and observed afresh, so the observer reports those near the viewport at once (and switches them) and the rest as they come near. The reader's place is held while the switched sections settle.
	layoutSet(layout: Layout): void {
		if (this.#destroyed || layout === this.#layout) {
			return;
		}
		const place = this.#placeTake();
		this.#layout = layout;
		for (const s of this.#sections) {
			if (s.editor !== undefined) {
				s.layoutStale = true;
				this.#observer.unobserve(s.body);
				this.#observer.observe(s.body);
			}
		}
		this.#placeHold(place);
	}

	// The line of the file at the top of the view, and how far below the view's top it is.
	#placeTake(): Place | undefined {
		const section = this.#sections[this.#sectionCurrent()];
		const editor = section?.editor;
		if (section === undefined || editor === undefined) {
			return undefined;
		}
		const top = this.#host.scroller.getBoundingClientRect().top;
		const pos = editor.lineBlockAtHeight(top - editor.documentTop).from;
		return { section, pos, offset: this.#placeTop(editor, pos) - top };
	}

	// Where a line's text starts on screen; spacers and folds above it in its own line block are not part of it.
	#placeTop(editor: EditorView, pos: number): number {
		return editor.coordsAtPos(pos, 1)?.top ?? editor.documentTop + editor.lineBlockAt(pos).top;
	}

	// Keeps the reader's place for a few frames while the switched sections lay out and line up, unless the reader moves first.
	#placeHold(place: Place | undefined): void {
		this.#placeRelease();
		if (place === undefined) {
			return;
		}
		let frames = 0;
		const scroller = this.#host.scroller;
		const tick = (): void => {
			const editor = place.section.editor;
			if (this.#destroyed || editor === undefined || ++frames > PLACE_HOLD_FRAMES) {
				this.#placeRelease();
				return;
			}
			scroller.scrollTop += this.#placeTop(editor, Math.min(place.pos, editor.state.doc.length)) - scroller.getBoundingClientRect().top - place.offset;
			this.#placeFrame = requestAnimationFrame(tick);
		};
		for (const type of ["wheel", "pointerdown", "keydown"]) {
			window.addEventListener(type, this.#placeRelease, { once: true, capture: true });
		}
		tick();
	}

	readonly #placeRelease = (): void => {
		if (this.#placeFrame !== undefined) {
			cancelAnimationFrame(this.#placeFrame);
			this.#placeFrame = undefined;
		}
		for (const type of ["wheel", "pointerdown", "keydown"]) {
			window.removeEventListener(type, this.#placeRelease, { capture: true });
		}
	};

	#onChange(s: Section, codec: TextCodec): () => void {
		const oid = this.#doc.oid;
		const f = s.file;
		const key = saveKeyFile(oid, f.path);
		return () => {
			const view = s.editor;
			if (view === undefined) {
				return;
			}
			if (!s.edited && !f.mineUnknown) {
				s.edited = true;
				this.#headerUpdate(s);
			}
			this.#host.autosave.schedule(key, async () => {
				// A section rebuilt since then (always after a flush) saves through its new editor.
				if (s.editor !== view && s.editor !== undefined) {
					return;
				}
				const text = view.state.doc.toString();
				s.shownOid = (await call(api.draftSetFile(oid, this.#doc.parentTree, f.path, s.shownOid ?? null, saveBytesFile(text, codec, f)))) ?? undefined;
				const edited = !f.mineUnknown && text !== this.#commitText(s);
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
		if (f.provisional) {
			s.badges.append(
				el("span", { class: "badge badge-warn", text: "without edits below", title: "A conflict below is not resolved yet, so this file is shown without the edits below it." }),
			);
		}
		s.actions.replaceChildren();
		if (!this.#editable || s.opaque) {
			return;
		}
		if ((s.edited || s.mine) && s.editor !== undefined && s.panes === undefined && f.draft !== undefined && f.commit !== undefined) {
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
			// Queued behind a switch away from this view, which destroyed it.
			if (this.#destroyed) {
				return;
			}
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
			await call(api.draftRestore(oid, this.#doc.parentTree, path, from));
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

	// The section the reader is at (`sectionCurrentForView`); the tree marks it, and file and change navigation start from it.
	#sectionCurrent(): number {
		const view = this.#host.scroller.getBoundingClientRect();
		const active = document.activeElement;
		const focused = this.#sections.findIndex((s) => active !== null && s.root.contains(active));
		return sectionCurrentForView(
			this.#sections.map((s) => s.root.getBoundingClientRect()),
			focused,
			view.top,
			view.bottom,
		);
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
			if (s.layoutStale) {
				this.#layoutApply(s);
			}
			const view = s.editor;
			const stops = view === undefined ? undefined : (s.panes?.stops() ?? getChunks(view.state)?.chunks.map((c) => c.fromB));
			if (view === undefined || stops === undefined || stops.length === 0) {
				continue;
			}
			const head = i === start && fromCursor ? (s.panes?.head() ?? view.state.selection.main.head) : dir > 0 ? -1 : view.state.doc.length + 1;
			const target = dir > 0 ? stops.find((p) => p > head) : stops.findLast((p) => p < head);
			if (target !== undefined) {
				view.focus();
				view.dispatch({ selection: { anchor: target }, effects: EditorView.scrollIntoView(target, { y: "center" }) });
				return;
			}
		}
	}
}
