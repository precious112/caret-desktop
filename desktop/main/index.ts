/**
 * Caret's main process.
 *
 * Owns the app lifecycle, the window manager and the crash surfaces. Everything
 * project-specific lives on a {@link ProjectWindow}; this file only decides what
 * exists and when.
 */
import { app, BrowserWindow, dialog, nativeImage, shell } from "electron"
import * as path from "path"
import { fileURLToPath } from "url"

import { disposeBackends, setBundledBackendDirectory } from "../../src/core/design"
import { extendOpencodeServerConfig } from "../../src/core/design/agent/opencode"
import { subscribeDesignEvents } from "../../src/core/design/telemetry-hooks"
import { Logger } from "../../src/shared/services/Logger"
import { hashText, scrubAndTruncate } from "../shared/telemetry"
import { capture, captureError, captureErrorLine, initAnalytics, sessionDurationSeconds, shutdownAnalytics } from "./analytics"
import { registerIpcHandlers } from "./ipc"
import { closeLauncherWindow, hasLauncherWindow, type LauncherWindowOptions, openLauncherWindow } from "./launcher-window"
import { startFileLog } from "./log-file"
import { ensureMcpBridge } from "./mcp/stdio-bridge"
import { MUTATING_TOOL_NAMES } from "./mcp/tools"
import { buildMenu } from "./menu"
import { loadPrefs } from "./prefs"
import { WindowManager } from "./window-manager"

const here = path.dirname(fileURLToPath(import.meta.url))

// Logger's default is silent — nothing subscribes in a bare Node process — so
// wire it to stdout before anything else can try to report a failure. The file
// writer attaches equally early and buffers until the logs dir is resolvable.
Logger.subscribe((line) => console.log(`[caret] ${line}`))
startFileLog()

/**
 * `--user-data-dir` must actually work, and must be applied before anything
 * touches preferences or the single-instance lock — both live under userData.
 *
 * Electron does not honour this flag by itself, and the certification harness
 * relies on it completely: without it every test run shares the developer's
 * real profile, which means test runs overwrite their preferences and recents,
 * session restore reopens temp fixtures in their own app, and — because the
 * instance lock is per-profile — the user opening Caret while a test runs
 * makes the two instances kill each other. All of that was observed, at length,
 * before this block existed.
 */
const userDataArg = process.argv.find((arg) => arg.startsWith("--user-data-dir="))
if (userDataArg) {
	app.setPath("userData", userDataArg.slice("--user-data-dir=".length))
}

/**
 * One instance owns the recents list and the session file. A second instance
 * would race both, and its windows would write over the first's idea of what is
 * open, so the second is asked to hand its arguments over and exit.
 */
if (!app.requestSingleInstanceLock()) {
	app.quit()
} else {
	void main()
}

async function main(): Promise<void> {
	installCrashHandlers()

	await app.whenReady()

	// In dev the dock shows Electron's own icon; the packaged app gets its icon
	// from `build/icon.png` via electron-builder. This closes the dev gap so the
	// app is recognisably Caret in both.
	if (process.platform === "darwin" && app.dock) {
		const icon = nativeImage.createFromPath(path.join(app.getAppPath(), "assets", "icons", "icon.png"))
		if (!icon.isEmpty()) app.dock.setIcon(icon)
	}
	loadPrefs()
	initAnalytics()
	// The design core reports product events without knowing telemetry exists;
	// this is the one place that decides listening means analytics.
	subscribeDesignEvents((event, props) => capture(event, props))
	// Error-level log lines become deduped, scrubbed, budgeted events — the
	// field visibility half of observability. The scrub happens before hashing
	// so one error class dedupes across the paths it mentions.
	Logger.subscribe((line) => {
		if (!line.startsWith("ERROR ")) return
		const source = /^ERROR \[([^\]]+)\]/.exec(line)?.[1] ?? "unknown"
		const message = scrubAndTruncate(line.slice("ERROR ".length))
		captureErrorLine(hashText(message), source, message)
	})

	// Where the bundled coding backend lives. Only the main process knows this,
	// and the design core is deliberately host-free, so it is told rather than
	// left to guess — and it never falls back to `PATH`.
	if (app.isPackaged) setBundledBackendDirectory(path.join(process.resourcesPath, "opencode"))

	// The chat agent's road to Caret's own tools: a stdio bridge OpenCode
	// launches per project directory, which finds that project's MCP endpoint
	// from its cwd. Registered before any session so the spawn config carries
	// it; a failure here costs the chat its tools, never the chat itself.
	//
	// The permission keys ride along because the backend's own gate only covers
	// the tools it ships — a `caret_*` call is an MCP tool from its point of
	// view and used to run without ever asking, so a page rewritten through
	// `caret_write_page` left no permission record in the chat at all. Naming
	// the mutating tools here puts them through the same boundary as an `edit`;
	// Caret's ruling then auto-allows them as design-layer writes, visibly.
	try {
		extendOpencodeServerConfig({
			mcp: { caret: await ensureMcpBridge() },
			permission: Object.fromEntries(MUTATING_TOOL_NAMES.map((name) => [`caret_${name}`, "ask"])),
		})
	} catch (err) {
		Logger.warn(`[main] chat agent will have no Caret tools: ${err}`)
	}

	const launcherOptions: LauncherWindowOptions = {
		chromeEntry: resolveChromeEntry(),
		preloadChrome: path.join(here, "../preload/index.mjs"),
	}

	const windows = new WindowManager({
		chromeEntry: launcherOptions.chromeEntry,
		preloadChrome: launcherOptions.preloadChrome,
		preloadCanvas: path.join(here, "../preload/canvas.mjs"),
		onFirstProjectOpened: () => closeLauncherWindow(),
	})

	registerIpcHandlers(windows)
	buildMenu(windows)

	app.on("second-instance", (_event, argv) => {
		const fromArgv = projectPathFromArgv(argv)
		if (fromArgv) {
			void windows.open(fromArgv)
		} else if (windows.isEmpty()) {
			openLauncherWindow(launcherOptions)
		} else {
			windows.list()[0]?.focus()
		}
	})

	// Blocks external navigation and new windows everywhere. The canvas renders
	// agent-generated code, and a stray `window.open` or a link to a remote page
	// would put untrusted content in a view with a preload attached.
	app.on("web-contents-created", (_event, contents) => {
		contents.setWindowOpenHandler(({ url }) => {
			void shell.openExternal(url)
			return { action: "deny" }
		})
		contents.on("will-navigate", (event, url) => {
			if (!isLocal(url)) {
				event.preventDefault()
				void shell.openExternal(url)
			}
		})
	})

	// `caret ~/some/project` should open that project, which the first version of
	// this ignored — it only looked at argv for a *second* instance.
	const requested = projectPathFromArgv(process.argv)
	const opened = requested ? await windows.open(requested) : null

	const restored = opened ? 1 : await windows.restoreSession()
	if (restored === 0) {
		openLauncherWindow(launcherOptions)
	} else {
		closeLauncherWindow()
	}
	capture(
		"app_launched",
		{ restored_windows: restored },
		{ app_version: app.getVersion(), platform: process.platform, arch: process.arch },
	)

	app.on("activate", () => {
		if (windows.isEmpty() && !hasLauncherWindow()) openLauncherWindow(launcherOptions)
	})

	app.on("window-all-closed", () => {
		// macOS convention is to stay resident with no windows; elsewhere, quitting
		// is what people expect.
		if (process.platform !== "darwin") app.quit()
	})

	app.on("before-quit", () => {
		// Diagnostic: full-suite runs died with a clean shutdown mid-scenario and
		// no attributable initiator. Name the moment quit begins.
		Logger.info(`[main] before-quit fired (windows open: ${BrowserWindow.getAllWindows().length})`)
		capture("app_quit", { session_duration_s: sessionDurationSeconds() })
		void windows.closeAll()
		// The embedded backend is a child process. Left running it would outlive
		// the app and keep holding a port.
		void disposeBackends()
	})

	// Electron does not await `before-quit`, so the tail of the event queue
	// (notably app_quit) would be lost on every exit. Hold quit once, flush with
	// a hard bound so a dead network can never hold the app hostage, then leave.
	let flushed = false
	app.on("will-quit", (event) => {
		if (flushed) return
		flushed = true
		event.preventDefault()
		void shutdownAnalytics(1500).finally(() => app.exit())
	})
}

/**
 * The first argument that looks like a directory path.
 *
 * Electron passes its own flags and, in a packaged app, the app path itself, so
 * this cannot just take `argv[1]`.
 */
function projectPathFromArgv(argv: string[]): string | null {
	for (const arg of argv.slice(1)) {
		if (arg.startsWith("-")) continue
		if (arg.endsWith(".js") || arg.endsWith(".asar")) continue
		if (path.isAbsolute(arg)) return arg
	}
	return null
}

function resolveChromeEntry(): { url?: string; file?: string } {
	const devServer = process.env.ELECTRON_RENDERER_URL
	return devServer ? { url: devServer } : { file: path.join(here, "../renderer/index.html") }
}

function isLocal(url: string): boolean {
	try {
		const { protocol, hostname } = new URL(url)
		return protocol === "file:" || hostname === "localhost" || hostname === "127.0.0.1"
	} catch {
		return false
	}
}

/**
 * Without VS Code's notification host, an unhandled rejection in the main
 * process is completely invisible — the app simply stops working. Surface it.
 */
function installCrashHandlers(): void {
	process.on("uncaughtException", (err) => {
		Logger.error("[main] uncaught exception:", err)
		captureError(err, "main")
		showCrash("Caret hit an unexpected error", err)
	})
	process.on("unhandledRejection", (reason) => {
		Logger.error("[main] unhandled rejection:", reason)
		captureError(reason, "main")
	})
}

function showCrash(title: string, err: unknown): void {
	const detail = err instanceof Error ? `${err.message}\n\n${err.stack ?? ""}` : String(err)
	if (app.isReady()) {
		void dialog.showMessageBox({ type: "error", title, message: title, detail, buttons: ["OK"] })
	} else {
		dialog.showErrorBox(title, detail)
	}
}
