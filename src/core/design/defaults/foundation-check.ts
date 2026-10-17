/**
 * Foundation suggestions, checked against the slop list's exact values before
 * the user sees them. The interview's AI reaches for the same few defaults
 * (a warm cream page, a terracotta accent, Inter, Fraunces); a common pairing
 * goes back to it once, the same way a badly formed question already does.
 * Whatever the user named or picked is theirs, and never comes back.
 */
import type { FoundationTokens } from "../types"
import { closeMatch, isUninformative, parseHex, type Rgb, sameColour } from "./colour"
import { activeHabits } from "./slop-list"

export interface CommonValue {
	value: string
	habit: string
}

export interface UserChoices {
	/** The user's own words: the description and every typed answer. */
	words: string
	/** Hexes and font families the user picked or typed. */
	colours: string[]
	fonts: string[]
}

const wordPattern = (phrase: string) =>
	new RegExp(
		`(^|[^a-z])${phrase
			.toLowerCase()
			.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
			.replace(/ /g, "\\s+")}([^a-z]|$)`,
	)

/** The suggested colours and fonts that are common AI defaults the user did not choose. */
export function commonValues(candidates: { colours: string[]; fonts: string[] }, user: UserChoices): CommonValue[] {
	const words = user.words.toLowerCase()
	const userColours = [...user.colours, ...(user.words.match(/#[0-9a-f]{3,6}\b/gi) ?? [])]
		.map(parseHex)
		.filter((c): c is Rgb => !!c)
	const userFonts = user.fonts.map((f) => f.toLowerCase().trim())
	const found: CommonValue[] = []
	const seen = new Set<string>()
	const add = (value: string, habit: string) => {
		if (seen.has(value.toLowerCase())) return
		seen.add(value.toLowerCase())
		found.push({ value, habit })
	}
	for (const hex of candidates.colours) {
		const colour = parseHex(hex)
		if (!colour || isUninformative(colour) || userColours.some((c) => sameColour(c, colour))) continue
		for (const habit of activeHabits()) {
			const hit = habit.colours.some((reported) => {
				const target = parseHex(reported)
				return !!target && !isUninformative(target) && closeMatch(colour, target) !== null
			})
			if (hit) add(hex, habit.name)
		}
	}
	for (const font of candidates.fonts) {
		const name = font.toLowerCase().trim()
		if (!name || userFonts.includes(name) || wordPattern(name).test(words)) continue
		for (const habit of activeHabits()) {
			if (habit.fonts.some((reported) => reported.toLowerCase() === name)) add(font, habit.name)
		}
	}
	return found
}

/** The values a finished foundation would put on every page: seeds, the page background, both faces. */
export function foundationCandidates(tokens: FoundationTokens): { colours: string[]; fonts: string[] } {
	const colours = [tokens.color.brand.seed, tokens.color.secondary?.seed, tokens.color.accent?.seed]
	// The page background on a light surface is the lightest neutral.
	if ((tokens.color.surface ?? "light") === "light") colours.push(tokens.color.neutral.scale[50])
	return {
		colours: colours.filter((c): c is string => !!c),
		fonts: [tokens.typography.displayFamily, tokens.typography.fontFamily].filter((f): f is string => !!f),
	}
}

/** What the AI is told when it suggested common defaults. */
export function commonValuesComplaint(found: CommonValue[]): string {
	return `${found.map((f) => `${f.value} (${f.habit})`).join(", ")} ${found.length === 1 ? "is" : "are"} among the most common AI design defaults, and the user did not ask for ${found.length === 1 ? "it" : "them"}. Suggest values that come from this product instead.`
}
