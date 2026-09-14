import * as fs from "fs/promises"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as os from "os"
import * as path from "path"
import should from "should"

import { listFlows, mutateFlowDefinition, readFlowDefinition, resolveFlowFile, writeFlowDefinition } from "../flow-meta"
import type { FlowDefinition } from "../types"

describe("flow-meta", () => {
	let workspace: string
	let flowsDir: string

	const sampleFlow = (id: string): FlowDefinition => ({
		id,
		name: id,
		steps: [
			{ page: "signup", next: ["dashboard"] },
			{ page: "dashboard", next: [] },
		],
	})

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), "flow-meta-test-"))
		flowsDir = path.join(workspace, ".caret", "flows")
		await fs.mkdir(flowsDir, { recursive: true })
	})

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true })
	})

	describe("resolveFlowFile", () => {
		it("resolves a flow whose filename matches its id", async () => {
			await fs.writeFile(path.join(flowsDir, "checkout.flow.json"), JSON.stringify(sampleFlow("checkout")))
			const resolved = await resolveFlowFile(workspace, "checkout")
			should(resolved).equal(path.join(flowsDir, "checkout.flow.json"))
		})

		it("auto-corrects a filename/id mismatch by scanning for the id", async () => {
			await fs.writeFile(path.join(flowsDir, "my-renamed-file.flow.json"), JSON.stringify(sampleFlow("checkout")))
			const resolved = await resolveFlowFile(workspace, "checkout")
			should(resolved).equal(path.join(flowsDir, "my-renamed-file.flow.json"))
		})

		it("returns null for an unknown flow id", async () => {
			should(await resolveFlowFile(workspace, "nope")).be.null()
		})

		it("skips corrupt files while scanning", async () => {
			await fs.writeFile(path.join(flowsDir, "broken.flow.json"), "{ not json")
			await fs.writeFile(path.join(flowsDir, "other.flow.json"), JSON.stringify(sampleFlow("checkout")))
			const resolved = await resolveFlowFile(workspace, "checkout")
			should(resolved).equal(path.join(flowsDir, "other.flow.json"))
		})
	})

	describe("mutateFlowDefinition", () => {
		it("mutates a flow stored under a mismatched filename", async () => {
			await fs.writeFile(path.join(flowsDir, "weird-name.flow.json"), JSON.stringify(sampleFlow("checkout")))
			const ok = await mutateFlowDefinition(workspace, "checkout", (flow) => {
				flow.steps[0].next.push("confirmation")
			})
			ok.should.be.true()
			const onDisk = JSON.parse(await fs.readFile(path.join(flowsDir, "weird-name.flow.json"), "utf-8"))
			onDisk.steps[0].next.should.deepEqual(["dashboard", "confirmation"])
			// no duplicate file created under the id-derived name
			const entries = await fs.readdir(flowsDir)
			entries.should.deepEqual(["weird-name.flow.json"])
		})

		it("returns false for a corrupt flow file instead of writing garbage", async () => {
			await fs.writeFile(path.join(flowsDir, "corrupt.flow.json"), '{"id": "corrupt", "name": ')
			const ok = await mutateFlowDefinition(workspace, "corrupt", () => {})
			ok.should.be.false()
			const onDisk = await fs.readFile(path.join(flowsDir, "corrupt.flow.json"), "utf-8")
			onDisk.should.equal('{"id": "corrupt", "name": ')
		})

		it("keeps the file valid under concurrent mutations", async () => {
			await fs.writeFile(path.join(flowsDir, "busy.flow.json"), JSON.stringify(sampleFlow("busy"), null, 2))
			const ops: Promise<boolean>[] = []
			for (let i = 0; i < 50; i++) {
				ops.push(
					mutateFlowDefinition(workspace, "busy", (flow) => {
						flow.steps[0].next = flow.steps[0].next.filter((p) => p !== "page-" + (i - 1))
						flow.steps[0].next.push("page-" + i)
					}),
				)
			}
			const results = await Promise.all(ops)
			results.every(Boolean).should.be.true()
			const onDisk = JSON.parse(await fs.readFile(path.join(flowsDir, "busy.flow.json"), "utf-8"))
			onDisk.steps[0].next.should.containEql("page-49")
		})
	})

	describe("read/list robustness", () => {
		it("readFlowDefinition returns null for corrupt files", async () => {
			await fs.writeFile(path.join(flowsDir, "bad.flow.json"), "garbage{{{")
			should(await readFlowDefinition(workspace, "bad")).be.null()
		})

		it("listFlows skips corrupt files but returns the rest", async () => {
			await fs.writeFile(path.join(flowsDir, "good.flow.json"), JSON.stringify(sampleFlow("good")))
			await fs.writeFile(path.join(flowsDir, "bad.flow.json"), "garbage{{{")
			const flows = await listFlows(workspace)
			flows.map((f) => f.id).should.deepEqual(["good"])
		})

		it("writeFlowDefinition round-trips", async () => {
			await writeFlowDefinition(workspace, "fresh", sampleFlow("fresh"))
			const flow = await readFlowDefinition(workspace, "fresh")
			should(flow).not.be.null()
			flow?.id.should.equal("fresh")
		})
	})
})
