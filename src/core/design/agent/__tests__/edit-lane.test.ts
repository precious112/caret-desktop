/**
 * The edit lane's contract with the pill.
 *
 * The pill renders exactly what this bridge narrates, so the narration IS the
 * UX: an instant "working" with the user's words, one edit at a time refused in
 * plain language, details only while busy, and a terminal phase for every way a
 * turn can end. A lifecycle hole here is a pill that spins forever — the
 * "screen froze" experience this whole lane exists to kill.
 */
import { strict as assert } from "assert"

import type { AgentConversation, ConversationState, RunOutcome } from "../conversation"
import { EditLaneBridge, type EditStatus } from "../edit-lane"

function stubConversation(behaviour: { run?: () => Promise<RunOutcome>; onAbort?: () => void }): AgentConversation {
	return {
		run: behaviour.run ?? (async () => ({ ok: true, sessionId: "s", text: "", closingText: "", filesChanged: [] })),
		abort: async () => behaviour.onAbort?.(),
		respondToPermission: async () => {},
	} as unknown as AgentConversation
}

function lane(conversation: AgentConversation, statuses: EditStatus[], ready = true): EditLaneBridge {
	return new EditLaneBridge(
		() => conversation,
		() => ready,
		(status) => statuses.push(status),
	)
}

const TASK = { kind: "visual-edit" as const, prompt: "p", displayPrompt: "make the heading bolder" }

function state(entries: unknown[]): ConversationState {
	return { transcript: { entries } } as unknown as ConversationState
}

describe("EditLaneBridge", () => {
	it("narrates working (with the user's words) then done", async () => {
		const statuses: EditStatus[] = []
		await lane(stubConversation({}), statuses).request(TASK)

		assert.deepEqual(
			statuses.map((s) => s.phase),
			["working", "done"],
		)
		assert.equal(statuses[0].instruction, "make the heading bolder")
	})

	it("narrates failed when the turn does not finish, and still throws", async () => {
		const statuses: EditStatus[] = []
		const bridge = lane(
			stubConversation({ run: async () => ({ ok: false, sessionId: "s", text: "", closingText: "", filesChanged: [] }) }),
			statuses,
		)

		await assert.rejects(bridge.request(TASK))
		assert.equal(statuses.at(-1)?.phase, "failed")
		assert.ok(statuses.at(-1)?.error, "a failure with no message is a pill with nothing to say")
	})

	it("refuses a second edit while one is in flight, in words the pill can show", async () => {
		const statuses: EditStatus[] = []
		let release: () => void = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const bridge = lane(
			stubConversation({
				run: async () => {
					await gate
					return { ok: true, sessionId: "s", text: "", closingText: "", filesChanged: [] }
				},
			}),
			statuses,
		)

		const first = bridge.request(TASK)
		await assert.rejects(bridge.request(TASK), /Still working on your last edit/)
		release()
		await first

		// The refusal must not have disturbed the first edit's lifecycle.
		assert.deepEqual(
			statuses.map((s) => s.phase),
			["working", "done"],
		)
	})

	it("maps an aborted turn to cancelled, not to done or failed", async () => {
		const statuses: EditStatus[] = []
		let release: () => void = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const bridge = lane(
			stubConversation({
				// The conversation's abort ends the stream; run resolves ok with
				// nothing written — which must not read as "Edit applied".
				run: async () => {
					await gate
					return { ok: true, sessionId: "s", text: "", closingText: "", filesChanged: [] }
				},
				onAbort: () => release(),
			}),
			statuses,
		)

		const inFlight = bridge.request(TASK)
		await bridge.cancel()
		await assert.rejects(inFlight)

		assert.equal(statuses.at(-1)?.phase, "cancelled")
	})

	it("relays the latest tool line while busy, and nothing when idle", async () => {
		const statuses: EditStatus[] = []
		let release: () => void = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const conversation = stubConversation({
			run: async () => {
				await gate
				return { ok: true, sessionId: "s", text: "", closingText: "", filesChanged: [] }
			},
		})
		const bridge = lane(conversation, statuses)

		const inFlight = bridge.request(TASK)
		bridge.handleState(
			state([{ kind: "tool", id: "t1", callId: "c", name: "edit", summary: "editing ProductCard.tsx", status: "running" }]),
		)
		release()
		await inFlight

		// After the turn, a stale state push must not resurrect the pill.
		bridge.handleState(state([{ kind: "tool", id: "t2", callId: "c", name: "read", summary: "late", status: "ok" }]))

		assert.deepEqual(
			statuses.map((s) => s.phase),
			["working", "working", "done"],
		)
		assert.equal(statuses[1].detail, "editing ProductCard.tsx")
	})

	it("surfaces a pending permission with its requestId, so the pill can answer it", async () => {
		const statuses: EditStatus[] = []
		let release: () => void = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const bridge = lane(
			stubConversation({
				run: async () => {
					await gate
					return { ok: true, sessionId: "s", text: "", closingText: "", filesChanged: [] }
				},
			}),
			statuses,
		)

		const inFlight = bridge.request(TASK)
		bridge.handleState(
			state([{ kind: "permission", id: "p1", requestId: "req-9", summary: "write src/App.tsx", status: "pending" }]),
		)
		release()
		await inFlight

		const ask = statuses.find((s) => s.phase === "needs-permission")
		assert.ok(ask, "a blocking ask never reached the pill — that is an invisible freeze")
		assert.equal(ask?.permission?.requestId, "req-9")
	})

	it("refuses with NoBackendError when nothing is configured", async () => {
		const statuses: EditStatus[] = []
		await assert.rejects(lane(stubConversation({}), statuses, false).request(TASK), /backend/i)
		assert.deepEqual(statuses, [], "a refused request must not flash a working pill")
	})
})
