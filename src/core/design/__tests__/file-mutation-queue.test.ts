import * as fs from "fs/promises"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as os from "os"
import * as path from "path"
import "should"

import { runExclusive, writeFileAtomic } from "../file-mutation-queue"

describe("runExclusive", () => {
	it("serializes calls with the same key", async () => {
		const order: string[] = []
		const slow = runExclusive("k", async () => {
			order.push("slow-start")
			await new Promise((r) => setTimeout(r, 30))
			order.push("slow-end")
		})
		const fast = runExclusive("k", async () => {
			order.push("fast")
		})
		await Promise.all([slow, fast])
		order.should.deepEqual(["slow-start", "slow-end", "fast"])
	})

	it("runs different keys concurrently", async () => {
		const order: string[] = []
		const a = runExclusive("a", async () => {
			await new Promise((r) => setTimeout(r, 30))
			order.push("a")
		})
		const b = runExclusive("b", async () => {
			order.push("b")
		})
		await Promise.all([a, b])
		order.should.deepEqual(["b", "a"])
	})

	it("continues the queue after a failure and propagates the error to the caller", async () => {
		const first = runExclusive("k2", async () => {
			throw new Error("boom")
		})
		const second = runExclusive("k2", async () => "ok")
		await first.should.be.rejectedWith("boom")
		const result = await second
		result.should.equal("ok")
	})

	it("returns the function's value", async () => {
		const result = await runExclusive("k3", async () => 42)
		result.should.equal(42)
	})
})

describe("writeFileAtomic", () => {
	let tmpDir: string

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-write-test-"))
	})

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	it("writes the content and leaves no temp files behind", async () => {
		const target = path.join(tmpDir, "out.json")
		await writeFileAtomic(target, '{"a":1}')
		const content = await fs.readFile(target, "utf-8")
		content.should.equal('{"a":1}')
		const entries = await fs.readdir(tmpDir)
		entries.should.deepEqual(["out.json"])
	})

	it("replaces existing content fully even when shorter", async () => {
		const target = path.join(tmpDir, "out.json")
		await writeFileAtomic(target, "x".repeat(500))
		await writeFileAtomic(target, "short")
		const content = await fs.readFile(target, "utf-8")
		content.should.equal("short")
	})
})
