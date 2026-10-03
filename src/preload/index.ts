import { contextBridge, ipcRenderer } from "electron";
import type { ApplyProgress } from "../engine/session.ts";
import { APPLY_PROGRESS_CHANNEL, apiChannel, type SuonetarApi, type SuonetarShell } from "../shared/api.ts";

const api: SuonetarApi = {
	state: () => ipcRenderer.invoke(apiChannel("state")),
	generation: () => ipcRenderer.invoke(apiChannel("generation")),
	commitDocument: (oid) => ipcRenderer.invoke(apiChannel("commitDocument"), oid),
	commitConflict: (oid) => ipcRenderer.invoke(apiChannel("commitConflict"), oid),
	draftDocument: (against) => ipcRenderer.invoke(apiChannel("draftDocument"), against),
	blob: (oid) => ipcRenderer.invoke(apiChannel("blob"), oid),
	blobAt: (tree, path) => ipcRenderer.invoke(apiChannel("blobAt"), tree, path),
	draftSetFile: (oid, parentTree, path, shown, content) => ipcRenderer.invoke(apiChannel("draftSetFile"), oid, parentTree, path, shown, content),
	draftRestore: (oid, parentTree, path, from) => ipcRenderer.invoke(apiChannel("draftRestore"), oid, parentTree, path, from),
	draftSetMessage: (oid, message) => ipcRenderer.invoke(apiChannel("draftSetMessage"), oid, message),
	draftDiscard: (against) => ipcRenderer.invoke(apiChannel("draftDiscard"), against),
	draftConfirm: (against) => ipcRenderer.invoke(apiChannel("draftConfirm"), against),
	draftAdopt: (against) => ipcRenderer.invoke(apiChannel("draftAdopt"), against),
	resolve: (inputs, key, choices) => ipcRenderer.invoke(apiChannel("resolve"), inputs, key, choices),
	preview: () => ipcRenderer.invoke(apiChannel("preview")),
	apply: (hooks) => ipcRenderer.invoke(apiChannel("apply"), hooks),
	undo: (old, newTip, kind) => ipcRenderer.invoke(apiChannel("undo"), old, newTip, kind),
	worktreeStatus: () => ipcRenderer.invoke(apiChannel("worktreeStatus")),
	worktreeDocument: (side) => ipcRenderer.invoke(apiChannel("worktreeDocument"), side),
	indentation: (tree, path) => ipcRenderer.invoke(apiChannel("indentation"), tree, path),
	mergetoolName: () => ipcRenderer.invoke(apiChannel("mergetoolName")),
	mergetool: (inputs, key, path, content) => ipcRenderer.invoke(apiChannel("mergetool"), inputs, key, path, content),
	cancel: () => ipcRenderer.invoke(apiChannel("cancel")),
};

const shell: SuonetarShell = {
	repository: () => ipcRenderer.invoke("suonetar:repository"),
	open: () => ipcRenderer.send("suonetar:open"),
	onCloseRequest(handler) {
		ipcRenderer.on("suonetar:close-request", () => {
			handler().then(
				(ok) => ipcRenderer.send("suonetar:close-reply", ok),
				(err: unknown) => {
					console.error("suonetar: close handler failed:", err);
					ipcRenderer.send("suonetar:close-reply", false);
				},
			);
		});
		ipcRenderer.send("suonetar:close-ready");
	},
	onApplyProgress(handler) {
		ipcRenderer.on(APPLY_PROGRESS_CHANNEL, (_event, progress: ApplyProgress) => handler(progress));
	},
	layoutRead: () => ipcRenderer.invoke("suonetar:layout-read"),
	layoutSave: (layout) => ipcRenderer.send("suonetar:layout-save", layout),
};

contextBridge.exposeInMainWorld("suonetar", api);
contextBridge.exposeInMainWorld("suonetarShell", shell);
