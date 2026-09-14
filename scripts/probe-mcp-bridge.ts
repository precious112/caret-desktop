/**
 * Does the bundled OpenCode server spawn a LOCAL MCP command per session
 * directory, with that directory as cwd?
 *
 *   npx tsx scripts/probe-mcp-bridge.ts
 *
 * The whole chat-tools design hangs on the answer: one shared server serves
 * every open project, so a per-project MCP entry cannot ride the global spawn
 * config — but a `local`-type entry whose command discovers the project from
 * its own cwd can, IF opencode launches it per directory. The docs hint
 * ("relative paths resolve from the workspace") and stop there; this measures.
 *
 * The probe command is a stub MCP server that logs its cwd and answers the
 * initialize/tools handshake with one tool, so the probe can also confirm the
 * tool actually reaches the session's tool list. Zero model turns.
 */
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { CARET_SERVER_CONFIG } from "../src/core/design/agent/opencode"
import { openEventStream, request } from "../src/core/design/agent/opencode/http"
import type { OpencodeSession } from "../src/core/design/agent/opencode/protocol"
import { ensureOpencodeServer, stopOpencodeServer } from "../src/core/design/agent/opencode/server"

/** Free model, zero cost — the turn exists only to force MCP initialization. */
const MODEL = { providerID: "opencode", modelID: "mimo-v2.5-free" }

const CWD_LOG = path.join(os.tmpdir(), `caret-mcp-probe-${process.pid}.log`)

/** A minimal stdio MCP server: logs cwd, answers initialize + tools/list. */
const STUB = `
const fs = require("fs")
fs.appendFileSync(${JSON.stringify(CWD_LOG)}, process.cwd() + "\\n")
let buffer = ""
process.stdin.on("data", (chunk) => {
	buffer += chunk.toString()
	let index
	while ((index = buffer.indexOf("\\n")) !== -1) {
		const line = buffer.slice(0, index).trim()
		buffer = buffer.slice(index + 1)
		if (!line) continue
		let message
		try { message = JSON.parse(line) } catch { continue }
		const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n")
		if (message.method === "initialize") {
			reply({ protocolVersion: message.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "caret-probe", version: "0" } })
		} else if (message.method === "tools/list") {
			reply({ tools: [{ name: "caret_probe_tool", description: "probe", inputSchema: { type: "object", properties: {} } }] })
		} else if (message.id !== undefined) {
			reply({})
		}
	}
})
`

async function main(): Promise<void> {
	await fs.rm(CWD_LOG, { force: true })
	const stubPath = path.join(os.tmpdir(), `caret-mcp-stub-${process.pid}.cjs`)
	await fs.writeFile(stubPath, STUB)

	const dirA = await fs.mkdtemp(path.join(os.tmpdir(), "caret-probe-a-"))
	const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "caret-probe-b-"))

	const server = await ensureOpencodeServer({
		...CARET_SERVER_CONFIG,
		mcp: {
			caret: { type: "local", command: [process.execPath, stubPath], environment: { ELECTRON_RUN_AS_NODE: "1" } },
		},
	} as never)
	console.log("server up")

	try {
		for (const [label, directory] of [
			["A", dirA],
			["B", dirB],
		] as const) {
			const session = await request<OpencodeSession>(server, "/session", {
				method: "POST",
				query: { directory },
				body: { title: `probe-${label}` },
			})
			console.log(`session ${label}: ${session.id} in ${directory}`)
			// Nudge tool discovery without a model: ask the server what this
			// session can do. Endpoint availability varies by version, so failures
			// are reported rather than fatal.
			for (const probe of [`/session/${session.id}/tool`, "/config/tool", "/tool", "/experimental/tool"]) {
				try {
					const tools = await request<unknown>(server, probe, { method: "GET", query: { directory } })
					const text = JSON.stringify(tools)
					console.log(
						`  ${probe}: ${text.includes("caret_probe_tool") ? "HAS caret_probe_tool" : `no probe tool (${text.slice(0, 120)})`}`,
					)
					break
				} catch {
					// try the next shape
				}
			}
		}

		// MCP may initialize only when a turn actually runs — session creation
		// alone spawned nothing (measured). One tiny free-model turn in dir A.
		const sessionA = await request<OpencodeSession>(server, "/session", {
			method: "POST",
			query: { directory: dirA },
			body: { title: "probe-turn" },
		})
		const controller = new AbortController()
		const events = await openEventStream<{ type: string; properties?: unknown }>(server, "/event", controller.signal, {
			directory: dirA,
		})
		await request(server, `/session/${sessionA.id}/prompt_async`, {
			method: "POST",
			query: { directory: dirA },
			body: {
				parts: [{ type: "text", text: "If you have a tool called caret_probe_tool, call it once. Then reply: done." }],
				model: MODEL,
			},
		})
		const deadline = setTimeout(() => controller.abort(), 90_000)
		try {
			for await (const event of events) {
				if (event.type === "session.idle" && (event.properties as { sessionID?: string })?.sessionID === sessionA.id) {
					console.log("turn completed (session.idle)")
					break
				}
			}
		} catch (err) {
			if (!(err instanceof Error && err.name === "AbortError")) throw err
			console.log("turn TIMED OUT after 90s")
		} finally {
			clearTimeout(deadline)
			controller.abort()
		}

		// Give lazy spawns a beat, then read what actually launched.
		await new Promise((resolve) => setTimeout(resolve, 3000))
		const log = await fs.readFile(CWD_LOG, "utf-8").catch(() => "")
		// realpath both sides: macOS /var is a symlink to /private/var, and a raw
		// string compare called a correct spawn wrong on the first run.
		const cwds = await Promise.all(
			log
				.split("\n")
				.filter(Boolean)
				.map((cwd) => fs.realpath(cwd).catch(() => cwd)),
		)
		const [realA, realB] = await Promise.all([fs.realpath(dirA), fs.realpath(dirB)])
		console.log(`\nstub spawned ${cwds.length} time(s):`)
		for (const cwd of cwds) console.log(`  cwd = ${cwd}`)
		console.log(
			cwds.length === 0
				? "\nVERDICT: the local MCP never spawned — config-level local mcp may need different wiring"
				: cwds.includes(realA) || cwds.includes(realB)
					? "\nVERDICT: spawned lazily at first turn, per directory, with the project as cwd — the bridge design works"
					: `\nVERDICT: spawned but NOT in a project directory — cwd routing will not work (dirs were ${realA} and ${realB})`,
		)
	} finally {
		await stopOpencodeServer().catch(() => {})
		await fs.rm(stubPath, { force: true })
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
