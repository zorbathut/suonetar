import { join, resolve } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, type WebContents } from "electron";
import { Session } from "../engine/session.ts";
import { ipcRegister } from "./ipc.ts";

function log(message: string, err: unknown): void {
	console.error(`suonetar: ${message}:`, err);
}

// The repository is the first non-flag argument, relative to where `npm run` was invoked (npm itself runs scripts from the package root).
function repoArgument(): string {
	const args = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith("-"));
	return resolve(process.env.INIT_CWD ?? process.cwd(), args[0] ?? ".");
}

function windowCreate(repoPath: string): BrowserWindow {
	const win = new BrowserWindow({
		width: 1600,
		height: 1000,
		title: `suonetar — ${repoPath}`,
		backgroundColor: "#1e1e1e",
		webPreferences: { preload: join(import.meta.dirname, "../preload/index.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
	});
	const contents = win.webContents;

	// Nothing may navigate the window away from the app (a dropped file, a clicked link): unsaved edits live in the page.
	contents.on("will-navigate", (event) => event.preventDefault());
	contents.setWindowOpenHandler(() => ({ action: "deny" }));

	// With the menu removed, the few window-level keys are handled here, before the page sees them.
	contents.on("before-input-event", (event, input) => {
		if (input.type !== "keyDown") {
			return;
		}
		if (input.key === "F12") {
			contents.toggleDevTools();
			event.preventDefault();
		} else if (input.control && !input.alt && (input.key === "=" || input.key === "+")) {
			contents.setZoomLevel(contents.getZoomLevel() + 0.5);
			event.preventDefault();
		} else if (input.control && !input.alt && input.key === "-") {
			contents.setZoomLevel(contents.getZoomLevel() - 0.5);
			event.preventDefault();
		} else if (input.control && !input.alt && input.key === "0") {
			contents.setZoomLevel(0);
			event.preventDefault();
		}
	});

	// Closing asks the renderer to flush its saves; it answers true once everything is on disk (or the user chose to drop what could not be saved).
	let rendererListening = false;
	let asking = false;
	let closing = false;
	ipcMain.on("suonetar:close-ready", (event) => {
		if (event.sender === contents) {
			rendererListening = true;
		}
	});
	ipcMain.on("suonetar:close-reply", (event, ok: unknown) => {
		if (event.sender !== contents) {
			return;
		}
		asking = false;
		if (ok === true) {
			closing = true;
			win.destroy();
		}
	});
	contents.on("did-start-loading", () => {
		rendererListening = false;
		asking = false;
	});
	contents.on("render-process-gone", (_event, details) => {
		log("the page crashed; reloading it", details.reason);
		rendererListening = false;
		asking = false;
		if (!win.isDestroyed()) {
			contents.reload();
		}
	});
	win.on("close", (event) => {
		if (closing || !rendererListening) {
			return;
		}
		event.preventDefault();
		if (!asking) {
			asking = true;
			contents.send("suonetar:close-request");
			return;
		}
		// Asked again while the page has not answered: it may be hung, so offer to close regardless.
		const choice = dialog.showMessageBoxSync(win, {
			type: "warning",
			message: "The window has not finished saving.",
			detail: "Edits not yet saved will be lost if it closes now.",
			buttons: ["Keep waiting", "Close anyway"],
			defaultId: 0,
			cancelId: 0,
		});
		if (choice === 1) {
			closing = true;
			win.destroy();
		}
	});

	// The dev server's page only under `electron-vite dev`, never merely because the variable happens to be set.
	const devUrl = process.env.ELECTRON_RENDERER_URL;
	if (devUrl !== undefined && process.env.NODE_ENV_ELECTRON_VITE === "development" && !app.isPackaged) {
		win.loadURL(devUrl).catch((err: unknown) => log("loading the renderer failed", err));
	} else {
		win.loadFile(join(import.meta.dirname, "../renderer/index.html")).catch((err: unknown) => log("loading the renderer failed", err));
	}
	return win;
}

async function main(): Promise<void> {
	await app.whenReady();
	Menu.setApplicationMenu(null);
	const repoPath = repoArgument();
	let session: Session;
	try {
		session = await Session.open(repoPath);
	} catch (err) {
		dialog.showErrorBox("suonetar", `Cannot open ${repoPath} as a git repository:\n\n${err instanceof Error ? err.message : String(err)}`);
		app.quit();
		return;
	}
	const win = windowCreate(session.repo.worktree);
	const ours = win.webContents;
	ipcRegister(ipcMain, session, (sender: WebContents) => sender === ours, log);
	app.on("window-all-closed", () => {
		session.closeWhenIdle().then(
			() => app.quit(),
			(err: unknown) => {
				log("closing the session failed", err);
				app.quit();
			},
		);
	});
}

main().catch((err: unknown) => {
	log("startup failed", err);
	app.exit(1);
});
