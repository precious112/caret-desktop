/**
 * Generated assets: the curated library, and the narrowing that fits it to a
 * project.
 *
 * §4.6 solved *the user has an asset*. This solves *the user has none*, which is
 * the common case for the pinned persona and a large part of why landing pages
 * built by developers look the way they do.
 */
import { countRecognisedTags, LIBRARY_TAGS } from "../foundation-library"
import type { FoundationTokens } from "../types"
import { findGenerator, GENERATORS, type Generator, runGenerator } from "./generators"
import { FREE_LANES } from "./lanes"
import { derivePalette } from "./palette"
import { ALL_RECIPES, runnableRecipes, SLOP_TELLS } from "./recipes"
import { ASPECTS, type AssetRecipe, type GeneratorPalette, type RecipeInput, type RecipeRequest } from "./types"

export { findGenerator, GENERATORS, type Generator, type GeneratorInput, runGenerator } from "./generators"
export {
	allRunnableRecipes,
	defaultAspect,
	findChoice,
	GENERATION_QUESTIONS,
	type GenerationAnswers,
	type GenerationChoice,
	type GenerationQuestion,
	isComplete,
	narrowForAnswers,
	proposeTag,
} from "./interview"
export { FREE_LANES, lanesWithRaster } from "./lanes"
export { DEFAULT_PALETTE, derivePalette, hexToHsl, hslToHex, normalizeHex } from "./palette"
/**
 * The raster lane's runner is deliberately **not** re-exported here.
 *
 * `raster/gemini` reaches `@/shared/net`, which reaches undici, which is
 * node-only — and re-exporting it made this whole barrel unbundleable for a
 * browser. That matters beyond tooling: the generators are pure and portable by
 * design, and anything that wants them (the explainer page, and one day the
 * canvas itself) should not have to drag `child_process` along to get them.
 * `src/core/design` re-exports the lane from its own modules, so nothing
 * outside sees a difference.
 */
export { foundationWords, keyWords, paletteWords } from "./raster/palette-words"
export { RASTER_RECIPES } from "./raster/recipes"
export { ALL_RECIPES, ASSET_RECIPES, runnableRecipes, SLOP_TELLS } from "./recipes"
export { type RefinedBrief, refineBrief } from "./refine-brief"
export {
	type AssetRequest,
	type ClarifyQuestion,
	type ClarifyResult,
	clarifyRequest,
	composeAssetRequest,
	type GenerationKind,
	recipeForRequest,
	SHARED_AVOID,
	STYLE_DEFAULT_AVOID,
} from "./request"
export {
	ASPECTS,
	type AssetPurpose,
	type AssetRecipe,
	type GeneratorPalette,
	type RecipeInput,
	type RecipeKind,
	type RecipeLane,
	type RecipeRequest,
} from "./types"

/** Kept for callers that predate `FREE_LANES`. Same set, clearer name there. */
export const RUNNABLE_LANES: ReadonlySet<string> = FREE_LANES

/**
 * Recipes worth offering for a set of vibe tags, best first.
 *
 * Exact tag matching, like the foundation library, and refused the same way when
 * nothing overlaps — see `countRecognisedTags`. An unmatched query ranks every
 * candidate zero and degenerates to declaration order, which looks identical to
 * a considered narrowing and is not one. Silent theatre is the worst failure
 * available to the screen whose entire job is injecting taste.
 */
export function narrowRecipes(tags: string[], limit = 6, lanes: ReadonlySet<string> = FREE_LANES): AssetRecipe[] {
	const wanted = new Set(tags.map((tag) => tag.toLowerCase()))
	const pool = runnableRecipes(lanes)
	if (wanted.size === 0) return pool.slice(0, limit)

	return [...pool]
		.map((recipe) => {
			const matched = recipe.tags.filter((tag) => wanted.has(tag)).length
			// Ties are common — several recipes are legitimately "technical" — and
			// breaking them by declaration order is the failure this library warns
			// about wearing a smaller hat. Specificity is the honest tiebreak: the
			// recipe most of whose own vocabulary this project matched is the one
			// aimed at this kind of project, rather than the broad one that fits
			// everything a little.
			return { recipe, matched, specificity: recipe.tags.length > 0 ? matched / recipe.tags.length : 0 }
		})
		.sort((a, b) => b.matched - a.matched || b.specificity - a.specificity)
		.map((scored) => scored.recipe)
		.slice(0, limit)
}

/**
 * Whether a set of tags can narrow anything at all.
 *
 * Returned rather than thrown so the caller decides: the picker shows the full
 * library and says so, while an agent asking for a narrowing gets a refusal that
 * names the vocabulary.
 */
export function canNarrow(tags: string[]): { ok: true } | { ok: false; reason: string } {
	if (countRecognisedTags(tags) > 0) return { ok: true }
	return {
		ok: false,
		reason:
			`None of those words are in the library's vocabulary, so ranking by them would return ` +
			`the first few recipes in declaration order and look like a real narrowing. ` +
			`The vocabulary is: ${LIBRARY_TAGS.join(", ")}.`,
	}
}

/** Named for the asset library specifically — `findRecipe` is the palette one. */
export function findAssetRecipe(id: string): AssetRecipe | undefined {
	return ALL_RECIPES.find((recipe) => recipe.id === id)
}

/** The tags a project's own foundation contributes to the narrowing. */
export function tagsFromFoundation(tokens: FoundationTokens | null): string[] {
	return [...new Set((tokens?.vibe.tags ?? []).map((tag) => tag.toLowerCase()))]
}

export interface VariantInput {
	recipe: AssetRecipe
	tokens: FoundationTokens | null
	aspect?: string
	answers?: Record<string, string>
	count?: number
}

/** One composed option, ready to look at. */
export interface GeneratedVariant {
	/** 0-based, and the seed. Recorded so a pick is reproducible. */
	variant: number
	request: RecipeRequest
	/** The asset itself, for lanes that produce one synchronously. */
	svg?: string
	width: number
	height: number
}

/**
 * Composes N variants of a recipe.
 *
 * Generator-lane variants come back complete, because they cost integers rather
 * than API calls — which is what makes generate-and-pick affordable here and is
 * half the reason the lane exists. Other lanes return the composed request for
 * their runner to execute; nothing in this function talks to a network.
 */
export function composeVariants(input: VariantInput): GeneratedVariant[] {
	const { recipe, tokens } = input
	const palette = derivePalette(tokens)
	const aspectKey = input.aspect && ASPECTS[input.aspect] ? input.aspect : recipe.aspects[0]
	const aspect = ASPECTS[aspectKey] ?? ASPECTS["16:9"]
	const count = Math.min(24, Math.max(1, input.count ?? 6))

	const variants: GeneratedVariant[] = []
	for (let variant = 0; variant < count; variant++) {
		const composeInput: RecipeInput = {
			palette,
			aspect: aspectKey,
			variant,
			answers: input.answers ?? {},
			tags: tagsFromFoundation(tokens),
		}
		const request = finalise(recipe.realise(composeInput), recipe, aspectKey)
		variants.push({
			variant,
			request,
			width: aspect.width,
			height: aspect.height,
			svg:
				request.lane === "generator"
					? runGenerator(request.generatorId, {
							palette,
							width: aspect.width,
							height: aspect.height,
							// Offset so two recipes on the same generator do not produce
							// the same seven pictures. Without it "try another recipe"
							// silently returns the previous one.
							seed: hashSeed(recipe.id) + variant,
							params: request.params,
						})
					: undefined,
		})
	}
	return variants
}

/**
 * Fills in the parts of a request no recipe should have to remember.
 *
 * The negative constraints are assembled here — the recipe's own, then the
 * documented slop tells — so a new recipe cannot ship having quietly forgotten
 * them, which is the failure that would take the whole anti-slop argument out
 * silently. The aspect is overwritten for the same reason: the user picked one,
 * the recipe declared a default, and only one of those can be right.
 */
function finalise(request: RecipeRequest, recipe: AssetRecipe, aspect: string): RecipeRequest {
	if (request.lane !== "raster") return request
	return {
		...request,
		aspect,
		avoid: [...new Set([...request.avoid, ...recipe.avoid, ...SLOP_TELLS])],
	}
}

/** FNV-1a over the recipe id. Stable across processes, unlike a string hash. */
function hashSeed(id: string): number {
	let hash = 0x811c9dc5
	for (let i = 0; i < id.length; i++) {
		hash ^= id.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193) >>> 0
	}
	return hash % 100000
}

/**
 * A one-line description of what a generated asset actually looks like.
 *
 * The description is the load-bearing field of the whole asset layer (§4.6), and
 * a generated asset arrives with nobody to write one. Composing it from the
 * decisions that produced the picture is more honest than asking a model to
 * describe an image it just made, and it is available offline.
 */
export function describeVariant(recipe: AssetRecipe, variant: GeneratedVariant, palette: GeneratorPalette): string {
	const generator = variant.request.lane === "generator" ? findGenerator(variant.request.generatorId) : undefined
	return [
		`${proportionOf(variant.width, variant.height)}, ${palette.mode}.`,
		generator?.produces ?? recipe.use,
		`Generated from the "${recipe.name}" recipe against this project's foundation.`,
	].join(" ")
}

function proportionOf(width: number, height: number): string {
	const ratio = width / height
	if (ratio > 2) return "ultra-wide"
	if (ratio > 1.2) return "wide"
	if (ratio < 0.83) return "tall"
	return "square"
}

/** Every generator, for the tuning surface and for tests that must cover them all. */
export function allGenerators(): Generator[] {
	return GENERATORS
}

/** The negative constraints a lane composes in. Exported for the raster runner. */
export function slopTells(): string[] {
	return SLOP_TELLS
}
