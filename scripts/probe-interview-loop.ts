/**
 * The whole foundation interview, turn by turn, on a real model, with nobody
 * at the screen: every question is answered with its recommendation, until
 * the model finishes or the turn cap forces it. Reports each turn's time,
 * retries and rejection reasons, and catches the one failure no log shows — a
 * turn that sits forever because the model called OpenCode's own `question`
 * tool, which waits for a human Caret never shows it to (field report: Argus,
 * glm-5.3-flash, 12 minutes stuck).
 *
 *   CARET_VERIFY_MODEL=opencode-go/glm-5.3-flash npx tsx scripts/probe-interview-loop.ts [project] [runs]
 *
 * `project` defaults to a fresh folder; pass one to load its AGENTS.md the
 * way the app does. `runs` is how many whole interviews to drive (default 1).
 */
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import type { StructuredRequest } from "../src/core/design/agent/backend"
import { OpencodeBackend } from "../src/core/design/agent/opencode"
import { request } from "../src/core/design/agent/opencode/http"
import { currentOpencodeServer, stopOpencodeServer } from "../src/core/design/agent/opencode/server"
import { nextWizardTurn } from "../src/core/design/interview/conductor"
import type { StoredQA, WizardAnswer, WizardQuestion } from "../src/core/design/interview/widgets"

const MODEL = process.env.CARET_VERIFY_MODEL ?? "opencode-go/glm-5.3-flash"
/** A probe needs a verdict; the product has no time limit. */
const STUCK_MS = 10 * 60_000

const DESCRIPTION = `Argus is an open-source monitoring tool for servers and applications, with an AI investigator built in. You run it on your own infrastructure with one Docker command, then add its SDK to your apps (Python and Node.js, about two lines of code). Argus watches system metrics, Docker containers and processes in real time. When something looks wrong, it doesn't just send an alert: it investigates. It correlates metrics, logs and events, finds the likely root cause, and explains it in plain language. Alerts go to Slack, email or webhooks, with suppression windows and escalation policies. It also scans for known vulnerabilities (CVEs) and keeps an audit log. It works with your own OpenAI, Anthropic or Gemini key. It's free and MIT licensed, with every feature included, and your data never leaves your servers. Brand colour: #28A4F0 (from the logo).`

function answerFor(q: WizardQuestion): WizardAnswer {
	const base = { questionId: q.id, question: q.question, kind: q.kind }
	const options = q.options ?? []
	const pick = options.find((o) => o.id === q.recommendedId) ?? options[0]
	switch (q.kind) {
		case "assumptions":
			return { ...base, value: options.map((o) => `${o.id}=yes`).join("\n") }
		case "color":
			return {
				...base,
				value: pick?.hex ?? pick?.id ?? "",
				label: pick?.label,
				data: pick?.hex ? { hex: pick.hex } : { none: true },
			}
		case "font":
			return { ...base, value: pick?.label ?? "", label: pick?.label, data: pick ? { family: pick.label } : undefined }
		case "chips":
			return {
				...base,
				value: options
					.slice(0, 2)
					.map((o) => o.id)
					.join(","),
			}
		case "text":
			return { ...base, value: "Plain and precise." }
		case "scale": {
			const steps = q.steps ?? []
			const step = steps[q.defaultStep ?? Math.floor(steps.length / 2)] ?? steps[0]
			return { ...base, value: step?.label ?? "middle", label: step?.label }
		}
		default:
			return { ...base, value: pick?.id ?? "", label: pick?.label }
	}
}

async function pendingQuestions(directory: string): Promise<string> {
	const server = currentOpencodeServer()
	if (!server) return "(no server)"
	const list = await request<unknown[]>(server, "/question", { query: { directory } }).catch((e) => [`(list failed: ${e})`])
	return JSON.stringify(list).slice(0, 600)
}

async function interview(run: number, dir: string): Promise<{ turns: number; stuck: number; failed: number; finished: boolean }> {
	const backend = new OpencodeBackend()
	// Watch every structured call: which tools it asked for, how long it took.
	const structured = backend.structured.bind(backend)
	backend.structured = async <T>(req: StructuredRequest) => {
		const result = await structured<T>(req)
		const calls = (result.toolCalls ?? []).map((c) => `${c.tool}${c.ok ? "" : "!"}`)
		if (calls.length) console.log(`      tools used: ${calls.join(", ")}`)
		return result
	}
	const history: StoredQA[] = []
	let stuck = 0
	let failed = 0
	for (let turn = 1; turn <= 14; turn++) {
		const started = Date.now()
		const rejections: string[] = []
		let attempts = 0
		const timer = new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), STUCK_MS))
		const result = await Promise.race([
			nextWizardTurn({
				backend,
				workingDirectory: dir,
				model: MODEL,
				description: DESCRIPTION,
				history,
				mode: "collaborative",
				onAttempt: (a) => {
					attempts = a
				},
			}).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })),
			timer,
		])
		const seconds = Math.round((Date.now() - started) / 1000)
		if (result === "stuck") {
			// Not a hang verdict by itself: the log says whether the model was still answering.
			stuck += 1
			console.log(
				`  [${run}.${turn}] STUCK after ${seconds}s on attempt ${attempts}. Pending OpenCode questions: ${await pendingQuestions(dir)}`,
			)
			return { turns: turn, stuck, failed, finished: false }
		}
		if ("error" in result) {
			failed += 1
			console.log(`  [${run}.${turn}] FAILED after ${seconds}s, ${attempts} attempt(s): ${result.error.slice(0, 300)}`)
			return { turns: turn, stuck, failed, finished: false }
		}
		if (result.action === "finish") {
			console.log(
				`  [${run}.${turn}] FINISH in ${seconds}s (${attempts} attempt(s)): ${result.foundation.displayFamily}/${result.foundation.bodyFamily}, brand ${result.foundation.brand}`,
			)
			return { turns: turn, stuck, failed, finished: true }
		}
		const q = result.question
		console.log(
			`  [${run}.${turn}] ${q.kind} ${JSON.stringify(q.covers ?? [])} in ${seconds}s (${attempts} attempt(s)), ${q.options?.length ?? q.steps?.length ?? 0} options: ${(q.options ?? []).map((o) => o.label.slice(0, 28)).join(" | ")}${rejections.length ? ` | rejected: ${rejections.join("; ")}` : ""}`,
		)
		history.push({ question: q, answer: answerFor(q) })
	}
	return { turns: 14, stuck, failed, finished: false }
}

async function main(): Promise<void> {
	const source = process.argv[2]
	const runs = Number(process.argv[3] ?? 1)
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caret-interview-"))
	if (source) {
		// The app's interview runs in the project folder, so the backend loads its AGENTS.md.
		for (const file of ["AGENTS.md", path.join(".caret", "AGENTS.md")]) {
			const from = path.join(source, file)
			if (fs.existsSync(from)) {
				fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
				fs.copyFileSync(from, path.join(dir, file))
			}
		}
	}
	console.log(`model ${MODEL}, folder ${dir}${source ? ` (AGENTS.md from ${source})` : ""}`)
	const totals = { stuck: 0, failed: 0, finished: 0 }
	for (let run = 1; run <= runs; run++) {
		console.log(`interview ${run}:`)
		const outcome = await interview(run, dir)
		totals.stuck += outcome.stuck
		totals.failed += outcome.failed
		if (outcome.finished) totals.finished += 1
	}
	console.log(`\n${totals.finished}/${runs} interviews finished; ${totals.stuck} stuck, ${totals.failed} failed.`)
}

main()
	.catch((error) => {
		console.error(error)
		process.exitCode = 1
	})
	// Exit outright: a turn abandoned as stuck still holds open requests, which
	// would otherwise keep this process alive for hours after the report.
	.finally(() => stopOpencodeServer().finally(() => process.exit()))
