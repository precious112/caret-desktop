/**
 * `write_flow` creates as well as replaces — and heals a nameless file.
 *
 * The first shipped version only updated. An agent whose own plan said "now
 * the two flows" was refused twice ("No flow …"), hand-wrote the files with
 * the raw write tool, and guessed the format one field wrong (`title` for
 * `name`) — a red "invalid flow files" banner over otherwise good design
 * work. Creation belongs in the tool so the file format stays Caret's.
 */
import { strict as assert } from "assert"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { TOOLS, type ToolContext } from "../mcp/tools"

const writeFlow = TOOLS.find((tool) => tool.name === "write_flow")
assert(writeFlow, "write_flow tool missing")

function contextFor(projectPath: string): ToolContext {
	return {
		projectPath,
		screenshot: () => Promise.reject(new Error("not in this test")),
		runChecks: () => Promise.reject(new Error("not in this test")),
		installComponent: () => Promise.reject(new Error("not in this test")),
	}
}

function payloadOf(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
	const text = result.content.find((part) => part.type === "text")?.text ?? "{}"
	return JSON.parse(text) as Record<string, unknown>
}

describe("write_flow upsert", () => {
	let projectPath: string
	const flowFile = () => path.join(projectPath, ".caret", "flows", "first-launch.flow.json")

	beforeEach(async () => {
		projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "caret-flow-upsert-"))
		await fs.mkdir(path.join(projectPath, ".caret", "flows"), { recursive: true })
	})

	afterEach(async () => {
		await fs.rm(projectPath, { recursive: true, force: true })
	})

	const steps = [{ page: "home", label: "Welcome", next: [] }]

	it("creates a flow that does not exist yet, when a name is given", async () => {
		const result = await writeFlow!.handler(contextFor(projectPath), {
			flowId: "first-launch",
			name: "First launch",
			steps,
		})
		assert.equal(result.isError, undefined)
		assert.deepEqual(payloadOf(result), { ok: true, flowId: "first-launch", created: true })

		const written = JSON.parse(await fs.readFile(flowFile(), "utf-8"))
		assert.equal(written.name, "First launch")
		assert.equal(written.id, "first-launch")
		assert.equal(written.steps.length, 1)
	})

	it("refuses to create without a name, and says what to pass", async () => {
		const result = await writeFlow!.handler(contextFor(projectPath), { flowId: "first-launch", steps })
		assert.equal(result.isError, true)
		const first = result.content[0]
		assert(first?.type === "text" && first.text.includes("name"), "the refusal must name the missing field")
	})

	it("replaces the steps of an existing flow and keeps its name", async () => {
		await fs.writeFile(flowFile(), JSON.stringify({ id: "first-launch", name: "First launch", steps: [] }))
		const result = await writeFlow!.handler(contextFor(projectPath), { flowId: "first-launch", steps })
		assert.deepEqual(payloadOf(result), { ok: true, flowId: "first-launch", created: false })

		const written = JSON.parse(await fs.readFile(flowFile(), "utf-8"))
		assert.equal(written.name, "First launch")
		assert.equal(written.steps.length, 1)
	})

	it("heals a hand-rolled file that has no name — the exact field the agent guessed wrong", async () => {
		await fs.writeFile(flowFile(), JSON.stringify({ id: "first-launch", title: "First launch — wrong field", steps: [] }))
		await writeFlow!.handler(contextFor(projectPath), { flowId: "first-launch", steps })

		const written = JSON.parse(await fs.readFile(flowFile(), "utf-8"))
		assert.equal(written.name, "First launch", "an update without a name falls back to the humanized id")
	})

	it("an update may rename", async () => {
		await fs.writeFile(flowFile(), JSON.stringify({ id: "first-launch", name: "Old", steps: [] }))
		await writeFlow!.handler(contextFor(projectPath), { flowId: "first-launch", name: "First launch", steps })
		const written = JSON.parse(await fs.readFile(flowFile(), "utf-8"))
		assert.equal(written.name, "First launch")
	})
})
