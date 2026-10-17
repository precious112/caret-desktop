/**
 * How long does the bundled server take to answer Stop (`POST /session/:id/abort`)?
 *
 * gg's give-up path pressed Stop and the chat stayed busy for a full minute.
 * Caret's Stop waits for this request before freeing the chat, so a slow
 * answer is a frozen Stop. Two moments are timed: while a shell command waits
 * for permission, and while the command is running. A cheap model; a few tokens.
 *
 *   npx tsx scripts/probe-abort.ts
 */
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { CARET_SERVER_CONFIG } from "../src/core/design/agent/opencode"
import { openEventStream, request } from "../src/core/design/agent/opencode/http"
import type { OpencodeSession } from "../src/core/design/agent/opencode/protocol"
import { ensureOpencodeServer, stopOpencodeServer } from "../src/core/design/agent/opencode/server"

const MODEL = { providerID: "opencode-go", modelID: "deepseek-v4.1-flash" }
const started = Date.now()
const t = () => `+${((Date.now() - started) / 1000).toFixed(1)}s`

type RawEvent = { type: string; properties?: Record<string, any> }

async function timedAbort(server: Awaited<ReturnType<typeof ensureOpencodeServer>>, id: string, directory: string, label: string) {
	const before = Date.now()
	const outcome = await Promise.race([
		request(server, `/session/${id}/abort`, { method: "POST", query: { directory } }).then(
			() => "answered",
			(err) => `failed: ${err}`,
		),
		new Promise((resolve) => setTimeout(() => resolve("NO ANSWER after 90s"), 90_000)),
	])
	console.log(`${t()}  ABORT ${label}: ${outcome} in ${((Date.now() - before) / 1000).toFixed(1)}s`)
}

async function scenario(server: Awaited<ReturnType<typeof ensureOpencodeServer>>, directory: string, allow: boolean) {
	const label = allow ? "while the command runs" : "while the command waits for permission"
	console.log(`\n===== ${label} =====`)
	const session = await request<OpencodeSession>(server, "/session", { method: "POST", query: { directory }, body: { title: "probe-abort" } })
	const controller = new AbortController()
	const events = await openEventStream<RawEvent>(server, "/event", controller.signal, { directory })
	await request(server, `/session/${session.id}/prompt_async`, {
		method: "POST",
		query: { directory },
		body: {
			parts: [{ type: "text", text: "Use your bash tool to run exactly this command, and nothing else: sleep 120" }],
			model: MODEL,
		},
	})
	const deadline = setTimeout(() => controller.abort(), 240_000)
	try {
		for await (const event of events) {
			const p = event.properties ?? {}
			if (p.sessionID && p.sessionID !== session.id) continue
			if (event.type === "permission.asked" || event.type === "permission.updated") {
				console.log(`${t()}  permission asked: ${JSON.stringify(p).slice(0, 160)}`)
				if (!allow) {
					await timedAbort(server, session.id, directory, label)
					break
				}
				const requestId = p.id ?? p.requestID
				await request(server, `/permission/${requestId}/reply`, { method: "POST", query: { directory }, body: { reply: "once" } })
				console.log(`${t()}  allowed`)
			}
			if (event.type === "message.part.updated" && p.part?.type === "tool" && p.part?.state?.status === "running" && allow) {
				console.log(`${t()}  tool running: ${p.part.tool}`)
				await new Promise((resolve) => setTimeout(resolve, 3000))
				await timedAbort(server, session.id, directory, label)
				break
			}
			if (event.type === "session.idle") {
				console.log(`${t()}  idle before the moment under test`)
				break
			}
		}
	} finally {
		clearTimeout(deadline)
		controller.abort()
	}
}

async function main(): Promise<void> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "caret-probe-abort-"))
	const server = await ensureOpencodeServer(CARET_SERVER_CONFIG)
	try {
		await scenario(server, directory, false)
		await scenario(server, directory, true)
	} finally {
		await stopOpencodeServer().catch(() => {})
		await fs.rm(directory, { recursive: true, force: true })
	}
}

main()
	.catch((err) => {
		console.error(err)
		process.exitCode = 1
	})
	.finally(() => setTimeout(() => process.exit(), 500))
