/**
 * The edit lane: canvas-initiated AI work, decoupled from the chat.
 *
 * AI edits and overlay edits used to run on the chat's own conversation, which
 * coupled the two surfaces at their worst points: a canvas edit mid-chat wiped
 * the sidebar's transcript (run() clears it on activity-kind change), and the
 * only live feedback for an edit lived in a panel the user wasn't looking at —
 * with a closed sidebar, Enter was followed by seconds of nothing and then a
 * toast, which reads as a freeze.
 *
 * The lanes now share everything that must be shared — the backend, the
 * permission rules, provenance and git history, the session record — and
 * nothing else. This bridge runs visual edits on its own conversation and
 * narrates them through {@link EditStatus} pushes, which the canvas renders as
 * a pill anchored where the intent was expressed. The chat never sees a live
 * edit; History shows completed ones.
 *
 * Status is driven by the request wrapper, not inferred from state diffs:
 * "working" when the turn starts, "done"/"failed"/"cancelled" when it settles.
 * Only the *details* — the latest tool line, a pending permission — come from
 * the conversation's state pushes, and only while this lane is busy.
 */

import type { PermissionDecision } from "./backend"
import { NoBackendError } from "./backend"
import type { AgentBridge, AgentTask } from "./bridge"
import type { AgentConversation, ConversationState } from "./conversation"

export interface EditStatus {
	phase: "working" | "needs-permission" | "done" | "failed" | "cancelled"
	/** The user's own words, echoed so the pill confirms WHAT was received. */
	instruction?: string
	/** Latest activity line — "editing ProductCard.tsx…". */
	detail?: string
	permission?: { requestId: string; summary: string }
	error?: string
}

export class EditLaneBridge implements AgentBridge {
	private busy = false
	private cancelled = false

	constructor(
		private readonly conversation: () => AgentConversation,
		private readonly isReady: () => boolean,
		private readonly onStatus: (status: EditStatus) => void,
	) {}

	connected(): boolean {
		return this.isReady()
	}

	async request(task: AgentTask): Promise<void> {
		if (!this.isReady()) throw new NoBackendError("visual-edit")
		if (this.busy) {
			// One edit at a time, said plainly at the pill — not a queue the user
			// can't see into.
			throw new Error("Still working on your last edit — cancel it or wait for it to finish.")
		}

		this.busy = true
		this.cancelled = false
		this.onStatus({ phase: "working", instruction: task.displayPrompt ?? "" })

		try {
			const outcome = await this.conversation().run({
				kind: "edit",
				title: "Edit",
				mode: "write",
				prompt: task.prompt,
				displayPrompt: task.displayPrompt,
				images: task.images,
				note: task.note,
				unattended: task.unattended,
				disabledTools: task.disabledTools,
				// Forwarded untouched: the overlay verify loop reads it in
				// onTurnComplete. Dropping it here silently disabled the loop for the
				// exact lane every overlay edit runs on.
				context: task.context,
			})

			if (this.cancelled) {
				this.onStatus({ phase: "cancelled" })
				throw new Error("Cancelled.")
			}
			if (!outcome.ok) {
				const error = "The agent could not finish that edit."
				this.onStatus({ phase: "failed", error })
				throw new Error(error)
			}
			this.onStatus({ phase: "done" })
		} catch (err) {
			if (!this.cancelled) {
				this.onStatus({ phase: "failed", error: err instanceof Error ? err.message : String(err) })
			}
			throw err
		} finally {
			this.busy = false
		}
	}

	/** The pill's ×. Abort is idempotent; the run's settle path reports "cancelled". */
	async cancel(): Promise<void> {
		if (!this.busy) return
		this.cancelled = true
		await this.conversation().abort()
	}

	async respondToPermission(requestId: string, decision: PermissionDecision): Promise<void> {
		await this.conversation().respondToPermission(requestId, decision)
	}

	/**
	 * Detail extraction from the lane conversation's state pushes.
	 *
	 * Wired as that conversation's `onChange`. Ignored when idle — a state push
	 * from a finished turn must not resurrect the pill.
	 */
	handleState(state: ConversationState): void {
		if (!this.busy) return

		const entries = state.transcript.entries
		const pending = [...entries].reverse().find((entry) => entry.kind === "permission" && entry.status === "pending")
		if (pending && pending.kind === "permission") {
			this.onStatus({
				phase: "needs-permission",
				permission: { requestId: pending.requestId, summary: pending.summary },
			})
			return
		}

		const lastTool = [...entries].reverse().find((entry) => entry.kind === "tool")
		if (lastTool && lastTool.kind === "tool") {
			this.onStatus({ phase: "working", detail: lastTool.summary || lastTool.name })
		}
	}
}
