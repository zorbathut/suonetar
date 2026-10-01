import { el } from "./dom.ts";
import { type FileStatus, statusClass, statusLabel } from "./file-status.ts";

type Status = FileStatus;

export type TreeNode =
	| { readonly kind: "file"; readonly name: string; readonly path: string; readonly status: Status }
	// `name` is the row's label, several directories deep when single-directory chains are merged; `path` is the deepest directory's full path.
	| { readonly kind: "dir"; readonly name: string; readonly path: string; readonly children: readonly TreeNode[] };

type DirBuilding = { dirs: Map<string, DirBuilding>; files: { name: string; path: string; status: Status }[] };

function byCodeUnit(a: { name: string }, b: { name: string }): number {
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function nodesOf(dir: DirBuilding, prefix: string): TreeNode[] {
	const dirs = [...dir.dirs].map(([name, sub]) => {
		let label = name;
		let path = `${prefix}${name}`;
		let inner = sub;
		// A directory holding nothing but one directory shows as one row with it.
		while (inner.files.length === 0 && inner.dirs.size === 1) {
			const [only] = inner.dirs;
			if (only === undefined) {
				break;
			}
			const [childName, child] = only;
			label = `${label}/${childName}`;
			path = `${path}/${childName}`;
			inner = child;
		}
		return { kind: "dir" as const, name: label, path, children: nodesOf(inner, `${path}/`) };
	});
	const files = dir.files.map((file) => ({ kind: "file" as const, ...file }));
	return [...dirs.sort(byCodeUnit), ...files.sort(byCodeUnit)];
}

// The changed files as a directory tree: directories before files, each level in code-unit order as git sorts.
export function fileTree(files: readonly { readonly path: string; readonly status: Status }[]): TreeNode[] {
	const root: DirBuilding = { dirs: new Map(), files: [] };
	for (const file of files) {
		const parts = file.path.split("/");
		const name = parts.pop() ?? file.path;
		let dir = root;
		for (const part of parts) {
			let next = dir.dirs.get(part);
			if (next === undefined) {
				next = { dirs: new Map(), files: [] };
				dir.dirs.set(part, next);
			}
			dir = next;
		}
		dir.files.push({ name, path: file.path, status: file.status });
	}
	return nodesOf(root, "");
}

// The tree's files in the order it shows them, top to bottom.
export function fileTreeOrder(nodes: readonly TreeNode[]): string[] {
	return nodes.flatMap((node) => (node.kind === "file" ? [node.path] : fileTreeOrder(node.children)));
}

// Which section the reader is at: the focused one while it is in view, else the first not yet scrolled past, else (scrolled past them all) the last; `top`/`bottom` are the viewport's edges, and -1 means no sections.
export function sectionCurrentForView(rects: readonly { readonly top: number; readonly bottom: number }[], focused: number, top: number, bottom: number): number {
	const focusedRect = rects[focused];
	if (focusedRect !== undefined && focusedRect.bottom > top + 1 && focusedRect.top < bottom) {
		return focused;
	}
	const first = rects.findIndex((r) => r.bottom > top + 1);
	return first === -1 ? rects.length - 1 : first;
}

// The row to mark for `path`: its own file row, or when that is hidden in a collapsed directory the deepest shown directory containing it; -1 for none.
export function treeHighlightTarget(rows: readonly { readonly kind: "file" | "dir"; readonly path: string }[], path: string): number {
	const own = rows.findIndex((r) => r.kind === "file" && r.path === path);
	if (own !== -1) {
		return own;
	}
	let target = -1;
	let deepest = -1;
	rows.forEach((r, i) => {
		if (r.kind === "dir" && path.startsWith(`${r.path}/`) && r.path.length > deepest) {
			target = i;
			deepest = r.path.length;
		}
	});
	return target;
}

export type FileTreeHandlers = {
	readonly reveal: (path: string) => void;
	// Called after a directory was collapsed or expanded and the tree redrawn.
	readonly toggled: () => void;
};

// Draws the tree into `container`. Directory rows collapse and expand; `collapsed` holds the collapsed directories' paths and is updated in place, so it outlives the tree.
export function fileTreeRender(container: HTMLElement, nodes: readonly TreeNode[], collapsed: Set<string>, handlers: FileTreeHandlers): void {
	const rows = (list: readonly TreeNode[], depth: number): HTMLElement[] =>
		list.flatMap((node) => {
			const indent = `${8 + depth * 14}px`;
			if (node.kind === "file") {
				const row = el(
					"div",
					{ class: "tree-row tree-file", title: node.path, onclick: () => handlers.reveal(node.path) },
					el("span", { class: statusClass(node.status), text: node.status, title: statusLabel(node.status) }),
					el("span", { class: "tree-name", text: node.name }),
				);
				row.dataset.path = node.path;
				row.style.paddingLeft = indent;
				return [row];
			}
			const open = !collapsed.has(node.path);
			const row = el(
				"div",
				{
					class: "tree-row tree-dir",
					title: node.path,
					onclick: () => {
						if (open) {
							collapsed.add(node.path);
						} else {
							collapsed.delete(node.path);
						}
						fileTreeRender(container, nodes, collapsed, handlers);
						handlers.toggled();
					},
				},
				el("span", { class: "tree-toggle", text: open ? "▾" : "▸" }),
				el("span", { class: "tree-name", text: `${node.name}/` }),
			);
			row.dataset.path = node.path;
			row.style.paddingLeft = indent;
			// Toggling a directory leaves the focus in whatever editor had it.
			row.addEventListener("mousedown", (event) => event.preventDefault());
			return open ? [row, ...rows(node.children, depth + 1)] : [row];
		});
	container.replaceChildren(...rows(nodes, 0));
}

// Marks the row `treeHighlightTarget` picks for `path` (nothing for undefined); returns the marked row when the mark moved.
export function fileTreeHighlight(container: HTMLElement, path: string | undefined): HTMLElement | undefined {
	const rows = [...container.querySelectorAll<HTMLElement>(".tree-row")];
	const described = rows.map((row) => {
		const rowPath = row.dataset.path;
		if (rowPath === undefined) {
			throw new Error("a file tree row has no path");
		}
		return { kind: row.classList.contains("tree-dir") ? ("dir" as const) : ("file" as const), path: rowPath };
	});
	const target = path === undefined ? undefined : rows[treeHighlightTarget(described, path)];
	const previous = container.querySelector<HTMLElement>(".tree-row.current");
	if (previous === target) {
		return undefined;
	}
	previous?.classList.remove("current");
	target?.classList.add("current");
	return target;
}
