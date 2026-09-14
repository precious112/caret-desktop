/**
 * The explore lane's contract with the playground.
 *
 * The cards render exactly what this lane narrates per node, and the pick
 * path relies on cancelAll actually WAITING: a settle that resolves while a
 * take's turn is still writing would let the router delete the directory
 * under it — the bug class this lane exists to close.
 */
import { strict as assert } from "assert"

import type { AgentConversation, ConversationState, RunOutcome } from "../conversation"
import { EXPLORE_CONCURRENCY, ExploreCancelledError, ExploreLane, type ExploreTakeStatus } from "../explore-lane"

const OK: RunOutcome = { ok: true, sessionId: "s", text: "", closingText: "", filesChanged: [] } as RunOutcome

interface StubHandle {
	conversation: AgentConversation
	finish: (outcome?: RunOutcome) => void
	aborted: () => boolean
	pushState: (entries: unknown[]) => void
}

/** A conversation whose run() the test settles by hand, so concurrency is observable. */
function stubConversation(onChange: (state: ConversationState) => void): StubHandle {
	let resolveRun: (outcome: RunOutcome) => void = () => {}
	let aborted = false
	const conversation = {
		run: () =>
			new Promise<RunOutcome>((resolve) => {
				resolveRun = resolve
			}),
		abort: async () => {
			aborted = true
			resolveRun({ ...OK, ok: false })
		},
		close: async () => {},
	} as unknown as AgentConversation
	return {
		conversation,
		finish: (outcome = OK) => resolveRun(outcome),
		aborted: () => aborted,
		pushState: (entries) => onChange({ transcript: { entries } } as unknown as ConversationState),
	}
}

function makeLane(ready = true) {
	const statuses: ExploreTakeStatus[] = []
	const handles: StubHandle[] = []
	const lane = new ExploreLane(
		(onChange) => {
			const handle = stubConversation(onChange)
			handles.push(handle)
			return handle.conversation
		},
		() => ready,
		(status) => statuses.push(status),
	)
	return { lane, statuses, handles }
}

const task = (n: number) => ({ kind: "visual-edit" as const, prompt: `p${n}` })

/** Lets queued microtasks (slot grants, conversation creation) run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

describe("ExploreLane", () => {
	it("runs a whole round in parallel — every take gets its own conversation at once", async () => {
		const { lane, handles } = makeLane()
		const runs = [lane.run("home--v1", task(1)), lane.run("home--v2", task(2)), lane.run("home--v3", task(3))]
		await settle()

		assert.equal(handles.length, EXPLORE_CONCURRENCY, "all three takes should be streaming simultaneously")

		handles.forEach((h) => h.finish())
		await Promise.all(runs)
	})

	it("queues past the cap, says so, and starts the queued take when a slot frees", async () => {
		const { lane, statuses, handles } = makeLane()
		const runs = [
			lane.run("home--v1", task(1)),
			lane.run("home--v2", task(2)),
			lane.run("home--v3", task(3)),
			lane.run("home--v4", task(4)),
		]
		await settle()

		assert.equal(handles.length, EXPLORE_CONCURRENCY, "the fourth take must wait")
		const waiting = statuses.find((s) => s.nodeId === "home--v4" && s.detail === "waiting for a free agent")
		assert.ok(waiting, "a queued take must say it is waiting, not sit silent")

		handles[0].finish()
		await settle()
		assert.equal(handles.length, 4, "a freed slot starts the queued take")

		handles.slice(1).forEach((h) => h.finish())
		await Promise.all(runs)
	})

	it("narrates per-node details from each conversation's own state pushes", async () => {
		const { lane, statuses, handles } = makeLane()
		const runs = [lane.run("home--v1", task(1)), lane.run("home--v2", task(2))]
		await settle()

		handles[1].pushState([{ kind: "tool", name: "edit", summary: "editing index.tsx" }])
		const detail = statuses.find((s) => s.detail === "editing index.tsx")
		assert.equal(detail?.nodeId, "home--v2", "detail must be keyed to the node whose conversation pushed it")

		handles.forEach((h) => h.finish())
		await Promise.all(runs)
	})

	it("cancelling one take aborts only it — siblings keep streaming and can still finish", async () => {
		const { lane, statuses, handles } = makeLane()
		const first = lane.run("home--v1", task(1))
		const second = lane.run("home--v2", task(2))
		await settle()

		await Promise.all([lane.cancel("home--v1"), assert.rejects(first, ExploreCancelledError)])
		assert.ok(handles[0].aborted())
		assert.ok(!handles[1].aborted(), "the sibling must not be touched")
		assert.equal(statuses.filter((s) => s.phase === "cancelled").length, 1)

		handles[1].finish()
		await second
		assert.equal(statuses.at(-1)?.phase, "done")
	})

	it("cancelling a QUEUED take settles it immediately, without waiting for a slot", async () => {
		const { lane, handles } = makeLane()
		const runs = [lane.run("home--v1", task(1)), lane.run("home--v2", task(2)), lane.run("home--v3", task(3))]
		const queued = lane.run("home--v4", task(4))
		await settle()

		// No slot ever frees — the cancel must still resolve.
		await Promise.all([lane.cancel("home--v4"), assert.rejects(queued, ExploreCancelledError)])
		assert.equal(handles.length, EXPLORE_CONCURRENCY, "a cancelled queued take must never start a conversation")

		handles.forEach((h) => h.finish())
		await Promise.all(runs)
	})

	it("cancelAll aborts every take and resolves only after every run has fully settled", async () => {
		const { lane, handles } = makeLane()
		const runs = [lane.run("home--v1", task(1)), lane.run("home--v2", task(2))]
		await settle()

		let allSettled = false
		void Promise.allSettled(runs).then(() => {
			allSettled = true
		})
		await lane.cancelAll()
		await settle()

		assert.ok(handles.every((h) => h.aborted()))
		assert.ok(allSettled, "cancelAll resolved while a run was still in flight — a pick could delete under it")
		assert.equal(lane.busy(), false)
	})

	it("refuses a duplicate node and refuses everything without a backend", async () => {
		const { lane, handles } = makeLane()
		const run = lane.run("home--v1", task(1))
		await settle()
		await assert.rejects(lane.run("home--v1", task(1)), /already generating/)
		handles[0].finish()
		await run

		const notReady = makeLane(false)
		await assert.rejects(notReady.lane.run("home--v1", task(1)))
	})

	it("a failed take narrates failed with the message, and other phases stay untouched", async () => {
		const { lane, statuses, handles } = makeLane()
		const run = lane.run("home--v1", task(1))
		await settle()
		handles[0].finish({ ...OK, ok: false })

		await assert.rejects(run)
		const last = statuses.at(-1)
		assert.equal(last?.phase, "failed")
		assert.ok(last?.error, "a failure with no message is a card with nothing to say")
	})
})
