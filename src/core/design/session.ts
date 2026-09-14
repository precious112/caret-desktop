/**
 * One open project.
 *
 * `DesignMode.ts` modelled design mode as a global on/off toggle inside an
 * editor that was mostly doing something else. In the desktop app there is no
 * toggle — opening a project *is* design mode — and several projects can be open
 * at once, so the state that used to be module-level lives on an instance.
 *
 * The session owns the Vite dev server, the canvas message router, the git
 * watcher and (from the caller's side) the MCP server, and guarantees they start
 * and stop together.
 */
import { Logger } from "@/shared/services/Logger"
import { RenderingShell } from "./rendering-shell"
import { createMessageRouter, type MessageRouter } from "./rendering-shell/message-router"
import type { DesignInboundMessage } from "./rendering-shell/messages"
import { ensureCaretDirectoryExists } from "./scaffold"
import { hostFor } from "./services"
import { createSyncWatcher, runSyncInteractive, type SyncWatcher } from "./sync/SyncWatcher"

const RESTART = "Restart"

export interface DesignSessionOptions {
	workspacePath: string
	/** Called when the Vite URL becomes available or goes away. */
	onUrlChanged?: (url: string | null) => void
}

export class DesignSession {
	readonly workspacePath: string

	private shell: RenderingShell
	private router: MessageRouter
	private syncWatcher: SyncWatcher | null = null
	private disposed = false

	/**
	 * Serializes start/stop. Booting can take ~60s on first run (npm install), so
	 * an unguarded restart could spawn a second Vite process against the same
	 * project. This mutex is carried over from V1, where it fixed exactly that.
	 */
	private lifecycle: Promise<void> = Promise.resolve()

	constructor(private readonly options: DesignSessionOptions) {
		this.workspacePath = options.workspacePath
		this.shell = new RenderingShell(this.workspacePath, () => this.onShellCrashed())
		this.router = createMessageRouter({
			workspacePath: this.workspacePath,
			onSyncRequested: () => this.requestSync(),
		})
	}

	getUrl(): string | null {
		return this.shell.getUrl()
	}

	isRunning(): boolean {
		return this.shell.isRunning()
	}

	/** Scaffolds `.caret/` if needed, boots Vite, and starts watching git. */
	async start(): Promise<void> {
		this.lifecycle = this.lifecycle.then(() => this.doStart())
		return this.lifecycle
	}

	async stop(): Promise<void> {
		this.disposed = true
		this.lifecycle = this.lifecycle.then(() => this.doStop())
		return this.lifecycle
	}

	/** Routes a message that arrived from the canvas. */
	handleCanvasMessage(message: DesignInboundMessage): Promise<void> {
		return this.router.handle(message)
	}

	/** Runs a design→app sync with the interactive preflight prompts. */
	async requestSync(): Promise<void> {
		await runSyncInteractive(this.workspacePath)
	}

	private async doStart(): Promise<void> {
		if (this.disposed) return
		try {
			await ensureCaretDirectoryExists(this.workspacePath)
			await this.shell.start()

			// The user may have closed the project while Vite was booting.
			if (this.disposed) {
				this.shell.stop()
				return
			}

			this.syncWatcher ??= createSyncWatcher(this.workspacePath)
			this.options.onUrlChanged?.(this.shell.getUrl())
			Logger.info(`[design] session ready at ${this.shell.getUrl()}`)
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error)
			await hostFor(this.workspacePath).notify(
				"error",
				`Caret couldn't start the design preview: ${detail}. See .caret/vite.log for details.`,
			)
		}
	}

	private async doStop(): Promise<void> {
		this.shell.stop()
		await this.syncWatcher?.dispose()
		this.syncWatcher = null
		this.options.onUrlChanged?.(null)
	}

	/**
	 * Vite died on its own. The canvas has no signal for this — it simply stops
	 * updating — so it has to be surfaced rather than logged.
	 */
	private onShellCrashed(): void {
		if (this.disposed) return
		this.options.onUrlChanged?.(null)
		void hostFor(this.workspacePath)
			.notify("warn", "The design preview server stopped unexpectedly. See .caret/vite.log for details.", [RESTART])
			.then((choice) => {
				if (choice === RESTART && !this.disposed) {
					this.lifecycle = this.lifecycle.then(() => this.doStart())
				}
			})
	}
}
