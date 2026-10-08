/**
 * Tracks which projects are open, and in which window.
 *
 * One window per project, keyed by absolute path: asking to open a project that
 * is already open focuses its window rather than starting a second Vite server
 * against the same directory.
 */
import { app } from "electron"
import * as fs from "fs/promises"
import * as path from "path"

import { caretDirectoryExists, detectAppProfile } from "../../src/core/design"
import { Logger } from "../../src/shared/services/Logger"
import { capture } from "./analytics"
import { getPrefs, setPref } from "./prefs"
import { ProjectWindow } from "./project-window"
import type { ProjectSummary } from "./types"

export interface WindowManagerOptions {
	chromeEntry: { url?: string; file?: string }
	preloadChrome: string
	preloadCanvas: string
	/** Lets the caller dismiss the launcher once a real project window exists. */
	onFirstProjectOpened?(): void
}

export class WindowManager {
	private windows = new Map<string, ProjectWindow>()

	constructor(private readonly options: WindowManagerOptions) {}

	get(projectPath: string): ProjectWindow | undefined {
		return this.windows.get(path.resolve(projectPath))
	}

	list(): ProjectWindow[] {
		return [...this.windows.values()]
	}

	isEmpty(): boolean {
		return this.windows.size === 0
	}

	/** The project window whose chrome sent an IPC call, if any. */
	fromWebContents(id: number): ProjectWindow | undefined {
		return this.list().find((window) => window.ownsWebContents(id))
	}

	/**
	 * Opens a project IN PLACE of another: the new project takes the current
	 * window's spot and the old one closes. Choosing a project from inside a
	 * window means "switch to it" — opening it as a second window behind the
	 * first read as the switch doing nothing (field-measured: a user picked a
	 * folder three times and thought the app was stuck). A project that is
	 * already open somewhere is focused instead, and nothing closes.
	 *
	 * The new window opens BEFORE the old one closes, so a project that fails
	 * to open leaves the user where they were rather than with no window.
	 */
	async replace(current: ProjectWindow, projectPath: string): Promise<ProjectWindow | null> {
		const resolved = path.resolve(projectPath)
		if (resolved === current.projectPath) {
			current.focus()
			return current
		}
		const existing = this.windows.get(resolved)
		if (existing) {
			existing.focus()
			return existing
		}
		const opened = await this.open(resolved, current.placement() ?? undefined)
		if (opened) await this.close(current.projectPath)
		return opened
	}

	/** Opens (or focuses) a project. Returns null if the path is not a directory. */
	async open(
		projectPath: string,
		placement?: ConstructorParameters<typeof ProjectWindow>[0]["placement"],
	): Promise<ProjectWindow | null> {
		const resolved = path.resolve(projectPath)

		const existing = this.windows.get(resolved)
		if (existing) {
			existing.focus()
			return existing
		}

		try {
			const stat = await fs.stat(resolved)
			if (!stat.isDirectory()) {
				Logger.warn(`[windows] not a directory: ${resolved}`)
				return null
			}
		} catch {
			Logger.warn(`[windows] path no longer exists: ${resolved}`)
			return null
		}

		const window = new ProjectWindow({
			projectPath: resolved,
			chromeEntry: this.options.chromeEntry,
			preloadChrome: this.options.preloadChrome,
			preloadCanvas: this.options.preloadCanvas,
			placement,
			onClosed: (closedPath) => {
				this.windows.delete(closedPath)
				void this.rememberSession()
			},
		})

		const wasEmpty = this.windows.size === 0
		this.windows.set(resolved, window)
		await this.rememberSession()
		if (wasEmpty) this.options.onFirstProjectOpened?.()

		// Booting installs dependencies on first run, which takes about a minute.
		// The window is already on screen, so the chrome can show progress rather
		// than the user staring at nothing.
		window.start().catch((err) => Logger.error(`[windows] failed to start ${resolved}:`, err))

		// Whether the folder already held an app is the fork the onboarding funnel
		// turns on: existing apps and fresh projects get different first screens.
		const hasAppCode = (await detectAppProfile(resolved)) !== null
		capture("project_opened", { open_windows: this.windows.size, has_app_code: hasAppCode })
		return window
	}

	async close(projectPath: string): Promise<void> {
		const resolved = path.resolve(projectPath)
		const window = this.windows.get(resolved)
		if (!window) return
		this.windows.delete(resolved)
		await window.close()
		await this.rememberSession()
	}

	async closeAll(): Promise<void> {
		await Promise.allSettled([...this.windows.values()].map((w) => w.close()))
		this.windows.clear()
	}

	/** Recents, annotated with whether each still exists and has a design layer. */
	async listRecents(): Promise<ProjectSummary[]> {
		return Promise.all(
			getPrefs().recentProjects.map(async (projectPath) => {
				let exists = false
				try {
					exists = (await fs.stat(projectPath)).isDirectory()
				} catch {
					exists = false
				}
				return {
					path: projectPath,
					name: path.basename(projectPath),
					exists,
					hasDesignLayer: exists ? await caretDirectoryExists(projectPath) : false,
				}
			}),
		)
	}

	/** Reopens whatever was open when the app last quit. */
	async restoreSession(): Promise<number> {
		const paths = getPrefs().lastSession
		let restored = 0
		for (const projectPath of paths) {
			if (await this.open(projectPath)) restored++
		}
		return restored
	}

	private async rememberSession(): Promise<void> {
		if (!app.isReady()) return
		await setPref("lastSession", [...this.windows.keys()])
	}
}
