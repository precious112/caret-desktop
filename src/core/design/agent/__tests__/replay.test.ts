/**
 * Recorded model answers: the base every interview app test stands on, so it is
 * tested on its own. If replay served the wrong answer, carried on silently
 * after the recording ran out, or accepted answers recorded for different
 * instructions, every test built on it would be meaningless.
 */
import { strict as assert } from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { BackendError, type CodingBackend, ProviderRefusalError, type StructuredRequest } from "../backend"
import {
	type Recording,
	RecordingBackend,
	ReplayBackend,
	ReplayExhaustedError,
	ReplayStaleError,
	readReplayLog,
	templateHash,
} from "../replay"

const schema = { type: "object" }
const request = (overrides: Partial<StructuredRequest> = {}): StructuredRequest => ({
	workingDirectory: "/tmp/project",
	prompt: "?",
	schema,
	...overrides,
})

function tempFile(name: string): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "caret-replay-")), name)
}

describe("ReplayBackend", () => {
	it("hands out recorded answers in order when calls are not labelled", async () => {
		const backend = new ReplayBackend({ format: 1, calls: [{ reply: { n: 1 } }, { reply: { n: 2 } }] })
		assert.deepEqual((await backend.structured(request())).value, { n: 1 })
		assert.deepEqual((await backend.structured(request())).value, { n: 2 })
	})

	it("matches a labelled call to the recorded call with the same label and topic, whatever the order", async () => {
		const backend = new ReplayBackend({
			format: 2,
			calls: [
				{ tag: "interview:area", area: "brand-color", reply: "brand" },
				{ tag: "interview:area", area: "surface", reply: "surface" },
			],
		})
		const surface = await backend.structured(request({ trace: { tag: "interview:area", area: "surface" } }))
		assert.equal(surface.value, "surface")
		const brand = await backend.structured(request({ trace: { tag: "interview:area", area: "brand-color" } }))
		assert.equal(brand.value, "brand")
	})

	it("fails loudly when the recording has no answer left, instead of inventing one", async () => {
		const backend = new ReplayBackend({ format: 1, calls: [{ reply: 1 }] })
		await backend.structured(request())
		await assert.rejects(backend.structured(request()), ReplayExhaustedError)
		await assert.rejects(
			new ReplayBackend({ format: 2, calls: [{ tag: "a", reply: 1 }] }).structured(request({ trace: { tag: "b" } })),
			ReplayExhaustedError,
		)
	})

	it("refuses an answer recorded with different instructions", async () => {
		const recorded = templateHash("old instructions", schema)
		const recording: Recording = { format: 2, calls: [{ templateHash: recorded, reply: 1 }] }
		await assert.rejects(
			new ReplayBackend(recording).structured(request({ systemPrompt: "new instructions" })),
			ReplayStaleError,
		)
		const same = await new ReplayBackend(recording).structured(request({ systemPrompt: "old instructions" }))
		assert.equal(same.value, 1)
	})

	it("plays back failures as the errors the app really gets", async () => {
		const backend = new ReplayBackend({
			format: 1,
			calls: [
				{ fault: "provider-refusal", message: "usage limit reached" },
				{ fault: "transport" },
				{ fault: "malformed" },
			],
		})
		await assert.rejects(backend.structured(request()), (err: unknown) => err instanceof ProviderRefusalError)
		await assert.rejects(
			backend.structured(request()),
			(err: unknown) => err instanceof BackendError && !(err instanceof ProviderRefusalError),
		)
		assert.deepEqual((await backend.structured(request())).value, { garbled: true })
	})

	it("keeps its place across a restart through its log, so a reopened app carries on", async () => {
		const logFile = tempFile("replay.log")
		const recording: Recording = { format: 1, calls: [{ reply: 1 }, { reply: 2 }, { reply: 3 }] }
		const first = new ReplayBackend(recording, { logFile })
		await first.structured(request())
		await first.structured(request())
		const reopened = new ReplayBackend(recording, { logFile })
		assert.equal(reopened.served, 2)
		assert.equal((await reopened.structured(request())).value, 3)
		assert.deepEqual(
			readReplayLog(logFile).map((entry) => entry.index),
			[0, 1, 2],
		)
	})
})

describe("RecordingBackend", () => {
	function liveReturning(values: unknown[]): CodingBackend {
		let call = 0
		return {
			id: "opencode",
			displayName: "Live",
			providerName: "Live",
			availability: async () => ({}) as never,
			startSession: async () => ({}) as never,
			async structured() {
				const value = values[call++]
				if (value instanceof Error) throw value
				return { value, emulated: true }
			},
		} as unknown as CodingBackend
	}

	it("saves each answer as it arrives, and a replay of the file gives the same answers back", async () => {
		const file = tempFile("recording.json")
		const live = new RecordingBackend(liveReturning([{ a: 1 }, new ProviderRefusalError("quota")]), file)
		await live.structured(
			request({
				systemPrompt: "s",
				prompt: "read /tmp/project/x.css",
				trace: { tag: "interview:area", area: "brand-color" },
			}),
		)
		await assert.rejects(live.structured(request({ trace: { tag: "interview:area", area: "surface" } })))

		const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Recording
		assert.equal(saved.calls.length, 2)
		assert.equal(saved.calls[0].prompt, "read <project>/x.css", "the project folder is replaced so recordings are portable")
		assert.equal(saved.calls[0].templateHash, templateHash("s", schema))
		assert.equal(saved.calls[1].fault, "provider-refusal")

		const replay = ReplayBackend.fromFile(file)
		const brand = await replay.structured(
			request({ systemPrompt: "s", trace: { tag: "interview:area", area: "brand-color" } }),
		)
		assert.deepEqual(brand.value, { a: 1 })
		await assert.rejects(
			replay.structured(request({ trace: { tag: "interview:area", area: "surface" } })),
			ProviderRefusalError,
		)
	})
})
