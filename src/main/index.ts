import { join, resolve } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, type NativeImage, nativeImage, type WebContents } from "electron";
import { Session } from "../engine/session.ts";
import { argumentsRead } from "./arguments.ts";
import { ipcRegister } from "./ipc.ts";

function log(message: string, err: unknown): void {
	console.error(`suonetar: ${message}:`, err);
}

// Rendered from icon.svg, since Electron cannot load SVG: `rsvg-convert -w 256 -h 256 resources/icon.svg -o resources/icon.png`.
function iconLoad(): NativeImage {
	const path = join(import.meta.dirname, "../../resources/icon.png");
	const icon = nativeImage.createFromPath(path);
	// Electron gives an empty image for a path it cannot read, without a word.
	if (icon.isEmpty()) {
		log("the window icon did not load", path);
	}
	return icon;
}

type AppWindow = {
	readonly win: BrowserWindow;
	// Asks the page to save everything it holds; true once it has, or when no page is listening yet and so holds nothing.
	readonly pageRelease: () => Promise<boolean>;
};

function windowCreate(repoPath: string): AppWindow {
	const win = new BrowserWindow({
		width: 1600,
		height: 1000,
		title: `Suonetar — ${repoPath}`,
		backgroundColor: "#1e1e1e",
		icon: iconLoad(),
		webPreferences: { preload: join(import.meta.dirname, "../preload/index.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
	});
	const contents = win.webContents;

	// The page's <title> would otherwise replace this one, which names the repository.
	win.on("page-title-updated", (event) => event.preventDefault());

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

	// Closing asks the page to flush its saves; it answers true once everything is on disk (or the user chose to drop what could not be saved).
	let rendererListening = false;
	let asked: { readonly answer: Promise<boolean>; readonly reply: (ok: boolean) => void } | undefined;
	let closing = false;
	const askDrop = () => {
		asked?.reply(false);
		asked = undefined;
	};
	const pageRelease = (): Promise<boolean> => {
		if (!rendererListening) {
			return Promise.resolve(true);
		}
		if (asked === undefined) {
			let reply: (ok: boolean) => void = () => undefined;
			const answer = new Promise<boolean>((resolve) => {
				reply = resolve;
			});
			asked = { answer, reply };
			contents.send("suonetar:close-request");
		}
		return asked.answer;
	};
	ipcMain.on("suonetar:close-ready", (event) => {
		if (event.sender === contents) {
			rendererListening = true;
		}
	});
	ipcMain.on("suonetar:close-reply", (event, ok: unknown) => {
		if (event.sender !== contents) {
			return;
		}
		asked?.reply(ok === true);
		asked = undefined;
	});
	// A page that is replaced or crashes mid-question will never answer it; whatever asked does not go ahead. Not on starting to load: the old page can still refuse to unload.
	contents.on("did-navigate", () => {
		rendererListening = false;
		askDrop();
	});
	contents.on("render-process-gone", (_event, details) => {
		log("the page crashed; reloading it", details.reason);
		rendererListening = false;
		askDrop();
		if (!win.isDestroyed()) {
			contents.reload();
		}
	});
	win.on("close", (event) => {
		if (closing || !rendererListening) {
			return;
		}
		event.preventDefault();
		if (asked === undefined) {
			void pageRelease().then((ok) => {
				if (ok && !win.isDestroyed()) {
					closing = true;
					win.destroy();
				}
			});
			return;
		}
		// Asked again while the page has not answered: it may be hung, so offer to close regardless.
		const choice = dialog.showMessageBoxSync(win, {
			type: "warning",
			title: "Suonetar",
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
	return { win, pageRelease };
}

async function main(): Promise<void> {
	await app.whenReady();
	Menu.setApplicationMenu(null);
	const args = argumentsRead(process.argv, app.isPackaged, process.env.INIT_CWD, process.cwd());
	const repoPath = args.repo ?? resolve(process.env.INIT_CWD ?? process.cwd(), ".");
	let session: Session;
	try {
		session = await Session.open(repoPath, args.base);
	} catch (err) {
		dialog.showErrorBox("Suonetar", `Cannot open ${repoPath} as a git repository:\n\n${err instanceof Error ? err.message : String(err)}`);
		app.quit();
		return;
	}
	const { win } = windowCreate(session.repo.worktree);
	const ours = win.webContents;
	ipcRegister(
		ipcMain,
		() => session,
		(sender: WebContents) => sender === ours,
		log,
	);
	app.on("window-all-closed", () => {
		// The window can only close mid-apply when forced; a hook still running would otherwise hold the session open.
		session.cancel();
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
