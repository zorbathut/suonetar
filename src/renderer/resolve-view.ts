import { type EditorState, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import type { ConflictStage } from "../engine/merge.ts";
import type { ConflictReport, MergetoolOutcome, ResolutionChoice } from "../engine/session.ts";
import type { Wire } from "../shared/api.ts";
import { api, call, errorText } from "./api.ts";
import { type TextCodec, textDecode, textEncode, textShow } from "./codec.ts";
import { type BlockChoice, conflictBlocks, conflictChoose, conflictRelabel, conflictRelabelMarkers, conflictsCombine } from "./conflicts.ts";
import { ask, button, el } from "./dom.ts";
import { editorCreate } from "./editor.ts";
import { imageElement, imageType } from "./image.ts";

export type Report = Wire<ConflictReport>;
type Record = Report["conflicts"][number];
type Choice = Wire<ResolutionChoice>;

export type ResolveViewHost = {
	readonly op: (what: string, fn: () => Promise<void>) => Promise<void>;
	// Called after a resolution was stored; the host previews again and updates or replaces this view.
	readonly onResolved: () => Promise<void>;
	// Marks the app busy (cancellable) while an external merge tool is open, and not busy once it is closed; `message` goes to the status line either way.
	readonly busy: (on: boolean, message: string) => void;
};

type Row = {
	readonly record: Record;
	readonly root: HTMLElement;
	// Unsaved work that leaving the view would lose.
	dirty: () => boolean;
	destroy: () => void;
};

const BLOCK_LABELS: readonly (readonly [BlockChoice, string])[] = [
	["ours", "Keep below"],
	["theirs", "Keep this commit"],
	["both", "Keep both"],
];

class BlockButtons extends WidgetType {
	readonly #index: number;

	constructor(index: number) {
		super();
		this.#index = index;
	}

	override eq(other: BlockButtons): boolean {
		return other.#index === this.#index;
	}

	override toDOM(view: EditorView): HTMLElement {
		const index = this.#index;
		const bar = el("div", { class: "block-buttons" });
		for (const [choice, label] of BLOCK_LABELS) {
			const b = button(label, () => {
				const block = conflictBlocks(view.state.doc.toString())[index];
				if (block !== undefined) {
					view.dispatch({ changes: { from: block.from, to: block.to, insert: conflictChoose(block, choice) }, userEvent: "input.choose" });
				}
			});
			b.addEventListener("mousedown", (e) => e.preventDefault());
			bar.append(b);
		}
		return bar;
	}

	override ignoreEvent(): boolean {
		return true;
	}
}

const MARKER_LINE = /^(<{7,}|\|{7,}|={7,}$|>{7,})/;

function blockDecorations(state: EditorState): DecorationSet {
	const text = state.doc.toString();
	const ranges: Range<Decoration>[] = [];
	conflictBlocks(text).forEach((block, index) => {
		ranges.push(Decoration.widget({ widget: new BlockButtons(index), block: true, side: -1 }).range(block.from));
		for (let pos = block.from; pos < block.to; ) {
			const line = state.doc.lineAt(pos);
			if (MARKER_LINE.test(line.text)) {
				ranges.push(Decoration.line({ class: "cm-conflict-marker" }).range(line.from));
			}
			pos = line.to + 1;
		}
	});
	return Decoration.set(ranges, true);
}

const blocksField = StateField.define<DecorationSet>({
	create: blockDecorations,
	update: (value, tr) => (tr.docChanged ? blockDecorations(tr.state) : value),
	provide: (field) => EditorView.decorations.from(field),
});

function stageLabel(stage: 1 | 2 | 3): string {
	switch (stage) {
		case 1:
			return "base version";
		case 2:
			return "below's version";
		case 3:
			return "this commit's version";
		default: {
			const never: never = stage;
			throw new Error(`unknown stage ${String(never)}`);
		}
	}
}

function modeNote(mode: string): string {
	switch (mode) {
		case "120000":
			return " (symlink)";
		case "160000":
			return " (submodule)";
		case "100755":
			return " (executable)";
		default:
			return "";
	}
}

// The file/directory conflict's pair of paths: git moves the file aside to `<path>~<tree>` so the directory can stay at `<path>`.
function fileDirectoryPair(record: Record): { dir: string; aside: string } | undefined {
	if (!record.type.includes("file/directory") && !record.type.includes("directory/file")) {
		return undefined;
	}
	for (const aside of record.paths) {
		const dir = record.paths.find((p) => aside.startsWith(`${p}~`));
		if (dir !== undefined) {
			return { dir, aside };
		}
	}
	return undefined;
}

// Everything that must be decided before one commit can be replayed onto the edits below it.
export class ResolveView {
	readonly root: HTMLElement;
	readonly #host: ResolveViewHost;
	#report: Report;
	readonly #labels: ReadonlyMap<string, string>;
	readonly #rows: Row[] = [];
	readonly #banners: HTMLElement;
	// The configured merge tool, offered for content conflicts.
	readonly #tool: string | undefined;

	private constructor(host: ResolveViewHost, report: Report, tool: string | undefined) {
		this.#host = host;
		this.#report = report;
		this.#tool = tool;
		const own = report.edited ? "this commit as you edited it" : "this commit";
		this.#labels = new Map([
			[report.inputs.ours, "below"],
			[report.inputs.theirs, own],
			[report.inputs.base, "base"],
		]);
		const commit = report.commit;
		this.#banners = el("div", { class: "banners" });
		this.root = el(
			"div",
			{ class: "resolve-view" },
			this.#banners,
			el("h1", { class: "commit-title" }, "Conflict: ", el("span", { class: "oid", text: commit.oid.slice(0, 10) }), " ", commit.subject),
			el("p", {
				class: "explain",
				text: `Restacking this commit onto the edits below it conflicts. “below” is the commits underneath as they are now, including your edits; “${own}” is this commit's own change${report.edited ? ", with your edits to it or an earlier resolution" : ""}; “base” is the parent it was made on.`,
			}),
		);
	}

	static async create(host: ResolveViewHost, report: Report): Promise<ResolveView> {
		const view = new ResolveView(host, report, await call(api.mergetoolName()));
		await view.#render();
		return view;
	}

	get oid(): string {
		return this.#report.commit.oid;
	}

	bannersSet(nodes: readonly Node[]): void {
		this.#banners.replaceChildren(...nodes);
	}

	// Whether this view shows the same merge as `report`, so it can be updated in place.
	sameMerge(report: Report): boolean {
		const a = this.#report;
		return a.markerTree === report.markerTree && a.inputs.base === report.inputs.base && a.inputs.ours === report.inputs.ours && a.inputs.theirs === report.inputs.theirs;
	}

	// Marks the records that are now resolved, keeping unsaved work in the others.
	update(report: Report): void {
		this.#report = report;
		for (const row of this.#rows) {
			if (report.conflicts.find((c) => c.key === row.record.key)?.resolved === true) {
				this.#rowResolved(row);
			}
		}
	}

	dirty(): boolean {
		return this.#rows.some((r) => r.dirty());
	}

	destroy(): void {
		for (const row of this.#rows) {
			row.destroy();
		}
		this.root.remove();
	}

	#relabel(text: string): string {
		return conflictRelabel(text, this.#labels);
	}

	async #render(): Promise<void> {
		const records = this.#report.conflicts;
		const pairs = records.flatMap((r) => {
			const pair = fileDirectoryPair(r);
			return pair === undefined ? [] : [{ record: r, ...pair }];
		});
		const asides = new Set(pairs.map((p) => p.aside));
		// Records only about a moved-aside file are settled by the file/directory choice.
		const followers = records.filter((r) => fileDirectoryPair(r) === undefined && r.paths.every((p) => asides.has(p)));
		for (const record of records) {
			if (followers.includes(record)) {
				continue;
			}
			const pair = pairs.find((p) => p.record === record);
			let row: Row;
			if (pair !== undefined) {
				row = this.#rowFileDirectory(record, pair.dir, pair.aside, followers);
			} else if (record.kind === "content") {
				row = await this.#rowContent(record);
			} else {
				row = this.#rowStructural(record);
			}
			this.#rows.push(row);
			this.root.append(row.root);
			if (record.resolved) {
				this.#rowResolved(row);
			}
		}
	}

	#rowHeader(record: Record): HTMLElement {
		return el(
			"div",
			{ class: "record-header" },
			el("span", { class: "record-type", text: record.type }),
			el("div", { class: "record-message", text: this.#relabel(record.message) }),
		);
	}

	#rowResolved(row: Row): void {
		row.destroy();
		row.destroy = () => undefined;
		row.dirty = () => false;
		row.root.replaceChildren(el("div", { class: "record-resolved", text: `✓ resolved — ${this.#relabel(row.record.message)}` }));
	}

	// Stores the choices for one record (and for records that follow from it), then lets the host move on.
	#save(record: Record, choices: readonly Choice[], followers: readonly { record: Record; choices: readonly Choice[] }[], status: HTMLElement): void {
		const inputs = this.#report.inputs;
		status.textContent = "";
		void this.#host.op("Saving the resolution", async () => {
			try {
				for (const [key, chosen] of [[record.key, choices] as const, ...followers.map((f) => [f.record.key, f.choices] as const)]) {
					const result = await call(api.resolve(inputs, key, chosen));
					if (result.kind === "invalid") {
						status.textContent = result.reason;
						return;
					}
				}
			} catch (err) {
				status.textContent = errorText(err);
				throw err;
			}
			for (const row of this.#rows) {
				if (row.record.key === record.key) {
					this.#rowResolved(row);
				}
			}
			await this.#host.onResolved();
		});
	}

	async #rowContent(record: Record): Promise<Row> {
		const root = el("section", { class: "record" }, this.#rowHeader(record));
		const status = el("div", { class: "record-status" });
		const editors: { path: string; view: EditorView; codec: TextCodec; initial: string }[] = [];
		for (const path of record.paths) {
			const bytes = await call(api.blobAt(this.#report.markerTree, path));
			const decoded = bytes === undefined ? undefined : textDecode(bytes);
			if (decoded?.kind !== "text") {
				// Not editable as text after all; fall back to picking a version.
				for (const e of editors) {
					e.view.destroy();
				}
				return this.#rowStructural(record);
			}
			const initial = conflictRelabelMarkers(decoded.text, this.#labels);
			const holder = el("div", { class: "section-body" });
			const counter = el("span", { class: "record-count" });
			const header = el("div", { class: "section-header" }, el("span", { class: "path", text: path }), counter);
			root.append(header, holder);
			const update = () => {
				const left = conflictBlocks(view.state.doc.toString()).length;
				counter.textContent = left === 0 ? "no conflict blocks left" : `${left} conflict block${left === 1 ? "" : "s"} left`;
			};
			const indentation = await call(api.indentation(this.#report.markerTree, path));
			const view = editorCreate(holder, { path, doc: initial, original: undefined, editable: true, onChange: () => update(), extensions: [blocksField], indentation });
			update();
			const actions = el("span", { class: "actions" });
			const combined = await this.#combined(record, path);
			if (combined !== undefined) {
				actions.append(
					button("Combine both changes", () => {
						view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: combined }, userEvent: "input.combine" });
						status.textContent = `${path}: both changes made together, as the two sides only touch. Check it, then Save resolution.`;
					}),
				);
			}
			const tool = this.#tool;
			if (tool !== undefined) {
				actions.append(button(`Open in ${tool}`, () => this.#mergetoolOpen(tool, record, path, view, decoded.codec, status)));
			}
			header.append(actions);
			editors.push({ path, view, codec: decoded.codec, initial });
		}
		root.append(
			el(
				"div",
				{ class: "record-actions" },
				button(
					"Save resolution",
					() => {
						const withMarkers = editors.filter((e) => conflictBlocks(e.view.state.doc.toString()).length > 0);
						const choicesFor = (markersAllowed: boolean): Choice[] =>
							editors.map((e) => ({ path: e.path, content: textEncode(e.view.state.doc.toString(), e.codec), markersAllowed }));
						if (withMarkers.length === 0) {
							this.#save(record, choicesFor(false), [], status);
							return;
						}
						void ask("Conflict markers remain", `${withMarkers.map((e) => e.path).join(", ")} still contains conflict blocks. Save it with the markers in the file?`, [
							{ label: "Save with markers", value: "save" },
							{ label: "Keep editing", value: "cancel", primary: true },
						]).then((answer) => {
							if (answer === "save") {
								this.#save(record, choicesFor(true), [], status);
							}
						});
					},
					"primary",
				),
				status,
			),
		);
		return {
			record,
			root,
			dirty: () => editors.some((e) => e.view.state.doc.toString() !== e.initial),
			destroy: () => {
				for (const e of editors) {
					e.view.destroy();
				}
			},
		};
	}

	// Both sides' changes to `path` made together, when they only touch (see `conflictsCombine`); undefined when they overlap, or a side is missing or not text.
	async #combined(record: Record, path: string): Promise<string | undefined> {
		const text = async (stage: 1 | 2 | 3): Promise<string | undefined> => {
			const oid = record.stages[path]?.find((s) => s.stage === stage)?.oid;
			const bytes = oid === undefined ? undefined : await call(api.blob(oid));
			const decoded = bytes === undefined ? undefined : textDecode(bytes);
			return decoded?.kind === "text" ? decoded.text : undefined;
		};
		const [base, ours, theirs] = [await text(1), await text(2), await text(3)];
		return base === undefined || ours === undefined || theirs === undefined ? undefined : conflictsCombine(base, ours, theirs);
	}

	// Hands the path to the merge tool, starting from the editor's text, and puts the tool's result into the editor for review; Save resolution still stores it.
	#mergetoolOpen(tool: string, record: Record, path: string, view: EditorView, codec: TextCodec, status: HTMLElement): void {
		void this.#host.op(`Opening ${tool}`, async () => {
			status.textContent = "";
			this.#host.busy(true, `Waiting for ${tool} to close… Cancel stops waiting; close the tool's own window yourself.`);
			let result: Wire<MergetoolOutcome>;
			try {
				result = await call(api.mergetool(this.#report.inputs, record.key, path, textEncode(view.state.doc.toString(), codec)));
			} finally {
				this.#host.busy(false, `${tool} closed; see the conflict for what it did.`);
			}
			switch (result.kind) {
				case "merged": {
					const decoded = textDecode(result.content);
					if (decoded.kind !== "text") {
						// Loading it into the editor would change its bytes, and dropping it would lose the merge: it can be stored exactly as the tool wrote it.
						const why = decoded.kind === "binary" ? "is not text" : decoded.reason;
						if (record.paths.length !== 1) {
							status.textContent = `${tool}'s result for ${path} ${why}, so it cannot be shown here; resolve it in the editor instead.`;
							return;
						}
						const content = result.content;
						status.replaceChildren(
							`${tool}'s result for ${path} ${why}, so it cannot be shown here. `,
							button("Save the tool's result as is", () => this.#save(record, [{ path, content, markersAllowed: true }], [], status)),
						);
						return;
					}
					view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: decoded.text }, userEvent: "input.mergetool" });
					status.textContent = `${path} merged in ${tool}. Check it, then Save resolution.`;
					return;
				}
				case "unresolved": {
					const tail = result.output.trim().split("\n").slice(-3).join(" ");
					status.textContent = `${tool} did not resolve ${path}${tail === "" ? "." : `: ${tail}`}`;
					return;
				}
				case "cancelled":
					status.textContent = `Stopped waiting for ${tool}; anything it saves now is ignored.`;
					return;
				case "unconfigured":
					status.textContent = "No merge tool is configured (git config merge.tool).";
					return;
				case "stale":
					status.textContent = "That conflict no longer occurs; apply again to see the current state.";
					return;
				default: {
					const never: never = result;
					throw new Error(`unknown merge tool result ${String(never)}`);
				}
			}
		});
	}

	#stagePreview(stage: Wire<ConflictStage>): HTMLElement {
		const details = el("details", { class: "stage-preview" }, el("summary", { text: "show" }));
		const pre = el("pre", {});
		details.append(pre);
		let loaded = false;
		details.addEventListener("toggle", () => {
			if (!details.open || loaded) {
				return;
			}
			loaded = true;
			call(api.blob(stage.oid)).then(
				(bytes) => {
					if (bytes === undefined) {
						pre.textContent = "(not a file)";
						return;
					}
					const type = stage.mode === "100644" || stage.mode === "100755" ? imageType(bytes) : undefined;
					if (type === undefined) {
						pre.textContent = textShow(bytes.subarray(0, 64 * 1024));
					} else {
						pre.replaceWith(imageElement(bytes, type, stageLabel(stage.stage)));
					}
				},
				(err: unknown) => {
					pre.textContent = errorText(err);
				},
			);
		});
		return details;
	}

	#rowStructural(record: Record): Row {
		const root = el("section", { class: "record" }, this.#rowHeader(record));
		const status = el("div", { class: "record-status" });
		const chosen = new Map<string, Choice>();
		const name = `r${record.key}`;
		for (const path of record.paths) {
			const stages = record.stages[path] ?? [];
			const group = el("div", { class: "path-choices" }, el("div", { class: "path", text: this.#relabel(path) }));
			const options: { label: string; choice: Choice; stage: Wire<ConflictStage> | undefined }[] = [];
			for (const n of [2, 3, 1] as const) {
				const stage = stages.find((s) => s.stage === n);
				if (stage !== undefined) {
					options.push({ label: `Take ${stageLabel(n)}${modeNote(stage.mode)}`, choice: { path, stage: n, from: undefined }, stage });
				}
			}
			if (stages.length > 0) {
				options.push({ label: "Delete it", choice: { path, delete: "file" }, stage: undefined });
			} else {
				options.push({ label: "Keep it as merged", choice: { path, keep: true }, stage: undefined });
			}
			for (const option of options) {
				const input = el("input", {});
				input.type = "radio";
				input.name = `${name}:${path}`;
				input.addEventListener("change", () => chosen.set(path, option.choice));
				const label = el("label", {}, input, ` ${option.label}`);
				group.append(el("div", { class: "option" }, label, option.stage !== undefined && option.stage.mode !== "160000" ? this.#stagePreview(option.stage) : ""));
			}
			root.append(group);
		}
		root.append(
			el(
				"div",
				{ class: "record-actions" },
				button(
					"Save resolution",
					() => {
						const missing = record.paths.filter((p) => !chosen.has(p));
						if (missing.length > 0) {
							status.textContent = `Choose what happens to ${missing.map((p) => this.#relabel(p)).join(", ")}.`;
							return;
						}
						this.#save(record, [...chosen.values()], [], status);
					},
					"primary",
				),
				status,
			),
		);
		return { record, root, dirty: () => chosen.size > 0, destroy: () => undefined };
	}

	#rowFileDirectory(record: Record, dir: string, aside: string, followers: readonly Record[]): Row {
		const root = el("section", { class: "record" }, this.#rowHeader(record));
		const status = el("div", { class: "record-status" });
		const fileStage = (record.stages[aside] ?? []).find((s) => s.stage !== 1);
		const settle = followers.filter((f) => f.paths.every((p) => p === aside)).map((f) => ({ record: f, choices: [{ path: aside, delete: "file" as const }] }));
		const keepDirectory: Choice[] = [
			{ path: aside, delete: "file" },
			{ path: dir, keep: true },
		];
		const actions = el("div", { class: "record-actions" });
		actions.append(button(`Keep the directory ${dir}/`, () => this.#save(record, keepDirectory, settle, status)));
		if (fileStage !== undefined) {
			const keepFile: Choice[] = [
				{ path: dir, delete: "directory" },
				{ path: dir, stage: fileStage.stage, from: aside },
				{ path: aside, delete: "file" },
			];
			actions.append(button(`Keep the file ${dir} (${stageLabel(fileStage.stage)})`, () => this.#save(record, keepFile, settle, status)));
		}
		actions.append(status);
		root.append(actions);
		return { record, root, dirty: () => false, destroy: () => undefined };
	}
}
