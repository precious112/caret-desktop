/**
 * The mapper's one hard job: telling the assistant's parts from the echo of
 * the user's own prompt, without knowing anyone's id scheme.
 *
 * The previous design recognised the user's message by a Caret-assigned id
 * (`msg_caret_<uuid>`), and that id is what broke resumed sessions: the
 * server's agent loop orders its queue by message id, its own ids are
 * ascending, and a foreign id sorting before the previous turn's assistant
 * messages reads as already-processed history — the loop exits at step 0
 * without running the model. Sorting after them is the mirror failure: the
 * same prompt is re-run forever (observed, 107 times). So the mapper must
 * work from what the bus announces — `message.updated` carries the role,
 * always before that message's parts — and anything not announced as the
 * assistant's stays off-screen.
 */
import { strict as assert } from "assert"

import type { BackendEvent } from "../../backend"
import { EventMapper } from "../index"
import type { OpencodeEvent } from "../protocol"

const SESSION = "ses_test"

function collect(mapper: EventMapper, events: OpencodeEvent[]): BackendEvent[] {
	return events.flatMap((event) => [...mapper.map(event)])
}

function announced(messageId: string, role: string, sessionID = SESSION): OpencodeEvent {
	return { type: "message.updated", properties: { sessionID, info: { id: messageId, role } } }
}

function textPart(messageId: string, text: string, partId = `prt_${messageId}`): OpencodeEvent {
	return {
		type: "message.part.updated",
		properties: { sessionID: SESSION, part: { type: "text", id: partId, messageID: messageId, text } },
	} as OpencodeEvent
}

function reasoningPart(messageId: string, text: string, partId = `prt_${messageId}`): OpencodeEvent {
	return {
		type: "message.part.updated",
		properties: { sessionID: SESSION, part: { type: "reasoning", id: partId, messageID: messageId, text } },
	} as OpencodeEvent
}

function delta(partId: string, messageId: string, text: string, sessionID = SESSION): OpencodeEvent {
	return {
		type: "message.part.delta",
		properties: { sessionID, messageID: messageId, partID: partId, field: "text", delta: text },
	} as OpencodeEvent
}

describe("EventMapper", () => {
	it("replays nothing of a message never announced as the assistant's", () => {
		// The user's own prompt coming back over the bus, exactly as the server
		// sends it: the message exists, its role was announced as `user`, its
		// text part follows.
		const mapper = new EventMapper(SESSION)
		const events = collect(mapper, [announced("msg_user", "user"), textPart("msg_user", "make the header blue")])
		assert.deepEqual(events, [])
	})

	it("maps the assistant's text once the bus has announced the message", () => {
		const mapper = new EventMapper(SESSION)
		const events = collect(mapper, [
			announced("msg_assistant", "assistant"),
			textPart("msg_assistant", "Changing the header now."),
		])
		assert.deepEqual(events, [{ type: "text", text: "Changing the header now." }])
	})

	it("drops parts whose message was announced by a different session", () => {
		// Two sessions share one per-directory bus. An announcement from another
		// session must not put its messages on this turn's allowlist.
		const mapper = new EventMapper(SESSION)
		const events = collect(mapper, [
			announced("msg_other", "assistant", "ses_other"),
			textPart("msg_other", "spoken elsewhere"),
		])
		assert.deepEqual(events, [])
	})

	it("emits only the suffix when the same part is re-sent longer", () => {
		const mapper = new EventMapper(SESSION)
		const events = collect(mapper, [
			announced("msg_a", "assistant"),
			textPart("msg_a", "Hello"),
			textPart("msg_a", "Hello, world"),
		])
		assert.deepEqual(events, [
			{ type: "text", text: "Hello" },
			{ type: "text", text: ", world" },
		])
	})

	// The delta contract, measured on the pinned server: `part.updated` fires
	// only at a part's creation (empty) and completion (whole text); every token
	// in between is a `message.part.delta`. A five-minute reasoning turn showed
	// "Working…" the whole way because the mapper only read `updated` — and a
	// cancelled turn never even gets the completing one.
	it("streams reasoning deltas as thinking, live", () => {
		const mapper = new EventMapper(SESSION)
		const events = collect(mapper, [
			announced("msg_a", "assistant"),
			reasoningPart("msg_a", "", "prt_r"),
			delta("prt_r", "msg_a", "Let me plan"),
			delta("prt_r", "msg_a", " the pages."),
		])
		assert.deepEqual(events, [
			{ type: "thinking", text: "Let me plan" },
			{ type: "thinking", text: " the pages." },
		])
	})

	it("does not re-speak deltas when the completing part re-sends the whole text", () => {
		const mapper = new EventMapper(SESSION)
		const events = collect(mapper, [
			announced("msg_a", "assistant"),
			textPart("msg_a", "", "prt_t"),
			delta("prt_t", "msg_a", "Hello"),
			delta("prt_t", "msg_a", ", world"),
			// Completion: the server re-sends the part whole, as measured.
			textPart("msg_a", "Hello, world", "prt_t"),
		])
		assert.deepEqual(events, [
			{ type: "text", text: "Hello" },
			{ type: "text", text: ", world" },
		])
	})

	it("still catches up from the completing part if deltas were missed", () => {
		const mapper = new EventMapper(SESSION)
		const events = collect(mapper, [
			announced("msg_a", "assistant"),
			textPart("msg_a", "", "prt_t"),
			delta("prt_t", "msg_a", "Hello"),
			textPart("msg_a", "Hello, world", "prt_t"),
		])
		assert.deepEqual(events, [
			{ type: "text", text: "Hello" },
			{ type: "text", text: ", world" },
		])
	})

	it("drops deltas of the user's own prompt echo and of unknown parts", () => {
		// The user's message streams over the same bus with the same shapes; its
		// `part.updated` never passes the role gate, so its part id earns no kind
		// and its deltas must stay off-screen. A delta for a part never announced
		// at all is the same case.
		const mapper = new EventMapper(SESSION)
		const events = collect(mapper, [
			announced("msg_user", "user"),
			textPart("msg_user", "", "prt_u"),
			delta("prt_u", "msg_user", "make the header blue"),
			delta("prt_never_seen", "msg_user", "ghost"),
		])
		assert.deepEqual(events, [])
	})

	it("drops deltas from another session", () => {
		const mapper = new EventMapper(SESSION)
		const events = collect(mapper, [
			announced("msg_a", "assistant"),
			textPart("msg_a", "", "prt_t"),
			delta("prt_t", "msg_a", "spoken elsewhere", "ses_other"),
		])
		assert.deepEqual(events, [])
	})

	// The pinned server (1.18.23) documents this but it has never been seen
	// live — this synthetic event is the only exercise it gets, and the mapping
	// is what turns seven silent minutes into "the provider errored — retrying".
	it("maps session.retry.scheduled to a retry event with the provider's words", () => {
		const mapper = new EventMapper(SESSION)
		const events = collect(mapper, [
			{
				type: "session.retry.scheduled",
				properties: {
					sessionID: SESSION,
					attempt: 2,
					error: { name: "AI_APICallError", data: { message: "Endpoint is unavailable." } },
				},
			} as OpencodeEvent,
		])
		assert.deepEqual(events, [{ type: "retry", attempt: 2, message: "Endpoint is unavailable." }])
	})

	it("drops another session's retry, and tolerates one with no detail", () => {
		const mapper = new EventMapper(SESSION)
		const foreign = collect(mapper, [
			{ type: "session.retry.scheduled", properties: { sessionID: "ses_other", attempt: 1 } } as OpencodeEvent,
		])
		assert.deepEqual(foreign, [])

		const bare = collect(mapper, [{ type: "session.retry.scheduled", properties: {} } as OpencodeEvent])
		assert.deepEqual(bare, [{ type: "retry" }])
	})

	it("maps session.idle for this session to done, and ignores other sessions'", () => {
		const mapper = new EventMapper(SESSION)
		const foreign = collect(mapper, [{ type: "session.idle", properties: { sessionID: "ses_other" } }])
		assert.deepEqual(foreign, [])

		const own = collect(mapper, [{ type: "session.idle", properties: { sessionID: SESSION } }])
		assert.deepEqual(own, [{ type: "done", text: "" }])
	})
})
