/**
 * Stand-in page takes for the Experiment canvas, for development builds only.
 *
 * With `CARET_TEST_EXPLORE` set, each take is made by this stand-in instead of
 * an AI model: after a short wait it rewrites the take's own page (the copy
 * Caret already made of its parent) so the page lists every instruction on
 * the way to it, oldest first. A take branched from another therefore shows
 * its parent's whole chain plus its own step, which is how a test proves a
 * branch really started from the take it was grown from. Everything around
 * the take (copying, the lock, statuses, cancelling, picking) is Caret's own
 * code, unchanged. A packaged Caret ignores the setting.
 *
 * Words in an instruction make a take misbehave on purpose: `[[fail]]` fails
 * it, `[[slow]]` makes it take eight seconds.
 */
import * as fs from "fs/promises"
import * as path from "path"

import type { AgentConversation, RunOutcome, RunRequest } from "../../src/core/design/agent/conversation"
import { Logger } from "../../src/shared/services/Logger"

let announced = false

/** How long a stand-in take takes, or null when stand-in takes are off. */
export function testExploreDelay(env: NodeJS.ProcessEnv, isPackaged: boolean): number | null {
	if (isPackaged || !env.CARET_TEST_EXPLORE) return null
	if (!announced) {
		announced = true
		Logger.info("[explore] TEST EXPLORE: page takes are made by the stand-in, not an AI model")
	}
	const ms = Number(env.CARET_TEST_EXPLORE)
	return Number.isFinite(ms) && ms > 1 ? ms : 1500
}

const STEPS = /const STEPS = (\[.*\])/

function pageWith(steps: string[], takeId: string): string {
	const hue = [...takeId].reduce((sum, ch) => sum + ch.charCodeAt(0) * 7, 0) % 360
	return [
		`const STEPS = ${JSON.stringify(steps)}`,
		``,
		`export default function Page() {`,
		`\treturn (`,
		`\t\t<main className="min-h-screen p-16" style={{ background: "hsl(${hue} 55% 92%)" }}>`,
		`\t\t\t<h1 className="text-5xl font-semibold" data-test-take="${takeId}">Take ${takeId}</h1>`,
		`\t\t\t<ol className="mt-8 list-decimal pl-6 text-xl">`,
		`\t\t\t\t{STEPS.map((step) => (`,
		`\t\t\t\t\t<li key={step}>{step}</li>`,
		`\t\t\t\t))}`,
		`\t\t\t</ol>`,
		`\t\t</main>`,
		`\t)`,
		`}`,
		``,
	].join("\n")
}

export function fakeTakeConversation(projectPath: string, delayMs: number): AgentConversation {
	let aborted = false
	let wake: (() => void) | null = null
	const outcome = (ok: boolean): RunOutcome => ({ ok, sessionId: null, text: "", closingText: "", filesChanged: [] })
	const fake = {
		async run(request: RunRequest): Promise<RunOutcome> {
			const instruction = /INSTRUCTION: (.*)/.exec(request.prompt)?.[1]?.trim() ?? "(no instruction)"
			const file = typeof request.context?.filePath === "string" ? request.context.filePath : ""
			const wait = instruction.includes("[[slow]]") ? 8000 : delayMs
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, wait)
				wake = () => {
					clearTimeout(timer)
					resolve()
				}
			})
			if (aborted) return outcome(false)
			if (instruction.includes("[[fail]]") || !file) return outcome(false)
			const target = path.resolve(projectPath, file)
			const source = await fs.readFile(target, "utf8").catch(() => "")
			const before: string[] = (() => {
				try {
					return JSON.parse(STEPS.exec(source)?.[1] ?? "[]")
				} catch {
					return []
				}
			})()
			const takeId = path.basename(path.dirname(target))
			await fs.writeFile(target, pageWith([...before, instruction], takeId))
			return { ...outcome(true), filesChanged: [file] }
		},
		async abort(): Promise<void> {
			aborted = true
			wake?.()
		},
		async close(): Promise<void> {},
	}
	return fake as unknown as AgentConversation
}
