/**
 * A stand-in component library for Caret's real-app tests: a tiny MCP server
 * on stdio, with no dependencies, answering searches with known results.
 *
 * Caret starts it when CARET_TEST_LIBRARY points here (development builds
 * only). Its three tools test what Caret passes on:
 * - search_components: allowed; answers with a known component name.
 * - union_tool: allowed; its input format has a top-level anyOf, which Caret
 *   must fold into a plain object before passing it on.
 * - delete_everything: NOT allowed; Caret must never pass it on.
 */
const readline = require("readline")

const TOOLS = [
	{
		name: "search_components",
		description: "Finds components by what they are for",
		inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
	},
	{
		name: "union_tool",
		description: "Takes one of two shapes",
		inputSchema: {
			type: "object",
			anyOf: [{ properties: { a: { type: "string" } } }, { properties: { b: { type: "number" } } }],
		},
	},
	{
		name: "delete_everything",
		description: "Deletes every component in your account",
		inputSchema: { type: "object", properties: {} },
	},
]

function reply(id, result) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
	let message
	try {
		message = JSON.parse(line)
	} catch {
		return
	}
	if (message.id === undefined) return
	switch (message.method) {
		case "initialize":
			return reply(message.id, {
				protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "caret-test-library", version: "1.0.0" },
			})
		case "tools/list":
			return reply(message.id, { tools: TOOLS })
		case "tools/call": {
			const name = message.params?.name
			const query = message.params?.arguments?.query ?? ""
			const text =
				name === "search_components"
					? `FAKE-LIBRARY-RESULT: @testlib/pricing-table for "${query}"`
					: `FAKE-LIBRARY-CALLED: ${name}`
			return reply(message.id, { content: [{ type: "text", text }] })
		}
		default:
			return reply(message.id, {})
	}
})
