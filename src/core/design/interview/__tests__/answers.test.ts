/**
 * The answer rules shared by the screen and the engine.
 *
 * The screen builds answers with these functions and the engine checks them
 * with `acceptAnswer`. These tests hold the two to the same rules: whatever
 * the screen offers is accepted, a typed value Caret can't save is refused
 * with a reason before anything is saved, and an answer the screen did not
 * build honestly is refused by the engine.
 */
import { strict as assert } from "assert"

import { acceptAnswer, optionAnswer, ownAnswer, skipAnswer } from "../answers"
import { AREA_ORDER, AREAS, type AreaId, isAreaValue } from "../areas"
import { deriveState, InterviewRuleError } from "../state"
import { finishWithRecommendations, openedRecord, questionFor } from "./paths"

/** A record whose next question is about `area`, everything before it on its recommendation. */
function recordAt(area: AreaId) {
	let record = openedRecord("collaborative", [])
	while (deriveState(record).next !== area) {
		const next = deriveState(record).next as AreaId
		const question = questionFor(next)
		record = acceptAnswer(record, question, skipAnswer(question))
	}
	return record
}

describe("answers: what the screen builds is what the engine accepts", () => {
	it("every option on every topic is accepted with exactly that option's value", () => {
		for (const area of AREA_ORDER) {
			const record = recordAt(area)
			const question = questionFor(area)
			for (const option of question.options) {
				const answer = optionAnswer(question, option.id)
				assert.ok(answer)
				const after = acceptAnswer(record, question, answer)
				assert.deepEqual(deriveState(after).areas[area].value, option.value)
			}
		}
	})

	it("Skip is the recommendation, exactly", () => {
		for (const area of AREA_ORDER) {
			const question = questionFor(area, 1)
			const answer = skipAnswer(question)
			assert.equal(answer.via, "skip")
			assert.deepEqual(answer.value, question.options[1].value)
			acceptAnswer(recordAt(area), question, answer)
		}
	})

	it("an answer whose value was changed after it was built is refused", () => {
		const record = recordAt("brand-color")
		const question = questionFor("brand-color")
		const answer = optionAnswer(question, question.options[0].id)
		assert.ok(answer)
		assert.throws(() => acceptAnswer(record, question, { ...answer, value: { hex: "#000000" } }), InterviewRuleError)
		const skip = skipAnswer(question)
		assert.throws(() => acceptAnswer(record, question, { ...skip, value: { hex: "#000000" } }), InterviewRuleError)
	})

	it("an answer for a different question, or a topic with no typing box, or a fill-in from the screen, is refused", () => {
		const record = recordAt("surface")
		const question = questionFor("surface")
		const answer = optionAnswer(question, question.options[0].id)
		assert.ok(answer)
		assert.throws(() => acceptAnswer(record, question, { ...answer, questionId: "another" }), InterviewRuleError)
		assert.throws(() => acceptAnswer(record, question, { ...answer, via: "own" }), InterviewRuleError)
		assert.throws(() => acceptAnswer(record, question, { ...answer, via: "finish-now" }), InterviewRuleError)
	})

	it("typed sizes Caret can't save are refused on screen, with the reason", () => {
		const question = questionFor("type-scale")
		const cases: Array<[string, string, RegExp]> = [
			["22", "", /12 to 20px.*can't store 22px/],
			["11", "", /12 to 20px/],
			["16.5", "", /whole number/],
			["abc", "", /whole number/],
			["16", "1.6", /1.05 to 1.5/],
			["16", "1.04", /1.05 to 1.5/],
		]
		for (const [px, ratio, reason] of cases) {
			const result = ownAnswer(question, { kind: "size", px, ratio })
			assert.equal(result.kind, "refused", `${px}px ×${ratio} was not refused`)
			if (result.kind === "refused") assert.match(result.reason, reason)
		}
	})

	it("typed values at the edges are saved exactly as typed", () => {
		const question = questionFor("type-scale")
		for (const [px, ratio] of [
			["12", "1.05"],
			["20", "1.5"],
		]) {
			const result = ownAnswer(question, { kind: "size", px, ratio })
			assert.equal(result.kind, "answer")
			if (result.kind === "answer")
				assert.deepEqual(result.answer.value, { baseSize: Number(px), scaleRatio: Number(ratio) })
		}
	})

	it("a size with one box left blank keeps the selected option's number for it", () => {
		const question = questionFor("type-scale")
		const selected = question.options[3]
		const result = ownAnswer(question, { kind: "size", px: "", ratio: "1.4" }, selected.id)
		assert.equal(result.kind, "answer")
		if (result.kind === "answer") {
			assert.deepEqual(result.answer.value, {
				baseSize: (selected.value as { baseSize: number }).baseSize,
				scaleRatio: 1.4,
			})
		}
	})

	it("empty boxes mean the selected card is the answer, not an empty typed value", () => {
		assert.equal(ownAnswer(questionFor("type-scale"), { kind: "size", px: " ", ratio: "" }).kind, "empty")
		assert.equal(ownAnswer(questionFor("brand-color"), { kind: "hex", hex: "" }).kind, "empty")
		assert.equal(ownAnswer(questionFor("display-type"), { kind: "font", family: "  " }).kind, "empty")
		assert.equal(
			ownAnswer(questionFor("semantics"), { kind: "status-hexes", success: "", warning: "", error: "", info: "" }).kind,
			"empty",
		)
	})

	it("typed colours are tidied to #rrggbb, and anything else is refused with a reason", () => {
		const question = questionFor("brand-color")
		const ok = ownAnswer(question, { kind: "hex", hex: " #28A4F0 " })
		assert.equal(ok.kind, "answer")
		if (ok.kind === "answer") assert.deepEqual(ok.answer.value, { hex: "#28a4f0" })
		const short = ownAnswer(question, { kind: "hex", hex: "abc" })
		if (short.kind === "answer") assert.deepEqual(short.answer.value, { hex: "#aabbcc" })
		const bad = ownAnswer(question, { kind: "hex", hex: "blue" })
		assert.equal(bad.kind, "refused")
		const partStatus = ownAnswer(questionFor("semantics"), {
			kind: "status-hexes",
			success: "#00aa00",
			warning: "",
			error: "#aa0000",
			info: "#0000aa",
		})
		assert.equal(partStatus.kind, "refused")
		if (partStatus.kind === "refused") assert.match(partStatus.reason, /warning is empty/)
	})

	it("every typed answer the screen can build is one the engine accepts", () => {
		const typed: Array<[AreaId, Parameters<typeof ownAnswer>[1]]> = [
			["display-type", { kind: "font", family: "Libre Baskerville" }],
			["body-type", { kind: "font", family: "Literata" }],
			["type-scale", { kind: "size", px: "19", ratio: "1.3" }],
			["brand-color", { kind: "hex", hex: "#28a4f0" }],
			["secondary-color", { kind: "hex", hex: "#123456" }],
			["accent-color", { kind: "hex", hex: "#654321" }],
			["semantics", { kind: "status-hexes", success: "#00aa00", warning: "#aaaa00", error: "#aa0000", info: "#0000aa" }],
		]
		for (const [area, raw] of typed) {
			assert.ok(AREAS[area].ownInput, `${area} has no typing box but the test types into it`)
			const question = questionFor(area)
			const result = ownAnswer(question, raw)
			assert.equal(result.kind, "answer", `${area}: ${JSON.stringify(raw)}`)
			if (result.kind === "answer") {
				assert.ok(isAreaValue(area, result.answer.value))
				acceptAnswer(recordAt(area), question, result.answer)
			}
		}
	})

	it("a whole interview of recommendations is accepted end to end", () => {
		assert.equal(deriveState(finishWithRecommendations(openedRecord("collaborative", []))).stage, "ready")
	})
})
