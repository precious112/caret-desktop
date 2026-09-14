/**
 * The explore lane: the playground's take generation, in parallel.
 *
 * The edit lane is deliberately one-at-a-time — a queue the user can't see
 * into is worse than a plain refusal. Takes are different: every take edits
 * only its own copied page directory, nobody is answering their prompts
 * (they run unattended and auto-deny), and the whole point of a round is
 * that three readings of one instruction arrive together. So each running
 * take gets its own {@link AgentConversation} — the same isolation the edit
 * lane has from the chat, applied between takes.
 *
 * Concurrency is capped: a deepening round on top of a still-working round
 * could otherwise stack six paid model turns from two clicks. Nothing is
 * refused — a take past the cap waits its turn and says so.
 */

import { NoBackendError } from "./backend"
import type { AgentTask } from "./bridge"
import { type AgentConversation, type ConversationState } from "./conversation"

/** How many takes generate at once. Matches the round size, so one round always runs fully parallel. */
export const EXPLORE_CONCURRENCY = 3

export interface ExploreTakeStatus {
	nodeId: string
	phase: "working" | "done" | "failed" | "cancelled"
	/** Latest activity line — "editing index.tsx…", or "waiting for a free agent". */
	detail?: string
	error?: string
}

/** Thrown by {@link ExploreLane.run} when the take was cancelled rather than failed. */
export class ExploreCancelledError extends Error {
	constructor() {
		super("Cancelled.")
		this.name = "ExploreCancelledError"
	}
}

interface SlotTicket {
	grant: () => void
	abandon: () => void
}

interface RunningTake {
	/** Null while the take is still waiting for a concurrency slot. */
	conversation: AgentConversation | null
	cancelled: boolean
	/** Present only while queued for a slot — cancel() abandons it so a queued
	 * take dies immediately instead of waiting for a slot it will never use. */
	ticket: SlotTicket | null
	/** Settles when run() has fully finished — cancelAll awaits these so a
	 * pick/discard never deletes a directory a turn is still writing into. */
	settled: Promise<void>
	markSettled: () => void
}

export class ExploreLane {
	private readonly running = new Map<string, RunningTake>()
	private active = 0
	private readonly queue: SlotTicket[] = []

	constructor(
		private readonly makeConversation: (onChange: (state: ConversationState) => void) => AgentConversation,
		private readonly isReady: () => boolean,
		private readonly onStatus: (status: ExploreTakeStatus) => void,
	) {}

	connected(): boolean {
		return this.isReady()
	}

	busy(): boolean {
		return this.running.size > 0
	}

	/**
	 * Generates one take. Resolves when its turn settles; rejects with
	 * {@link ExploreCancelledError} on cancel, anything else on failure.
	 */
	async run(nodeId: string, task: AgentTask): Promise<void> {
		if (!this.isReady()) throw new NoBackendError("visual-edit")
		if (this.running.has(nodeId)) throw new Error(`Take "${nodeId}" is already generating.`)

		let markSettled = () => {}
		const settled = new Promise<void>((resolve) => {
			markSettled = resolve
		})
		const entry: RunningTake = { conversation: null, cancelled: false, ticket: null, settled, markSettled }
		this.running.set(nodeId, entry)
		this.onStatus({ nodeId, phase: "working" })

		try {
			const gotSlot = await this.acquireSlot(nodeId, entry)
			if (!gotSlot) throw new ExploreCancelledError()
			try {
				if (entry.cancelled) throw new ExploreCancelledError()
				const conversation = this.makeConversation((state) => this.handleState(nodeId, state))
				entry.conversation = conversation
				try {
					const outcome = await conversation.run({
						kind: "edit",
						title: "Take",
						mode: "write",
						prompt: task.prompt,
						displayPrompt: task.displayPrompt,
						images: task.images,
						note: task.note,
						unattended: true,
						disabledTools: task.disabledTools,
						context: task.context,
					})
					if (entry.cancelled) throw new ExploreCancelledError()
					if (!outcome.ok) throw new Error("The agent could not finish this take.")
					this.onStatus({ nodeId, phase: "done" })
				} finally {
					await conversation.close().catch(() => {})
				}
			} finally {
				this.releaseSlot()
			}
		} catch (err) {
			if (entry.cancelled || err instanceof ExploreCancelledError) {
				this.onStatus({ nodeId, phase: "cancelled" })
				throw new ExploreCancelledError()
			}
			this.onStatus({ nodeId, phase: "failed", error: err instanceof Error ? err.message : String(err) })
			throw err
		} finally {
			this.running.delete(nodeId)
			entry.markSettled()
		}
	}

	/** Cancels one take. A queued take never starts; a streaming one is aborted. */
	async cancel(nodeId: string): Promise<void> {
		const entry = this.running.get(nodeId)
		if (!entry) return
		entry.cancelled = true
		this.abandonTicket(entry)
		await entry.conversation?.abort()
		await entry.settled
	}

	/**
	 * Cancels every running take and waits for all of them to actually finish.
	 * Pick and discard call this BEFORE deleting anything, so no turn is ever
	 * left editing a directory that no longer exists.
	 */
	async cancelAll(): Promise<void> {
		const entries = [...this.running.values()]
		for (const entry of entries) {
			entry.cancelled = true
			this.abandonTicket(entry)
		}
		await Promise.allSettled(entries.map((entry) => entry.conversation?.abort()))
		await Promise.allSettled(entries.map((entry) => entry.settled))
	}

	/**
	 * Detail extraction from a take conversation's state pushes — the same
	 * last-tool-line the edit pill shows, minus the permission branch:
	 * unattended turns auto-deny, so a pending ask never survives to be shown.
	 */
	private handleState(nodeId: string, state: ConversationState): void {
		const entry = this.running.get(nodeId)
		if (!entry || entry.cancelled) return
		const entries = state.transcript.entries
		const lastTool = [...entries].reverse().find((item) => item.kind === "tool")
		if (lastTool && lastTool.kind === "tool") {
			this.onStatus({ nodeId, phase: "working", detail: lastTool.summary || lastTool.name })
		}
	}

	/** Resolves true holding a slot, false if the take was cancelled while queued. */
	private acquireSlot(nodeId: string, entry: RunningTake): Promise<boolean> {
		if (entry.cancelled) return Promise.resolve(false)
		if (this.active < EXPLORE_CONCURRENCY) {
			this.active++
			return Promise.resolve(true)
		}
		this.onStatus({ nodeId, phase: "working", detail: "waiting for a free agent" })
		return new Promise<boolean>((resolve) => {
			const ticket: SlotTicket = {
				// Granted by releaseSlot, which hands its slot over — the count stays put.
				grant: () => {
					entry.ticket = null
					resolve(true)
				},
				abandon: () => {
					entry.ticket = null
					resolve(false)
				},
			}
			entry.ticket = ticket
			this.queue.push(ticket)
		})
	}

	private releaseSlot(): void {
		const next = this.queue.shift()
		if (next) next.grant()
		else this.active--
	}

	/** Pulls a queued take out of line so its run settles now, not at the next free slot. */
	private abandonTicket(entry: RunningTake): void {
		if (!entry.ticket) return
		const index = this.queue.indexOf(entry.ticket)
		if (index >= 0) this.queue.splice(index, 1)
		entry.ticket.abandon()
	}
}
