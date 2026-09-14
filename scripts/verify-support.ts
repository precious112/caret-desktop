/**
 * Which backend and model the certification suites are allowed to spend.
 *
 * Two rules, and the second one is the important one:
 *
 * 1. **`CARET_VERIFY_MODEL` wins.** Once a subscription is connected — an
 *    OpenCode plan, a ChatGPT sign-in, Kimi For Coding, a GLM coding plan — that
 *    is how you point the suites at it: deliberately, by setting a variable, in
 *    `provider/model` form. `CARET_VERIFY_EFFORT` goes with it, and
 *    `CARET_VERIFY_BACKEND` survives for the day there is a second backend.
 * 2. **Nothing paid is ever spent by accident.** A test run must not quietly
 *    bill someone's subscription because it happened to find one signed in. So
 *    without that variable the suites use a zero-cost model if the backend
 *    offers one, and otherwise **skip** the scenarios that need inference.
 *
 * Skipping rather than failing matters because a Caret with no backend is a
 * *supported* state, not a broken one — every feature refuses with a named fix,
 * and that refusal is itself certified. A red suite on a machine with no
 * credentials would say Caret is broken when it is behaving exactly as designed.
 */
import * as zlib from "zlib"

import type { BackendId, CodingBackend, ReasoningEffort } from "../src/core/design/agent/backend"
import { CARET_SERVER_CONFIG } from "../src/core/design/agent/opencode"
import { request } from "../src/core/design/agent/opencode/http"
import type { OpencodeProvidersResponse } from "../src/core/design/agent/opencode/protocol"
import { ensureOpencodeServer } from "../src/core/design/agent/opencode/server"
import { getBackend } from "../src/core/design/agent/registry"

export interface VerifyModel {
	/** In the backend's own namespace, e.g. `anthropic/claude-sonnet-5`. */
	id: string
	/** Which backend to run it on. */
	backendId: BackendId
	backend: CodingBackend
	effort?: ReasoningEffort
	/** Where it came from, for the scenario's detail line. */
	source: "env" | "free"
}

const BACKEND_IDS = new Set<string>(["opencode"])
const EFFORTS = new Set<string>(["minimal", "low", "medium", "high", "xhigh"])

/** Null means: no model this suite is allowed to use. Skip, do not fail. */
export async function resolveVerifyModel(): Promise<VerifyModel | null> {
	const effort = process.env.CARET_VERIFY_EFFORT?.trim()
	if (effort && !EFFORTS.has(effort)) {
		// Loudly, not silently: a typo here would otherwise run the whole suite at
		// the wrong effort and the results would look like a model regression.
		throw new Error(`CARET_VERIFY_EFFORT="${effort}" is not one of ${[...EFFORTS].join(", ")}`)
	}
	const chosenEffort = effort as ReasoningEffort | undefined

	const fromEnv = process.env.CARET_VERIFY_MODEL?.trim()
	const backendId = process.env.CARET_VERIFY_BACKEND?.trim() ?? "opencode"
	if (!BACKEND_IDS.has(backendId)) {
		throw new Error(`CARET_VERIFY_BACKEND="${backendId}" is not one of ${[...BACKEND_IDS].join(", ")}`)
	}

	const backend = getBackend(backendId as BackendId)

	if (fromEnv) {
		// A named backend still has to be usable. Reporting "not ready" here beats
		// a turn that fails minutes later for a reason nobody connects to auth.
		const report = await backend.availability().catch(() => null)
		if (!report?.ready) return null
		return { id: fromEnv, backendId: backendId as BackendId, backend, effort: chosenEffort, source: "env" }
	}

	if (backendId !== "opencode") return null

	const report = await backend.availability().catch(() => null)
	if (!report?.ready) return null

	const free = await freeModel().catch(() => null)
	return free ? { id: free, backendId: "opencode", backend, effort: chosenEffort, source: "free" } : null
}

/**
 * Zero-cost models that have actually been watched doing agentic work here,
 * best first.
 *
 * A preference, not a requirement — see {@link freeModel}. The ones left out
 * were left out for reasons: some refuse a forced tool choice, and at least one
 * provider's speculative decoding has no grammar support at all, so they fail
 * schema-constrained requests in ways that look like Caret's bug.
 */
const PREFERRED_FREE_MODELS = ["opencode/ling-3.0-flash-free", "opencode/mimo-v2.5-free"]

/**
 * Providers whose zero cost means "subscription", not "free".
 *
 * **Zero cost is not the same as free to spend, and discovering that the hard
 * way would mean spending somebody's subscription.** OpenCode's provider plugins
 * deliberately report `cost: { input: 0, output: 0 }` for plans you have already
 * paid for — a ChatGPT sign-in, Kimi For Coding, the Z.AI and Zhipu coding
 * plans, Copilot — because there is no per-token price to report. Left to the
 * cost check alone, an unattended run would pick one of those and burn a monthly
 * quota, which is the exact accident rule 2 at the top of this file exists to
 * prevent. Metered providers do not need listing here: their prices are non-zero,
 * so the cost check already excludes them.
 */
const SUBSCRIPTION_PROVIDERS = new Set([
	"openai",
	"anthropic",
	"github-copilot",
	"gitlab",
	"kimi-for-coding",
	"zai-coding-plan",
	"zhipuai-coding-plan",
	"poe",
	"xai",
])

/**
 * A zero-cost model the backend offers, or null.
 *
 * Preferred-then-discovered rather than pinned: a free tier's catalogue is
 * somebody else's to change, and a hardcoded id that quietly disappears fails
 * as "the backend is broken" instead of "that model is gone". Taking the first
 * zero-cost entry on its own would be worse — the order is arbitrary, so the
 * suite would silently swap models between runs and its results would stop
 * being comparable.
 */
async function freeModel(): Promise<string | null> {
	const server = await ensureOpencodeServer(CARET_SERVER_CONFIG)
	const providers = await request<OpencodeProvidersResponse>(server, "/config/providers")

	const free: string[] = []
	for (const provider of providers.providers) {
		if (SUBSCRIPTION_PROVIDERS.has(provider.id)) {
			// Said out loud. A run that quietly skipped the models you are signed in
			// to would look like the catalogue was empty.
			console.log(`[verify] skipping ${provider.id} — its zero cost is a subscription you pay for, not a free tier`)
			continue
		}
		for (const [id, model] of Object.entries(provider.models ?? {})) {
			const cost = model.cost
			if (cost && cost.input === 0 && cost.output === 0) free.push(`${provider.id}/${id}`)
		}
	}

	// Preferred first, then whatever else the catalogue calls free.
	const ordered = [
		...PREFERRED_FREE_MODELS.filter((id) => free.includes(id)),
		...free.filter((id) => !PREFERRED_FREE_MODELS.includes(id)),
	]

	// **Advertised free is not the same as usable.** A provider can retire a model
	// from its free tier while still listing it as zero-cost — observed: an id
	// this list preferred began answering `[404] This model is unavailable for
	// free` mid-afternoon, and the suite spent twenty minutes waiting on turns
	// that could never finish before reporting failures that had nothing to do
	// with Caret. So each candidate is asked one trivial question, and the first
	// that actually answers is the one the suite spends.
	for (const id of ordered) {
		if (await modelAnswers(server, id)) return id
		console.log(`[verify] ${id} is advertised as free but does not answer — trying the next`)
	}
	return null
}

/** One trivial round-trip. Cheap enough to be worth it, real enough to prove the model runs. */
async function modelAnswers(server: Awaited<ReturnType<typeof ensureOpencodeServer>>, model: string): Promise<boolean> {
	const slash = model.indexOf("/")
	if (slash <= 0) return false

	try {
		const session = await request<{ id: string }>(server, "/session", {
			method: "POST",
			body: { title: "verify: model check" },
		})
		const response = await request<{ info?: { error?: unknown } }>(server, `/session/${session.id}/message`, {
			method: "POST",
			body: {
				parts: [{ type: "text", text: "Reply with the single word: ok" }],
				model: { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) },
				tools: { bash: false, edit: false, write: false, webfetch: false },
			},
		})
		return !response.info?.error
	} catch {
		return false
	}
}

/** One line explaining what was skipped and how to run it for real. */
export const NO_MODEL_REASON =
	"no model this suite may spend — set CARET_VERIFY_BACKEND=<id> CARET_VERIFY_MODEL=<model> to run it against your own subscription"

/**
 * A genuinely valid solid-colour PNG.
 *
 * Not a header stub: the asset path ends with these bytes being served to a
 * browser and handed to a model, and a file that only satisfies the dimension
 * probe would pass the indexing assertions while being undecodable everywhere it
 * actually matters.
 */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
	const raw = Buffer.alloc(height * (width * 3 + 1))
	for (let y = 0; y < height; y++) {
		const rowStart = y * (width * 3 + 1)
		raw[rowStart] = 0 // filter: none
		for (let x = 0; x < width; x++) {
			raw[rowStart + 1 + x * 3] = rgb[0]
			raw[rowStart + 2 + x * 3] = rgb[1]
			raw[rowStart + 3 + x * 3] = rgb[2]
		}
	}

	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(width, 0)
	ihdr.writeUInt32BE(height, 4)
	ihdr[8] = 8 // bit depth
	ihdr[9] = 2 // truecolour

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", zlib.deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	])
}

function pngChunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4)
	length.writeUInt32BE(data.length, 0)
	const body = Buffer.concat([Buffer.from(type, "ascii"), data])
	const crc = Buffer.alloc(4)
	crc.writeUInt32BE(crc32(body), 0)
	return Buffer.concat([length, body, crc])
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256)
	for (let n = 0; n < 256; n++) {
		let c = n
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		table[n] = c >>> 0
	}
	return table
})()

function crc32(buffer: Buffer): number {
	let c = 0xffffffff
	for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
	return (c ^ 0xffffffff) >>> 0
}
