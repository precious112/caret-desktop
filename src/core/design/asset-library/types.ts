/**
 * The generated-asset recipe library's data model.
 *
 * Deliberately the same shape as `foundation-library/`: a curated set of things
 * somebody thought about, narrowed by the project's own vibe tags, offered as
 * pictures to point at. The argument is the one from Phase 6.5 and it does not
 * change here — **the user never gets a prompt box.** They answer questions
 * about what the asset is for, Caret composes the request, N variants come back,
 * they point at one. A prompt box hands the taste problem back to the person who
 * does not have it, and `cinematic, 8k, hyperdetailed` is precisely the artefact
 * that makes generated imagery legible as generated.
 *
 * One recipe type across all four lanes. What varies is how a recipe is
 * *realised* — a prompt, a set of generator parameters, an icon set, a brief for
 * a render-compare loop — which keeps the interview, the narrowing and the pick
 * screen identical regardless of what produced the pixels.
 */
import type { FoundationTokens } from "../types"

/** What the asset is, which decides where it belongs on a page. */
export type RecipeKind = "photo" | "texture" | "pattern" | "gradient" | "mark"

/**
 * The job an asset does, which is what the user is actually asked about.
 *
 * Separate from `kind` on purpose. Kind describes the artefact; purpose
 * describes the slot, and only one of those is a question a non-designer can
 * answer. It also **filters** rather than ranks — a section divider offered as
 * a hero background is not a worse match, it is the wrong object.
 */
export type AssetPurpose = "background" | "overlay" | "accent" | "divider" | "mark" | "object3d" | "cutout"

/**
 * How a recipe is realised. Only `raster` costs money, and only `raster`
 * needs an account of any kind.
 */
export type RecipeLane = "raster" | "generator" | "iconset" | "authored"

/** Ratios a recipe was composed for. Anything else is a crop of somebody's idea. */
export const ASPECTS: Record<string, { width: number; height: number; label: string }> = {
	"21:9": { width: 2100, height: 900, label: "Ultra-wide banner" },
	"16:9": { width: 1920, height: 1080, label: "Wide" },
	"3:2": { width: 1800, height: 1200, label: "Landscape" },
	"1:1": { width: 1200, height: 1200, label: "Square" },
	"4:5": { width: 1080, height: 1350, label: "Portrait" },
	"9:16": { width: 1080, height: 1920, label: "Tall" },
}

/**
 * The colours a recipe is allowed to use, derived from `foundation.json`.
 *
 * Derived rather than chosen: this is the point where the foundation stops
 * describing the project and starts producing things for it, and an asset that
 * fights the palette is worse than no asset at all.
 */
export interface GeneratorPalette {
	/** The page background this asset will sit on. */
	surface: string
	/** One step away from the surface — a raised card, a band. */
	raised: string
	/** Text-weight contrast against the surface. */
	ink: string
	/** The brand colour at the step that actually reads on this surface. */
	brand: string
	/** A quieter brand step, for a second gradient stop or a wash. */
	brandQuiet: string
	mode: "light" | "dark"
}

/** What the user settled, plus everything the recipe needs to compose a request. */
export interface RecipeInput {
	palette: GeneratorPalette
	/** Key from `ASPECTS`. */
	aspect: string
	/**
	 * Which variant this is, 0-based.
	 *
	 * The only source of variation. Generators consume it as a seed, so twelve
	 * variants cost twelve integers; the raster lane passes it through so a
	 * re-run of the same choice reproduces the same request.
	 */
	variant: number
	/** The interview answers, verbatim, so provenance records what was asked. */
	answers: Record<string, string>
	/** The project's own vibe tags, from `foundation.json`. */
	tags: string[]
}

/**
 * A composed request, ready for whichever runner owns the lane.
 *
 * Discriminated by lane so a runner cannot be handed the wrong shape, and so a
 * lane with no runner yet is a compile error at the call site rather than a
 * request that silently does nothing.
 */
export type RecipeRequest =
	| {
			lane: "generator"
			generatorId: string
			/** Numeric only, so a realised request is diffable and re-runnable. */
			params: Record<string, number>
	  }
	| {
			lane: "raster"
			prompt: string
			/** Negative constraints — the documented slop tells, composed in. */
			avoid: string[]
			aspect: string
			/**
			 * The subject is to be cut out.
			 *
			 * The model is asked for a plain white background and the runner floods
			 * it away from the frame edge before any variant is shown, so what the
			 * user picks is the finished cutout rather than a promise of one. There
			 * is no key colour: asked for a specific hex the model returns a flat
			 * background of its own choosing, and gating on the hex threw away
			 * perfect pictures.
			 */
			transparent: boolean
	  }
	| { lane: "iconset"; setId: string; weight?: string }
	| { lane: "authored"; brief: string; avoid: string[] }

export interface AssetRecipe {
	id: string
	name: string
	/** When to reach for this, in plain language. Shown under the specimen. */
	use: string
	kind: RecipeKind
	lane: RecipeLane
	/** The slots this belongs in. At least one, and they filter the offer. */
	purposes: AssetPurpose[]
	/**
	 * The **shared** vocabulary — `LIBRARY_TAGS` from the foundation library.
	 *
	 * Sharing is load-bearing rather than tidy: a project's committed vibe tags
	 * narrow these recipes directly, with no second vocabulary to keep in sync.
	 * Matching is exact, which is why the vocabulary is published and a query
	 * overlapping nothing is refused rather than answered — an unmatched query
	 * ranks every candidate zero and degenerates to declaration order, which is
	 * indistinguishable from a real narrowing.
	 */
	tags: string[]
	/** Keys from `ASPECTS`. The first is the default. */
	aspects: string[]
	/** Composes the request. Pure — no I/O, no clock, no randomness but `variant`. */
	realise(input: RecipeInput): RecipeRequest
	/** Negative constraints. Carried into the prompt for lanes that take one. */
	avoid: string[]
	/** Palette recipes this was designed against, by `PaletteRecipe.id`. */
	pairsWith: { palettes: string[] }
	/** Why this exists and when it fails, for the library and for review. */
	rationale: string
}

/** The tokens a recipe reads. Null when the project has no foundation yet. */
export type RecipeFoundation = FoundationTokens | null
