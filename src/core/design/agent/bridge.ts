/**
 * The outbound boundary: work Caret starts and hands to an agent.
 *
 * Caret used to call `controller.initTask(prompt)` in four places — design→app
 * sync, visual AI edits, the overlay editor, and flow-restructure nav sync. Each
 * is an outbound request on this interface.
 *
 * **There is no MCP implementation of this, and there cannot be one.** MCP is
 * client-initiated: a server can hold a tool call open for minutes, but it
 * cannot start one, and every caller above begins with the user clicking
 * something in Caret's window. An earlier version queued these tasks for an
 * agent to collect and nothing ever collected them, so sync and visual edits
 * silently did nothing whenever an agent was connected — worse than refusing.
 *
 * The implementation is now {@link BackendBridge}, which runs the task on the
 * coding backend Caret owns and drives (`backend.ts`). {@link NullBridge}
 * survives for the state where no backend is configured, which is supported: it
 * refuses with a message naming the fix rather than appearing to work.
 */
import { NoBackendError } from "./backend"
import type { AgentConversation } from "./conversation"

export type AgentTaskKind = "sync" | "visual-edit" | "flow-sync"

export interface AgentTask {
	kind: AgentTaskKind
	/** The fully built prompt. Prompt construction stays in the design core. */
	prompt: string
	/** What the chat shows in place of the prompt — usually the user's own words. */
	displayPrompt?: string
	/** Data-URL images (overlay-editor screenshots). */
	images?: string[]
	/** Kind-specific structured context, echoed to the agent alongside the prompt. */
	context?: Record<string, unknown>
	/** Shown above the turn in the chat, in Caret's own voice. */
	note?: string
	/**
	 * Nobody is watching this turn's prompts — a playground take running
	 * unattended. Anything that would ASK the user is denied with a reason
	 * instead: a question no one can see is a deadlock, not a safeguard.
	 */
	unattended?: boolean
	/** Tools withheld from the model this turn, in the backend's namespace. */
	disabledTools?: string[]
}

export interface AgentBridge {
	/** Whether a backend is configured and able to accept work. */
	connected(): boolean
	/**
	 * Runs a task on the backend.
	 *
	 * Resolves when the turn **finishes**, not when it is accepted. That changed
	 * with Phase 6.4: Caret owns the loop now, so it can tell the difference
	 * between "handed off" and "done", and every caller would rather report the
	 * second.
	 *
	 * Rejects with {@link NoBackendError} when nothing is configured.
	 */
	request(task: AgentTask): Promise<void>
}

/** Refuses every request, with an explanation. Used when no backend is set up. */
export class NullBridge implements AgentBridge {
	connected(): boolean {
		return false
	}

	async request(task: AgentTask): Promise<void> {
		throw new NoBackendError(task.kind === "sync" ? "sync" : task.kind === "flow-sync" ? "flow-sync" : "visual-edit")
	}
}

const TITLES: Record<AgentTaskKind, string> = {
	sync: "Sync design → app",
	"visual-edit": "Edit",
	"flow-sync": "Update navigation",
}

/**
 * Runs outbound tasks on the project's own conversation, so everything Caret
 * starts appears in the same chat the user can read, stop and answer.
 */
export class BackendBridge implements AgentBridge {
	constructor(
		private readonly conversation: AgentConversation,
		private readonly isReady: () => boolean,
	) {}

	connected(): boolean {
		return this.isReady()
	}

	async request(task: AgentTask): Promise<void> {
		const outcome = await this.conversation.run({
			kind: task.kind === "sync" ? "sync-apply" : task.kind === "flow-sync" ? "flow-sync" : "edit",
			title: TITLES[task.kind],
			// Sync's plan phase runs through the sync orchestrator, which starts its
			// own read-only session. Anything arriving here is meant to write.
			mode: "write",
			prompt: task.prompt,
			displayPrompt: task.displayPrompt,
			images: task.images,
			note: task.note,
			unattended: task.unattended,
			disabledTools: task.disabledTools,
			context: task.context,
		})

		if (!outcome.ok) {
			throw new Error("The agent could not finish that — see the chat for what it said.")
		}
	}
}

// Bridges are looked up per project — see `services.ts`.
