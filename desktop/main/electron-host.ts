/**
 * The Electron implementation of {@link DesignHost}.
 *
 * Notifications are rendered by the chrome renderer rather than as native
 * dialogs: a native modal steals focus and blocks the canvas, and most of what
 * the design core reports ("design changes detected — sync them?", "the preview
 * server stopped") is a soft signal the user should be able to ignore. Native
 * dialogs are reserved for genuinely blocking choices (folder pickers, quit
 * confirmations), which live in the menu and project code instead.
 */
import { spawn } from "child_process"
import { randomUUID } from "crypto"
import { shell, type WebContents } from "electron"

import type { DesignHost, NotifyLevel } from "../../src/core/design"
import { Logger } from "../../src/shared/services/Logger"
import { getPref } from "./prefs"
import type { DesignOutboundMessage, NotificationRequest } from "./types"

/** Notifications waiting on the user, keyed by the id sent to the renderer. */
const pending = new Map<string, (action: string | null) => void>()

/** Resolves the notification `id` with the user's choice. Called from the IPC layer. */
export function resolveNotification(id: string, action: string | null): void {
	const resolve = pending.get(id)
	if (!resolve) return
	pending.delete(id)
	resolve(action)
}

export interface ElectronHostTargets {
	/** The chrome renderer that displays notifications, or null once it is gone. */
	chrome(): WebContents | null
	/** Sends a message down to the canvas view. */
	sendToCanvas(message: DesignOutboundMessage): void
	/** Marks a file as about to be written by Caret, so the healer's watcher doesn't log it as external. */
	noteSelfWrite(filePath: string): void
}

export function createElectronDesignHost(targets: ElectronHostTargets): DesignHost {
	return {
		async notify(level: NotifyLevel, message: string, actions: readonly string[] = []): Promise<string | undefined> {
			const chrome = targets.chrome()
			if (!chrome || chrome.isDestroyed()) {
				// No UI to ask through. Log it rather than hanging a caller forever
				// on a promise nobody can resolve.
				Logger.warn(`[host] notification with no window (${level}): ${message}`)
				return undefined
			}

			const request: NotificationRequest = { id: randomUUID(), level, message, actions: [...actions] }
			chrome.send("notification:show", request)

			// A notification with no actions is informational — don't make the
			// caller wait for a dismissal it doesn't care about.
			if (actions.length === 0) return undefined

			return new Promise<string | undefined>((resolve) => {
				pending.set(request.id, (action) => resolve(action ?? undefined))
			})
		},

		async openInEditor(filePath: string, lineNumber?: number): Promise<void> {
			const command = getPref("editorCommand").trim()

			if (!command) {
				// No configured editor: hand it to the OS. Loses the line number,
				// which is why the preference exists.
				const error = await shell.openPath(filePath)
				if (error) Logger.error(`[host] could not open ${filePath}: ${error}`)
				return
			}

			// `code -g file:line` and `cursor -g file:line` both take this shape;
			// editors that don't understand `:line` still open the file.
			const [bin, ...baseArgs] = command.split(/\s+/)
			const target = lineNumber ? `${filePath}:${lineNumber}` : filePath
			// Windows editors are `.cmd` shims only a shell can start — and a shell
			// re-joins the arguments unquoted, so the one that may contain a space
			// (the file path) is quoted by hand.
			const viaShell = process.platform === "win32"
			const child = spawn(bin, [...baseArgs, viaShell && /\s/.test(target) ? `"${target}"` : target], {
				detached: true,
				stdio: "ignore",
				shell: viaShell,
			})
			// A missing editor arrives as an async 'error' event, not a throw — with
			// no listener it would crash the whole main process.
			child.once("error", (err) => {
				Logger.error(`[host] editor command "${command}" failed:`, err)
				void shell.openPath(filePath)
			})
			child.unref()
		},

		sendToCanvas(message: DesignOutboundMessage): void {
			targets.sendToCanvas(message)
		},

		noteSelfWrite(filePath: string): void {
			targets.noteSelfWrite(filePath)
		},
	}
}
