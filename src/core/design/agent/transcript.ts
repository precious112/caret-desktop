/**
 * The chat transcript, and the one reducer that builds it.
 *
 * Live turns and rehydrated history both arrive as {@link BackendEvent}s and go
 * through this same function, so a replayed session cannot render differently
 * from the session that produced it — which is exactly what happens when the
 * history panel gets its own parser.
 */
import type { BackendEvent } from "./backend"

export type ToolStatus = "running" | "ok" | "failed"
export type PermissionStatus = "pending" | "allowed" | "denied"

export type TranscriptEntry =
	| { kind: "user"; id: string; text: string }
	/**
	 * `plan` marks an entry that was the reply of a completed plan-mode turn.
	 * The flag is permanent history — which entry is the LIVE plan is decided
	 * by `ConversationState.plan.entryId`, so a discarded or superseded plan
	 * demotes without rewriting the transcript.
	 */
	| { kind: "assistant"; id: string; text: string; plan?: true }
	| { kind: "thinking"; id: string; text: string }
	| { kind: "tool"; id: string; callId: string; name: string; summary: string; status: ToolStatus }
	| {
			kind: "permission"
			id: string
			requestId: string
			summary: string
			status: PermissionStatus
			/** Set when Caret decided without asking, so the transcript says why. */
			automatic?: string
	  }
	| { kind: "error"; id: string; message: string }
	/** Caret's own voice — never the model's. */
	| { kind: "note"; id: string; text: string }

export interface Usage {
	inputTokens: number
	outputTokens: number
	costUsd: number
}

export interface TranscriptState {
	entries: TranscriptEntry[]
	/** Files the agent changed this session, in first-touched order. */
	files: string[]
	usage: Usage
}

export function emptyTranscript(): TranscriptState {
	return { entries: [], files: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }
}

let counter = 0
function nextId(prefix: string): string {
	counter += 1
	return `${prefix}-${counter}`
}

/**
 * Folds one event into the transcript, in place.
 *
 * Streaming text is appended to the entry already at the tail rather than
 * creating one entry per chunk — a chat that renders a paragraph as forty
 * separate bubbles is unreadable, and re-deriving that at render time means the
 * renderer has to know which chunks belong together.
 */
export function applyEvent(state: TranscriptState, event: BackendEvent): void {
	switch (event.type) {
		case "user-message":
			state.entries.push({ kind: "user", id: nextId("user"), text: event.text })
			return

		case "text":
			appendText(state, "assistant", event.text)
			return

		case "thinking":
			appendText(state, "thinking", event.text)
			return

		case "tool-start":
			state.entries.push({
				kind: "tool",
				id: nextId("tool"),
				callId: event.callId,
				name: event.name,
				summary: event.summary,
				status: "running",
			})
			return

		case "tool-end": {
			const entry = [...state.entries].reverse().find((e) => e.kind === "tool" && e.callId === event.callId)
			if (entry && entry.kind === "tool") {
				entry.status = event.ok ? "ok" : "failed"
				if (event.summary) entry.summary = event.summary
			}
			return
		}

		case "file-changed":
			if (!state.files.includes(event.path)) state.files.push(event.path)
			return

		case "permission":
			state.entries.push({
				kind: "permission",
				id: nextId("perm"),
				requestId: event.requestId,
				summary: event.summary,
				status: "pending",
			})
			return

		case "permission-resolved": {
			// Settled backend-side without Caret in the loop — its own config, a
			// timeout. The buttons must leave the screen the moment they stop
			// meaning anything. Only a still-pending ask resolves here: our own
			// replies echo back as the same event, and that echo must not stamp
			// "settled by the backend" over the user's actual decision.
			const pending = state.entries.find(
				(e) => e.kind === "permission" && e.requestId === event.requestId && e.status === "pending",
			)
			if (pending) {
				resolvePermission(state, event.requestId, event.allowed ? "allowed" : "denied", "settled by the backend")
			}
			return
		}

		case "retry":
			// An error entry, not a muted note — it IS an error, and it renders
			// red. The turn stays alive (the backend is retrying), which is why
			// this is a transcript entry and not a turn failure.
			state.entries.push({
				kind: "error",
				id: nextId("error"),
				message: `The provider errored${event.message ? `: "${event.message}"` : ""} — the backend is retrying${
					event.attempt !== undefined ? ` (attempt ${event.attempt})` : ""
				}.`,
			})
			return

		case "usage":
			state.usage = {
				inputTokens: state.usage.inputTokens + (event.inputTokens ?? 0),
				outputTokens: state.usage.outputTokens + (event.outputTokens ?? 0),
				costUsd: state.usage.costUsd + (event.costUsd ?? 0),
			}
			return

		case "error":
			state.entries.push({ kind: "error", id: nextId("error"), message: event.message })
			return

		case "done":
			// A pending ask cannot outlive its turn: the agent has moved on and the
			// buttons no longer do anything. Leaving them live is the ghost-request
			// experience — an Allow that arrives after the fact, answering nothing.
			for (const entry of state.entries) {
				if (entry.kind === "permission" && entry.status === "pending") {
					entry.status = "denied"
					entry.automatic = "the turn ended before this was answered"
				}
			}
			return
	}
}

/** Records what happened to a permission, whether Caret or the user decided it. */
export function resolvePermission(state: TranscriptState, requestId: string, status: PermissionStatus, automatic?: string): void {
	const entry = state.entries.find((e) => e.kind === "permission" && e.requestId === requestId)
	if (entry && entry.kind === "permission") {
		entry.status = status
		if (automatic) entry.automatic = automatic
	}
}

/**
 * Flags the last assistant entry as a plan and returns its id.
 *
 * Called by the conversation when a plan-mode turn completes with a reply; the
 * reducer itself never sets the flag, because replayed history arrives without
 * turn modes and an "Earlier session" rendering plans as prose is correct.
 */
export function markPlanEntry(state: TranscriptState): string | null {
	for (let i = state.entries.length - 1; i >= 0; i--) {
		const entry = state.entries[i]
		if (entry.kind === "assistant") {
			entry.plan = true
			return entry.id
		}
	}
	return null
}

export function addNote(state: TranscriptState, text: string): void {
	state.entries.push({ kind: "note", id: nextId("note"), text })
}

export function addUserMessage(state: TranscriptState, text: string): void {
	state.entries.push({ kind: "user", id: nextId("user"), text })
}

function appendText(state: TranscriptState, kind: "assistant" | "thinking", text: string): void {
	const tail = state.entries[state.entries.length - 1]
	if (tail && tail.kind === kind) {
		tail.text += text
		return
	}
	state.entries.push({ kind, id: nextId(kind), text } as TranscriptEntry)
}
