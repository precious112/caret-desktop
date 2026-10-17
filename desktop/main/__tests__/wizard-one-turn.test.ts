/**
 * The interview does one thing at a time per project.
 *
 * React's StrictMode mounts the interview twice in development: unguarded,
 * the start ran two model turns and the later one replaced the question on
 * screen (five options became three). So the same action asked twice while it
 * runs gets the same result. Different actions wait their turn, in order: the
 * old guard gave an answer sent during a retry the retry's result, and the
 * answer was silently lost.
 */
import { strict as assert } from "assert"

import { oneAtATime } from "../token-wizard"

function gate<T>() {
	let open: (value: T) => void = () => {}
	const opened = new Promise<T>((resolve) => {
		open = resolve
	})
	return { opened, open }
}

describe("the interview does one thing at a time per project", () => {
	it("the same action asked twice while it runs runs once, and both get its result", async () => {
		let runs = 0
		const release = gate<string>()
		const run = () => {
			runs += 1
			return release.opened
		}
		const first = oneAtATime("/p", "start", run)
		const second = oneAtATime("/p", "start", run)
		release.open("question 1")
		assert.equal(await first, "question 1")
		assert.equal(await second, "question 1")
		assert.equal(runs, 1)
	})

	it("a different action waits for the one running, then runs: it is never dropped", async () => {
		const order: string[] = []
		const retry = gate<string>()
		const retrying = oneAtATime("/p", "retry", async () => {
			order.push("retry started")
			const result = await retry.opened
			order.push("retry done")
			return result
		})
		const answering = oneAtATime("/p", "answer:q2", async () => {
			order.push("answer ran")
			return "question 3"
		})
		retry.open("question 2")
		assert.equal(await retrying, "question 2")
		assert.equal(await answering, "question 3", "the answer got another action's result")
		assert.deepEqual(order, ["retry started", "retry done", "answer ran"])
	})

	it("a failed action doesn't block the next one, and projects never wait for each other", async () => {
		await assert.rejects(oneAtATime("/p", "retry", async () => Promise.reject(new Error("model down"))))
		assert.equal(await oneAtATime("/p", "retry", async () => "ok"), "ok")
		const slow = gate<string>()
		const other = oneAtATime("/a", "start", () => slow.opened)
		assert.equal(await oneAtATime("/b", "start", async () => "b first"), "b first")
		slow.open("a")
		assert.equal(await other, "a")
	})
})
