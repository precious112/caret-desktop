/**
 * The whole Design pass against real models and real libraries, outside the app.
 *
 * Drives `runDesignPass` through Caret's own OpenCode backend exactly as the
 * chat does — structured answers, the libraries added at runtime, the per-prompt
 * tool policy — and prints each step, every library tool call, and the result.
 * Questions are answered "remove" so the run needs no person.
 *
 *   CARET_PASS_MAIN=opencode-go/gpt-5.6-luna CARET_PASS_HELPER=opencode-go/claude-haiku-5-5 \
 *     npx tsx scripts/probe-design-pass.ts "A landing page for …"
 *
 * Optional: TWENTYFIRST_KEY_FILE (a file holding a 21st.dev key; never printed).
 */
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { OpencodeBackend, setOpencodeToolPolicy } from "../src/core/design/agent/opencode"
import { stopOpencodeServer } from "../src/core/design/agent/opencode/server"
import { runDesignPass } from "../src/core/design/design-pass/engine"
import { NOTHING_APPROVED } from "../src/core/design/design-pass/findings"
import {
	LIBRARIES,
	type LibraryId,
	libraryToolPolicy,
	mcpConfigFor,
	shadcnComponentsJson,
} from "../src/core/design/design-pass/libraries"
import { buildInstructions } from "../src/core/design/design-pass/prompts"
import { systemSpawnEnv } from "../src/core/design/spawn-env"

const MAIN = process.env.CARET_PASS_MAIN ?? "opencode-go/gpt-5.6-luna"
const HELPER = process.env.CARET_PASS_HELPER ?? "opencode-go/claude-haiku-5-5"
const BRIEF =
	process.argv[2] ??
	"A landing page for Ferrylink, a booking app for the small passenger ferries between the Greek islands: live departures, which boats still have seats, and buying a ticket in under a minute."

async function lazywebToken(): Promise<string | undefined> {
	const response = await fetch("https://www.lazyweb.com/api/mcp/install-token?install_channel=caret", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	})
	return ((await response.json()) as { token?: string }).token
}

async function main(): Promise<void> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caret-pass-"))
	const shadcnDir = path.join(dir, "..", `caret-pass-shadcn-${process.pid}`)
	fs.mkdirSync(shadcnDir, { recursive: true })
	fs.writeFileSync(path.join(shadcnDir, "components.json"), shadcnComponentsJson())

	const backend = new OpencodeBackend()
	const credentials: Partial<Record<LibraryId, string | undefined>> = {
		lazyweb: await lazywebToken().catch(() => undefined),
		twentyfirst: process.env.TWENTYFIRST_KEY_FILE
			? fs.readFileSync(process.env.TWENTYFIRST_KEY_FILE, "utf-8").trim()
			: undefined,
	}
	const context = { npx: "npx", path: systemSpawnEnv().PATH, shadcnDir }
	for (const library of LIBRARIES) {
		const config = mcpConfigFor(library.id, { ...context, credential: credentials[library.id] })
		if (!config) continue
		await backend.mcp
			.add(dir, library.id, config as unknown as Record<string, unknown>)
			.catch((e) => console.log(`add ${library.id} failed: ${e}`))
	}
	const status = await backend.mcp.status(dir)
	const usable = new Set(LIBRARIES.filter((l) => status[l.id]?.status === "connected").map((l) => l.id))
	console.log("libraries:", JSON.stringify(status))
	setOpencodeToolPolicy(() => libraryToolPolicy(usable))

	const started = Date.now()
	const ask = async <T>(
		model: string,
		prompt: string,
		schema: Record<string, unknown>,
		tools: Record<string, boolean> = {},
	) => {
		const t0 = Date.now()
		const answer = await backend.structured<T>({
			workingDirectory: dir,
			prompt,
			schema,
			model,
			tools: { "caret_*": false, ...tools },
		})
		console.log(
			`    · ${model.split("/").pop()} answered in ${Math.round((Date.now() - t0) / 1000)}s${answer.emulated ? " (emulated)" : ""}`,
		)
		return answer
	}

	const result = await runDesignPass({
		models: {
			main: async (prompt, schema) => (await ask(MAIN, prompt, schema)).value as never,
			helper: async (prompt, schema) => (await ask(HELPER, prompt, schema)).value as never,
			designer: async (prompt, schema) => {
				const answer = await ask(MAIN, prompt, schema)
				return { value: answer.value as never, toolCalls: answer.toolCalls ?? [] }
			},
		},
		context: { brief: BRIEF, foundation: null, existingPages: [] },
		approved: NOTHING_APPROVED,
		tasteTools: () => ({
			libraries: LIBRARIES.filter((l) => usable.has(l.id)).map((l) => ({ name: l.name, gives: l.gives, kind: l.kind })),
			viewTool: "caret_view_reference",
		}),
		ask: async (questions) => {
			console.log(`  QUESTIONS (${questions.length}):`)
			for (const q of questions) console.log(`    - [${q.habit}] "${q.quote}" — AI's reason: ${q.reason}`)
			return questions.map(() => "remove")
		},
		progress: (p) =>
			console.log(
				`[${Math.round((Date.now() - started) / 1000)}s] ${p.step} ${p.state}${p.detail ? ` · ${p.detail}` : ""}`,
			),
		onToolCalls: (calls) => {
			console.log(`  designer tool calls (${calls.length}):`)
			for (const c of calls)
				console.log(`    ${c.ok ? "ok " : "ERR"} ${c.tool}${c.error ? ` → ${c.error.slice(0, 140)}` : ""}`)
		},
	})

	console.log("\nREMOVED:")
	for (const r of result.removed) console.log(`  - [${r.habit}] "${r.was}" → ${r.action}${r.now ? `: ${r.now}` : ""}`)
	console.log("BANNED HABITS:", result.stats.bannedHabits.join(", ") || "none")
	console.log("KEPT:", result.kept.map((k) => `${k.item.names[0]} (${k.by})`).join(", ") || "none")
	console.log("REFERENCES:", JSON.stringify(result.references))
	console.log("COMPONENTS:", JSON.stringify(result.components))
	console.log("DECLINED:", JSON.stringify(result.declined))
	console.log("TIMINGS:", JSON.stringify(result.stats.timings), "total", Math.round((Date.now() - started) / 1000), "s")
	const out = path.join(os.tmpdir(), `caret-pass-result-${Date.now()}.json`)
	fs.writeFileSync(out, JSON.stringify({ result, build: buildInstructions(result.plan, result.removed, []) }, null, 1))
	console.log("full result:", out)
}

main()
	.catch((error) => {
		console.error(error)
		process.exitCode = 1
	})
	.finally(() => stopOpencodeServer())
