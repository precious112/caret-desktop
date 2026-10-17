/**
 * What a one-off answer costs before the model reads a word of the request.
 *
 * Caret asks the bundled backend many single questions (interview turns,
 * asset briefs). Each runs as a full coding
 * agent: OpenCode's built-in system prompt, the project's AGENTS.md, every
 * tool's schema (Caret's MCP tools and the libraries' included). This sends
 * the same trivial request under each setup and reports the input tokens, and
 * checks that a schema-constrained answer still works under a lean agent with
 * its own prompt and no tools.
 *
 *   CARET_VERIFY_MODEL=opencode-go/glm-5.3-flash npx tsx scripts/probe-context-size.ts [project]
 */
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { CARET_SERVER_CONFIG, extendOpencodeServerConfig, OpencodeBackend } from "../src/core/design/agent/opencode"
import { request } from "../src/core/design/agent/opencode/http"
import { currentOpencodeServer, stopOpencodeServer } from "../src/core/design/agent/opencode/server"

const MODEL = process.env.CARET_VERIFY_MODEL ?? "opencode-go/glm-5.3-flash"
const LEAN = "caret-probe-lean"

interface Reply {
	info: { tokens?: { input?: number; cache?: { read?: number; write?: number } }; error?: unknown }
	parts: Array<{ type: string; tool?: string; text?: string }>
}

async function ask(directory: string, body: Record<string, unknown>): Promise<{ input: number; parts: string; error?: string }> {
	const server = currentOpencodeServer()!
	const [providerID, ...rest] = MODEL.split("/")
	const session = await request<{ id: string }>(server, "/session", {
		method: "POST",
		query: { directory },
		body: { title: "probe" },
	})
	try {
		const reply = await request<Reply>(server, `/session/${session.id}/message`, {
			method: "POST",
			query: { directory },
			body: { model: { providerID, modelID: rest.join("/") }, ...body },
		})
		const t = reply.info.tokens ?? {}
		return {
			input: (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0),
			parts: reply.parts
				.map((p) =>
					p.type === "tool" ? `tool:${p.tool}` : p.type === "text" ? `text:${(p.text ?? "").slice(0, 40)}` : p.type,
				)
				.join(", "),
			error: reply.info.error ? JSON.stringify(reply.info.error).slice(0, 300) : undefined,
		}
	} finally {
		await request(server, `/session/${session.id}`, { method: "DELETE", query: { directory } }).catch(() => {})
	}
}

async function main(): Promise<void> {
	const project = process.argv[2]
	const empty = fs.mkdtempSync(path.join(os.tmpdir(), "caret-ctx-empty-"))
	extendOpencodeServerConfig({
		agent: {
			[LEAN]: {
				mode: "primary",
				prompt: "You answer one request from Caret, a design tool. Reply exactly in the format the request asks for. You cannot ask the user anything; everything you need is in the request.",
				permission: { "*": "deny", StructuredOutput: "allow" },
			},
		},
	})
	// Boot through the backend so the config Caret really ships is the one measured.
	await new OpencodeBackend().listModels().catch(() => [])
	if (!currentOpencodeServer()) throw new Error("the server did not start")
	const prompt = [{ type: "text", text: "Reply with the single word: ok" }]
	const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }

	const rows: Array<[string, Promise<{ input: number; parts: string; error?: string }>]> = []
	if (project) rows.push(["default agent, in the project (today's interview)", ask(project, { parts: prompt })])
	rows.push(["default agent, empty folder", ask(empty, { parts: prompt })])
	rows.push(["lean agent, empty folder", ask(empty, { parts: prompt, agent: LEAN })])
	if (project) rows.push(["lean agent, in the project", ask(project, { parts: prompt, agent: LEAN })])
	rows.push([
		"lean agent + json_schema answer",
		ask(empty, { parts: prompt, agent: LEAN, format: { type: "json_schema", schema } }),
	])
	for (const [label, pending] of rows) {
		const r = await pending
		console.log(`${label.padEnd(52)} input ${String(r.input).padStart(6)} tokens | ${r.error ?? r.parts}`)
	}
	console.log(`(base config: ${JSON.stringify(CARET_SERVER_CONFIG.permission)})`)
}

main()
	.catch((error) => {
		console.error(error)
		process.exitCode = 1
	})
	.finally(() => stopOpencodeServer())
