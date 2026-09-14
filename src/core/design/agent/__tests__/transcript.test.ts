/**
 * Ghost permissions.
 *
 * A permission ask rendered as live Allow/Refuse buttons while the agent
 * visibly proceeds past it is worse than either honest state: the user cannot
 * tell whether answering still matters. Observed in the wild — the ask stayed
 * pending while later tool calls streamed in below it. Two rules kill the
 * ghost: a reply settled anywhere (backend config, timeout, another surface)
 * resolves the entry, and no pending ask survives the end of its turn.
 */
import { strict as assert } from "assert"

import { applyEvent, emptyTranscript, resolvePermission } from "../transcript"

function pending(state = emptyTranscript()) {
	applyEvent(state, { type: "permission", requestId: "req-1", tool: "bash", summary: "Run `tail -30 vite.log`?" })
	return state
}

function entry(state: ReturnType<typeof emptyTranscript>) {
	const found = state.entries.find((e) => e.kind === "permission")
	assert.ok(found && found.kind === "permission")
	return found
}

describe("transcript permissions", () => {
	it("resolves a pending ask when the backend settles it without Caret", () => {
		const state = pending()
		applyEvent(state, { type: "permission-resolved", requestId: "req-1", allowed: true })

		const e = entry(state)
		assert.equal(e.status, "allowed")
		assert.equal(e.automatic, "settled by the backend")
	})

	it("does not let the backend's echo overwrite the user's own decision", () => {
		const state = pending()
		// The user clicked Deny; the server echoes the reply back as an event.
		resolvePermission(state, "req-1", "denied")
		applyEvent(state, { type: "permission-resolved", requestId: "req-1", allowed: true })

		assert.equal(entry(state).status, "denied", "the echo flipped a decision the user already made")
	})

	it("expires any still-pending ask when the turn ends", () => {
		const state = pending()
		applyEvent(state, { type: "done", text: "" })

		const e = entry(state)
		assert.equal(e.status, "denied", "live buttons survived the turn they belonged to")
		assert.match(e.automatic ?? "", /turn ended/)
	})

	it("leaves answered asks alone at turn end", () => {
		const state = pending()
		resolvePermission(state, "req-1", "allowed")
		applyEvent(state, { type: "done", text: "" })

		const e = entry(state)
		assert.equal(e.status, "allowed")
		assert.equal(e.automatic, undefined)
	})
})

describe("transcript retries", () => {
	it("a backend retry lands as a RED error entry, with the provider's words", () => {
		const state = emptyTranscript()
		applyEvent(state, { type: "retry", attempt: 2, message: "Endpoint is unavailable." })

		const entry = state.entries[0]
		assert.equal(entry?.kind, "error")
		assert(entry.kind === "error" && entry.message.includes("Endpoint is unavailable."), "the provider's words are missing")
		assert(entry.kind === "error" && entry.message.includes("attempt 2"), "the attempt count is missing")
	})

	it("a bare retry still says what is happening", () => {
		const state = emptyTranscript()
		applyEvent(state, { type: "retry" })

		const entry = state.entries[0]
		assert.equal(entry?.kind, "error")
		assert(entry.kind === "error" && /retrying/.test(entry.message))
	})
})
