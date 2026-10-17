/**
 * Passes the libraries' tools on through Caret's own connection.
 *
 * Caret's tools are registered the usual way, with input formats written in
 * zod. A library's tools arrive with their own JSON input formats, which must
 * reach the AI exactly as the library wrote them (made safe, see
 * `safeInputSchema`), so they cannot go through the same registration. Instead
 * the server's two tool requests are wrapped: the tool list gains the
 * libraries' tools, and a call to one of them goes to the library; everything
 * else reaches Caret's own handlers unchanged.
 *
 * The wrap reads the MCP library's stored handlers, which it does not promise
 * to keep in that place. `pass-on.test.ts` runs a real server and client
 * through it, so an MCP library update that moves them fails a test rather
 * than silently dropping every library tool.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js"

export interface PassedOnTools {
	tools(): Promise<Tool[]>
	owns(name: string): boolean
	call(name: string, args: Record<string, unknown>): Promise<CallToolResult>
}

type StoredHandler = (request: unknown, extra: unknown) => Promise<unknown>

/** Call after every Caret tool is registered on `mcp`. */
export function passLibrariesOn(mcp: McpServer, libraries: PassedOnTools): void {
	const handlers = (mcp.server as unknown as { _requestHandlers?: Map<string, StoredHandler> })._requestHandlers
	const list = handlers?.get("tools/list")
	const call = handlers?.get("tools/call")
	if (!list || !call) throw new Error("the MCP library no longer stores its tool handlers where Caret wraps them")

	mcp.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
		const own = (await list(request, extra)) as { tools: Tool[] }
		const passed = await libraries.tools().catch(() => [])
		const taken = new Set(own.tools.map((tool) => tool.name))
		return { ...own, tools: [...own.tools, ...passed.filter((tool) => !taken.has(tool.name))] }
	})

	mcp.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		if (libraries.owns(request.params.name)) {
			return libraries.call(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>)
		}
		return (await call(request, extra)) as CallToolResult
	})
}
