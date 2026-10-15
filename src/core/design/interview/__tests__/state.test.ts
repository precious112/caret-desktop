/**
 * The interview's record and what is worked out from it, walked through every
 * path a person can take. After every single step the rules in `paths.ts`
 * must hold: no topic twice, each answer settles exactly its topic, the next
 * question is always the first unsettled topic, Covering and So far match
 * the answers, and the final values (and the saved foundation) carry every
 * answer unchanged.
 */
import { strict as assert } from "assert"

import { AREA_ORDER, type AreaId } from "../areas"
import { applyAnswer, deriveState, type InterviewRecord, InterviewRuleError, newRecord, stepBack } from "../state"
import {
	answerNext,
	type Choice,
	checkRules,
	finishWithRecommendations,
	OWN_VALID,
	openedRecord,
	questionFor,
	SAMPLE_OPTIONS,
	seeded,
} from "./paths"

const CONFIRMABLE: AreaId[] = ["surface", "neutral", "semantics", "radius", "depth"]

/** Every subset of a list. */
function subsets<T>(items: T[]): T[][] {
	return items.reduce<T[][]>((all, item) => all.concat(all.map((set) => [...set, item])), [[]])
}

describe("the interview record: every path", () => {
	it("starts on the opening screen and asks nothing until it is answered", () => {
		const record = newRecord("collaborative", "A product.")
		checkRules(record)
		assert.equal(deriveState(record).stage, "opening")
		assert.throws(
			() => applyAnswer(record, { area: "surface", questionId: "q", via: "option", value: { surface: "dark" } }),
			InterviewRuleError,
		)
	})

	it("every option, skip, None and typed value on every topic, with everything else on its recommendation", () => {
		for (const area of AREA_ORDER) {
			const choices: Choice[] = [
				...SAMPLE_OPTIONS[area].map((_, index) => ({ via: "option", index }) as Choice),
				{ via: "skip" },
				...(OWN_VALID[area] ?? []).map((raw) => ({ via: "own", raw }) as Choice),
			]
			for (const choice of choices) {
				let record = openedRecord("collaborative", [])
				while (deriveState(record).next) {
					const before = record
					const step = answerNext(record, deriveState(record).next === area ? choice : { via: "skip" })
					record = step.record
					checkRules(record, before, step.answer.area)
				}
				assert.equal(deriveState(record).stage, "ready")
			}
		}
	})

	it("every combination of agreeing and correcting the opening screen, starting from a description", () => {
		for (const shown of subsets(CONFIRMABLE)) {
			for (const corrected of subsets(shown)) {
				const record = openedRecord("collaborative", shown, corrected)
				checkRules(record)
				const state = deriveState(record)
				for (const area of shown) {
					const expected = corrected.includes(area) ? "open" : "confirmed"
					assert.equal(
						state.areas[area].status,
						expected,
						`${area} after ${corrected.includes(area) ? "a correction" : "agreeing"}`,
					)
					if (corrected.includes(area)) assert.match(state.areas[area].correction ?? "", /Not quite/)
				}
				checkRules(finishWithRecommendations(record))
			}
		}
	})

	it("from a description, an opening line about a font, colour, size or spacing never settles it", () => {
		const record = openedRecord("collaborative", ["display-type", "brand-color", "type-scale", "spacing", "surface"])
		const state = deriveState(record)
		for (const area of ["display-type", "brand-color", "type-scale", "spacing"] as const) {
			assert.equal(state.areas[area].status, "open", `${area} was settled by the opening screen`)
		}
		assert.equal(state.areas.surface.status, "confirmed")
		checkRules(finishWithRecommendations(record))
	})

	it("reading an app, any topic can be settled on the opening screen, and a correction reopens just that one", () => {
		for (const corrected of [[], ...AREA_ORDER.map((area) => [area])] as AreaId[][]) {
			const record = openedRecord("from-app", [...AREA_ORDER], corrected)
			checkRules(record)
			const state = deriveState(record)
			assert.deepEqual(state.next ? [state.next] : [], corrected, "the wrong topics were left open")
			assert.equal(state.position.total, corrected.length)
			checkRules(finishWithRecommendations(record))
		}
	})

	it("Back from every position, then the same answer again, gives the same result", () => {
		const full = finishWithRecommendations(openedRecord("collaborative", ["surface", "neutral"]))
		for (let k = 1; k <= full.answers.length; k++) {
			let record = full
			for (let i = 0; i < k; i++) {
				record = stepBack(record)
				checkRules(record)
			}
			assert.equal(record.answers.length, full.answers.length - k)
			for (const answer of full.answers.slice(full.answers.length - k)) {
				const before = record
				record = applyAnswer(record, answer)
				checkRules(record, before, answer.area)
			}
			assert.deepEqual(deriveState(record), deriveState(full))
		}
	})

	it("Back and a different answer changes only that topic", () => {
		const full = finishWithRecommendations(openedRecord("collaborative", []))
		const back = stepBack(full)
		const changed = answerNext(back, { via: "option", index: 1 }).record
		checkRules(changed, back, full.answers.at(-1)?.area)
		const area = full.answers.at(-1)?.area as AreaId
		assert.notDeepEqual(deriveState(changed).areas[area].value, deriveState(full).areas[area].value)
		for (const other of AREA_ORDER.filter((a) => a !== area)) {
			assert.deepEqual(deriveState(changed).areas[other].value, deriveState(full).areas[other].value)
		}
	})

	it("Back past the first question reopens the opening screen with nothing lost", () => {
		const record = openedRecord("collaborative", ["surface"])
		const reopened = stepBack(record)
		assert.equal(deriveState(reopened).stage, "opening")
		assert.equal(reopened.opening?.statements.length, 1)
	})

	it("an answer for any topic but the next is refused", () => {
		const record = openedRecord("collaborative", [])
		for (const area of AREA_ORDER.slice(1)) {
			const question = questionFor(area)
			assert.throws(
				() =>
					applyAnswer(record, {
						area,
						questionId: question.id,
						via: "option",
						value: question.options[0].value,
					}),
				InterviewRuleError,
				`an answer about ${area} was accepted while ${deriveState(record).next} was on screen`,
			)
		}
	})

	it("an answer with a value the topic doesn't allow is refused", () => {
		const record = openedRecord("collaborative", [])
		const bad = [{ surface: "grey" }, { surface: "dark", extra: 1 }, {}, { family: "x" }]
		for (const value of bad) {
			assert.throws(
				() => applyAnswer(record, { area: "surface", questionId: "q", via: "option", value: value as never }),
				InterviewRuleError,
			)
		}
	})

	it("300 random mixes of answers, skips, typed values and Back keep every rule", () => {
		const random = seeded(20261015)
		for (let walk = 0; walk < 300; walk++) {
			const mode = random() < 0.5 ? "collaborative" : "from-app"
			const pool: AreaId[] = mode === "from-app" ? [...AREA_ORDER] : CONFIRMABLE
			const shown = pool.filter(() => random() < 0.5)
			const corrected = shown.filter(() => random() < 0.3)
			let record: InterviewRecord = openedRecord(mode, shown, corrected)
			checkRules(record)
			for (let step = 0; step < 40 && deriveState(record).next; step++) {
				const roll = random()
				if (roll < 0.15 && record.answers.length) {
					record = stepBack(record)
					checkRules(record)
					continue
				}
				const area = deriveState(record).next as AreaId
				const own = OWN_VALID[area] ?? []
				const choice: Choice =
					roll < 0.35
						? { via: "skip" }
						: roll < 0.55 && own.length
							? { via: "own", raw: own[Math.floor(random() * own.length)] }
							: { via: "option", index: Math.floor(random() * 4) }
				const before = record
				const result = answerNext(record, choice)
				record = result.record
				checkRules(record, before, result.answer.area)
			}
			checkRules(finishWithRecommendations(record))
		}
	})
})
