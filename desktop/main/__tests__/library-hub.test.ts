/**
 * The library manager (`libraries/libraries.ts`): which libraries count as on,
 * which tools it passes on and under what names, and resting after outages.
 * Connections are replaced by a stand-in; what a real connection does is the
 * real-app test's job.
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js"
import { strict as assert } from "assert"
import * as os from "os"

import type { LibraryDefinition } from "../../../src/core/design/libraries/catalog"
import { mockFetchForTesting } from "../../../src/shared/net"
import { LibraryHub, type LiveLibrary, REST_MS } from "../libraries/libraries"

const TOOLS: Record<string, Tool[]> = {
	shadcn: [
		{ name: "search_items_in_registries", description: "search", inputSchema: { type: "object", properties: {} } },
		{ name: "add_command", description: "writes files", inputSchema: { type: "object", properties: {} } },
	],
	aceternity: [{ name: "search_components", description: "search", inputSchema: { type: "object", properties: {} } }],
	lazyweb: [
		{
			name: "lazyweb_execute",
			description: "run",
			inputSchema: {
				type: "object",
				anyOf: [{ properties: { a: { type: "string" } } }, { properties: { b: { type: "number" } } }],
			},
		},
		{ name: "lazyweb_discover_tools", description: "discover", inputSchema: { type: "object", properties: {} } },
	],
}

/** Stand-in connections; `fail` makes a library's calls answer with that error text. */
function hub(fail: Record<string, string> = {}) {
	const opened: string[] = []
	const calls: string[] = []
	let off: string[] = []
	const libraries = new LibraryHub({
		dataDir: () => os.tmpdir(),
		offStore: {
			get: () => off,
			set: async (next) => {
				off = next
			},
		},
		open: async (_connection, definition: LibraryDefinition): Promise<LiveLibrary> => {
			opened.push(definition.id)
			return {
				tools: TOOLS[definition.id] ?? [],
				call: async (tool): Promise<CallToolResult> => {
					calls.push(`${definition.id}:${tool}`)
					return fail[definition.id]
						? { content: [{ type: "text", text: fail[definition.id] }], isError: true }
						: { content: [{ type: "text", text: "found" }] }
				},
				close: async () => {},
			}
		},
	})
	return { libraries, opened, calls }
}

const lazywebToken = (async () =>
	new Response(JSON.stringify({ token: "free-token" }), { status: 200 })) as unknown as typeof globalThis.fetch

describe("the library manager", () => {
	it("counts a library as on only when it is switched on and has what it needs", async () => {
		await mockFetchForTesting(lazywebToken, async () => {
			const { libraries } = hub()
			const on = (await libraries.onLibraries()).map((library) => library.id)
			assert.deepEqual(on, ["shadcn", "aceternity", "lazyweb"], "21st.dev has no key and Gummble no sign-in")
			await libraries.setEnabled("aceternity", false)
			assert.deepEqual(
				(await libraries.onLibraries()).map((library) => library.id),
				["shadcn", "lazyweb"],
			)
		})
	})

	it("passes on only the allowed tools, renamed to their library, with input formats made safe", async () => {
		await mockFetchForTesting(lazywebToken, async () => {
			const { libraries } = hub()
			const tools = await libraries.tools()
			const names = tools.map((tool) => tool.name).sort()
			assert.deepEqual(names, [
				"aceternity_search_components",
				"lazyweb_lazyweb_discover_tools",
				"lazyweb_lazyweb_execute",
				"shadcn_search_items_in_registries",
			])
			assert.ok(!names.some((name) => name.includes("add_command")), "a tool that writes files was passed on")
			const execute = tools.find((tool) => tool.name === "lazyweb_lazyweb_execute")!
			assert.equal(execute.inputSchema.anyOf, undefined, "a top-level anyOf would make Anthropic refuse every turn")
			assert.deepEqual(Object.keys(execute.inputSchema.properties ?? {}).sort(), ["a", "b"])
		})
	})

	it("sends a call to its library under the library's own tool name, and refuses a tool it does not pass on", async () => {
		await mockFetchForTesting(lazywebToken, async () => {
			const { libraries, calls } = hub()
			const result = await libraries.call("shadcn_search_items_in_registries", { query: "x" })
			assert.equal(result.isError, undefined)
			assert.deepEqual(calls, ["shadcn:search_items_in_registries"])
			assert.equal(libraries.owns("shadcn_add_command"), false)
			const refused = await libraries.call("shadcn_add_command", {})
			assert.equal(refused.isError, true)
			assert.deepEqual(calls, ["shadcn:search_items_in_registries"], "a refused tool reached the library")
		})
	})

	it("rests a library for 15 minutes after a rate limit: its tools leave the list and calls are refused without reaching it", async () => {
		await mockFetchForTesting(lazywebToken, async () => {
			const { libraries, calls } = hub({ aceternity: "HTTP 429 Too Many Requests" })
			let changes = 0
			libraries.onChange(() => changes++)
			await libraries.call("aceternity_search_components", {})
			assert.equal(changes, 1, "the rules were not told the library is resting")
			assert.equal(REST_MS, 15 * 60_000)
			assert.ok(!(await libraries.tools()).some((tool) => tool.name.startsWith("aceternity_")))
			const second = await libraries.call("aceternity_search_components", {})
			assert.match(String((second.content as Array<{ text: string }>)[0].text), /resting/)
			assert.equal(calls.filter((call) => call.startsWith("aceternity")).length, 1)
			const row = (await libraries.list()).find((library) => library.id === "aceternity")
			assert.equal(row?.state, "resting")
		})
	})

	it("does not rest a library over a bad argument the AI can fix", async () => {
		await mockFetchForTesting(lazywebToken, async () => {
			const { libraries } = hub({ shadcn: "Invalid arguments: query is required" })
			await libraries.call("shadcn_search_items_in_registries", {})
			assert.ok((await libraries.tools()).some((tool) => tool.name.startsWith("shadcn_")))
		})
	})

	it("a switched-off library offers no tools and its calls are refused", async () => {
		await mockFetchForTesting(lazywebToken, async () => {
			const { libraries, calls } = hub()
			await libraries.setEnabled("shadcn", false)
			assert.ok(!(await libraries.tools()).some((tool) => tool.name.startsWith("shadcn_")))
			const refused = await libraries.call("shadcn_search_items_in_registries", {})
			assert.equal(refused.isError, true)
			assert.equal(calls.length, 0)
		})
	})
})
