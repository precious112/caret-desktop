/**
 * One window, one open project.
 *
 * The window hosts two things. The **chrome renderer** is the window's own
 * `webContents` and owns everything that is not generated code — the top bar,
 * project switching, the foundation wizard, preferences, notifications. The
 * **canvas** is a `WebContentsView` layered on top of it, pointed straight at
 * the project's Vite URL, so the canvas app that already exists in
 * `.caret/lib/canvas/` runs completely unported.
 *
 * A `BrowserWindow` rather than a `BaseWindow` with two child views, because the
 * chrome *is* the window here — and because automation tools (and the OS) only
 * recognise a window's own `webContents` as a window, which a `BaseWindow` does
 * not have.
 *
 * The chrome reports how much room its top bar takes (`canvas:setBounds`), which
 * keeps layout authority in the renderer, where that height is actually known.
 */
import { BrowserWindow, Notification, WebContentsView } from "electron"
import * as fs from "fs"
import * as path from "path"

import {
	type ConversationState,
	caretDirectoryExists,
	DesignSession,
	hostFor,
	readFoundationTokens,
	registerProjectServices,
	unregisterProjectServices,
} from "../../src/core/design"
import { emitDesignEvent } from "../../src/core/design/telemetry-hooks"
import { Logger } from "../../src/shared/services/Logger"
import { AgentService } from "./agent-service"
import { CatalogService } from "./catalog-service"
import { DesignChecksService } from "./design-checks"
import { createElectronDesignHost } from "./electron-host"
import { ensureMatteModel } from "./matte"
import { CaretMcpServer } from "./mcp/server"
import { refreshMenu } from "./menu"
import { migrateProject } from "./migrate"
import { OverlayVerifyService } from "./overlay-verify"
import { EMPTY_SETTLE_REPORT, type SettleReport, settleScript } from "./page-settle"
import { recordRecentProject } from "./prefs"
import { regenerateRulesFiles } from "./rules/generate"
import type { DesignInboundMessage, DesignOutboundMessage, ProjectState, ScreenshotFrame, ScreenshotResult } from "./types"
import { WatchAndHeal } from "./watch-and-heal"

/** Fallback top-bar height, used until the chrome reports its real layout. */
const DEFAULT_CHROME_INSET = 44

/** The screenshot viewport, and the size of every full-page capture frame. */
const FRAME_WIDTH = 1440
const FRAME_HEIGHT = 900

/**
 * Frames per get_screenshot part: 5400px of page per call. Enough that most
 * pages arrive whole, small enough to stay under every provider's
 * images-per-message ceiling and not spend image tokens on footers nobody
 * asked about.
 */
const FRAMES_PER_PART = 6

/** Post-scroll beat per frame — a GSAP scrub eases toward the scroll position over ~0.6s. */
const SCRUB_SETTLE_MS = 700

interface ChromeInsets {
	top: number
	right: number
}

export interface ProjectWindowOptions {
	projectPath: string
	chromeEntry: { url?: string; file?: string }
	preloadChrome: string
	preloadCanvas: string
	onClosed(projectPath: string): void
}

export class ProjectWindow {
	readonly projectPath: string
	readonly window: BrowserWindow

	private canvas: WebContentsView | null = null
	private agent: AgentService
	private checks: DesignChecksService
	private overlayVerify: OverlayVerifyService
	private catalog: CatalogService
	private session: DesignSession
	private mcp: CaretMcpServer
	private healer: WatchAndHeal
	private chromeInsets: ChromeInsets = { top: DEFAULT_CHROME_INSET, right: 0 }
	private canvasVisible = false
	private closed = false
	/** Watches `.caret/.variants.json` existence so the chrome can badge an open exploration. */
	private exploreWatcher: fs.FSWatcher | null = null
	private exploreOpen: boolean | null = null
	/** Asks already notified about — one native notification per ask, ever. */
	private notifiedAsks = new Set<string>()

	constructor(private readonly options: ProjectWindowOptions) {
		this.projectPath = options.projectPath

		this.window = new BrowserWindow({
			width: 1440,
			height: 900,
			minWidth: 900,
			minHeight: 600,
			title: `${path.basename(this.projectPath)} — Caret`,
			backgroundColor: "#0b0d12",
			titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
			webPreferences: {
				preload: options.preloadChrome,
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: false,
			},
		})

		// Services are keyed by project path, so two open projects each notify into
		// their own window rather than whichever one started last.
		registerProjectServices(this.projectPath, {
			host: createElectronDesignHost({
				chrome: () => (this.closed || this.window.isDestroyed() ? null : this.window.webContents),
				sendToCanvas: (message) => this.sendToCanvas(message),
				// Lazily: the healer is constructed a few lines below this call.
				noteSelfWrite: (file) => this.healer?.markSelfWrite(file),
			}),
		})

		this.checks = new DesignChecksService({
			projectPath: this.projectPath,
			baseUrl: () => this.session.getUrl(),
		})

		this.overlayVerify = new OverlayVerifyService({
			projectPath: this.projectPath,
			baseUrl: () => this.session.getUrl(),
		})

		this.catalog = new CatalogService({
			projectPath: this.projectPath,
			// The lock is always-on context — a stale index would have the agent
			// re-import what is already installed under a different name.
			onInstalled: () =>
				void regenerateRulesFiles(this.projectPath).catch((err) => Logger.warn(`[window] rules regen failed: ${err}`)),
			// Consent lands in the chat like every blocking ask; the toast path
			// proved invisible under the native canvas view.
			sendPrompt: (prompt) => this.sendToChrome("interview:prompt", prompt),
		})

		// Constructed before the session, because registering the bridge is what
		// makes every outbound feature stop refusing.
		this.agent = new AgentService({
			projectPath: this.projectPath,
			onState: (state) => {
				this.sendToChrome("agent:state", this.projectPath, state)
				this.noticeAskWaiting(state)
			},
			// The pill lives where the intent was expressed: in the canvas, not the
			// chat. This is the entire live surface a canvas edit gets.
			onEditStatus: (status) => this.sendToCanvas({ source: "caret-host", type: "edit-status", payload: status }),
			// Each playground take narrates to its own card on the explore surface.
			onExploreStatus: (status) => this.sendToCanvas({ source: "caret-host", type: "explore-status", payload: status }),
			// The owned loop is what makes the checker ENFORCED rather than
			// requested: every turn that wrote pages gets checked, and errors go
			// straight back into the session that made them. The overlay verifier
			// rides the same seam for overlay edits: re-measure, show the model.
			onTurnComplete: (conversation, outcome, request) => {
				this.checks.afterTurn(conversation, outcome, request)
				this.overlayVerify.afterTurn(conversation, outcome, request)
			},
		})

		this.session = new DesignSession({
			workspacePath: this.projectPath,
			onUrlChanged: (url) => this.onCanvasUrlChanged(url),
		})

		this.mcp = new CaretMcpServer({
			projectPath: this.projectPath,
			onAgentConnectionChanged: () => void this.pushState(),
			screenshot: (pageId, part) => this.screenshotPage(pageId, part),
			runChecks: (pageId) => this.checks.run(pageId ? [pageId] : undefined),
			installComponent: (libraryId, componentId) => this.catalog.install(libraryId, componentId),
			onInterviewPrompt: (prompt) => this.sendToChrome("interview:prompt", prompt),
		})

		this.healer = new WatchAndHeal({
			projectPath: this.projectPath,
			isAgentActive: () => this.agent.isWorking(),
			onFirstDirectWrite: (file) => this.noticeDirectWrite(file),
			onTokensChanged: () => void this.pushState(),
			// An asset can arrive from an agent or from Finder, not only from the
			// library surface, so the renderer is told rather than left to poll.
			onAssetsChanged: () => this.sendToChrome("assets:changed", this.projectPath),
			onPageWritten: (file) => void this.catalog.ensureSuppliedFor(file),
		})

		this.loadChrome()
		this.window.on("resize", () => this.layout())
		this.window.on("closed", () => this.onWindowClosed())
		this.layout()
	}

	/** Boots Vite, the MCP endpoint, the backend and the healer. Safe to call once. */
	async start(): Promise<void> {
		await recordRecentProject(this.projectPath)
		// The menu's recents are a snapshot; without this the list a user reaches
		// for to switch projects never learns about the one they just opened.
		refreshMenu()

		// Deliberately not awaited, and deliberately not gated on anything. This
		// is a 214MB background fetch that wants the whole of someone's first
		// session to finish in; waiting for a key, or for the asset generator to
		// be opened, would start it exactly when it is in the way. Single-flight,
		// so several windows opening at once fetch it once.
		void ensureMatteModel()

		// Runs before anything reads `.caret/`, so a project written by the VS Code
		// extension is in the current shape by the time the session starts.
		await migrateProject(this.projectPath).catch((err) => Logger.warn(`[window] migration failed: ${err}`))

		// The healer and the rules files do not wait on Vite.
		//
		// Booting the preview can take a minute on first run (npm install) and can
		// fail outright — a port already taken, a broken install. Neither has
		// anything to do with healing `.caret/` or writing the rules an agent reads,
		// and gating them on Vite meant a slow preview left the design layer
		// unhealed and every agent working from stale foundations.
		this.healer.start()
		const rules = regenerateRulesFiles(this.projectPath).catch((err) =>
			Logger.warn(`[window] rules generation failed: ${err}`),
		)

		await Promise.all([this.session.start(), this.mcp.start(), this.agent.start(), rules])

		// First pass over every page, so the canvas shows check results without
		// anything having asked — a defect that predates this session is still a
		// defect. Backgrounded: N hidden renders must not delay the window.
		void this.checks.run().catch((err) => Logger.warn(`[window] initial design checks failed: ${err}`))

		await this.pushState()
	}

	async close(): Promise<void> {
		if (this.closed) return
		Logger.info(`[window] close() invoked for ${this.projectPath}`)
		this.closed = true
		this.exploreWatcher?.close()
		this.exploreWatcher = null
		this.checks.close()
		this.overlayVerify.close()
		await Promise.allSettled([this.session.stop(), this.mcp.stop(), this.healer.stop(), this.agent.close()])
		unregisterProjectServices(this.projectPath)
		if (!this.window.isDestroyed()) this.window.destroy()
	}

	async getState(): Promise<ProjectState> {
		// "Has a foundation" means a person committed one, not that the file
		// exists — the scaffold writes a default `foundation.json` into every
		// project, so mere presence is meaningless. The committed marker is the
		// real signal; a derived brand ramp identifies foundations committed
		// before the marker existed (the scaffold default ships `scale: {}`).
		let hasFoundation = false
		if (await caretDirectoryExists(this.projectPath)) {
			const tokens = await readFoundationTokens(this.projectPath)
			hasFoundation = tokens?.meta?.committed === true || Object.keys(tokens?.color?.brand?.scale ?? {}).length > 0
		}
		return {
			path: this.projectPath,
			name: path.basename(this.projectPath),
			canvasUrl: this.session.getUrl(),
			mcpUrl: this.mcp.getUrl(),
			agentConnected: this.mcp.hasConnectedAgent(),
			hasFoundation,
		}
	}

	/** Routes a message that arrived from the canvas. */
	handleCanvasMessage(message: DesignInboundMessage): Promise<void> {
		return this.session.handleCanvasMessage(message)
	}

	sendToCanvas(message: DesignOutboundMessage): void {
		if (this.canvas && !this.canvas.webContents.isDestroyed()) {
			this.canvas.webContents.send("canvas:fromHost", message)
		}
	}

	sendToChrome(channel: string, ...args: unknown[]): void {
		if (this.closed || this.window.isDestroyed()) return
		this.window.webContents.send(channel, ...args)
	}

	/**
	 * A permission ask surfacing while this window is unfocused gets one native
	 * notification — a long apply turn is exactly when the user is elsewhere,
	 * and an unanswered ask now waits indefinitely (the watchdog pauses on it),
	 * so nothing else will ever call them back. Checked again after a settle
	 * delay because auto-ruled asks are "pending" for milliseconds; only one
	 * that outlives the delay was actually surfaced to a person.
	 */
	private noticeAskWaiting(state: ConversationState): void {
		for (const entry of state.transcript.entries) {
			if (entry.kind !== "permission" || entry.status !== "pending") continue
			if (this.notifiedAsks.has(entry.requestId)) continue
			this.notifiedAsks.add(entry.requestId)
			const { requestId, summary } = entry
			setTimeout(() => this.notifyAsk(requestId, summary), 1_500)
		}
	}

	private notifyAsk(requestId: string, summary: string): void {
		if (this.closed || this.window.isDestroyed() || this.window.isFocused()) return
		const stillPending = this.agent.conversation
			.getState()
			.transcript.entries.some((e) => e.kind === "permission" && e.requestId === requestId && e.status === "pending")
		if (!stillPending || !Notification.isSupported()) return
		Logger.info(`[window] ask ${requestId} unanswered with the window unfocused — native notification shown`)
		const notification = new Notification({ title: "Caret is waiting on you", body: summary })
		notification.on("click", () => {
			if (this.closed || this.window.isDestroyed()) return
			this.window.show()
			this.window.focus()
		})
		notification.show()
	}

	/** The chrome reporting how much room it occupies around the canvas. */
	setChromeInsets(insets: ChromeInsets): void {
		this.chromeInsets = {
			top: Math.max(0, Math.round(insets.top)),
			right: Math.max(0, Math.round(insets.right)),
		}
		this.layout()
	}

	/** Hides the canvas so the chrome can show a full-window surface (wizard, prefs). */
	setCanvasVisible(visible: boolean): void {
		this.canvasVisible = visible
		this.layout()
	}

	requestSync(): Promise<void> {
		return this.session.requestSync()
	}

	getMcpServer(): CaretMcpServer {
		return this.mcp
	}

	/**
	 * Said once, the first time something edits `.caret/` around Caret.
	 *
	 * Not a warning — the write is honoured and healed like any other, and it has
	 * to be, because Caret cannot stop an agent or an editor from touching a file.
	 * It is a signpost: the visual editor knows what a caret-id is for and a text
	 * editor does not, so the file that comes back from one needs no repair.
	 */
	private noticeDirectWrite(filePath: string): void {
		const name = path.relative(this.projectPath, filePath) || path.basename(filePath)
		void hostFor(this.projectPath).notify(
			"info",
			`Something edited ${name} directly. Caret fixed it up, but editing on the canvas — or asking in the chat — is the path that stays reliable.`,
		)
	}

	getAgent(): AgentService {
		return this.agent
	}

	focus(): void {
		if (!this.window.isDestroyed()) this.window.focus()
	}

	private loadChrome(): void {
		const { url, file } = this.options.chromeEntry

		// The renderer's own `<title>` wins once the document loads, which would
		// leave every project window named the same thing — unusable in the dock
		// and the Window menu with more than one project open.
		const title = `${path.basename(this.projectPath)} — Caret`
		this.window.on("page-title-updated", (event) => {
			event.preventDefault()
			this.window.setTitle(title)
		})

		if (url) {
			void this.window.webContents.loadURL(url)
		} else if (file) {
			void this.window.webContents.loadFile(file)
		}
	}

	private onCanvasUrlChanged(url: string | null): void {
		if (this.closed) return
		if (url === null) {
			this.destroyCanvas()
		} else {
			this.mountCanvas(url)
			// `.caret/` exists by the time Vite is up, so the watch can start.
			this.startExploreWatch()
		}
		void this.pushState()
	}

	/**
	 * The playground lives in the canvas, which is hidden entirely on other
	 * surfaces (`canvas:setVisible`) — an open exploration would vanish without
	 * a trace. The chrome badges the Canvas button instead, off the scratch
	 * file's existence: it is the exploration's single source of truth, however
	 * the exploration was opened (a click, MCP, a restart).
	 */
	private startExploreWatch(): void {
		if (this.exploreWatcher) return
		const caretDir = path.join(this.projectPath, ".caret")
		const scratch = path.join(caretDir, ".variants.json")
		const report = () => {
			const open = fs.existsSync(scratch)
			if (open === this.exploreOpen) return
			this.exploreOpen = open
			this.sendToChrome("explore:open-changed", this.projectPath, open)
		}
		try {
			this.exploreWatcher = fs.watch(caretDir, (_event, filename) => {
				if (filename === ".variants.json") report()
			})
		} catch (err) {
			Logger.warn(`[window] explore watch failed to start: ${err}`)
			return
		}
		report()
	}

	private mountCanvas(url: string): void {
		if (!this.canvas) {
			this.canvas = new WebContentsView({
				webPreferences: {
					preload: this.options.preloadCanvas,
					contextIsolation: true,
					nodeIntegration: false,
					sandbox: false,
					// The canvas renders agent-generated code. It gets no Node reach
					// and no filesystem access — only the message pipe in its preload.
					webSecurity: true,
				},
			})
			this.canvas.webContents.on("ipc-message", (_event, channel, payload) => {
				if (channel === "canvas:toHost") {
					void this.handleCanvasMessage(payload as DesignInboundMessage)
				}
			})
			// The gap that made the Windows canvas failure invisible: the main
			// process watched Vite (healthy) but nothing watched whether the
			// renderer actually REACHED it. This is the user's side of the story.
			this.canvas.webContents.on("did-fail-load", (_e, code, description, validatedUrl) => {
				Logger.error(`[canvas] failed to load ${validatedUrl}: ${description} (${code})`)
				emitDesignEvent("canvas_blocked", { reason: "renderer_load_failed", code })
			})
			this.canvas.webContents.on("render-process-gone", (_e, details) => {
				Logger.error(`[canvas] renderer gone: ${details.reason} (exit ${details.exitCode})`)
				emitDesignEvent("canvas_blocked", { reason: "renderer_gone" })
			})
			this.window.contentView.addChildView(this.canvas)
		}
		this.canvasVisible = true
		void this.canvas.webContents.loadURL(url)
		this.layout()
	}

	private destroyCanvas(): void {
		if (!this.canvas) return
		this.window.contentView.removeChildView(this.canvas)
		this.canvas.webContents.close()
		this.canvas = null
	}

	/**
	 * Screenshots one design page by loading it in a hidden window rather than
	 * capturing the canvas, which would return whatever the user happens to be
	 * looking at — possibly zoomed out, scrolled, or showing a different page.
	 *
	 * A hidden `BrowserWindow`, not a detached `WebContentsView`: capturing
	 * needs a real compositor surface, and a view that was never added to a window
	 * has none, so it returns an empty image no matter how long you wait.
	 * `paintWhenInitiallyHidden` keeps that surface alive while the window stays
	 * off-screen.
	 *
	 * The FULL page is captured, as viewport-height frames, each one "what a
	 * user sees scrolled to y": the settle sweeps the scroll position once so
	 * every lazy asset loads and every once-only entrance plays, then each
	 * frame scrolls there, waits a beat, and captures the viewport. NOT a
	 * single tall render sliced up: scroll-driven pages (GSAP pin/scrub is in
	 * the catalog) have no static full-height state — a pinned section exists
	 * only while scrolled through, and capturing the scroll-0 state beyond the
	 * viewport photographs its pin spacer as a blank band (measured on
	 * fold-landing; `scripts/probe-fullpage-capture.ts`). Nor a window resized
	 * to the page height, which re-lays-out every vh-sized section into a
	 * shape no user ever sees. Frames rather than one tall image because
	 * providers downscale to a ~1500px long edge: a tall capture arrives
	 * illegible, slices arrive at full resolution. `part` pages through long
	 * pages, `FRAMES_PER_PART` frames at a time.
	 *
	 * Failures return a reason rather than null. Every caller is an agent, and
	 * "could not screenshot" with no cause is a dead end for it and for us.
	 */
	private async screenshotPage(pageId: string, part = 1): Promise<ScreenshotResult> {
		const base = this.session.getUrl()
		if (!base) {
			return { ok: false, reason: "the design preview is still starting up — try again in a few seconds" }
		}
		if (!Number.isInteger(part) || part < 1) {
			return { ok: false, reason: `part must be a positive integer, got ${part}` }
		}

		const capture = new BrowserWindow({
			show: false,
			width: FRAME_WIDTH,
			height: FRAME_HEIGHT,
			// The web content itself must be 1440x900 — without this, width and
			// height describe the window INCLUDING its title bar, and the actual
			// viewport is 872px on macOS while every caption claims 900.
			useContentSize: true,
			paintWhenInitiallyHidden: true,
			// backgroundThrottling off: Chromium parks timers and rAF in hidden
			// windows, which is exactly where WebGL content (shaders, 3D viewers)
			// stops producing frames — every other capture window sets this too.
			webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: false, backgroundThrottling: false },
		})

		try {
			await capture.loadURL(`${base}?page=${encodeURIComponent(pageId)}&isolated=1`)
			const visuals = await this.settle(capture)

			const pageHeight = Math.max(visuals.scrollHeight, FRAME_HEIGHT)
			const totalFrames = Math.ceil(pageHeight / FRAME_HEIGHT)
			const parts = Math.ceil(totalFrames / FRAMES_PER_PART)
			if (part > parts) {
				return {
					ok: false,
					reason: `page "${pageId}" is ${pageHeight}px tall — ${totalFrames} frame(s) in ${parts} part(s); there is no part ${part}`,
				}
			}

			const firstIndex = (part - 1) * FRAMES_PER_PART
			const count = Math.min(FRAMES_PER_PART, totalFrames - firstIndex)
			const frames: ScreenshotFrame[] = []
			for (let i = 0; i < count; i++) {
				// The last frame scrolls to the page bottom rather than past it, so
				// its reported top is the real scroll position (it may overlap the
				// frame above; the label stays honest).
				const target = Math.max(0, Math.min((firstIndex + i) * FRAME_HEIGHT, pageHeight - FRAME_HEIGHT))
				// The beat after scrolling is for scroll-DRIVEN animation: a GSAP
				// scrub eases toward the new position over ~0.6s, and capturing
				// sooner photographs the easing, not the state.
				const top = (await capture.webContents.executeJavaScript(
					`(async () => {
						scrollTo(0, ${target})
						await new Promise((r) => setTimeout(r, ${SCRUB_SETTLE_MS}))
						await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
						return Math.round(scrollY)
					})()`,
				)) as number
				const image = await capture.webContents.capturePage()
				if (image.isEmpty()) {
					return { ok: false, reason: `page "${pageId}" rendered nothing at y=${top} — does it render at 1440x900?` }
				}
				frames.push({ dataUrl: image.toDataURL(), top, height: FRAME_HEIGHT })
			}

			// Only measured failures are worth a word: an image that completed with
			// zero pixels 404'd or failed to decode, and naming it saves the agent
			// from debugging a "missing" asset off a blank region. Anything softer
			// ("still loading…") is a guess, and the one time it fired in the field
			// it was wrong — a below-the-fold lazy viewer that never loads by design.
			return {
				ok: true,
				frames,
				pageHeight,
				totalFrames,
				firstFrame: firstIndex + 1,
				parts,
				...(visuals.broken.length > 0 ? { warning: `image(s) failed to load: ${visuals.broken.join(", ")}` } : {}),
			}
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err)
			Logger.error(`[window] screenshot of "${pageId}" failed:`, err)
			return { ok: false, reason: `loading page "${pageId}" failed: ${detail}` }
		} finally {
			if (!capture.isDestroyed()) capture.destroy()
		}
	}

	/**
	 * Waits for the page to stop changing before capturing it.
	 *
	 * The contract itself (mount, fonts, images looped until stable, 3D
	 * viewers, a WebGL beat) lives in `page-settle.ts`, shared with the checks
	 * and overlay paths. This caller gives it the long 30-second cap: the
	 * first version capped at 4 seconds and captured anyway, and a user
	 * watched the model chase a logo that was merely still loading, twice.
	 * 30s is only ever paid for a genuine hang — a broken image (404) resolves
	 * immediately and exits through the `broken` report.
	 */
	private async settle(capture: BrowserWindow): Promise<SettleReport> {
		return await capture.webContents
			.executeJavaScript(settleScript(30_000, { fullPage: true }))
			.catch(() => EMPTY_SETTLE_REPORT)
	}

	private layout(): void {
		if (this.closed || this.window.isDestroyed()) return
		const { width, height } = this.window.getContentBounds()

		// The chrome is the window's own webContents, so it fills the window on its
		// own. Only the canvas view needs positioning.
		if (this.canvas) {
			// Parked below the fold rather than removed, so hiding and showing the
			// canvas doesn't reload Vite or lose canvas scroll position.
			const y = this.canvasVisible ? this.chromeInsets.top : height
			this.canvas.setBounds({
				x: 0,
				y,
				width: Math.max(0, width - this.chromeInsets.right),
				height: Math.max(0, height - this.chromeInsets.top),
			})
		}
	}

	private async pushState(): Promise<void> {
		if (this.closed) return
		try {
			this.sendToChrome("project:stateChanged", await this.getState())
		} catch (err) {
			Logger.error("[window] could not push project state:", err)
		}
	}

	private onWindowClosed(): void {
		if (this.closed) return
		Logger.info(`[window] project window 'closed' event fired (not via close()) for ${this.projectPath}`)
		this.closed = true
		void this.session.stop()
		void this.mcp.stop()
		void this.healer.stop()
		void this.agent.close()
		unregisterProjectServices(this.projectPath)
		this.options.onClosed(this.projectPath)
	}
}
