/**
 * What survives of the presets flow: the decisions vocabulary and the
 * description→tags reading.
 *
 * The deterministic step-walking UI (the old "Pick from presets" tab) is gone —
 * the wizard's modes replaced it — but the external-agent interview still
 * commits through `buildFoundation`, which needs the `Decisions` shape and the
 * tag matching below.
 */
import { LIBRARY_TAGS } from "../foundation-library"

export type StepId = "typeface" | "palette" | "brand" | "shape"

/** What the user has settled so far. Every value is a library id, or a hex for `brand`. */
export type Decisions = Partial<Record<StepId, string>>

/**
 * Library tags the user's own words imply.
 *
 * Tag matching is exact, so this is word-boundary matching against the published
 * vocabulary rather than anything cleverer — "a dashboard for technical teams"
 * yields `dashboard`, `technical`. It only has to be good enough to order a
 * fallback; the model's ranking is the good path, and pretending otherwise by
 * fuzzy-matching would produce a narrowing that looks considered and isn't.
 */
export function tagsFromDescription(description: string): string[] {
	const text = withoutNegations(description.toLowerCase())
	return LIBRARY_TAGS.filter((tag) => new RegExp(`\\b${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text))
}

/** Words that turn everything after them, up to the next clause, into a negative. */
const NEGATORS = /\b(?:no|not|nothing|never|without|avoid|avoiding|rather than|instead of|less)\b/

/**
 * Drops the part of each clause that follows a negation.
 *
 * Matching is on the word rather than the meaning, so "nothing playful" seeded
 * `playful` and "rather than loud" seeded `loud` — the *opposite* of what the
 * person said, which is worse than reading nothing at all. The product's own
 * placeholder demonstrated it: "Dark, calm, nothing playful." yielded
 * `["calm", "dark", "playful"]`.
 *
 * Clause-scoped rather than whole-string, so a negation late in a sentence does
 * not discard the qualities named before it: "editorial and minimal, calm and
 * considered rather than loud" keeps all four and drops only `loud`. This is not
 * the fuzzy matching this function deliberately avoids — it removes an inversion
 * rather than inventing a similarity.
 */
function withoutNegations(text: string): string {
	return text
		.split(/[,.;:!?]|\band\b(?=[^,.;:!?]*\b(?:no|not|nothing|never|without|rather than|instead of)\b)/)
		.map((clause) => {
			const hit = clause.match(NEGATORS)
			return hit?.index === undefined ? clause : clause.slice(0, hit.index)
		})
		.join(" ")
}
