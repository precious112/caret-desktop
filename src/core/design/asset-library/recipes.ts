/**
 * The curated recipes.
 *
 * **This is the anti-slop floor, and it is set here once** rather than by
 * whichever model happens to be connected — the same argument as the foundation
 * library. A recipe is a decision somebody made: what this asset is for, which
 * ratios it was composed for, what it must not do, and which palette strategies
 * it belongs to.
 *
 * Only the generator lane is populated so far. That is deliberate rather than
 * partial: a recipe whose lane has no runner would appear in the picker and fail
 * when chosen, and "the option existed but did nothing" is worse than the option
 * not being there. The other three lanes land with their runners.
 */
import { findGenerator } from "./generators"
import { RASTER_RECIPES } from "./raster/recipes"
import type { AssetRecipe } from "./types"

/**
 * Slop tells, written once and composed into every request that takes negative
 * constraints.
 *
 * These are the documented artefacts of prompt-box generation, not a taste
 * preference: the phrases people add when they do not know what to ask for, and
 * the results those phrases produce.
 */
export const SLOP_TELLS = [
	"no lens flare, no bokeh sparkles, no light leaks",
	"no glowing edges or neon rim lighting",
	"no gradient meshes in colours outside the palette",
	"no stock-photo business metaphors — handshakes, ladders, lightbulbs, jigsaw pieces",
	"no fake UI, no invented logos, no illegible text",
	"no centred symmetrical composition unless asked for",
	"nothing described as cinematic, hyperdetailed, 8k, or trending",
]

export const ASSET_RECIPES: AssetRecipe[] = [
	{
		id: "quiet-wash",
		name: "Quiet colour wash",
		use: "Behind a hero or a section that already has a headline on it.",
		kind: "gradient",
		lane: "generator",
		purposes: ["background"],
		tags: ["calm", "considered", "premium", "minimal", "editorial", "clean", "product"],
		aspects: ["16:9", "21:9", "3:2"],
		avoid: ["competing hues", "a focal point that fights the headline"],
		pairsWith: { palettes: ["mono-accent", "warm-earth", "quiet-institutional"] },
		rationale:
			"A background's job is to be looked past. Three colour sources, opacity falling across the set, and enough grain to stop it reading as a screensaver. It fails when someone turns the intensity up to make it 'interesting' — at that point it is competing with the content it exists to sit behind.",
		realise: ({ variant, palette }) => ({
			lane: "generator",
			generatorId: "mesh-gradient",
			params: {
				blobs: 3 + (variant % 3),
				spread: 0.45 + (variant % 4) * 0.08,
				// Dark surfaces swallow colour, so the same wash needs more of it to
				// register at all. Matching the numbers across modes is what makes a
				// dark-mode background look like nothing rendered.
				intensity: palette.mode === "dark" ? 0.6 : 0.42,
				grain: 0.12,
			},
		}),
	},
	{
		id: "printed-fade",
		name: "Printed fade",
		use: "A hero background with more presence — grain doing the work, not colour.",
		kind: "gradient",
		lane: "generator",
		purposes: ["background"],
		tags: ["editorial", "craft", "warm", "human", "creative", "expressive", "publishing"],
		aspects: ["16:9", "3:2", "4:5"],
		avoid: ["smooth banding", "more than two hues"],
		pairsWith: { palettes: ["warm-earth", "mono-accent", "single-bold"] },
		rationale:
			"Heavy grain over a two-stop fade is what separates a surface that looks printed from one that looks rendered. The grain is the subject here, which is why this is not the wash generator with a parameter turned up.",
		realise: ({ variant }) => ({
			lane: "generator",
			generatorId: "grain-wash",
			params: { angle: 120 + (variant % 5) * 30, grain: 0.45 + (variant % 3) * 0.08, contrast: 0.65 },
		}),
	},
	{
		id: "film-grain",
		name: "Film grain",
		use: "Laid over a photograph or a flat block to take the digital edge off.",
		kind: "texture",
		lane: "generator",
		purposes: ["overlay"],
		tags: ["craft", "editorial", "human", "premium", "creative", "publishing"],
		aspects: ["16:9", "1:1", "3:2"],
		avoid: ["visible tiling", "grain coarse enough to read as dirt"],
		pairsWith: { palettes: ["warm-earth", "mono-accent", "quiet-institutional"] },
		rationale:
			"The one recipe here that is meant to sit on top of something else, so it has no background at all. Transparent output is the whole point — an overlay with a surface behind it is just a second background.",
		realise: ({ variant }) => ({
			lane: "generator",
			generatorId: "grain-overlay",
			params: { amount: 0.16 + (variant % 4) * 0.05, fineness: 0.8 + (variant % 3) * 0.25 },
		}),
	},
	{
		id: "halftone-fade",
		name: "Halftone fade",
		use: "An edge treatment or a corner that needs weight without a picture.",
		kind: "pattern",
		lane: "generator",
		purposes: ["accent", "background"],
		tags: ["technical", "precise", "modern", "bold", "creative", "dense", "data"],
		aspects: ["16:9", "1:1", "21:9"],
		avoid: ["dots large enough to read as a polka pattern", "full-frame coverage"],
		pairsWith: { palettes: ["mono-accent", "deep-technical", "single-bold"] },
		rationale:
			"A dot field that thins out gives a flat block somewhere to end. It fails at full coverage, where it stops being an edge treatment and becomes a texture the content has to fight.",
		realise: ({ variant }) => ({
			lane: "generator",
			generatorId: "halftone",
			params: { spacing: 14 + (variant % 4) * 4, maxRadius: 0.4, angle: 90 + (variant % 4) * 45 },
		}),
	},
	{
		id: "technical-grid",
		name: "Technical grid",
		use: "A quiet background for a product or documentation page.",
		kind: "pattern",
		lane: "generator",
		purposes: ["background"],
		tags: ["technical", "developer", "precise", "dense", "dashboard", "data", "saas", "enterprise"],
		aspects: ["16:9", "1:1", "21:9"],
		avoid: ["a grid dark enough to read through the content", "a second colour"],
		pairsWith: { palettes: ["deep-technical", "quiet-institutional", "mono-accent"] },
		rationale:
			"Blueprint grids are the one decoration a technical product can wear without looking like it is trying. One ink colour, low opacity, sparse marks — at any higher contrast it becomes graph paper and every table on top of it looks misaligned.",
		realise: ({ variant, palette }) => ({
			lane: "generator",
			generatorId: "line-grid",
			params: {
				cell: 48 + (variant % 4) * 16,
				density: 0.2 + (variant % 3) * 0.15,
				// Ink on a dark surface is a light colour on a dark one, where the
				// same opacity reads considerably louder.
				opacity: palette.mode === "dark" ? 0.14 : 0.2,
			},
		}),
	},
	{
		id: "soft-shape",
		name: "Soft shape",
		use: "A blob behind an illustration, a screenshot, or an empty state.",
		kind: "pattern",
		lane: "generator",
		purposes: ["accent"],
		tags: ["friendly", "consumer", "warm", "organic", "clean", "human", "mobile"],
		aspects: ["1:1", "4:5", "3:2"],
		avoid: ["straight segments where the curve should continue", "more than one shape"],
		pairsWith: { palettes: ["warm-earth", "single-bold", "mono-accent"] },
		rationale:
			"One shape, in the brand colour, behind something else. The tell of a generated blob is a visible straight edge between control points, which is why the path is a closed spline rather than a polygon.",
		realise: ({ variant }) => ({
			lane: "generator",
			generatorId: "organic-shape",
			params: { points: 5 + (variant % 6), wobble: 0.22 + (variant % 4) * 0.07, opacity: 0.9 },
		}),
	},
	{
		id: "section-edge",
		name: "Section edge",
		use: "The join between two bands of a long page.",
		kind: "pattern",
		lane: "generator",
		purposes: ["divider"],
		tags: ["marketing", "content", "consumer", "friendly", "launch", "creative"],
		aspects: ["21:9", "16:9"],
		avoid: ["a wave deep enough to eat the content above it", "more than one direction of curve"],
		pairsWith: { palettes: ["warm-earth", "single-bold", "quiet-institutional"] },
		rationale:
			"Filled with the surface colour so it reads as the page pushing up into the section above, rather than as a decoration laid over the join. That single choice is the difference between this looking designed and looking stuck on.",
		realise: ({ variant }) => ({
			lane: "generator",
			generatorId: "section-edge",
			params: { depth: 0.3 + (variant % 4) * 0.12, waves: 1 + (variant % 3), flip: variant % 2 },
		}),
	},
]

/**
 * Every recipe Caret knows, across every lane.
 *
 * The lane a recipe belongs to decides whether it can *run* here, never whether
 * it exists — `runnableRecipes` is the filter, and it takes the set of lanes
 * this build can actually execute. Keeping the catalogue whole means the picker
 * can say "this needs a key" rather than silently having fewer options than the
 * library does.
 */
export const ALL_RECIPES: AssetRecipe[] = [...ASSET_RECIPES, ...RASTER_RECIPES]

/**
 * Every recipe whose lane can actually run, and whose generator exists.
 *
 * The generator check is not paranoia: recipes and generators are separate
 * tables edited by different changes, and a recipe naming a generator that was
 * renamed would throw at the moment the user picks it — after the interview,
 * which is the worst possible time to discover it.
 */
export function runnableRecipes(lanes: ReadonlySet<string>): AssetRecipe[] {
	return ALL_RECIPES.filter((recipe) => {
		if (!lanes.has(recipe.lane)) return false
		if (recipe.lane !== "generator") return true
		const request = recipe.realise({
			palette: { surface: "#fff", raised: "#eee", ink: "#111", brand: "#123456", brandQuiet: "#abcdef", mode: "light" },
			aspect: recipe.aspects[0],
			variant: 0,
			answers: {},
			tags: [],
		})
		return request.lane === "generator" && Boolean(findGenerator(request.generatorId))
	})
}
