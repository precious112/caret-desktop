/**
 * The curated foundation library, and the interview that narrows it.
 *
 * The wizard used to be a form, which assumes the user already knows what to put
 * in it — precisely what Caret's user does not. Instead: a short interview in
 * plain language, then a handful of candidates to look at and point at.
 *
 * Pointing requires no design vocabulary. That is the entire argument, and it is
 * the same one behind generate-and-pick: high-bandwidth from the tool to the
 * person, without requiring high bandwidth back.
 *
 * **The curation is what makes this non-slop.** The agent narrows a pre-approved
 * space; it never invents a hex or a font name. So the floor is set here, once,
 * rather than by whichever agent happens to be connected.
 */
import { generateTokenScale } from "../token-scales"
import type { FoundationTokens } from "../types"
import { findRecipe, PALETTE_RECIPES, type PaletteRecipe } from "./palettes"
import { findPreset, SHAPE_PRESETS, type ShapePreset } from "./presets"
import { findPairing, googleFontsUrl, narrowPairings, TYPEFACE_PAIRINGS, type TypefacePairing } from "./typefaces"

export { findRecipe, narrowRecipes, PALETTE_RECIPES, type PaletteRecipe } from "./palettes"
export { findPreset, narrowPresets, SHAPE_PRESETS, type ShapePreset } from "./presets"
export {
	findPairing,
	googleFontsUrl,
	narrowPairings,
	TYPEFACE_PAIRINGS,
	type TypefacePairing,
	type TypefaceRole,
} from "./typefaces"

/**
 * The interview questions, in order.
 *
 * Deliberately five, deliberately plain. Anything longer and people start
 * answering to finish rather than to be understood; anything phrased in design
 * vocabulary ("what's your visual hierarchy?") gets a guess rather than an
 * answer. Every choice maps to vibe tags, which is how the library is narrowed.
 */
export interface InterviewQuestion {
	id: string
	question: string
	/** Shown under the question when the choice is not self-evident. */
	hint?: string
	choices: InterviewChoice[]
}

export interface InterviewChoice {
	label: string
	/** Tags this answer contributes to the narrowing. */
	tags: string[]
}

export const INTERVIEW_QUESTIONS: InterviewQuestion[] = [
	{
		id: "what",
		question: "What are you building?",
		choices: [
			{ label: "A tool people work in all day", tags: ["technical", "dense", "product", "saas", "dashboard"] },
			{ label: "A site that explains or sells something", tags: ["marketing", "content", "editorial", "premium"] },
			{ label: "Something people read", tags: ["editorial", "content", "reading", "publishing", "calm"] },
			{ label: "An app people use now and then", tags: ["consumer", "friendly", "mobile", "clean"] },
		],
	},
	{
		id: "who",
		question: "Who is it for?",
		choices: [
			{ label: "Developers or technical people", tags: ["technical", "developer", "precise", "data"] },
			{ label: "Businesses that need to trust it", tags: ["serious", "enterprise", "fintech", "trustworthy"] },
			{ label: "Ordinary people, no training", tags: ["consumer", "friendly", "clean", "warm"] },
			{ label: "Designers or creative people", tags: ["creative", "expressive", "bold", "agency"] },
		],
	},
	{
		id: "feel",
		question: "How should it feel?",
		hint: "There is no wrong answer — this only narrows what we show you.",
		choices: [
			{ label: "Calm and considered", tags: ["calm", "considered", "premium", "minimal", "editorial"] },
			{ label: "Sharp and precise", tags: ["precise", "technical", "modern", "dense"] },
			{ label: "Warm and human", tags: ["warm", "human", "friendly", "organic", "craft"] },
			{ label: "Bold and confident", tags: ["bold", "loud", "expressive", "creative"] },
		],
	},
	{
		id: "volume",
		question: "Louder or quieter than most things in your field?",
		choices: [
			{ label: "Quieter — let it recede", tags: ["calm", "minimal", "neutral", "considered", "serious"] },
			{ label: "About the same", tags: ["neutral", "clean", "flexible", "product"] },
			{ label: "Louder — stand out", tags: ["bold", "loud", "expressive", "creative", "launch"] },
		],
	},
	{
		id: "temperature",
		question: "Warmer or cooler?",
		hint: "Warmer reads friendlier; cooler reads more technical.",
		choices: [
			{ label: "Warmer", tags: ["warm", "human", "organic", "friendly", "craft"] },
			{ label: "Cooler", tags: ["cool", "technical", "precise", "modern", "serious"] },
			{ label: "Neither, keep it neutral", tags: ["neutral", "clean", "flexible"] },
		],
	},
]

/** A complete candidate foundation the user can look at and pick. */
export interface FoundationCandidate {
	id: string
	name: string
	/** One line, plain language, on what this is. */
	summary: string
	typeface: TypefacePairing
	palette: PaletteRecipe
	shape: ShapePreset
	/** Ready to write; what `commit_foundation` receives. */
	tokens: FoundationTokens
}

/**
 * Narrows the library to a few complete candidates from the interview answers.
 *
 * Candidates are whole foundations rather than three separate pick-lists,
 * because typeface, palette and shape interact — a rounded, airy preset under a
 * high-contrast editorial serif is worse than either choice suggests. Combining
 * them here means every option the user sees is one somebody thought about.
 */
export function narrowCandidates(tags: string[], count = 3): FoundationCandidate[] {
	const typefaces = narrowPairings(tags, count)
	const wanted = new Set(tags.map((t) => t.toLowerCase()))
	const score = (candidateTags: string[]) => candidateTags.filter((t) => wanted.has(t)).length

	return typefaces.map((typeface) => {
		// Only combinations the typeface is declared to work with. Ranking the
		// three axes separately and zipping by index produced pairings nobody
		// approved — the exact failure this function's existence is meant to
		// prevent.
		const palette = bestOf(
			typeface.pairsWith.palettes.map(findRecipe).filter(Boolean) as PaletteRecipe[],
			PALETTE_RECIPES,
			score,
		)
		const shape = bestOf(typeface.pairsWith.shapes.map(findPreset).filter(Boolean) as ShapePreset[], SHAPE_PRESETS, score)
		return {
			id: `${typeface.id}+${palette.id}+${shape.id}`,
			name: `${typeface.name} · ${palette.name}`,
			summary: `${typeface.feel} ${palette.feel}`,
			typeface,
			palette,
			shape,
			tokens: buildTokens({ typeface, palette, shape, tags }),
		}
	})
}

/** The best-scoring allowed option, falling back to the first of all when empty. */
function bestOf<T extends { tags: string[] }>(allowed: T[], all: T[], score: (tags: string[]) => number): T {
	const pool = allowed.length > 0 ? allowed : all
	return [...pool].sort((a, b) => score(b.tags) - score(a.tags))[0]
}

export interface BuildTokensInput {
	typeface: TypefacePairing
	palette: PaletteRecipe
	shape: ShapePreset
	tags: string[]
	/** Overrides the recipe's suggested brand colour. */
	seed?: string
}

/**
 * Expands a candidate into a complete `foundation.json`.
 *
 * Scales are derived rather than stored, using the same generator the wizard
 * uses, so a foundation picked in the interview and one built by hand are the
 * same shape and stay editable afterwards.
 */
export function buildTokens(input: BuildTokensInput): FoundationTokens {
	const { typeface, palette, shape, tags } = input
	const seed = input.seed ?? palette.seed

	return {
		vibe: {
			description: `${typeface.feel} ${palette.rule}`,
			tags: [...new Set(tags)],
		},
		color: {
			brand: { seed, scale: generateTokenScale("color", seed, { steps: 11 }) },
			neutral: { character: palette.neutral, scale: {} },
			semantic: palette.semantic,
			// The recipe was designed for one surface or the other; a dark-surface
			// strategy committed as light is a different strategy.
			surface: palette.surface,
		},
		typography: {
			fontFamily: typeface.body.family,
			fallback: typeface.body.fallback,
			// The pairing's whole point is a display face; dropping it here made
			// every agent-committed foundation render headings in the body face
			// and the DS view name the system after half the pairing.
			displayFamily: typeface.display.family,
			displayFallback: typeface.display.fallback,
			scaleRatio: typeface.scaleRatio,
			baseSize: shape.baseSize,
			scale: numericScale(generateTokenScale("typography", String(shape.baseSize), { ratio: typeface.scaleRatio })),
		},
		spacing: shape.spacing,
		radius: shape.radius,
	}
}

/** Rebuilds a candidate from its composite id, for `commit_foundation`. */
export function resolveCandidate(id: string, tags: string[] = []): FoundationCandidate | null {
	const [typefaceId, paletteId, shapeId] = id.split("+")
	const typeface = findPairing(typefaceId)
	const palette = findRecipe(paletteId)
	const shape = findPreset(shapeId)
	if (!typeface || !palette || !shape) return null

	// A combination Caret never offered is not a curated foundation, whoever
	// assembled the id.
	if (!typeface.pairsWith.palettes.includes(paletteId) || !typeface.pairsWith.shapes.includes(shapeId)) {
		return null
	}

	return {
		id,
		name: `${typeface.name} · ${palette.name}`,
		summary: `${typeface.feel} ${palette.feel}`,
		typeface,
		palette,
		shape,
		tokens: buildTokens({ typeface, palette, shape, tags }),
	}
}

/** Collects the vibe tags implied by a set of interview answers. */
export function tagsFromAnswers(answers: Record<string, string>): string[] {
	const tags: string[] = []
	for (const question of INTERVIEW_QUESTIONS) {
		const chosen = answers[question.id]
		const choice = question.choices.find((c) => c.label === chosen)
		if (choice) tags.push(...choice.tags)
	}
	return [...new Set(tags)]
}

/** The font CSS a candidate needs, for the preview and the generated entry CSS. */
export function candidateFontUrl(candidate: FoundationCandidate): string {
	return googleFontsUrl(candidate.typeface)
}

/** `FoundationTokens.typography.scale` is numeric; the generator emits px strings. */
function numericScale(scale: Record<string, string>): Record<string, number> {
	const out: Record<string, number> = {}
	for (const [key, value] of Object.entries(scale)) {
		out[key] = Number.parseFloat(value)
	}
	return out
}

/**
 * Every tag the library recognises.
 *
 * This has to be published, because tag matching is exact. An agent describing a
 * product as "sleek, professional, modern" overlaps nothing, every candidate
 * scores zero, and the ranking degenerates to "the first three in declaration
 * order" — which looks identical to a real narrowing and is not one. Silent
 * theatre is the worst possible failure for the one screen that is supposed to
 * inject taste, so the vocabulary is advertised and a zero-overlap query is
 * refused rather than answered.
 */
export const LIBRARY_TAGS: string[] = [
	...new Set([
		...TYPEFACE_PAIRINGS.flatMap((p) => p.tags),
		...PALETTE_RECIPES.flatMap((r) => r.tags),
		...SHAPE_PRESETS.flatMap((s) => s.tags),
	]),
].sort()

/** How many of `tags` the library actually recognises. */
export function countRecognisedTags(tags: string[]): number {
	const known = new Set(LIBRARY_TAGS)
	return tags.filter((t) => known.has(t.toLowerCase())).length
}

/** Every pairing, recipe and preset — the no-agent path shows all of them. */
export function fullLibrary(): { typefaces: TypefacePairing[]; palettes: PaletteRecipe[]; shapes: ShapePreset[] } {
	return { typefaces: TYPEFACE_PAIRINGS, palettes: PALETTE_RECIPES, shapes: SHAPE_PRESETS }
}
