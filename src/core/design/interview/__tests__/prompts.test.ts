/**
 * What Caret tells the AI during the interview must not contradict what Caret
 * then checks.
 *
 * Field finding (2026-10-15): the interview's instructions listed "known-good"
 * fonts and colours, and six of those ten fonts were on Caret's own list of
 * overused AI defaults. The model recommended them, Caret rejected them, and
 * every font question cost an extra model call. The only place an overused
 * default may appear in the instructions is a line telling the model to avoid
 * it.
 *
 * Checked two ways: the instructions today's code builds, and every request
 * saved in the interview recordings (real requests from real runs).
 */
import { strict as assert } from "assert"
import * as fs from "fs"
import * as path from "path"

import type { CodingBackend, StructuredRequest } from "../../agent/backend"
import type { Recording } from "../../agent/replay"
import { commonValues } from "../../design-pass/foundation-check"
import { activeHabits } from "../../design-pass/slop-list"
import { nextWizardTurn } from "../conductor"

const DESCRIPTION = "Argus is an open-source monitoring tool for servers, with an AI investigator built in."
const RECORDINGS = path.resolve(__dirname, "../../../../../test-fixtures/interview")

/** Overused defaults named in the text, ignoring lines that tell the model to avoid them. */
function overusedDefaultsIn(text: string, userWords: string): string[] {
	const kept = text
		.split("\n")
		.filter((line) => !/^\s*[-*]?\s*(avoid|never offer|do not offer)\b/i.test(line))
		.join("\n")
	const fonts = [...new Set(activeHabits().flatMap((habit) => habit.fonts))].filter((font) =>
		new RegExp(`(^|[^A-Za-z])${font.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z]|$)`).test(kept),
	)
	const colours = kept.match(/#[0-9a-fA-F]{6}\b/g) ?? []
	return commonValues({ colours, fonts }, { words: userWords, colours: [], fonts: [] }).map((found) => found.value)
}

async function firstRequest(mode: "collaborative" | "from-app"): Promise<StructuredRequest> {
	let captured: StructuredRequest | undefined
	const backend = {
		id: "opencode",
		async structured(request: StructuredRequest) {
			captured = request
			throw new Error("captured")
		},
	} as unknown as CodingBackend
	await nextWizardTurn({ backend, workingDirectory: "/tmp/x", description: DESCRIPTION, history: [], mode }).catch(() => {})
	assert.ok(captured, "the interview made no model request")
	return captured
}

describe("the interview's instructions to the AI", () => {
	for (const mode of ["collaborative", "from-app"] as const) {
		it(`recommend no overused AI default (${mode})`, async () => {
			const request = await firstRequest(mode)
			const found = overusedDefaultsIn(`${request.systemPrompt ?? ""}\n${request.prompt}`, DESCRIPTION)
			assert.deepEqual(found, [], `the instructions name overused defaults outside an avoid line: ${found.join(", ")}`)
		})
	}

	it("recommend no overused AI default in any recorded real request", () => {
		const files = fs.existsSync(RECORDINGS) ? fs.readdirSync(RECORDINGS).filter((f) => f.endsWith(".json")) : []
		assert.ok(files.length > 0, `no interview recordings in ${RECORDINGS}`)
		for (const file of files) {
			const recording = JSON.parse(fs.readFileSync(path.join(RECORDINGS, file), "utf8")) as Recording
			for (const [i, call] of recording.calls.entries()) {
				// Only Caret's own words: the user's description and their typed answers are theirs to name anything in.
				const found = overusedDefaultsIn(call.systemPrompt ?? "", recording.description ?? "")
				assert.deepEqual(found, [], `${file}, request ${i + 1}: the instructions name ${found.join(", ")}`)
			}
		}
	})
})
