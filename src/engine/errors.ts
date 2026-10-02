// Errors a caller or the user must be able to distinguish. Plain `Error` is reserved for bugs.

export class ErrorGit extends Error {
	readonly args: readonly string[];
	readonly code: number;
	readonly stderr: string;

	constructor(args: readonly string[], code: number, stderr: string) {
		super(`git ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
		this.name = "ErrorGit";
		this.args = args;
		this.code = code;
		this.stderr = stderr;
	}
}

// No repository at or above the path git was asked about, as against one it found but would not open.
export class ErrorNotRepository extends Error {
	constructor(stderr: string) {
		super(stderr.trim());
		this.name = "ErrorNotRepository";
	}
}

export class ErrorNotOnBranch extends Error {
	constructor() {
		super("HEAD is detached; Suonetar edits the stack of the checked-out branch");
		this.name = "ErrorNotOnBranch";
	}
}

// Why a branch has no base: none was found, the one the user chose (by the caller, or in `suonetar.base`) does not work, or the branch has no commits at all.
export type NoBaseCause = { readonly kind: "undetected" } | { readonly kind: "chosen"; readonly ref: string; readonly by: "caller" | "config" } | { readonly kind: "unborn" };

function noBaseMessage(branch: string, cause: NoBaseCause): string {
	switch (cause.kind) {
		case "undetected":
			return `No base for branch '${branch}': give one after the repository on the command line, or set 'git config suonetar.base <ref>'`;
		case "chosen":
			return `The base '${cause.ref}' ${cause.by === "caller" ? "given on the command line" : "set in suonetar.base"} is not a commit that branch '${branch}' shares history with`;
		case "unborn":
			return `Branch '${branch}' has no commits yet`;
		default: {
			const never: never = cause;
			throw new Error(`unknown cause ${String(never)}`);
		}
	}
}

export class ErrorNoBase extends Error {
	constructor(branch: string, cause: NoBaseCause) {
		super(noBaseMessage(branch, cause));
		this.name = "ErrorNoBase";
	}
}

export class ErrorEditRefused extends Error {
	readonly path: string;

	constructor(path: string, reason: string) {
		super(`Cannot edit ${path}: ${reason}`);
		this.name = "ErrorEditRefused";
		this.path = path;
	}
}

export class ErrorStoreChanged extends Error {
	constructor() {
		super("Suonetar's draft store changed while it was being updated");
		this.name = "ErrorStoreChanged";
	}
}

export class ErrorStale extends Error {
	constructor(what: string) {
		super(`${what} is no longer in the stack; refresh`);
		this.name = "ErrorStale";
	}
}

// A save made from a view of a commit that has since changed elsewhere (another window, or a rewrite of the branch), which cannot be laid onto it safely.
export class ErrorEditStale extends Error {
	constructor(path: string) {
		super(`${path} changed since it was shown, in another window or by a rewrite of the branch; reload to see it as it is now`);
		this.name = "ErrorEditStale";
	}
}
