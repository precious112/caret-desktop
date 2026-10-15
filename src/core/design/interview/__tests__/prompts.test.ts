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
import { AREA_ORDER } from "../areas"
import { nextWizardTurn } from "../conductor"
import { avoidListFor, userChoicesFrom } from "../defaults"
import { areaSystemPrompt, areaUserPrompt, fillSystemPrompt, openingSystemPrompt, proseSystemPrompt } from "../model-calls"
import { newRecord } from "../state"
import { openedRecord } from "./paths"

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

describe("the rebuilt interview's instructions to the AI", () => {
	const record = openedRecord("collaborative", ["surface"])
	const system: Array<[string, string]> = [
		...AREA_ORDER.map((area) => [`question about ${area}`, areaSystemPrompt(area)] as [string, string]),
		["opening (from a description)", openingSystemPrompt(newRecord("collaborative", DESCRIPTION))],
		["opening (reading an app)", openingSystemPrompt(newRecord("from-app", DESCRIPTION))],
		["Just finish it", fillSystemPrompt()],
		["the finish's words", proseSystemPrompt()],
	]

	it("recommend no overused AI default anywhere except the avoid line", () => {
		for (const [name, text] of system) {
			assert.deepEqual(overusedDefaultsIn(text, ""), [], `${name}: the instructions name overused defaults`)
		}
		for (const area of AREA_ORDER) {
			const prompt = areaUserPrompt(record, area)
			assert.deepEqual(
				overusedDefaultsIn(prompt, DESCRIPTION),
				[],
				`the request about ${area} names overused defaults outside its avoid line`,
			)
		}
	})

	it("tell the model to avoid exactly what the check then refuses", () => {
		for (const area of AREA_ORDER) {
			const prompt = areaUserPrompt(record, area)
			const line = prompt.split("\n").find((l) => l.startsWith("Avoid"))
			const expected = avoidListFor(area, userChoicesFrom(record))
			if (!expected.length) {
				assert.equal(line, undefined, `${area} has an avoid line but nothing is checked`)
				continue
			}
			assert.ok(line, `${area} is checked for overused defaults but its request has no avoid line`)
			assert.deepEqual(
				line
					.replace(/^[^:]*:\s*/, "")
					.split(", ")
					.sort(),
				[...expected].sort(),
			)
		}
	})

	it("stay short: one job per call, no reference lists", () => {
		for (const [name, text] of system) {
			const limit = name.startsWith("opening") ? 3500 : 2500
			assert.ok(text.length <= limit, `${name}: ${text.length} characters, over ${limit}`)
		}
		for (const area of AREA_ORDER) {
			const prompt = areaUserPrompt(record, area).replace(DESCRIPTION, "")
			assert.ok(prompt.length <= 1500, `the request about ${area} is ${prompt.length} characters without the description`)
		}
	})

	it("never contain the rules that contradicted each other", () => {
		const banned = [
			/may not decide anything silently/i,
			/known-good/i,
			/never settle values/i,
			/tag every question/i,
			/covers/i,
		]
		for (const [name, text] of system) {
			for (const phrase of banned) assert.doesNotMatch(text, phrase, `${name} contains "${phrase.source}"`)
		}
	})
})
