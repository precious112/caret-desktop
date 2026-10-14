import { strict as assert } from "assert"

import { ANSWER_AGENT, answerSetup, setOpencodeToolPolicy } from "../index"

/**
 * One-off answers run as Caret's lean agent, whose own short prompt replaces
 * the backend's coding-agent prompt and which may use nothing unless the call
 * opts in (measured: ~8,000 input tokens as the default agent, under 500 as
 * this one). These pin which agent and which tools each kind of answer gets.
 */
describe("what each one-off answer runs as", () => {
	const base = { workingDirectory: "/p", prompt: "x", schema: {} }
	before(() => setOpencodeToolPolicy(() => ({ "shadcn_*": false, shadcn_search_items_in_registries: true })))
	after(() => setOpencodeToolPolicy(() => ({})))

	it("a plain answer: the lean agent, no tools, and none of the libraries", () => {
		const setup = answerSetup(base)
		assert.equal(setup.agent, ANSWER_AGENT)
		assert.deepEqual(setup.tools, {})
	})

	it("an answer that reads the project: the lean agent, reads only", () => {
		assert.deepEqual(answerSetup({ ...base, reads: true }).tools, { read: true, glob: true, grep: true, list: true })
	})

	it("the planner: the backend's own prompt, every tool off but reads and the answer itself", () => {
		const setup = answerSetup({ ...base, openCodePrompt: true, reads: true })
		assert.equal(setup.agent, undefined)
		const keys = Object.keys(setup.tools)
		assert.equal(keys[0], "*", "the off switch must come first so the named tools win")
		assert.equal(setup.tools["*"], false)
		assert.equal(setup.tools.StructuredOutput, true)
		assert.equal(setup.tools.read, true)
		assert.equal(setup.tools.bash, undefined)
	})

	it("the designer: the lean agent with the project's library allowlist and the tools it asks for", () => {
		const setup = answerSetup({ ...base, allowTools: true, tools: { caret_view_reference: true } })
		assert.equal(setup.agent, ANSWER_AGENT)
		assert.equal(setup.tools.shadcn_search_items_in_registries, true)
		assert.equal(setup.tools.caret_view_reference, true)
	})
})
