import * as fs from "fs/promises"
import { describe, it } from "mocha"
import * as os from "os"
import * as path from "path"
import "should"

import { NO_RASTER_REASON, solidPng } from "../../../src/core/design"
import { configureRasterPacing } from "../../../src/core/design/asset-library/raster/gemini"
import { mockFetchForTesting } from "../../../src/shared/net"
import type { BoardWire } from "../../shared/ipc"
import {
	type BoardDeps,
	boardSnapshot,
	branchTake,
	CHANGE_TAKES,
	cancelTakes,
	changePrompt,
	closeBoard,
	FIRST_TAKES,
	saveTake,
	startBoard,
	takePicture,
} from "../take-board"

/** What the fake image service was sent, call by call. */
interface Sent {
	prompt: string
	references: string[]
	aspect: string
}

/**
 * A stand-in for Google's image endpoint. Each call returns a different solid
 * colour; a prompt containing a marker misbehaves on purpose.
 */
function fakeService(sent: Sent[], options: { holdMs?: number } = {}) {
	let n = 0
	return async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const body = JSON.parse(String(init?.body))
		const parts = body.contents[0].parts as Array<{ text?: string; inlineData?: { data: string } }>
		const prompt = parts.find((part) => part.text)?.text ?? ""
		sent.push({
			prompt,
			references: parts.filter((part) => part.inlineData).map((part) => part.inlineData!.data),
			aspect: body.generationConfig.imageConfig.aspectRatio,
		})
		if (options.holdMs) {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, options.holdMs)
				init?.signal?.addEventListener("abort", () => {
					clearTimeout(timer)
					reject(new DOMException("aborted", "AbortError"))
				})
			})
		}
		if (prompt.includes("[[refuse]]")) {
			return Response.json({ candidates: [{ content: { parts: [{ text: "I can't draw that." }] } }] })
		}
		n++
		const png = solidPng(16, 9, [n * 20, 100, 200])
		return Response.json({
			candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png.toString("base64") } }] } }],
			usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1290, totalTokenCount: 1300 },
		})
	}
}

function deps(overrides: Partial<BoardDeps> = {}): BoardDeps & { emitted: BoardWire[] } {
	const emitted: BoardWire[] = []
	return {
		emitted,
		config: () => ({ backend: "api-key", apiKey: "test" }),
		tokens: async () => null,
		styleAnchor: async () => undefined,
		cutOut: async (bytes) => ({ ok: true, bytes }),
		cutoutReady: async () => ({ ok: true }),
		postProcess: async (bytes, width, height) => ({
			bytes,
			mime: "image/png",
			extension: ".png",
			width,
			height,
			originalBytes: bytes.length,
		}),
		preview: async (bytes, mime) => `data:${mime};base64,${bytes.toString("base64").slice(0, 16)}`,
		polish: async () => ({ prompt: "A walnut keyboard on a dark oak desk, low warm window light." }),
		emit: (_project, board) => emitted.push(board),
		...overrides,
	}
}

async function until<T>(probe: () => T | null | undefined | false, ms = 5000): Promise<T> {
	const deadline = Date.now() + ms
	while (Date.now() < deadline) {
		const value = probe()
		if (value) return value
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	throw new Error("timed out")
}

const settled = (project: string) => () => {
	const board = boardSnapshot(project)
	return board && board.takes.every((take) => !["waiting", "working"].includes(take.status)) ? board : null
}

async function project(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "caret-board-"))
	await fs.mkdir(path.join(dir, ".caret", "assets"), { recursive: true })
	return dir
}

describe("the take board", () => {
	before(() => configureRasterPacing({ minSpacingMs: 0, backoffMs: [0, 0, 0, 0], jitter: 0 }))
	after(() => configureRasterPacing({ minSpacingMs: 6_000, backoffMs: [4_000, 10_000, 20_000, 40_000], jitter: 0.2 }))

	it("'Use my words' sends exactly the words, and nothing else when the foundation's look is off", async () => {
		const dir = await project()
		const sent: Sent[] = []
		await mockFetchForTesting(fakeService(sent), async () => {
			const d = deps()
			startBoard(d, dir, {
				request: { kind: "image", text: "a brass compass on linen, top-down" },
				aspect: "16:9",
				mode: "exact",
				keepFoundationLook: false,
			})
			await until(settled(dir))
			closeBoard(dir)
		})
		sent.length.should.equal(FIRST_TAKES)
		for (const call of sent) {
			call.prompt.should.equal("a brass compass on linen, top-down")
			call.aspect.should.equal("16:9")
		}
	})

	it("'Use my words' with the foundation's look keeps the words first and adds only the colours", async () => {
		const dir = await project()
		const sent: Sent[] = []
		await mockFetchForTesting(fakeService(sent), async () => {
			startBoard(deps(), dir, {
				request: { kind: "image", text: "a brass compass on linen" },
				aspect: "3:2",
				mode: "exact",
			})
			await until(settled(dir))
			closeBoard(dir)
		})
		sent[0].prompt.should.startWith("a brass compass on linen\n\n")
		sent[0].prompt.should.not.containEql("Do not include")
		sent[0].prompt.should.not.containEql("avoid")
	})

	it("'Polish it' makes the takes from Caret's brief, and says so when no brief could be written", async () => {
		const dir = await project()
		const sent: Sent[] = []
		await mockFetchForTesting(fakeService(sent), async () => {
			startBoard(deps(), dir, { request: { kind: "image", text: "walnut keyboard" }, aspect: "16:9", mode: "polish" })
			const board = await until(settled(dir))
			board.brief!.should.containEql("dark oak desk")
			board.branches[0].source.should.equal("brief")
			sent.every((call) => call.prompt.includes("dark oak desk")).should.be.true()

			startBoard(deps({ polish: async () => null }), dir, {
				request: { kind: "image", text: "walnut keyboard" },
				aspect: "16:9",
				mode: "polish",
			})
			const fallback = await until(settled(dir))
			;(fallback.brief === undefined).should.be.true()
			fallback.briefNote!.should.containEql("your words")
			fallback.takes.filter((take) => take.status === "ready").length.should.equal(FIRST_TAKES)
			closeBoard(dir)
		})
	})

	it("reports each take as it lands, and a refusal stays on its own take", async () => {
		const dir = await project()
		const sent: Sent[] = []
		const d = deps()
		await mockFetchForTesting(fakeService(sent), async () => {
			startBoard(d, dir, { request: { kind: "image", text: "a bowl [[refuse]]" }, aspect: "1:1", mode: "exact" })
			const board = await until(settled(dir))
			board.takes.every((take) => take.status === "failed").should.be.true()
			board.takes[0].error!.should.containEql("I can't draw that.")
			closeBoard(dir)

			startBoard(d, dir, { request: { kind: "image", text: "a bowl" }, aspect: "1:1", mode: "exact" })
			await until(settled(dir))
			closeBoard(dir)
		})
		// Every take passed through waiting and working before it was ready, one at a time.
		const ready = d.emitted.map((board) => board.takes.filter((take) => take.status === "ready").length)
		ready.should.containEql(1)
		ready.should.containEql(2)
		ready.should.containEql(3)
	})

	it("grows a branch from the exact take, sending it as the reference, as often as asked", async () => {
		const dir = await project()
		const sent: Sent[] = []
		await mockFetchForTesting(fakeService(sent), async () => {
			const d = deps()
			startBoard(d, dir, { request: { kind: "image", text: "a mug" }, aspect: "16:9", mode: "exact" })
			const first = await until(settled(dir))
			const parent = first.takes[2]
			const parentBytes = takePicture(dir, parent.id)!.split(",")[1]

			const one = branchTake(d, dir, parent.id, { chips: ["Warmer light"], note: "", strength: "subtle" })
			one.ok.should.be.true()
			await until(settled(dir))
			const two = branchTake(d, dir, parent.id, { chips: [], note: "on a wooden table", strength: "strong" })
			two.ok.should.be.true()
			const board = await until(settled(dir))

			const children = board.branches.filter((branch) => branch.parentTakeId === parent.id)
			children.length.should.equal(2)
			children[0].label.should.equal("warmer light")
			children[1].label.should.equal("on a wooden table")
			children[1].strength!.should.equal("strong")
			children.every((branch) => branch.takeIds.length === CHANGE_TAKES).should.be.true()
			// Ids are never reused, so nothing on the board is ever overwritten.
			new Set(board.takes.map((take) => take.id)).size.should.equal(FIRST_TAKES + 2 * CHANGE_TAKES)

			const branchCalls = sent.slice(FIRST_TAKES)
			branchCalls.length.should.equal(2 * CHANGE_TAKES)
			branchCalls.every((call) => call.references.length === 1 && call.references[0] === parentBytes).should.be.true()
			branchCalls[0].prompt.should.containEql("make the light warmer")
			branchCalls[2].prompt.should.containEql("bolder version")

			// Three levels deep: the grandchild's reference is the child take, not the first one.
			const child = board.takes.find((take) => take.branchId === children[0].id)!
			const childBytes = takePicture(dir, child.id)!.split(",")[1]
			branchTake(d, dir, child.id, { chips: ["Closer in"], note: "", strength: "subtle" }).ok.should.be.true()
			await until(settled(dir))
			sent[sent.length - 1].references[0].should.equal(childBytes)
			closeBoard(dir)
		})
	})

	it("refuses to grow from a take that isn't ready, and from a closed board", async () => {
		const dir = await project()
		await mockFetchForTesting(fakeService([], { holdMs: 300 }), async () => {
			const d = deps()
			const board = startBoard(d, dir, { request: { kind: "image", text: "a mug" }, aspect: "1:1", mode: "exact" })
			const refused = branchTake(d, dir, board.takes[0].id, { chips: [], note: "x", strength: "subtle" })
			refused.ok.should.be.false()
			closeBoard(dir)
			const closed = branchTake(d, dir, board.takes[0].id, { chips: [], note: "x", strength: "subtle" })
			closed.ok.should.be.false()
		})
	})

	it("a cancelled waiting take is never sent, and one being made stops", async () => {
		const dir = await project()
		const sent: Sent[] = []
		await mockFetchForTesting(fakeService(sent, { holdMs: 200 }), async () => {
			const d = deps()
			const board = startBoard(d, dir, { request: { kind: "image", text: "a lamp" }, aspect: "1:1", mode: "exact" })
			await until(() => boardSnapshot(dir)?.takes[0].status === "working")
			cancelTakes(d, dir, [board.takes[0].id, board.takes[3].id])
			const done = await until(settled(dir))
			done.takes[0].status.should.equal("cancelled")
			done.takes[3].status.should.equal("cancelled")
			done.takes[1].status.should.equal("ready")
			done.takes[2].status.should.equal("ready")
			closeBoard(dir)
		})
		// Take 4 was cancelled before its turn: only takes 1, 2 and 3 were ever sent.
		sent.length.should.equal(3)
	})

	it("saving keeps the board, and a second take can be saved too", async () => {
		const dir = await project()
		await mockFetchForTesting(fakeService([]), async () => {
			const d = deps()
			startBoard(d, dir, { request: { kind: "image", text: "a kettle" }, aspect: "16:9", mode: "exact" })
			const board = await until(settled(dir))
			const first = await saveTake(d, dir, board.takes[0].id, "kettle-hero")
			first.ok.should.be.true()
			first.tag!.should.equal("kettle-hero")
			const second = await saveTake(d, dir, board.takes[1].id, "kettle-hero")
			second.ok.should.be.true()
			second.tag!.should.not.equal("kettle-hero")
			const after = boardSnapshot(dir)!
			after.takes[0].savedAs!.should.equal("kettle-hero")
			after.takes[1].savedAs!.should.equal(second.tag!)

			// A name in the wrong form is tidied into a usable one, not refused.
			const tidied = await saveTake(d, dir, board.takes[2].id, "Not A Tag")
			tidied.ok.should.be.true()
			tidied.tag!.should.equal("not-a-tag")
			const blank = await saveTake(d, dir, board.takes[3].id, "!!!")
			if (blank.ok) blank.tag!.should.match(/^[a-z0-9-]+$/)
			const gone = await saveTake(d, dir, "t999", "x")
			gone.ok.should.be.false()

			const index = JSON.parse(await fs.readFile(path.join(dir, ".caret", "assets", "index.json"), "utf8"))
			const saved = index.assets.find((asset: { tag: string }) => asset.tag === "kettle-hero")
			saved.origin.answers.promptHelp.should.equal("exact")
			saved.origin.resolved.should.equal("a kettle\n\n" + saved.origin.resolved.split("\n\n").slice(1).join("\n\n"))
			saved.origin.cost.unit.should.equal("tokens")
			closeBoard(dir)
		})
	})

	it("with no key, every first take says which key is missing", async () => {
		const dir = await project()
		const d = deps({ config: () => null })
		startBoard(d, dir, { request: { kind: "image", text: "a vase" }, aspect: "1:1", mode: "exact" })
		const board = await until(settled(dir))
		board.takes.every((take) => take.status === "failed" && take.error === NO_RASTER_REASON).should.be.true()
		closeBoard(dir)
	})

	it("a closed board ignores takes that land afterwards", async () => {
		const dir = await project()
		await mockFetchForTesting(fakeService([], { holdMs: 150 }), async () => {
			const d = deps()
			startBoard(d, dir, { request: { kind: "image", text: "a cup" }, aspect: "1:1", mode: "exact" })
			await until(() => boardSnapshot(dir)?.takes[0].status === "working")
			const before = d.emitted.length
			closeBoard(dir)
			await new Promise((resolve) => setTimeout(resolve, 400))
			d.emitted.length.should.equal(before)
			;(boardSnapshot(dir) === null).should.be.true()
		})
	})

	it("a cutout waits for the cutout tool, and spends nothing if it can't be had", async () => {
		const dir = await project()
		const sent: Sent[] = []
		await mockFetchForTesting(fakeService(sent), async () => {
			let release!: () => void
			const gate = new Promise<void>((resolve) => {
				release = resolve
			})
			const d = deps({
				cutoutReady: async (onProgress) => {
					onProgress("40 of 224MB")
					await gate
					return { ok: true }
				},
			})
			startBoard(d, dir, { request: { kind: "image", text: "a vase", transparent: true }, aspect: "1:1", mode: "exact" })
			const waiting = await until(() => d.emitted.find((board) => board.preparing?.includes("40 of 224MB")))
			waiting.takes.every((take) => take.status === "waiting").should.be.true()
			sent.length.should.equal(0)
			release()
			await until(settled(dir))
			sent.length.should.equal(FIRST_TAKES)
			closeBoard(dir)

			const none = deps({ cutoutReady: async () => ({ ok: false, reason: "The cutout tool could not be downloaded." }) })
			startBoard(none, dir, { request: { kind: "image", text: "a vase", transparent: true }, aspect: "1:1", mode: "exact" })
			const failed = await until(settled(dir))
			failed.takes
				.every((take) => take.status === "failed" && take.error === "The cutout tool could not be downloaded.")
				.should.be.true()
			sent.length.should.equal(FIRST_TAKES)
			closeBoard(dir)
		})
	})

	it("words a change the way the person picked it", () => {
		changePrompt({ chips: ["More room for text"], note: "", strength: "subtle" }, false).should.startWith(
			"Edit the reference image: leave more empty space around the subject for a headline.",
		)
		changePrompt({ chips: [], note: "on slate.", strength: "strong" }, true).should.containEql("pure flat white")
		changePrompt({ chips: [], note: "", strength: "subtle" }, false).should.containEql("make a close variation")
	})
})
