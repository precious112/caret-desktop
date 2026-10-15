/**
 * Overused AI defaults, per interview topic.
 *
 * One function gives both halves of the rule: the "Avoid" line the model is
 * told, and the check on the options it sends back. They used to come from
 * different places, and the instructions recommended six fonts the checker
 * then rejected, which cost a wasted model call on most font questions.
 *
 * Whatever the user named or picked is theirs and is never flagged. Status
 * colours are not checked: an everyday green, amber and red are not a sign of
 * AI-made design.
 *
 * Engine only (reads the overused-defaults list file).
 */
import { commonValues, type UserChoices } from "../design-pass/foundation-check"
import { activeHabits } from "../design-pass/slop-list"
import type { AreaOption } from "./answers"
import type { AreaId } from "./areas"
import type { InterviewRecord } from "./state"

const FONT_AREAS: ReadonlySet<AreaId> = new Set(["display-type", "body-type"])
const COLOUR_AREAS: ReadonlySet<AreaId> = new Set(["brand-color", "secondary-color", "accent-color"])

/** Whether a topic's options are checked against the overused-defaults list. */
export function isCheckedForDefaults(area: AreaId): boolean {
	return FONT_AREAS.has(area) || COLOUR_AREAS.has(area)
}

/** What the user chose or said so far: never flagged as an overused default. */
export function userChoicesFrom(record: InterviewRecord): UserChoices {
	const corrections = (record.opening?.verdicts ?? []).flatMap((v) => (v.verdict === "corrected" ? [v.note] : []))
	const colours: string[] = []
	const fonts: string[] = []
	for (const answer of record.answers) {
		const value = answer.value as Record<string, unknown>
		if (typeof value.hex === "string") colours.push(value.hex)
		if (typeof value.family === "string") fonts.push(value.family)
	}
	return { words: [record.description, ...corrections].join("\n"), colours, fonts }
}

/** The values to tell the model to avoid for a topic: the list's fonts or colours, minus the user's own. */
export function avoidListFor(area: AreaId, user: UserChoices): string[] {
	if (!isCheckedForDefaults(area)) return []
	const candidates = FONT_AREAS.has(area)
		? { colours: [], fonts: [...new Set(activeHabits().flatMap((habit) => habit.fonts))] }
		: { colours: [...new Set(activeHabits().flatMap((habit) => habit.colours))], fonts: [] }
	return [...new Set(commonValues(candidates, user).map((found) => found.value))]
}

/** The ids of options that are overused defaults the user didn't choose. */
export function flaggedOptions(area: AreaId, options: AreaOption[], user: UserChoices): string[] {
	if (!isCheckedForDefaults(area)) return []
	const offered = (option: AreaOption) => {
		const value = option.value as Record<string, unknown>
		return typeof value.family === "string" ? value.family : typeof value.hex === "string" ? value.hex : ""
	}
	const found = new Set(
		commonValues(
			{
				colours: COLOUR_AREAS.has(area) ? options.map(offered).filter(Boolean) : [],
				fonts: FONT_AREAS.has(area) ? options.map(offered).filter(Boolean) : [],
			},
			user,
		).map((f) => f.value.toLowerCase()),
	)
	return options.filter((option) => found.has(offered(option).toLowerCase())).map((option) => option.id)
}
