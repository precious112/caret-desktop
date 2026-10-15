/**
 * The recorded interviews, replayed through the engine word for word.
 *
 * Each recording in test-fixtures/interview was made by running a script
 * (testing/scripts.ts) against a live model. Replaying it checks that today's
 * code makes exactly the same requests (same instructions, same wording) and
 * handles the model's real answers: every rule holds on every screen, every
 * recorded answer is used, and the finish carries what the script chose.
 *
 * When the instructions change, the recordings no longer match and this fails
 * with the line that changed. That is on purpose: an answer recorded for
 * different instructions proves nothing. Re-record with
 *   CARET_VERIFY_MODEL=opencode-go/deepseek-v4.1-flash npx tsx scripts/record-interview.ts
 */
import { strict as assert } from "assert"
import * as fs from "fs"
import * as path from "path"

import { type Recording, ReplayBackend } from "../../agent/replay"
import { InterviewSession } from "../session"
import { runScript, SCRIPTS } from "../testing/scripts"
import { checkRules } from "./paths"

const FIXTURES = path.resolve(__dirname, "../../../../../test-fixtures/interview")

function recordings(): Array<{ file: string; recording: Recording }> {
	if (!fs.existsSync(FIXTURES)) return []
	return fs
		.readdirSync(FIXTURES)
		.filter((file) => file.endsWith(".json"))
		.map((file) => ({ file, recording: JSON.parse(fs.readFileSync(path.join(FIXTURES, file), "utf8")) as Recording }))
		.filter(({ recording }) => recording.format === 2)
}

describe("recorded interviews, replayed word for word", () => {
	const found = recordings()

	it("there is a recording for every scripted interview", () => {
		const scripts = Object.values(SCRIPTS).map((s) => s.name)
		const recorded = found.map((r) => r.recording.script)
		for (const name of scripts) assert.ok(recorded.includes(name), `no recording for the "${name}" script in ${FIXTURES}`)
	})

	for (const { file, recording } of found) {
		it(`${file}: the same requests, every rule on every screen, every answer used`, async () => {
			const script = recording.script ? SCRIPTS[recording.script] : undefined
			assert.ok(script, `${file} names no known script`)
			const backend = new ReplayBackend(recording)
			let session: InterviewSession | null = null
			// Reading an app, the description is what Caret detected; the recording keeps it.
			const description = script.mode === "from-app" ? (recording.description ?? "") : script.description
			session = await InterviewSession.start(script.mode, description, {
				backend,
				workingDirectory: "/tmp/replayed-project",
				persist: async () => {},
			})
			const end = await runScript(session, script, () => checkRules((session as InterviewSession).saved.record))
			assert.equal(
				end.phase,
				"finish",
				`the replay ended on the ${end.phase} screen${end.phase === "error" ? `: ${end.message}` : ""}`,
			)
			assert.equal(
				backend.served,
				recording.calls.length,
				`today's code made ${backend.served} model calls; the recording has ${recording.calls.length}. The interview's behaviour changed: re-record.`,
			)
			if (end.phase !== "finish") return
			const typedBrand = script.steps?.["brand-color"]
			if (typedBrand && "own" in typedBrand && typedBrand.own.kind === "hex") {
				assert.equal(end.proposal.brand, typedBrand.own.hex, "the typed brand colour did not reach the finish")
			}
			assert.equal(end.proposal.decisions?.length, 12)
		})
	}
})
