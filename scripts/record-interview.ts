/**
 * Records the interview's model answers for the scripted interviews, with a
 * live model, so the tests can replay them with no model.
 *
 *   CARET_VERIFY_MODEL=opencode-go/deepseek-v4.1-flash npx tsx scripts/record-interview.ts [script ...]
 *
 * Runs each script (src/core/design/interview/testing/scripts.ts) through the
 * interview engine and saves every request and answer to
 * test-fixtures/interview/<script>.json. A recording is only saved when the
 * script reached the finish; anything else is reported and nothing is written.
 *
 * Re-run this whenever the interview's instructions to the model change: the
 * tests refuse recordings made with different instructions.
 */
import * as child_process from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { OpencodeBackend } from "../src/core/design/agent/opencode"
import { stopOpencodeServer } from "../src/core/design/agent/opencode/server"
import { type Recording, RecordingBackend } from "../src/core/design/agent/replay"
import { InterviewSession } from "../src/core/design/interview/session"
import { runScript, SCRIPTS } from "../src/core/design/interview/testing/scripts"

const FIXTURES = path.resolve("test-fixtures/interview")

async function main(): Promise<void> {
	const model = process.env.CARET_VERIFY_MODEL?.trim()
	if (!model) throw new Error("Set CARET_VERIFY_MODEL (for example opencode-go/deepseek-v4.1-flash).")
	const names = process.argv.slice(2).length
		? process.argv.slice(2)
		: Object.keys(SCRIPTS).filter((n) => SCRIPTS[n].mode === "collaborative")
	const gitSha = child_process.execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim()
	fs.mkdirSync(FIXTURES, { recursive: true })
	const live = new OpencodeBackend()

	for (const name of names) {
		const script = SCRIPTS[name]
		if (!script) throw new Error(`No script called "${name}". Known: ${Object.keys(SCRIPTS).join(", ")}`)
		const temp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "caret-record-")), "recording.json")
		const meta: Omit<Recording, "format" | "calls"> = {
			recorded: { model, at: new Date().toISOString(), gitSha },
			script: name,
			mode: script.mode,
			description: script.description,
		}
		const backend = new RecordingBackend(live, temp, meta)
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "caret-record-project-"))
		const started = Date.now()
		console.log(`\n${name}: recording with ${model}`)
		const session = await InterviewSession.start(script.mode, script.description, {
			backend,
			workingDirectory: project,
			model,
			persist: async () => {},
			log: (line) => console.log(`  ${line.slice(0, 220)}`),
		})
		const end = await runScript(session, script, (view) => {
			if (view.phase === "question")
				console.log(`  question about ${view.question.area} (${view.question.options.length} options)`)
		})
		const seconds = Math.round((Date.now() - started) / 1000)
		if (end.phase !== "finish") {
			console.log(
				`  NOT SAVED: ended on the ${end.phase} screen${end.phase === "error" ? `: ${end.message}` : ""} (${seconds}s)`,
			)
			process.exitCode = 1
			continue
		}
		fs.copyFileSync(temp, path.join(FIXTURES, `${name}.json`))
		console.log(`  saved ${backend.calls.length} model calls to test-fixtures/interview/${name}.json (${seconds}s)`)
	}
}

main()
	.catch((err) => {
		console.error(err instanceof Error ? err.message : err)
		process.exitCode = 1
	})
	.finally(() => stopOpencodeServer().finally(() => process.exit()))
