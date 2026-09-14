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

import { caretDirectoryExists } from "../../src/core/design"
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

	/** Opens (or focuses) a project. Returns null if the path is not a directory. */
	async open(projectPath: string): Promise<ProjectWindow | null> {
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

		capture("project_opened", { open_windows: this.windows.size })
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
