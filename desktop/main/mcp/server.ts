/**
 * The local MCP server — one per open project.
 *
 * Plain Node `http` rather than express, because the only thing being served is
 * a single MCP endpoint behind an auth check and adding a framework for that
 * would be adding a dependency for nothing.
 *
 * Port 0 means the OS assigns, and the assignment is written into the project's
 * own `.caret/.mcp.json`. That is what lets several projects be open at once and
 * what makes a client config point at a *project* rather than at a machine.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http"
import type { AddressInfo } from "net"
import type { InstallResult, PageCheckResult } from "../../../src/core/design"
import { Logger } from "../../../src/shared/services/Logger"
import { capture } from "../analytics"
import { cancelInterviewPrompts, type InterviewPrompt } from "../interview"
import type { ScreenshotResult } from "../types"
import { authorize, generateToken } from "./auth"
import { clearDiscovery, writeDiscovery } from "./discovery"
import { buildInterviewTools, INTERVIEW_PROMPT } from "./interview-tools"
import { logToolError, TOOLS, type ToolContext } from "./tools"

const MCP_PATH = "/mcp"

/** Requests larger than this are refused rather than buffered. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

export interface CaretMcpServerOptions {
	projectPath: string
	/** Fired when an agent connects or disconnects, so the UI can reflect it. */
	onAgentConnectionChanged?(connected: boolean): void
	/** Renders one page and captures it, or says why it could not. */
	screenshot?(pageId: string, part?: number): Promise<ScreenshotResult>
	/** Runs the deterministic design checks on one page (or all), returning findings. */
	runChecks?(pageId?: string): Promise<PageCheckResult[]>
	/** Installs an allowlisted catalog component into the project (consent-gated). */
	installComponent?(libraryId: string, componentId: string): Promise<InstallResult>
	/** Sends an interview question or option set to the chrome renderer. */
	onInterviewPrompt?(prompt: InterviewPrompt): void
}

export class CaretMcpServer {
	private http: Server | null = null
	private token = generateToken()
	private port: number | null = null
	private connected = false

	constructor(private readonly options: CaretMcpServerOptions) {}

	getUrl(): string | null {
		return this.port === null ? null : `http://127.0.0.1:${this.port}${MCP_PATH}`
	}

	getToken(): string {
		return this.token
	}

	hasConnectedAgent(): boolean {
		return this.connected
	}

	async start(): Promise<void> {
		if (this.http) return

		this.http = createServer((req, res) => void this.handleRequest(req, res))

		await new Promise<void>((resolve, reject) => {
			this.http?.once("error", reject)
			// Bound to loopback explicitly — the default would listen on every
			// interface and expose a file-writing server to the local network.
			this.http?.listen(0, "127.0.0.1", resolve)
		})

		this.port = (this.http.address() as AddressInfo).port

		await writeDiscovery(this.options.projectPath, {
			version: 1,
			url: this.getUrl() as string,
			port: this.port,
			token: this.token,
			project: this.options.projectPath,
			pid: process.pid,
			startedAt: new Date().toISOString(),
		})

		Logger.info(`[mcp] serving ${this.options.projectPath} on ${this.getUrl()}`)
	}

	async stop(): Promise<void> {
		// Any tool call still waiting on the user would otherwise hang against a
		// window that no longer exists.
		//
		// This used to also install a `NullBridge`, from when MCP was expected to
		// carry outbound work. It cannot, and the bridge now belongs to the coding
		// backend — so an MCP server starting or stopping quietly replaced a
		// working backend with one that refuses everything.
		cancelInterviewPrompts()
		await clearDiscovery(this.options.projectPath)
		await new Promise<void>((resolve) => {
			if (!this.http) return resolve()
			this.http.close(() => resolve())
		})
		this.http = null
		this.port = null
		this.setConnected(false)
	}

	private registerTools(mcp: McpServer): void {
		const ctx: ToolContext = {
			projectPath: this.options.projectPath,
			screenshot: (pageId, part) =>
				this.options.screenshot?.(pageId, part) ??
				Promise.resolve({ ok: false as const, reason: "this project has no window to render pages in" }),
			runChecks: (pageId) =>
				this.options.runChecks?.(pageId) ?? Promise.reject(new Error("this project has no window to render pages in")),
			installComponent: (libraryId, componentId) =>
				this.options.installComponent?.(libraryId, componentId) ??
				Promise.resolve({ ok: false as const, reason: "this project has no window to install into" }),
		}

		const tools = [...TOOLS, ...buildInterviewTools({ send: (prompt) => this.options.onInterviewPrompt?.(prompt) })]

		// The interview script ships as a prompt so any client can run it without
		// the user having to know what to type.
		mcp.registerPrompt(
			"foundation_interview",
			{
				title: "Set up this project's visual foundations",
				description: "A short plain-language interview that lands on foundations from Caret's curated library.",
			},
			() => ({ messages: [{ role: "user", content: { type: "text", text: INTERVIEW_PROMPT } }] }),
		)

		for (const tool of tools) {
			mcp.registerTool(
				tool.name,
				{ title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
				(async (args: unknown) => {
					this.setConnected(true)
					try {
						const result = await tool.handler(ctx, args)
						// Tool names are Caret's own fixed vocabulary — safe to send.
						capture("mcp_tool_invoked", {
							tool: tool.name,
							ok: (result as { isError?: boolean }).isError !== true,
							initiator: "agent",
						})
						return result
					} catch (err) {
						capture("mcp_tool_invoked", { tool: tool.name, ok: false, initiator: "agent" })
						return logToolError(tool.name, err)
					}
				}) as never,
			)
		}
	}

	private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`)

		if (url.pathname !== MCP_PATH) {
			res.writeHead(404).end()
			return
		}

		const auth = authorize(req, this.token)
		if (!auth.ok) {
			Logger.warn(`[mcp] refused a request: ${auth.reason}`)
			res.writeHead(auth.status, { "content-type": "application/json" })
			res.end(JSON.stringify({ error: auth.reason }))
			return
		}

		let body: unknown
		try {
			body = await readJsonBody(req)
		} catch (err) {
			res.writeHead(400, { "content-type": "application/json" })
			res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Malformed request body" }))
			return
		}

		this.setConnected(true)

		// A fresh server and transport per request. `StreamableHTTPServerTransport`
		// in stateless mode (no session id) is single-use: reusing one instance
		// answers the first request correctly and then returns 500 to every request
		// after it, forever. That is invisible until something makes a second call,
		// which is why `verify:app` now makes several.
		const mcp = new McpServer({ name: "caret", version: "0.1.0" })
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

		res.on("close", () => {
			void transport.close().catch(() => {})
			void mcp.close().catch(() => {})
		})

		try {
			this.registerTools(mcp)
			await mcp.connect(transport)
			await transport.handleRequest(req, res, body)
		} catch (err) {
			Logger.error("[mcp] request handling failed:", err)
			if (!res.headersSent) res.writeHead(500).end()
		}
	}

	private setConnected(connected: boolean): void {
		if (this.connected === connected) return
		this.connected = connected
		Logger.info(`[mcp] agent ${connected ? "connected" : "disconnected"}`)
		this.options.onAgentConnectionChanged?.(connected)
	}
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		if (req.method === "GET" || req.method === "DELETE") return resolve(undefined)

		const chunks: Buffer[] = []
		let size = 0

		req.on("data", (chunk: Buffer) => {
			size += chunk.length
			if (size > MAX_BODY_BYTES) {
				reject(new Error("Request body too large"))
				req.destroy()
				return
			}
			chunks.push(chunk)
		})
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf-8")
			if (!raw) return resolve(undefined)
			try {
				resolve(JSON.parse(raw))
			} catch {
				reject(new Error("Request body is not valid JSON"))
			}
		})
		req.on("error", reject)
	})
}
