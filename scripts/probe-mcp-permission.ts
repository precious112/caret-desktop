/**
 * Can OpenCode be made to ask before an **MCP** tool runs?
 *
 * The question matters because Caret's own tools are MCP tools. When the chat
 * agent edits a page with `caret_write_page`, OpenCode's model chose the call —
 * but OpenCode's `permission` config gates its *own* tools (bash, edit, read,
 * webfetch…), and nothing in that list is an MCP server. So the write happens
 * inside Caret's process without a permission event, and Caret's transcript has
 * no auto-approval to record. `verify:app`'s `ee` failed on exactly that.
 *
 * This asks whether a tool name that is not one of OpenCode's own works as a
 * permission key anyway. If it does, Caret's existing permission machinery
 * covers its own tools with a one-line config change.
 *
 *   npx tsx scripts/probe-mcp-permission.ts
 */
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { BackendEvent } from "../src/core/design/agent/backend"
import { extendOpencodeServerConfig, OpencodeBackend } from "../src/core/design/agent/opencode"
import { stopOpencodeServer } from "../src/core/design/agent/opencode/server"

/** A one-tool MCP server, named the way Caret names its own. */
const TINY_SERVER = `const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
let buf = ""
process.stdin.on("data", (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "caretprobe", version: "0" } } })
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "caret_write_page", description: "Writes a design page. Use this when asked to change page text.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } })
    } else if (msg.method === "tools/call") {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "written" }] } })
    } else if (msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, result: {} })
    }
  }
})
`

async function main(): Promise<void> {
	const model = process.env.CARET_VERIFY_MODEL
	if (!model) throw new Error("set CARET_VERIFY_MODEL")

	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "caret-mcpperm-"))
	const serverPath = path.join(dir, "tiny-mcp.cjs")
	await fs.writeFile(serverPath, TINY_SERVER, "utf-8")

	// The tool is registered, and named as a permission key — which is the whole
	// experiment. OpenCode's own docs only ever show its built-ins here.
	extendOpencodeServerConfig({
		mcp: { caretprobe: { type: "local", command: [process.execPath, serverPath], enabled: true } },
		// The minimal rule: Caret's own tools by prefix, alongside the real config's
		// own keys. Reads must stay silent — a plan phase that prompted on every
		// file read would be unusable, and reading is not the risk.
		permission: { "caretprobe_*": "ask", edit: "ask", bash: "ask", webfetch: "ask", external_directory: "ask" },
	})

	const backend = new OpencodeBackend()
	const session = await backend.startSession({ workingDirectory: dir, mode: "write", model })

	const seen: BackendEvent[] = []
	for await (const event of session.send({
		text: "First list the files here with the glob tool, then call the caret_write_page tool with text 'hello'. Report both results.",
	})) {
		seen.push(event)
		if (event.type === "permission") {
			console.log(`  PERMISSION RAISED for ${event.tool}: ${event.summary}`)
			await session.respondToPermission(event.requestId, "allow")
		}
		if (event.type === "tool-start") console.log(`  tool-start: ${event.name}`)
	}
	await session.close()

	const asked = seen.some((event) => event.type === "permission" && event.tool.includes("caret_write_page"))
	const askedForRead = seen.some(
		(event) => event.type === "permission" && /glob|read|list|grep/.test(event.tool) && !event.tool.includes("caret_"),
	)
	console.log(`\nasked before a read (must be false): ${askedForRead}`)
	const called = seen.some((event) => event.type === "tool-start" && event.name.includes("caret_write_page"))
	console.log(`\ncalled the MCP tool: ${called}`)
	console.log(`OpenCode asked first: ${asked}`)
	console.log(
		asked
			? "→ MCP tools CAN be gated by name; Caret's own tools can go through the same boundary."
			: "→ MCP tools are NOT gated by the permission config; the boundary has to live in Caret's own tool layer.",
	)

	await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
}

main().then(
	async () => {
		await stopOpencodeServer()
		process.exit(0)
	},
	async (err) => {
		console.error(err)
		await stopOpencodeServer()
		process.exit(1)
	},
)
