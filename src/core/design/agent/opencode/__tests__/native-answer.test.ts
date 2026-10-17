/**
 * A model that cannot take a forced answer tool is asked in words from then on.
 *
 * Measured in verify:app (deepseek-v4.1-flash, thinking mode): every interview
 * turn sent a native structured request the provider refused ("Thinking mode
 * does not support this tool_choice"), then the worded one that worked. Two
 * requests per turn, one of them certain to fail.
 */
import { strict as assert } from "assert"

import { OpencodeBackend } from "../index"

function backendRecording(failsNatively: (model: string) => boolean) {
	const backend = new OpencodeBackend()
	const calls: Array<{ model: string; native: boolean }> = []
	;(backend as unknown as Record<string, unknown>).promptForJson = async (req: { model?: string }, native: boolean) => {
		const model = req.model ?? "(default)"
		calls.push({ model, native })
		if (native && failsNatively(model)) throw new Error("Thinking mode does not support this tool_choice")
		return { value: { ok: true }, toolCalls: [] }
	}
	return { backend, calls }
}

const ask = (backend: OpencodeBackend, model: string) =>
	backend.structured({ workingDirectory: "/tmp", prompt: "?", schema: { type: "object" }, model })

describe("native structured answers", () => {
	it("stops trying native for a model once words worked where native failed", async () => {
		const { backend, calls } = backendRecording((model) => model === "go/thinking-only-a")
		const first = await ask(backend, "go/thinking-only-a")
		const second = await ask(backend, "go/thinking-only-a")
		assert.equal(first.emulated, true)
		assert.equal(second.emulated, true)
		assert.deepEqual(
			calls.map((c) => c.native),
			[true, false, false],
			"the second call paid for a native request the model already refused",
		)
	})

	it("remembers per model, so another model still gets the native guarantee", async () => {
		const { backend, calls } = backendRecording((model) => model === "go/thinking-only-b")
		await ask(backend, "go/thinking-only-b")
		const other = await ask(backend, "go/tool-capable")
		assert.equal(other.emulated, false)
		assert.deepEqual(calls.at(-1), { model: "go/tool-capable", native: true })
	})
})
