/**
 * Turning what someone clicked or typed into an answer, and checking it.
 *
 * The screen builds every answer with these functions, and the engine checks
 * every answer it receives with `acceptAnswer`, so what the screen allows and
 * what the engine accepts are the same rules. A typed value Caret can't save
 * is refused here with a reason the screen shows, instead of being accepted
 * and quietly changed later.
 *
 * Shared with the screen: no Node, no `@/` aliases.
 */
import { AREAS, type AreaId, type AreaValue, type InputKind, isAreaValue, normalizeHex, RANGES, sameValue } from "./areas"
import { type AreaAnswer, applyAnswer, deriveState, type InterviewRecord, InterviewRuleError } from "./state"

export interface AreaOption<A extends AreaId = AreaId> {
	id: string
	label: string
	reason?: string
	value: AreaValue<A>
}

/** A question about one topic, as shown: Caret chose the topic and the input; the model wrote the words and options. */
export interface AreaQuestion<A extends AreaId = AreaId> {
	id: string
	area: A
	input: InputKind
	question: string
	why?: string
	options: AreaOption<A>[]
	recommendedId: string
	/** Fingerprint of what had been decided when the question was written; Back reuses it only while this still matches. */
	contextKey: string
}

/** The answer for picking one of the options. */
export function optionAnswer<A extends AreaId>(question: AreaQuestion<A>, optionId: string): AreaAnswer<A> | null {
	const option = question.options.find((o) => o.id === optionId)
	if (!option) return null
	return { area: question.area, questionId: question.id, via: "option", optionId, value: option.value, reason: option.reason }
}

/** The answer for Skip: the recommendation stands. */
export function skipAnswer<A extends AreaId>(question: AreaQuestion<A>): AreaAnswer<A> {
	const option = question.options.find((o) => o.id === question.recommendedId) ?? question.options[0]
	return {
		area: question.area,
		questionId: question.id,
		via: "skip",
		optionId: option.id,
		value: option.value,
		reason: option.reason,
	}
}

/** What can be typed into a topic's own-answer box. Blank fields are left empty, not zero. */
export type OwnRaw =
	| { kind: "hex"; hex: string }
	| { kind: "font"; family: string }
	| { kind: "size"; px: string; ratio: string }
	| { kind: "status-hexes"; success: string; warning: string; error: string; info: string }

/**
 * The answer for something typed into a topic's own-answer box.
 *
 * - `empty`: nothing typed; the selected card stays the answer.
 * - `refused`: typed, but Caret can't save it; `reason` says why, in words the screen shows.
 * - `answer`: a valid answer, saved exactly as typed.
 *
 * For sizes, a blank field takes its number from the option that is selected,
 * so typing only a ratio keeps the selected body size.
 */
export type OwnResult<A extends AreaId = AreaId> =
	| { kind: "empty" }
	| { kind: "refused"; reason: string }
	| { kind: "answer"; answer: AreaAnswer<A> }

export function ownAnswer<A extends AreaId>(question: AreaQuestion<A>, raw: OwnRaw, selectedOptionId?: string): OwnResult<A> {
	const own = (value: AreaValue): OwnResult<A> => ({
		kind: "answer",
		answer: { area: question.area, questionId: question.id, via: "own", value: value as AreaValue<A> },
	})
	switch (raw.kind) {
		case "hex": {
			if (!raw.hex.trim()) return { kind: "empty" }
			const hex = normalizeHex(raw.hex)
			if (!hex) return { kind: "refused", reason: `"${raw.hex.trim()}" isn't a colour. Use a hex like #28a4f0.` }
			return own({ hex })
		}
		case "font": {
			const family = raw.family.trim()
			return family ? own({ family }) : { kind: "empty" }
		}
		case "size": {
			const px = raw.px.trim()
			const ratio = raw.ratio.trim()
			if (!px && !ratio) return { kind: "empty" }
			const selected = question.options.find((o) => o.id === (selectedOptionId ?? question.recommendedId))
			const base = (selected?.value ?? question.options[0]?.value) as { baseSize?: number; scaleRatio?: number }
			const baseSize = px ? Number(px) : base.baseSize
			const scaleRatio = ratio ? Number(ratio) : base.scaleRatio
			if (!Number.isFinite(baseSize) || !Number.isInteger(baseSize)) {
				return { kind: "refused", reason: "Body text size must be a whole number of pixels." }
			}
			if ((baseSize as number) < RANGES.baseSize.min || (baseSize as number) > RANGES.baseSize.max) {
				return {
					kind: "refused",
					reason: `Body text must be ${RANGES.baseSize.min} to ${RANGES.baseSize.max}px: the design system can't store ${px}px.`,
				}
			}
			if (
				!Number.isFinite(scaleRatio) ||
				(scaleRatio as number) < RANGES.scaleRatio.min ||
				(scaleRatio as number) > RANGES.scaleRatio.max
			) {
				return {
					kind: "refused",
					reason: `The step between sizes must be ${RANGES.scaleRatio.min} to ${RANGES.scaleRatio.max}.`,
				}
			}
			return own({ baseSize: baseSize as number, scaleRatio: scaleRatio as number })
		}
		case "status-hexes": {
			const fields = { success: raw.success, warning: raw.warning, error: raw.error, info: raw.info }
			if (Object.values(fields).every((v) => !v.trim())) return { kind: "empty" }
			const names = { success: "healthy", warning: "warning", error: "error", info: "info" } as const
			const value: Record<string, string> = {}
			for (const [key, typed] of Object.entries(fields)) {
				const hex = normalizeHex(typed)
				if (!hex) {
					return {
						kind: "refused",
						reason: typed.trim()
							? `"${typed.trim()}" isn't a colour for ${names[key as keyof typeof names]}. Use a hex like #2e9e5b.`
							: `Fill in all four colours (${names[key as keyof typeof names]} is empty).`,
					}
				}
				value[key] = hex
			}
			return own(value as AreaValue)
		}
	}
}

/**
 * The engine's check of an answer the screen sent, then the record with it
 * added. The screen is not trusted: the answer must be for the question on
 * screen, an option answer must carry exactly that option's value, a skip
 * exactly the recommendation's, and a typed answer must be a valid value.
 */
export function acceptAnswer(record: InterviewRecord, question: AreaQuestion, answer: AreaAnswer): InterviewRecord {
	if (answer.questionId !== question.id || answer.area !== question.area) {
		throw new InterviewRuleError(`This answer is for "${answer.questionId}", but the question on screen is "${question.id}".`)
	}
	const state = deriveState(record)
	if (state.next !== question.area) {
		throw new InterviewRuleError(`The question on screen is about "${question.area}", but the next topic is "${state.next}".`)
	}
	if (answer.via === "finish-now") {
		throw new InterviewRuleError('Answers filled in by "Just finish it" are made by Caret, never sent by the screen.')
	}
	if (answer.via === "option" || answer.via === "skip") {
		const expectedId = answer.via === "option" ? answer.optionId : question.recommendedId
		const option = question.options.find((o) => o.id === expectedId)
		if (!option || !sameValue(option.value, answer.value)) {
			throw new InterviewRuleError(`The answer's value doesn't match option "${expectedId}" of "${question.id}".`)
		}
	}
	if (answer.via === "own" && AREAS[question.area].ownInput === null) {
		throw new InterviewRuleError(`${AREAS[question.area].label} has no own-answer box.`)
	}
	if (!isAreaValue(question.area, answer.value)) {
		throw new InterviewRuleError(`${JSON.stringify(answer.value)} is not a valid answer about ${AREAS[question.area].label}.`)
	}
	return applyAnswer(record, answer)
}
