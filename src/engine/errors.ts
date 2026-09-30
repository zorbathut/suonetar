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

export class ErrorNotOnBranch extends Error {
	constructor() {
		super("HEAD is detached; Suonetar edits the stack of the checked-out branch");
		this.name = "ErrorNotOnBranch";
	}
}

export class ErrorNoBase extends Error {
	constructor(branch: string) {
		super(`No base for branch '${branch}': set one with 'git config suonetar.base <ref>'`);
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
