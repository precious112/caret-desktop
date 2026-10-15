/**
 * The avoid line the model is told and the check on its options must be the
 * same rule. If they ever disagree, the model is told one thing and punished
 * for another, which is the waste the field run showed.
 */
import { strict as assert } from "assert"

import type { AreaOption } from "../answers"
import { AREA_ORDER } from "../areas"
import { avoidListFor, flaggedOptions, isCheckedForDefaults, userChoicesFrom } from "../defaults"
import { applyAnswer, newRecord } from "../state"
import { openedRecord, questionFor, SAMPLE_OPTIONS } from "./paths"

const nobody = { words: "A monitoring tool.", colours: [], fonts: [] }

function option(area: (typeof AREA_ORDER)[number], value: Record<string, unknown>): AreaOption {
	return { id: JSON.stringify(value), label: "x", value: value as never }
}

describe("overused defaults", () => {
	it("everything on a topic's avoid line is flagged when offered, and the user's own choices never are", () => {
		for (const area of AREA_ORDER.filter(isCheckedForDefaults)) {
			const avoid = avoidListFor(area, nobody)
			assert.ok(avoid.length > 0, `${area} has an empty avoid line`)
			const isFont = area === "display-type" || area === "body-type"
			const offered = avoid.map((value) => option(area, isFont ? { family: value } : { hex: value }))
			assert.deepEqual(
				flaggedOptions(area, offered, nobody).sort(),
				offered.map((o) => o.id).sort(),
				`${area}: something on the avoid line was not flagged when offered`,
			)
			const theirs = { ...nobody, fonts: isFont ? avoid : [], colours: isFont ? [] : avoid }
			assert.deepEqual(flaggedOptions(area, offered, theirs), [], `${area}: the user's own choice was flagged`)
			assert.deepEqual(avoidListFor(area, theirs), [], `${area}: the user's own choice is on the avoid line`)
		}
	})

	it("the field-run offenders are on the font avoid line", () => {
		const avoid = avoidListFor("display-type", nobody)
		for (const font of ["Inter", "Geist", "Space Grotesk"]) assert.ok(avoid.includes(font), `${font} is missing`)
	})

	it("the test samples themselves contain no overused default, so tests never fail on their own data", () => {
		for (const area of AREA_ORDER) {
			const options = SAMPLE_OPTIONS[area].map((value, i) => ({ id: String(i), label: "x", value }))
			assert.deepEqual(
				flaggedOptions(area, options as AreaOption[], nobody),
				[],
				`${area} samples include an overused default`,
			)
		}
	})

	it("ordinary choices are not flagged", () => {
		const options = [option("display-type", { family: "Red Hat Display" }), option("display-type", { family: "Archivo" })]
		assert.deepEqual(flaggedOptions("display-type", options, nobody), [])
	})

	it("light/dark, greys, status colours, spacing, corners and depth are never checked", () => {
		for (const area of ["surface", "neutral", "semantics", "spacing", "radius", "depth"] as const) {
			assert.equal(isCheckedForDefaults(area), false)
			assert.deepEqual(avoidListFor(area, nobody), [])
		}
	})

	it("the user's words, corrections and typed values count as their choices", () => {
		let record = openedRecord("collaborative", ["surface"], ["surface"])
		record = { ...record, description: "We use Inter everywhere." }
		const question = questionFor("surface")
		record = applyAnswer(record, { area: "surface", questionId: question.id, via: "option", value: { surface: "dark" } })
		const choices = userChoicesFrom(record)
		assert.match(choices.words, /Inter everywhere/)
		assert.match(choices.words, /Not quite: surface/)
		assert.deepEqual(flaggedOptions("display-type", [option("display-type", { family: "Inter" })], choices), [])
		assert.deepEqual(userChoicesFrom(newRecord("from-app", "")).colours, [])
	})
})
