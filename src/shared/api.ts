import type { MergeInputs } from "../engine/derive.ts";
import type { Indentation } from "../engine/editorconfig.ts";
import type {
	ApplyProgress,
	ApplyResult,
	CommitDocument,
	ConflictReport,
	HookChoice,
	MergetoolOutcome,
	PreviewResult,
	ResolutionChoice,
	ResolveResult,
	SessionState,
	UndoResult,
	WorktreeDocument,
} from "../engine/session.ts";
import type { WorktreeSide, WorktreeStatus } from "../engine/worktree-changes.ts";

// An engine type as it arrives on the other side of IPC: structured clone turns every Buffer into a plain Uint8Array.
export type Wire<T> = T extends Uint8Array ? Uint8Array : T extends readonly (infer U)[] ? readonly Wire<U>[] : T extends object ? { readonly [K in keyof T]: Wire<T[K]> } : T;

// Errors cross IPC as data, since Electron reduces a thrown error to its message; the name keeps engine error classes (`ErrorStale`, `ErrorEditRefused`) distinguishable.
export type WireError = { readonly name: string; readonly message: string };

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: WireError };

// The session as the renderer sees it; every method is one IPC round trip into `Session`.
export type SuonetarApi = {
	readonly state: () => Promise<Result<Wire<SessionState>>>;
	readonly generation: () => Promise<Result<string>>;
	readonly commitDocument: (oid: string) => Promise<Result<Wire<CommitDocument>>>;
	// The conflict restacking a commit runs into.
	readonly commitConflict: (oid: string) => Promise<Result<Wire<ConflictReport>>>;
	readonly draftDocument: (against: string) => Promise<Result<Wire<CommitDocument>>>;
	readonly blob: (oid: string) => Promise<Result<Uint8Array | undefined>>;
	readonly blobAt: (tree: string, path: string) => Promise<Result<Uint8Array | undefined>>;
	// Saves a file as edited in a document showing the commit on `parentTree`, where the file was blob `shown` (null: absent); returns the blob now stored (null: deleted).
	readonly draftSetFile: (oid: string, parentTree: string, path: string, shown: string | null, content: Uint8Array | null) => Promise<Result<string | null>>;
	readonly draftRestore: (oid: string, parentTree: string, path: string, from: "commit" | "parent") => Promise<Result<undefined>>;
	readonly draftSetMessage: (oid: string, message: Uint8Array | null) => Promise<Result<undefined>>;
	readonly draftDiscard: (against: string) => Promise<Result<undefined>>;
	readonly draftConfirm: (against: string) => Promise<Result<undefined>>;
	readonly draftAdopt: (against: string) => Promise<Result<undefined>>;
	readonly resolve: (inputs: MergeInputs, key: string, choices: readonly Wire<ResolutionChoice>[]) => Promise<Result<ResolveResult>>;
	readonly preview: () => Promise<Result<Wire<PreviewResult>>>;
	readonly apply: (hooks: HookChoice) => Promise<Result<Wire<ApplyResult>>>;
	// Undoes the branch's last Suonetar move, as `SessionState`'s `undo` described it.
	readonly undo: (old: string, newTip: string, kind: "exact" | "edits") => Promise<Result<Wire<UndoResult>>>;
	// The working tree's staged and unstaged changes: counts and prints, cheap enough to poll.
	readonly worktreeStatus: () => Promise<Result<WorktreeStatus>>;
	// One side of them as a read-only document.
	readonly worktreeDocument: (side: WorktreeSide) => Promise<Result<Wire<WorktreeDocument>>>;
	// A path's EditorConfig indentation as of a tree.
	readonly indentation: (tree: string, path: string) => Promise<Result<Indentation>>;
	// The configured `merge.tool`, or undefined when there is none.
	readonly mergetoolName: () => Promise<Result<string | undefined>>;
	// Opens one path of a content conflict in the merge tool, starting from `content`; waits until the tool is closed or `cancel` is called.
	readonly mergetool: (inputs: MergeInputs, key: string, path: string, content: Uint8Array) => Promise<Result<Wire<MergetoolOutcome>>>;
	// Stops the long operation in progress (the pre-commit pass of an apply, or waiting for a merge tool), which then returns `cancelled`.
	readonly cancel: () => Promise<Result<undefined>>;
};

// How a commit's files show their diff: one editor with the changes inline, or the parent, the commit and the edited version side by side.
export type Layout = "inline" | "three";
export const LAYOUTS: readonly Layout[] = ["inline", "three"];

// Window lifecycle: closing the window asks the renderer first, so pending saves are flushed before anything is torn down.
export type SuonetarShell = {
	// The open repository's worktree, or undefined before one is opened.
	readonly repository: () => Promise<string | undefined>;
	// Asks for a repository to open, as File › Open Repository… does.
	readonly open: () => void;
	// The handler resolves to true once the page has saved everything, so the window may close or switch repositories.
	readonly onCloseRequest: (handler: () => Promise<boolean>) => void;
	// Progress of the apply this page started.
	readonly onApplyProgress: (handler: (progress: ApplyProgress) => void) => void;
	// The layout last chosen in any window.
	readonly layoutRead: () => Promise<Layout>;
	// Remembers the layout for windows opened from now on.
	readonly layoutSave: (layout: Layout) => void;
};

export const APPLY_PROGRESS_CHANNEL = "suonetar:apply-progress";

export function apiChannel(name: keyof SuonetarApi): string {
	return `suonetar:${name}`;
}

export type ApiValue<K extends keyof SuonetarApi> = Awaited<ReturnType<SuonetarApi[K]>> extends Result<infer T> ? T : never;
