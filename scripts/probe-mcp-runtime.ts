/**
 * Can the Design pass libraries be added to the running OpenCode server, and
 * switched on and off, without restarting it?
 *
 * The server's config is fixed when the process starts, so a library the user
 * switches on in the backend tab would otherwise wait for the next launch. The
 * pinned binary documents `POST /mcp` ("Dynamically add a new MCP server"),
 * `GET /mcp` (status per server) and connect/disconnect. This measures them:
 * the payload shape, the status words, what an OAuth-only server reports, and
 * whether a per-prompt `tools` glob hides a server's tools from one turn.
 *
 *   npx tsx scripts/probe-mcp-runtime.ts            # routes only, no model
 *   CARET_VERIFY_MODEL=opencode-go/claude-haiku-5-5 npx tsx scripts/probe-mcp-runtime.ts
 */
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { CARET_SERVER_CONFIG } from "../src/core/design/agent/opencode"
import { request } from "../src/core/design/agent/opencode/http"
import { ensureOpencodeServer, stopOpencodeServer } from "../src/core/design/agent/opencode/server"

async function main(): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "caret-mcprt-"))
	const server = await ensureOpencodeServer({
		...CARET_SERVER_CONFIG,
		tools: { "twentyfirst_*": false, twentyfirst_search: true },
	})
	const query = { directory: dir }
	const show = async (label: string) => console.log(label, JSON.stringify(await request(server, "/mcp", { query })))

	await show("before:")
	for (const [name, config] of [
		["lazyweb", { type: "remote", url: "https://www.lazyweb.com/mcp/public", enabled: true }],
		["gummble", { type: "remote", url: "https://mcp.gummble.com/mcp", enabled: true }],
		["shadcn", { type: "local", command: ["npx", "-y", "shadcn@latest", "mcp"], enabled: true }],
	] as const) {
		try {
			console.log(
				`add ${name}:`,
				JSON.stringify(await request(server, "/mcp", { method: "POST", query, body: { name, config } })),
			)
		} catch (error) {
			console.log(`add ${name} FAILED:`, String(error))
		}
	}
	await show("after add:")
	console.log(
		"disconnect lazyweb:",
		JSON.stringify(await request(server, "/mcp/lazyweb/disconnect", { method: "POST", query })),
	)
	await show("after disconnect:")
	console.log("connect lazyweb:", JSON.stringify(await request(server, "/mcp/lazyweb/connect", { method: "POST", query })))
	await show("after connect:")
	// Another directory: are added servers per directory or global?
	const other = await fs.mkdtemp(path.join(os.tmpdir(), "caret-mcprt2-"))
	console.log("other dir:", JSON.stringify(await request(server, "/mcp", { query: { directory: other } })))

	const model = process.env.CARET_VERIFY_MODEL
	if (model) {
		const [providerID, ...rest] = model.split("/")
		const session = await request<{ id: string }>(server, "/session", { method: "POST", query, body: { title: "probe" } })
		const ask = async (tools: Record<string, boolean> | undefined) => {
			const reply = await request<{ info?: { error?: unknown }; parts: Array<{ type: string; text?: string }> }>(
				server,
				`/session/${session.id}/message`,
				{
					method: "POST",
					query,
					body: {
						parts: [
							{
								type: "text",
								text: "List the exact names of every tool you can call whose name starts with lazyweb_ or shadcn_. Names only, comma separated. If none, say NONE.",
							},
						],
						model: { providerID, modelID: rest.join("/") },
						...(tools ? { tools } : {}),
					},
				},
			)
			if (reply.info?.error) return "ERROR " + JSON.stringify(reply.info.error).slice(0, 600)
			return reply.parts
				.map((p) =>
					p.type === "text" ? p.text : p.type === "tool" ? `[tool ${(p as { tool?: string }).tool}]` : `[${p.type}]`,
				)
				.join(" ")
				.trim()
		}
		console.log('tools, {"shadcn_*": false}:', await ask({ "shadcn_*": false }))
		console.log('tools, {"lazyweb_*": false}:', await ask({ "lazyweb_*": false }))
	}
}

main()
	.catch((error) => {
		console.error(error)
		process.exitCode = 1
	})
	.finally(() => stopOpencodeServer())
