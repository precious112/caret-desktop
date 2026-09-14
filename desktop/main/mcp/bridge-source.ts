/**
 * The bridge's source, importable without Electron so the suite can spawn it
 * as a real process. See `stdio-bridge.ts` for why it exists and how it runs.
 */
export const MCP_BRIDGE_SOURCE = `// Written by Caret at launch. Speaks MCP stdio to OpenCode, HTTP to Caret.
"use strict"
const fs = require("fs")
const path = require("path")
const http = require("http")

/** The project's endpoint, from the discovery record beside the session cwd. */
function discover() {
	try {
		const record = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".caret", ".mcp.json"), "utf-8"))
		if (record && record.version === 1 && record.url && record.token) return record
	} catch {}
	return null
}

const record = discover()

function respond(message) {
	process.stdout.write(JSON.stringify(message) + "\\n")
}

/** What a project-less cwd gets: a well-formed server with nothing in it. */
function answerLocally(message) {
	if (message.id === undefined) return
	if (message.method === "initialize") {
		respond({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				protocolVersion: (message.params && message.params.protocolVersion) || "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "caret", version: "0" },
			},
		})
	} else if (message.method === "tools/list") {
		respond({ jsonrpc: "2.0", id: message.id, result: { tools: [] } })
	} else {
		respond({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "This folder is not a Caret project." } })
	}
}

/** One stdio message → one authorized POST. SSE and JSON replies both map back. */
function forward(message) {
	const url = new URL(record.url)
	const body = JSON.stringify(message)
	const request = http.request(
		{
			hostname: url.hostname,
			port: url.port,
			path: url.pathname,
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: "Bearer " + record.token,
				"content-length": Buffer.byteLength(body),
			},
		},
		(reply) => {
			let raw = ""
			reply.setEncoding("utf8")
			reply.on("data", (chunk) => {
				raw += chunk
			})
			reply.on("end", () => {
				if (message.id === undefined) return // a notification wants no reply
				const type = String(reply.headers["content-type"] || "")
				try {
					if (type.includes("text/event-stream")) {
						for (const frame of raw.split("\\n\\n")) {
							const data = frame
								.split("\\n")
								.filter((line) => line.startsWith("data:"))
								.map((line) => line.slice(5).trim())
								.join("")
							if (data) respond(JSON.parse(data))
						}
					} else if (raw.trim()) {
						respond(JSON.parse(raw))
					} else {
						respond({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Caret returned an empty reply (HTTP " + reply.statusCode + ")." } })
					}
				} catch (err) {
					respond({ jsonrpc: "2.0", id: message.id, error: { code: -32700, message: "Caret's reply did not parse: " + err.message } })
				}
			})
		},
	)
	// No timeout on purpose: a tool call can legitimately wait minutes on the
	// user (consent, a take pick) or on generation. OpenCode owns the deadline.
	request.on("error", (err) => {
		if (message.id !== undefined) {
			respond({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Caret is not reachable: " + err.message } })
		}
	})
	request.end(body)
}

let buffer = ""
process.stdin.on("data", (chunk) => {
	buffer += chunk.toString()
	let index
	while ((index = buffer.indexOf("\\n")) !== -1) {
		const line = buffer.slice(0, index).trim()
		buffer = buffer.slice(index + 1)
		if (!line) continue
		let message
		try {
			message = JSON.parse(line)
		} catch {
			continue
		}
		if (record) forward(message)
		else answerLocally(message)
	}
})
process.stdin.on("end", () => process.exit(0))
`
