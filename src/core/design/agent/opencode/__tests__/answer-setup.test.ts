import { strict as assert } from "assert"

import { ANSWER_AGENT, answerSetup } from "../index"

/**
 * One-off answers run as Caret's lean agent, whose own short prompt replaces
 * the backend's coding-agent prompt and which may use nothing unless the call
 * opts in (measured: ~8,000 input tokens as the default agent, under 500 as
 * this one). These pin which agent and which tools each kind of answer gets.
 */
describe("what each one-off answer runs as", () => {
	const base = { workingDirectory: "/p", prompt: "x", schema: {} }

	it("a plain answer: the lean agent, no tools", () => {
		const setup = answerSetup(base)
		assert.equal(setup.agent, ANSWER_AGENT)
		assert.deepEqual(setup.tools, {})
	})

	it("an answer that reads the project: the lean agent, reads only", () => {
		assert.deepEqual(answerSetup({ ...base, reads: true }).tools, { read: true, glob: true, grep: true, list: true })
	})

	it("an answer that needs tools: the lean agent with exactly the tools it asks for", () => {
		const setup = answerSetup({ ...base, allowTools: true, tools: { caret_view_reference: true } })
		assert.equal(setup.agent, ANSWER_AGENT)
		assert.deepEqual(setup.tools, { caret_view_reference: true })
	})
})
