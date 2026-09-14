/**
 * The chat-tools bridge, run for real: a node process speaking stdio JSON-RPC
 * on one side and authorized HTTP on the other. Tested as a process rather
 * than as functions because the template IS the artifact — a quoting slip in
 * the string would pass any unit test of its pieces and still ship a bridge
 * that cannot parse its first line.
 */
import { strict as assert } from "assert"
import { type ChildProcess, spawn } from "child_process"
import * as fs from "fs/promises"
import { createServer, type Server } from "http"
import type { AddressInfo } from "net"
import * as os from "os"
import * as path from "path"

import { MCP_BRIDGE_SOURCE } from "../mcp/bridge-source"

const TOKEN = "test-token-abc"

describe("mcp stdio bridge", function () {
	// Real processes and sockets; give it room on a slow machine.
	this.timeout(10_000)

	let server: Server
	let url = ""
	let seenAuth: string[] = []
	let scratch = ""
	let bridgePath = ""

	before(async () => {
		seenAuth = []
		server = createServer((req, res) => {
			seenAuth.push(String(req.headers.authorization ?? ""))
			let body = ""
			req.on("data", (chunk) => {
				body += chunk
			})
			req.on("end", () => {
				const message = JSON.parse(body)
				if (message.method === "initialize") {
					// Plain JSON reply — one of the two shapes the endpoint produces.
					res.writeHead(200, { "content-type": "application/json" })
					res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "caret" } } }))
				} else {
					// SSE reply — the other shape.
					res.writeHead(200, { "content-type": "text/event-stream" })
					res.end(
						`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "get_project" }] } })}\n\n`,
					)
				}
			})
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`

		scratch = await fs.mkdtemp(path.join(os.tmpdir(), "caret-bridge-test-"))
		bridgePath = path.join(scratch, "bridge.cjs")
		await fs.writeFile(bridgePath, MCP_BRIDGE_SOURCE)
	})

	after(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()))
		await fs.rm(scratch, { recursive: true, force: true })
	})

	/** Spawns the bridge in `cwd`, sends lines, returns stdout lines. */
	async function converse(cwd: string, lines: string[], expect: number): Promise<string[]> {
		const child: ChildProcess = spawn(process.execPath, [bridgePath], { cwd, stdio: ["pipe", "pipe", "pipe"] })
		const out: string[] = []
		const done = new Promise<void>((resolve, reject) => {
			let buffer = ""
			child.stdout?.on("data", (chunk) => {
				buffer += chunk.toString()
				let index: number
				while ((index = buffer.indexOf("\n")) !== -1) {
					out.push(buffer.slice(0, index))
					buffer = buffer.slice(index + 1)
					if (out.length >= expect) resolve()
				}
			})
			child.on("error", reject)
			setTimeout(() => reject(new Error(`bridge answered ${out.length}/${expect} within 5s: ${JSON.stringify(out)}`)), 5000)
		})
		for (const line of lines) child.stdin?.write(`${line}\n`)
		try {
			await done
		} finally {
			child.kill()
		}
		return out
	}

	it("proxies both reply shapes and carries the bearer token", async () => {
		const project = path.join(scratch, "project")
		await fs.mkdir(path.join(project, ".caret"), { recursive: true })
		await fs.writeFile(
			path.join(project, ".caret", ".mcp.json"),
			JSON.stringify({ version: 1, url, token: TOKEN, port: 0, project, pid: 1, startedAt: "" }),
		)

		const replies = await converse(
			project,
			[
				JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
				JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
			],
			2,
		)

		const first = JSON.parse(replies[0])
		const second = JSON.parse(replies[1])
		assert.equal(first.result.serverInfo.name, "caret", "the JSON-shaped reply did not come back")
		assert.equal(second.result.tools[0].name, "get_project", "the SSE-shaped reply did not come back")
		assert.ok(
			seenAuth.every((header) => header === `Bearer ${TOKEN}`),
			`a request went out without the token: ${JSON.stringify(seenAuth)}`,
		)
	})

	it("serves an empty, well-formed server outside a Caret project", async () => {
		const plain = path.join(scratch, "not-a-project")
		await fs.mkdir(plain, { recursive: true })

		const replies = await converse(
			plain,
			[
				JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
				JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
			],
			2,
		)
		assert.equal(JSON.parse(replies[0]).result.serverInfo.name, "caret")
		assert.deepEqual(JSON.parse(replies[1]).result.tools, [], "a folder with no project should offer zero tools")
	})
})
