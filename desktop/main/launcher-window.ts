/**
 * The window you get with no project open.
 *
 * An earlier version opened a native folder dialog straight away instead. That
 * was wrong twice over: a modal file picker as the first thing a new user sees
 * gives them no idea what they are picking *for*, and it makes the app
 * impossible to drive without a human — including for its own tests.
 *
 * So the launcher is a real window running the same chrome renderer, which
 * already knows how to show recents and a folder button when it has no project.
 */
import { BrowserWindow } from "electron"

export interface LauncherWindowOptions {
	chromeEntry: { url?: string; file?: string }
	preloadChrome: string
}

let current: BrowserWindow | null = null

export function openLauncherWindow(options: LauncherWindowOptions): BrowserWindow {
	if (current && !current.isDestroyed()) {
		current.focus()
		return current
	}

	const window = new BrowserWindow({
		width: 900,
		height: 620,
		title: "Caret",
		backgroundColor: "#0b0d12",
		titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
		webPreferences: {
			preload: options.preloadChrome,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
		},
	})

	if (options.chromeEntry.url) {
		void window.webContents.loadURL(options.chromeEntry.url)
	} else if (options.chromeEntry.file) {
		void window.webContents.loadFile(options.chromeEntry.file)
	}

	window.on("closed", () => {
		current = null
	})

	current = window
	return window
}

/** Closes the launcher once a project window has taken over. */
export function closeLauncherWindow(): void {
	if (current && !current.isDestroyed()) current.close()
	current = null
}

export function hasLauncherWindow(): boolean {
	return current !== null && !current.isDestroyed()
}
