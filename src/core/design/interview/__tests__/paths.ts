/**
 * Test helpers: sample questions for every topic, a way to answer the next
 * question the way a person would, and the rules that must hold after every
 * step. Not a test file itself; the interview tests import it.
 *
 * The rules are checked against an independent reading of the record (the
 * expectations below are written out here, not taken from the code under
 * test), so a mistake in the shared code can't hide by agreeing with itself.
 */
import { strict as assert } from "assert"
import { closeMatch, parseHex } from "../../design-pass/colour"
import { type AreaQuestion, acceptAnswer, type OwnRaw, optionAnswer, ownAnswer, skipAnswer } from "../answers"
import { AREA_ORDER, AREAS, type AreaId, type AreaValue, describeValue } from "../areas"
import { finalizeProposal } from "../finalize"
import {
	type AreaAnswer,
	applyOpening,
	deriveState,
	type InterviewMode,
	type InterviewRecord,
	newRecord,
	type OpeningStatement,
	type Verdict,
} from "../state"

/** Options a model might offer for each topic. Fixed-value topics use their fixed values. */
export const SAMPLE_OPTIONS: { [A in AreaId]: AreaValue<A>[] } = {
	surface: [{ surface: "dark" }, { surface: "light" }],
	"display-type": [{ family: "Red Hat Display" }, { family: "Archivo" }, { family: "Chakra Petch" }],
	"body-type": [{ family: "Public Sans" }, { family: "Atkinson Hyperlegible" }],
	"type-scale": [
		{ baseSize: 16, scaleRatio: 1.125 },
		{ baseSize: 16, scaleRatio: 1.2 },
		{ baseSize: 16, scaleRatio: 1.25 },
		{ baseSize: 17, scaleRatio: 1.333 },
	],
	"brand-color": [{ hex: "#1d7ec4" }, { hex: "#0f6e5a" }, { hex: "#5b47c4" }],
	"secondary-color": [{ hex: "#3e4c6b" }, { hex: "#8a6d3b" }, { none: true }],
	"accent-color": [{ hex: "#b0413e" }, { hex: "#c9a227" }, { none: true }],
	neutral: [{ neutral: "cool" }, { neutral: "true" }, { neutral: "warm" }],
	semantics: [
		{ success: "#2e9e5b", warning: "#d99a1e", error: "#d9453b", info: "#3b82c4" },
		{ success: "#4f8f6a", warning: "#b8913f", error: "#b85a52", info: "#5b7fa6" },
	],
	spacing: [{ spacingUnit: 4 }, { spacingUnit: 8 }],
	radius: [
		{ radiusCharacter: "sharp" },
		{ radiusCharacter: "soft" },
		{ radiusCharacter: "round" },
		{ radiusCharacter: "pill" },
	],
	depth: [{ elevation: "flat" }, { elevation: "subtle" }, { elevation: "pronounced" }],
}

/** Valid things to type into each topic's own-answer box, at the edges of what Caret can save. */
export const OWN_VALID: Partial<Record<AreaId, OwnRaw[]>> = {
	"display-type": [{ kind: "font", family: "Libre Baskerville" }],
	"body-type": [{ kind: "font", family: "Literata" }],
	"type-scale": [
		{ kind: "size", px: "12", ratio: "1.05" },
		{ kind: "size", px: "20", ratio: "1.5" },
		{ kind: "size", px: "18", ratio: "" },
	],
	"brand-color": [
		{ kind: "hex", hex: "#28A4F0" },
		{ kind: "hex", hex: "abc" },
	],
	"secondary-color": [{ kind: "hex", hex: "#112233" }],
	"accent-color": [{ kind: "hex", hex: "#445566" }],
	semantics: [{ kind: "status-hexes", success: "#00aa00", warning: "#aaaa00", error: "#aa0000", info: "#0000aa" }],
}

let questionCounter = 0

/** A question about `area` as the engine would show it; the recommendation is the first option. */
export function questionFor<A extends AreaId>(area: A, recommended = 0): AreaQuestion<A> {
	const options = (SAMPLE_OPTIONS[area] as AreaValue<A>[]).map((value, i) => ({
		id: `${area}-${i}`,
		label: describeValue(area, value),
		reason: `reason ${i}`,
		value,
	}))
	return {
		id: `q${++questionCounter}-${area}`,
		area,
		input: AREAS[area].input,
		question: `About ${AREAS[area].label}?`,
		options,
		recommendedId: options[Math.min(recommended, options.length - 1)].id,
		contextKey: "test",
	}
}

export type Choice = { via: "option"; index: number } | { via: "skip" } | { via: "own"; raw: OwnRaw }

/** Answers the question about the next topic, as the screen would, and returns the new record. */
export function answerNext(record: InterviewRecord, choice: Choice): { record: InterviewRecord; answer: AreaAnswer } {
	const area = deriveState(record).next
	assert.ok(area, "answerNext called with no topic left to ask")
	const question = questionFor(area)
	let answer: AreaAnswer | null
	if (choice.via === "option") answer = optionAnswer(question, question.options[choice.index % question.options.length].id)
	else if (choice.via === "skip") answer = skipAnswer(question)
	else {
		const result = ownAnswer(question, choice.raw)
		assert.equal(result.kind, "answer", `typing ${JSON.stringify(choice.raw)} about ${area} was not accepted`)
		answer = result.kind === "answer" ? result.answer : null
	}
	assert.ok(answer)
	return { record: acceptAnswer(record, question, answer), answer }
}

// ── an independent reading of the record ───────────────────────────────────

/** From a description, only these can be settled on the opening screen. Written out, not imported. */
const CONFIRMABLE_FROM_DESCRIPTION: ReadonlySet<AreaId> = new Set(["surface", "neutral", "semantics", "radius", "depth"])

/** What each topic is settled to, read straight from the record. */
export function expectedSettled(record: InterviewRecord): Map<AreaId, AreaValue> {
	const settled = new Map<AreaId, AreaValue>()
	const verdicts = record.opening?.verdicts
	if (verdicts) {
		for (const statement of record.opening?.statements ?? []) {
			const verdict = verdicts.find((v) => v.statementId === statement.id)
			const allowed = record.mode === "from-app" || CONFIRMABLE_FROM_DESCRIPTION.has(statement.area)
			if (verdict?.verdict === "confirmed" && allowed) settled.set(statement.area, statement.value)
		}
	}
	for (const answer of record.answers) settled.set(answer.area, answer.value)
	// An agreed supporting or accent colour that is the brand's (or the supporting colour's) twin is not settled.
	const hexOf = (area: AreaId) => (settled.get(area) as { hex?: string } | undefined)?.hex
	const near = (a?: string, b?: string) => {
		const x = a ? parseHex(a) : null
		const y = b ? parseHex(b) : null
		return !!x && !!y && closeMatch(x, y) !== null
	}
	const answered = new Set(record.answers.map((a) => a.area))
	if (!answered.has("secondary-color") && near(hexOf("secondary-color"), hexOf("brand-color")))
		settled.delete("secondary-color")
	if (
		!answered.has("accent-color") &&
		(near(hexOf("accent-color"), hexOf("brand-color")) || near(hexOf("accent-color"), hexOf("secondary-color")))
	) {
		settled.delete("accent-color")
	}
	return settled
}

/**
 * The rules that must hold after every step. `before` is the record before the
 * step and `answered` the topic the step answered, when it answered one.
 */
export function checkRules(record: InterviewRecord, before?: InterviewRecord, answered?: AreaId): void {
	const state = deriveState(record)
	const settled = expectedSettled(record)
	const openingDone = record.opening?.verdicts !== undefined

	// No topic is answered twice.
	const areas = record.answers.map((a) => a.area)
	assert.equal(new Set(areas).size, areas.length, `a topic was answered twice: ${areas.join(", ")}`)

	// Each answer completes exactly its own topic.
	if (before && answered) {
		const was = expectedSettled(before)
		const added = [...settled.keys()].filter((area) => !was.has(area))
		assert.deepEqual(added, [answered], `answering ${answered} settled ${added.join(", ") || "nothing"}`)
	}

	// The next question is the first topic not yet settled, in the fixed order.
	const firstOpen = AREA_ORDER.find((area) => !settled.has(area)) ?? null
	assert.equal(state.next, openingDone ? firstOpen : null, "the next topic is not the first unsettled one")
	assert.equal(state.stage, !openingDone ? "opening" : firstOpen ? "asking" : "ready")

	// From a description, fonts, colours, sizes and spacing are only ever settled by their own question.
	if (record.mode === "collaborative") {
		for (const area of AREA_ORDER) {
			if (CONFIRMABLE_FROM_DESCRIPTION.has(area) || !settled.has(area)) continue
			assert.ok(
				record.answers.some((a) => a.area === area),
				`${area} was settled without its own question`,
			)
		}
	}

	// Covering and So far show exactly the settled topics, with their values.
	for (const row of state.coverage) assert.equal(row.done, settled.has(row.area), `Covering is wrong about ${row.area}`)
	assert.deepEqual(
		state.soFar.map((row) => [row.area, row.text]),
		AREA_ORDER.filter((area) => settled.has(area)).map((area) => [area, describeValue(area, settled.get(area) as AreaValue)]),
		"So far does not match what was settled",
	)
	// The preview's colour is the brand, never the supporting or accent colour.
	const brand = settled.get("brand-color") as { hex: string } | undefined
	assert.equal(state.spec.accent, brand?.hex, "the preview shows a colour that is not the brand")

	// Every topic counted once: confirmed ones aren't asked, the rest are.
	const confirmedCount = AREA_ORDER.filter((area) => settled.has(area) && !record.answers.some((a) => a.area === area)).length
	assert.equal(state.position.total, 12 - confirmedCount)

	// The final values exist only when everything is settled, and carry every value exactly.
	if (!openingDone || firstOpen) {
		assert.equal(state.values, null, "final values exist before every topic is settled")
		return
	}
	assert.ok(state.values, "every topic is settled but there are no final values")
	checkValuesSurviveSaving(settled, state.values)
}

/** The final values, and the saved foundation built from them, carry every settled value unchanged. */
export function checkValuesSurviveSaving(
	settled: Map<AreaId, AreaValue>,
	values: NonNullable<ReturnType<typeof deriveState>["values"]>,
): void {
	const get = <A extends AreaId>(area: A) => settled.get(area) as AreaValue<A>
	const secondary = get("secondary-color")
	const accent = get("accent-color")
	assert.equal(values.surface, get("surface").surface)
	assert.equal(values.displayFamily, get("display-type").family)
	assert.equal(values.bodyFamily, get("body-type").family)
	assert.equal(values.baseSize, get("type-scale").baseSize)
	assert.equal(values.scaleRatio, get("type-scale").scaleRatio)
	assert.equal(values.brand, get("brand-color").hex)
	assert.equal(values.secondary, "hex" in secondary ? secondary.hex : undefined)
	assert.equal(values.accent, "hex" in accent ? accent.hex : undefined)
	assert.equal(values.neutral, get("neutral").neutral)
	assert.deepEqual(values.semantic, get("semantics"))
	assert.equal(values.spacingUnit, get("spacing").spacingUnit)
	assert.equal(values.radiusCharacter, get("radius").radiusCharacter)
	assert.equal(values.elevationCharacter, get("depth").elevation)

	const { tokens } = finalizeProposal({ ...values, rule: "Brand colour on actions only.", summary: "Test." }, "")
	assert.equal(tokens.color.surface, values.surface)
	assert.equal(tokens.typography.displayFamily, values.displayFamily)
	assert.equal(tokens.typography.fontFamily, values.bodyFamily)
	assert.equal(tokens.typography.baseSize, values.baseSize, "the saved body size differs from the answer")
	assert.equal(tokens.typography.scaleRatio, values.scaleRatio, "the saved step ratio differs from the answer")
	assert.equal(tokens.color.brand.seed, values.brand)
	assert.equal(tokens.color.secondary?.seed, values.secondary)
	assert.equal(tokens.color.accent?.seed, values.accent)
	assert.equal(tokens.color.neutral.character, values.neutral)
	assert.deepEqual(
		{
			success: tokens.color.semantic.success,
			warning: tokens.color.semantic.warning,
			error: tokens.color.semantic.error,
			info: tokens.color.semantic.info,
		},
		values.semantic,
	)
	assert.equal(tokens.spacing.baseUnit, values.spacingUnit)
	assert.equal(tokens.radius.character, values.radiusCharacter)
	assert.equal(tokens.elevation?.character, values.elevationCharacter)
}

// ── building records ────────────────────────────────────────────────────────

export function openingStatements(areas: AreaId[], mode: InterviewMode): OpeningStatement[] {
	return areas.map((area, i) => ({
		id: `s${i}`,
		area,
		value: SAMPLE_OPTIONS[area][SAMPLE_OPTIONS[area].length - 1],
		text: `A statement about ${AREAS[area].label}.`,
		source: mode === "from-app" ? `src/styles/${area}.css` : undefined,
	}))
}

/** A record whose opening screen showed `areas` and was answered with corrections on `corrected`. */
export function openedRecord(mode: InterviewMode, areas: AreaId[], corrected: AreaId[] = []): InterviewRecord {
	const statements = openingStatements(areas, mode)
	const record: InterviewRecord = { ...newRecord(mode, "A product."), opening: { questionId: "opening", statements } }
	const verdicts: Verdict[] = statements.map((s) =>
		corrected.includes(s.area)
			? { statementId: s.id, verdict: "corrected", note: `Not quite: ${s.area}.` }
			: { statementId: s.id, verdict: "confirmed" },
	)
	return applyOpening(record, verdicts)
}

/** Answers every remaining topic with its recommendation. */
export function finishWithRecommendations(record: InterviewRecord): InterviewRecord {
	let current = record
	while (deriveState(current).next) {
		const before = current
		const step = answerNext(current, { via: "skip" })
		current = step.record
		checkRules(current, before, step.answer.area)
	}
	return current
}

/** A small, fixed-seed random number generator, so the random walks are the same on every run. */
export function seeded(seed: number): () => number {
	let state = seed >>> 0
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0
		return state / 2 ** 32
	}
}
