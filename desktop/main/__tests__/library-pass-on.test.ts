/**
 * Caret's connection passes the libraries' tools on (`pass-on.ts`).
 *
 * A real MCP server and client, talking in memory: the server has one of
 * Caret's own tools, registered the usual way, and the wrap adds a library's.
 * This is also the guard on the wrap itself: it reads where the MCP library
 * keeps its handlers, so an MCP library update that moves them fails here.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import { strict as assert } from "assert"
import { z } from "zod"

import { passLibrariesOn } from "../libraries/pass-on"

const LIBRARY_TOOL: Tool = {
	name: "testlib_search_components",
	description: "Test library: finds components",
	inputSchema: {
		type: "object",
		properties: { query: { type: "string", description: "what to find" }, limit: { type: "number" } },
		required: ["query"],
	},
}

async function connected(libraryCalls: Array<{ name: string; args: unknown }>) {
	const mcp = new McpServer({ name: "caret", version: "0" })
	mcp.registerTool("get_project", { description: "Caret's own", inputSchema: { page: z.number().optional() } }, async () => ({
		content: [{ type: "text", text: "caret's own answer" }],
	}))
	passLibrariesOn(mcp, {
		tools: async () => [LIBRARY_TOOL],
		owns: (name) => name === LIBRARY_TOOL.name,
		call: async (name, args) => {
			libraryCalls.push({ name, args })
			return { content: [{ type: "text", text: "from the library" }] }
		},
	})
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
	await mcp.connect(serverSide)
	const client = new Client({ name: "test", version: "0" })
	await client.connect(clientSide)
	return client
}

describe("Caret's connection passes the libraries' tools on", () => {
	it("lists Caret's own tools and the library's, with the library's input format unchanged", async () => {
		const client = await connected([])
		const { tools } = await client.listTools()
		assert.deepEqual(
			tools.map((tool) => tool.name),
			["get_project", "testlib_search_components"],
		)
		const passed = tools.find((tool) => tool.name === LIBRARY_TOOL.name)
		assert.deepEqual(passed?.inputSchema, LIBRARY_TOOL.inputSchema)
	})

	it("sends a library tool's call to the library, and Caret's own to Caret", async () => {
		const calls: Array<{ name: string; args: unknown }> = []
		const client = await connected(calls)
		const fromLibrary = await client.callTool({ name: LIBRARY_TOOL.name, arguments: { query: "pricing" } })
		assert.equal((fromLibrary.content as Array<{ text: string }>)[0].text, "from the library")
		assert.deepEqual(calls, [{ name: LIBRARY_TOOL.name, args: { query: "pricing" } }])
		const own = await client.callTool({ name: "get_project", arguments: {} })
		assert.equal((own.content as Array<{ text: string }>)[0].text, "caret's own answer")
		assert.equal(calls.length, 1, "Caret's own tool reached the library")
	})
})
