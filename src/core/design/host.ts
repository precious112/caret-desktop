/**
 * The seam between the design core and whatever is hosting it.
 *
 * Everything under `src/core/design` is host-free: it never imports `vscode`,
 * `electron`, or anything that assumes a UI toolkit. The three things the core
 * genuinely cannot do for itself — tell the user something, reveal a file in
 * their editor, and push a message down to the canvas — live behind this
 * interface. The Electron main process supplies the real implementation; tests
 * and headless runs use `nullDesignHost`.
 */
import type { DesignOutboundMessage } from "./rendering-shell/messages"

export type NotifyLevel = "info" | "warn" | "error"

export interface DesignHost {
	/**
	 * Surface a message. When `actions` are given, resolves with the chosen label
	 * (or `undefined` if the user dismissed it). Must never throw — a host that
	 * cannot show anything resolves `undefined`.
	 */
	notify(level: NotifyLevel, message: string, actions?: readonly string[]): Promise<string | undefined>

	/** Reveal a source file (optionally at a line) in the user's editor of choice. */
	openInEditor(filePath: string, lineNumber?: number): Promise<void>

	/** Push a message down to the canvas / preview surface. */
	sendToCanvas(message: DesignOutboundMessage): void

	/**
	 * Announce that Caret itself is about to write this file, so the host's
	 * file watcher doesn't record the change as an external hand-edit. Getting
	 * this wrong corrupts the provenance log's one load-bearing distinction —
	 * inline (user taste) versus everything else.
	 */
	noteSelfWrite(filePath: string): void
}

/**
 * Does nothing, successfully. The default until a host registers, so a missing
 * host degrades to silence rather than a crash on a background code path.
 */
export const nullDesignHost: DesignHost = {
	async notify() {
		return undefined
	},
	async openInEditor() {},
	sendToCanvas() {},
	noteSelfWrite() {},
}

// Hosts are looked up per project — see `services.ts`. There is deliberately no
// singleton here: two open projects each need their own window to notify into.
