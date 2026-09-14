/**
 * Curated palette recipes.
 *
 * These are **strategies, not colour schemes**. The reason generated UI reads as
 * generic is almost never the specific blue — it is that everything is at the
 * same saturation, there are four accent colours competing, and the neutrals are
 * pure grey. Every recipe here encodes a restraint rule that survives whatever
 * hue the user ends up with:
 *
 * - one accent, used rarely
 * - neutrals that are tinted rather than pure grey
 * - a deliberate lightness gap between surface and text
 *
 * The seed colour is still the user's. What the recipe supplies is everything
 * around it, which is the part a non-designer has no way to reason about.
 */
import type { ColorTokens } from "../types"

export interface PaletteRecipe {
	id: string
	name: string
	/** What this feels like, in plain language. */
	feel: string
	tags: string[]
	/** Suggested brand seed. The user can replace it; the strategy still holds. */
	seed: string
	/** Warm, cool or true neutrals — the decision that does most of the work. */
	neutral: ColorTokens["neutral"]["character"]
	/**
	 * The surface this recipe is designed for. A dark-surface recipe previewed on
	 * a light card is not a preview of that recipe — it misstates it, and the user
	 * is choosing on the basis of the picture.
	 */
	surface: "light" | "dark"
	semantic: ColorTokens["semantic"]
	/** The restraint rule, carried into the generated rules files. */
	rule: string
	rationale: string
}

export const PALETTE_RECIPES: PaletteRecipe[] = [
	{
		id: "mono-accent",
		surface: "light",
		name: "Almost monochrome",
		feel: "Nearly black and white, with one colour used sparingly.",
		tags: ["premium", "editorial", "calm", "minimal", "considered", "serious"],
		seed: "#2563eb",
		neutral: "cool",
		semantic: { success: "#16a34a", warning: "#ca8a04", error: "#dc2626", info: "#2563eb" },
		rule: "Use the brand colour for at most one element per screen — usually the primary action. Everything else is neutral.",
		rationale:
			"The most reliable way to look expensive, and the hardest to get wrong. Because colour is scarce, the one place it appears reads as emphasis rather than decoration.",
	},
	{
		id: "warm-earth",
		surface: "light",
		name: "Warm and earthy",
		feel: "Sand, clay and ink. Nothing is pure white or pure black.",
		tags: ["warm", "human", "craft", "wellness", "friendly", "consumer", "organic"],
		seed: "#b45309",
		neutral: "warm",
		semantic: { success: "#4d7c0f", warning: "#b45309", error: "#b91c1c", info: "#0e7490" },
		rule: "Never use pure white or pure black. Surfaces sit at the warm end of the neutral scale; text is a very dark brown-grey, not #000.",
		rationale:
			"Warm neutrals are the single cheapest way to stop something looking like a default framework. The absence of pure white is what the eye reads as considered.",
	},
	{
		id: "deep-technical",
		surface: "dark",
		name: "Deep and technical",
		feel: "Dark surfaces, one bright colour, sharp contrast.",
		tags: ["technical", "developer", "dashboard", "data", "modern", "saas", "dark"],
		seed: "#22d3ee",
		neutral: "cool",
		semantic: { success: "#22c55e", warning: "#eab308", error: "#f87171", info: "#22d3ee" },
		rule: "Dark surfaces carry the layout; the accent appears only on interactive and live elements. Never tint large surfaces with the accent.",
		rationale:
			"A saturated accent against a deep cool neutral reads as instrumentation. It fails when the accent is used for surfaces rather than signals, which is what the rule prevents.",
	},
	{
		id: "quiet-institutional",
		surface: "light",
		name: "Quiet and institutional",
		feel: "Restrained, low saturation, easy to trust.",
		tags: ["serious", "enterprise", "fintech", "healthcare", "government", "trustworthy", "dense"],
		seed: "#1e40af",
		neutral: "slight-tint",
		semantic: { success: "#15803d", warning: "#a16207", error: "#b91c1c", info: "#1e40af" },
		rule: "Keep saturation low everywhere except status colours. Status colour is information, so it is the only place brightness is allowed to compete.",
		rationale:
			"Dense, form-heavy products fail when everything is saturated — nothing stands out because everything does. Reserving brightness for status is what makes a dense screen readable.",
	},
	{
		id: "single-bold",
		surface: "light",
		name: "One bold colour",
		feel: "One strong colour used confidently and often.",
		tags: ["bold", "loud", "creative", "agency", "launch", "expressive", "consumer"],
		seed: "#e11d48",
		neutral: "true",
		semantic: { success: "#16a34a", warning: "#d97706", error: "#e11d48", info: "#4f46e5" },
		rule: "One colour, used large and unapologetically — a full-bleed section, an oversized element. Never introduce a second accent to balance it.",
		rationale:
			"Confidence with a single hue reads as a brand. The failure mode is adding a second colour to 'balance' the first, which immediately reads as a template.",
	},
]

export function findRecipe(id: string): PaletteRecipe | undefined {
	return PALETTE_RECIPES.find((r) => r.id === id)
}

/** Ranks recipes by tag overlap. Shortlists; never decides. */
export function narrowRecipes(tags: string[], limit = 3): PaletteRecipe[] {
	if (tags.length === 0) return PALETTE_RECIPES.slice(0, limit)
	const wanted = new Set(tags.map((t) => t.toLowerCase()))
	return [...PALETTE_RECIPES]
		.map((recipe) => ({ recipe, score: recipe.tags.filter((t) => wanted.has(t)).length }))
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((entry) => entry.recipe)
}
