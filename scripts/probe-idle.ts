/**
 * Which of the two candidates kills the apply turn?
 *
 * Every `gg` run shows the same signature in the server's own database: the
 * apply prompt is stored, and no assistant message ever follows it. Caret's
 * `run()` returned `ok: true` for those turns, so *something* ended the event
 * stream — either the SSE body closed with zero frames, or a stale
 * `session.idle` arrived before the turn started. The fix differs, so this
 * reproduces the exact two-turn shape (plan turn → idle gap → resumed build
 * turn on a fresh subscription) on a free model and logs every raw frame with
 * a timestamp. Costs nothing.
 *
 *   npx tsx scripts/probe-idle.ts
 */
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { CARET_SERVER_CONFIG } from "../src/core/design/agent/opencode"
import { openEventStream, request } from "../src/core/design/agent/opencode/http"
import type { OpencodeSession } from "../src/core/design/agent/opencode/protocol"
import { ensureOpencodeServer, stopOpencodeServer } from "../src/core/design/agent/opencode/server"

const MODEL = { providerID: "opencode", modelID: "mimo-v2.5-free" }
const started = Date.now()
const t = () => `+${((Date.now() - started) / 1000).toFixed(2)}s`

interface RawEvent {
	type: string
	properties?: Record<string, unknown>
}

/** Event types the adapter's protocol union knows about. Anything else is news. */
const KNOWN_TYPES = new Set(["message.part.updated", "message.updated", "permission.asked", "session.error", "session.idle"])

function describe(event: RawEvent): string {
	// Status-bearing and unknown events are printed whole: the semantics of what
	// this server version emits is exactly what this probe exists to learn.
	if (
		event.type === "session.status" ||
		event.type === "session.idle" ||
		event.type === "session.error" ||
		!KNOWN_TYPES.has(event.type)
	) {
		return `${event.type}  ${JSON.stringify(event.properties ?? {}).slice(0, 300)}`
	}
	const p = event.properties ?? {}
	const bits = [
		typeof p.sessionID === "string" ? `session=${(p.sessionID as string).slice(-6)}` : null,
		(() => {
			const part = p.part as { type?: string; messageID?: string } | undefined
			return part ? `part=${part.type} msg=${part.messageID?.slice(-6)}` : null
		})(),
		(() => {
			const info = p.info as { id?: string; role?: string } | undefined
			return info?.role ? `msg=${info.id?.slice(-6)} role=${info.role}` : null
		})(),
	].filter(Boolean)
	return `${event.type}${bits.length ? `  (${bits.join(" ")})` : ""}`
}

/** One turn at the raw-frame level, exactly as OpencodeSessionHandle.send() does it. */
async function turn(
	server: Awaited<ReturnType<typeof ensureOpencodeServer>>,
	sessionId: string,
	directory: string,
	label: string,
	prompt: string,
	agent: "plan" | "build",
	idleTimeoutMs: number,
): Promise<void> {
	console.log(`\n===== ${label} (agent=${agent}) =====`)
	const controller = new AbortController()
	// Subscription first, prompt second — same order as send().
	const events = await openEventStream<RawEvent>(server, "/event", controller.signal, { directory })
	console.log(`${t()}  subscribed`)

	// No client-assigned messageID: the hypothesis under test is that Caret's
	// `msg_caret_*` ids break the server's id-ordered message queue. Server ids
	// only, both turns — if turn 2 now runs, the mechanism is confirmed.
	await request(server, `/session/${sessionId}/prompt_async`, {
		method: "POST",
		query: { directory },
		body: { parts: [{ type: "text", text: prompt }], model: MODEL, ...(agent === "plan" ? { agent: "plan" } : {}) },
	})
	console.log(`${t()}  prompt posted (server-assigned id)`)

	const deadline = setTimeout(() => {
		console.log(`${t()}  TIMEOUT after ${idleTimeoutMs / 1000}s without session.idle — aborting subscription`)
		controller.abort()
	}, idleTimeoutMs)

	let frames = 0
	try {
		for await (const event of events) {
			frames += 1
			console.log(`${t()}  ${describe(event)}`)
			if (event.type === "session.idle" && (event.properties as { sessionID?: string })?.sessionID === sessionId) {
				console.log(`${t()}  << session.idle for OUR session after ${frames} frame(s) — this is what send() maps to done`)
				break
			}
		}
	} catch (err) {
		// The timeout aborting the subscription mid-read lands here; it is the
		// probe's own doing, not a finding.
		if (!(err instanceof Error && err.name === "AbortError")) throw err
	} finally {
		clearTimeout(deadline)
		controller.abort()
	}
	if (frames === 0) console.log(`${t()}  << STREAM ENDED WITH ZERO FRAMES`)
}

async function main(): Promise<void> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "caret-probe-idle-"))
	await fs.writeFile(path.join(directory, "README.md"), "probe fixture\n")

	const server = await ensureOpencodeServer(CARET_SERVER_CONFIG)
	console.log(`${t()}  server up`)

	const session = await request<OpencodeSession>(server, "/session", {
		method: "POST",
		query: { directory },
		body: { title: "probe-idle" },
	})
	console.log(`${t()}  session ${session.id}`)

	// Turn 1 — the plan turn. Tiny prompt, free model, read-only agent.
	await turn(server, session.id, directory, "turn1-plan", "Reply with the single word: ready", "plan", 90_000)

	// The approval gap. In the real runs the user (harness) took ~11s to click Apply.
	console.log(`\n${t()}  sleeping 11s to mimic the approval gap…`)
	await new Promise((resolve) => setTimeout(resolve, 11_000))

	// Turn 2 — the apply turn: same session, FRESH subscription, build agent.
	await turn(server, session.id, directory, "turn2-apply", "Reply with the single word: applied", "build", 90_000)

	await fs.rm(directory, { recursive: true, force: true })
}

// The server must die no matter how the probe ends: its agent loop outlives the
// probe process, and a leaked loop on a broken turn polls the free tier forever.
main()
	.catch((err) => {
		console.error(err)
		process.exitCode = 1
	})
	.finally(async () => {
		await stopOpencodeServer().catch(() => {})
	})
