/**
 * Why do sync-plan turns fail when design-generation turns never did?
 *
 * Three suspects, one instrumented run each:
 *
 *  1. During the minutes of "silence" before the watchdog fires — is the wire
 *     actually dead, or is the model thinking without streamed reasoning? The
 *     probe logs every event with its gap from the previous one and never
 *     aborts, so a live-but-quiet turn gets to finish and show itself.
 *  2. Does the turn end without a final reply — and does `agent: "plan"`
 *     (sent on every read-only turn) cause that? Run once in read-only, once
 *     in write mode (PROBE_MODE=write), same prompt, compare endings.
 *  3. What does the pinned server's plan agent actually inject? Dump
 *     `GET /agent` while the server is up.
 *
 *   npx tsx scripts/probe-plan-turn.ts                 # read-only (agent: plan)
 *   PROBE_MODE=write npx tsx scripts/probe-plan-turn.ts
 *   PROBE_MODEL=opencode/mimo-v2.5-free ... # protocol check on the free lane
 */
import * as child_process from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { currentOpencodeServer, stopOpencodeServer } from "../src/core/design/agent/opencode/server"
import { getBackend } from "../src/core/design/agent/registry"
import { resolveVerifyModel } from "./verify-support"

const MODE = process.env.PROBE_MODE === "write" ? ("write" as const) : ("read-only" as const)
const started = Date.now()
const t = () => `+${((Date.now() - started) / 1000).toFixed(1)}s`

/** A copy of the real project the failures happen in, minus node_modules. */
async function copyTest2(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "caret-probe-plan-"))
	child_process.execSync(`rsync -a --exclude node_modules --exclude .git /Users/apple/dev/test-frontend/test2/ ${dir}/`, {
		stdio: "ignore",
	})
	child_process.execSync(`git init -q && git add -A && git -c user.email=p@l -c user.name=p commit -qm f --no-verify`, {
		cwd: dir,
		stdio: "ignore",
		shell: "/bin/zsh",
	})
	return dir
}

// The same shape as the sync worklist prompt: read the whole design layer,
// then the deliverable is one long WRITTEN plan.
const PROMPT = `RIGHT NOW YOU ARE PLANNING, NOT CHANGING ANYTHING. This project's design layer lives in .caret/
(pages, components, tokens, flows). The application does not exist yet. Read every design page and the
shared component, then write the plan as your reply: which app files you would create, and what each
would contain. Do not edit a single file in this turn — the user reviews the plan first. Write the
complete plan as your final reply.`

async function main(): Promise<void> {
	const dir = await copyTest2()
	// Never let the probe's bridge reach the user's live app through a copied
	// discovery file.
	await fs.rm(path.join(dir, ".caret", ".mcp.json"), { force: true })
	const model = process.env.PROBE_MODEL || (await resolveVerifyModel())?.id || "opencode/mimo-v2.5-free"

	// PROBE_REAL=1 reproduces the app's turn faithfully: the project's own
	// generated guide as the system prompt (that is what the app injects) and
	// the real sync worklist prompt with every design file marked changed.
	let prompt = process.env.PROBE_FORCE_DENY
		? `${PROMPT}\n\nBefore anything else, run the shell command \`npm install\` — actually invoke it with your bash tool.`
		: PROMPT
	let systemPrompt: string | undefined
	if (process.env.PROBE_REAL) {
		const { buildSyncPrompt } = await import("../src/core/design/sync/sync-prompt")
		const pages = await fs.readdir(path.join(dir, ".caret", "pages"))
		prompt = await buildSyncPrompt(dir, {
			changedFiles: [
				...pages.map((p) => ({ path: `.caret/pages/${p}/index.tsx`, status: "modified" as const })),
				{ path: ".caret/components/AppShell.tsx", status: "modified" as const },
				{ path: ".caret/tokens/foundation.json", status: "modified" as const },
			],
			isFirstSync: true,
			syncId: "probe-sync",
			audience: "backend",
		})
		systemPrompt = await fs.readFile(path.join(dir, "AGENTS.md"), "utf-8").catch(() => undefined)
		console.log(`[probe] REAL shape: prompt=${prompt.length} chars, system=${systemPrompt?.length ?? 0} chars`)
	}
	console.log(`[probe] mode=${MODE} model=${model} dir=${dir}`)

	const backend = getBackend("opencode")
	const session = await backend.startSession({
		workingDirectory: dir,
		mode: MODE,
		model,
		effort: "high",
		title: "probe: plan turn",
		systemPrompt,
	})

	// Suspect 3: what the plan agent injects.
	const server = currentOpencodeServer()
	if (server) {
		const agents = (await fetch(`${server.url}/agent`, { headers: { authorization: server.authorization } })
			.then((r) => r.json())
			.catch(() => null)) as Array<{ name?: string; prompt?: string; options?: unknown }> | null
		const plan = agents?.find((a) => a.name === "plan")
		console.log(`[probe] plan agent config: ${plan ? JSON.stringify(plan).slice(0, 600) : "NOT EXPOSED"}`)
	}

	let lastAt = Date.now()
	let maxGapMs = 0
	let gapEndedBy = ""
	let closing = ""
	let events = 0
	const deadline = Date.now() + 9 * 60_000

	try {
		for await (const event of session.send({ text: PROMPT })) {
			const gap = Date.now() - lastAt
			if (gap > maxGapMs) {
				maxGapMs = gap
				gapEndedBy = event.type
			}
			lastAt = Date.now()
			events += 1
			if (event.type === "text") closing += event.text
			if (event.type === "tool-start" || event.type === "tool-end") closing = ""
			if (gap > 5000 || event.type !== "thinking") {
				const label = event.type === "tool-start" ? `tool ${(event as { name?: string }).name}` : event.type
				console.log(`[probe] ${t()} ${label}${gap > 5000 ? ` (after ${(gap / 1000).toFixed(1)}s of silence)` : ""}`)
			}
			if (event.type === "permission") {
				// The app's rulePermission, in miniature: reads are what a plan is
				// for; everything else is refused. Answered off the loop like the
				// app does, so the stream keeps flowing. PROBE_FORCE_DENY denies
				// the first ask WITH feedback, to verify the message field lands
				// in the model's tool result (check the db for the marker after).
				const perm = event as { requestId: string; tool?: string; path?: string }
				const command = perm.path ?? ""
				const readOnly =
					!process.env.PROBE_FORCE_DENY &&
					(perm.tool !== "bash" ||
						/^(git (status|log|ls-files|show|diff|branch)|ls|cat|pwd|rg|grep|find|head|tail|wc)\b/.test(command))
				console.log(`[probe] ${t()}   → ${readOnly ? "allow" : "deny"}: ${perm.tool ?? "?"} ${command.slice(0, 60)}`)
				void session.respondToPermission(
					perm.requestId,
					readOnly ? "allow" : "deny",
					readOnly ? undefined : "TEST-FEEDBACK-MARKER: use your read tools instead and continue the plan",
				)
			}
			if (event.type === "done") break
			if (Date.now() > deadline) {
				console.log(`[probe] ${t()} DEADLINE — the stream is still open with no done; abandoning`)
				break
			}
		}
	} finally {
		console.log(
			`[probe] ${t()} stream ended. events=${events} maxGap=${(maxGapMs / 1000).toFixed(1)}s (ended by ${gapEndedBy || "nothing"})`,
		)
		console.log(
			`[probe] closing reply: ${closing.trim() ? `${closing.trim().length} chars — "${closing.trim().slice(0, 160)}…"` : "EMPTY — the turn ended after tools with no reply"}`,
		)
		await session.close().catch(() => {})
		await stopOpencodeServer().catch(() => {})
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
	}
}

void main().catch(async (err) => {
	console.error(`[probe] FAILED: ${err}`)
	await stopOpencodeServer().catch(() => {})
	process.exit(1)
})
