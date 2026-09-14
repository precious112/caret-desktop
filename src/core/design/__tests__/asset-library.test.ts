import * as fs from "fs/promises"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as os from "os"
import * as path from "path"
import "should"

import {
	canNarrow,
	composeVariants,
	defaultAspect,
	describeVariant,
	findAssetRecipe,
	GENERATION_QUESTIONS,
	isComplete,
	narrowForAnswers,
	narrowRecipes,
	proposeTag,
} from "../asset-library"
import { GENERATORS, runGenerator } from "../asset-library/generators"
import { derivePalette, hexToHsl, hslToHex } from "../asset-library/palette"
import { ASSET_RECIPES, runnableRecipes } from "../asset-library/recipes"
import { ASPECTS } from "../asset-library/types"
import { addGeneratedAsset } from "../assets/generated"
import { readAssetIndex } from "../assets/store"
import { LIBRARY_TAGS, PALETTE_RECIPES } from "../foundation-library"
import type { FoundationTokens } from "../types"

function tokens(overrides: Partial<FoundationTokens["color"]> = {}): FoundationTokens {
	return {
		vibe: { description: "a tool for technical teams", tags: ["technical", "dense", "precise"] },
		color: {
			brand: { seed: "#2563eb", scale: {} },
			neutral: { character: "cool", scale: {} },
			semantic: { success: "#16a34a", warning: "#ca8a04", error: "#dc2626", info: "#2563eb" },
			...overrides,
		},
		typography: { fontFamily: "Inter", fallback: "system-ui", scaleRatio: 1.25, baseSize: 16, scale: {} },
		spacing: { baseUnit: 4, scale: [0, 4, 8] },
		radius: { character: "soft", scale: [0, 4, 8] },
	}
}

describe("asset recipe library", () => {
	it("only speaks the published vocabulary", () => {
		// Exact matching is the whole narrowing mechanism, so a recipe tag outside
		// the foundation library's vocabulary can never be matched by anything and
		// is dead weight that looks like curation.
		const known = new Set(LIBRARY_TAGS)
		for (const recipe of ASSET_RECIPES) {
			for (const tag of recipe.tags) {
				known.has(tag).should.be.true(`recipe "${recipe.id}" uses unknown tag "${tag}"`)
			}
		}
	})

	it("pairs only with palette recipes that exist", () => {
		// Two tables edited by different changes. A rename here would otherwise
		// surface as a pairing that silently never matches.
		const palettes = new Set(PALETTE_RECIPES.map((recipe) => recipe.id))
		for (const recipe of ASSET_RECIPES) {
			for (const id of recipe.pairsWith.palettes) {
				palettes.has(id).should.be.true(`recipe "${recipe.id}" pairs with unknown palette "${id}"`)
			}
		}
	})

	it("composes for ratios it declares", () => {
		for (const recipe of ASSET_RECIPES) {
			recipe.aspects.length.should.be.above(0)
			for (const aspect of recipe.aspects) {
				Boolean(ASPECTS[aspect]).should.be.true(`recipe "${recipe.id}" names unknown aspect "${aspect}"`)
			}
		}
	})

	it("offers nothing whose generator has been renamed away", () => {
		// The check that matters: a recipe naming a missing generator throws at the
		// moment the user picks it, which is after the interview.
		runnableRecipes(new Set(["generator"])).length.should.equal(
			ASSET_RECIPES.filter((recipe) => recipe.lane === "generator").length,
		)
		runnableRecipes(new Set([])).should.have.length(0)
	})

	it("ranks by overlap and refuses a query that overlaps nothing", () => {
		const technical = narrowRecipes(["technical", "dense", "data"])
			.slice(0, 2)
			.map((recipe) => recipe.id)
		technical.sort().should.deepEqual(["halftone-fade", "technical-grid"])

		// And the same library asked a different question answers differently, or
		// the ranking is not doing anything.
		const human = narrowRecipes(["warm", "human", "craft"])
			.slice(0, 2)
			.map((recipe) => recipe.id)
		human.should.not.containEql("technical-grid")

		canNarrow(["technical"]).ok.should.be.true()
		const refusal = canNarrow(["sleek", "professional", "modern-looking"])
		refusal.ok.should.be.false()
		// The refusal has to name the vocabulary, or the caller cannot recover.
		;(refusal as { reason: string }).reason.should.containEql("editorial")
	})
})

describe("the product cutout recipe", () => {
	it("asks for the key Caret chose, and carries it for the runner to remove", () => {
		const recipe = findAssetRecipe("product-cutout")!
		const [variant] = composeVariants({ recipe, tokens: tokens(), aspect: "1:1", count: 1 })
		variant.request.lane.should.equal("raster")
		if (variant.request.lane !== "raster") return

		// Plain white, which the runner floods away from the frame edge. Not a key
		// colour: asked for a specific hex the model returns a flat background of
		// its own choosing, and gating on the hex refused perfect pictures.
		variant.request.prompt.should.containEql("white")
		variant.request.transparent.should.be.true()
		// The slop tells still compose in — a keyed recipe is not exempt.
		variant.request.avoid.join(" ").should.containEql("cast shadow")
	})

	it("asks for the same white whatever the project's own brand is", () => {
		// The old mechanism swapped the key colour when the brand collided with it.
		// Nothing collides with "no background", so the instruction is now the same
		// for every project — one less thing for the model to get wrong.
		const recipe = findAssetRecipe("product-cutout")!
		const green = tokens({ brand: { seed: "#16a34a", scale: {} } })
		const [variant] = composeVariants({ recipe, tokens: green, aspect: "1:1", count: 1 })
		if (variant.request.lane !== "raster") return
		variant.request.prompt.should.containEql("pure flat white")
	})

	it("is what the cutout purpose narrows to", () => {
		const cutouts = narrowForAnswers({ purpose: "cutout", volume: "balanced" }, tokens(), new Set(["generator", "raster"]))
		cutouts.map((recipe) => recipe.id).should.deepEqual(["product-cutout"])
		// And no free-lane answer offers it by accident — it costs money.
		narrowForAnswers({ purpose: "background", volume: "recede" }, tokens(), new Set(["generator", "raster"]))
			.map((recipe) => recipe.id)
			.should.not.containEql("product-cutout")
	})
})

describe("the generation interview", () => {
	it("asks about the job, never about the look", () => {
		// The load-bearing property of the whole surface. A question offering a
		// free-text answer is a prompt box with better manners, and the phase
		// exists specifically to not have one.
		GENERATION_QUESTIONS.should.have.length(2)
		for (const question of GENERATION_QUESTIONS) {
			question.choices.length.should.be.above(1)
			for (const choice of question.choices) {
				choice.label.should.not.be.empty()
				choice.hint.should.not.be.empty()
			}
		}
	})

	it("filters by purpose rather than ranking by it", () => {
		// A section divider offered as a hero background is not a worse match, it
		// is the wrong object, and no tag overlap should promote it.
		const backgrounds = narrowForAnswers({ purpose: "background", volume: "recede" }, tokens())
		backgrounds.map((recipe) => recipe.id).should.not.containEql("section-edge")
		backgrounds.every((recipe) => recipe.purposes.includes("background")).should.be.true()

		const dividers = narrowForAnswers({ purpose: "divider", volume: "lead" }, tokens())
		dividers.map((recipe) => recipe.id).should.deepEqual(["section-edge"])
	})

	it("lets the volume answer reorder the same set", () => {
		const quiet = narrowForAnswers({ purpose: "background", volume: "recede" }, tokens())
		const loud = narrowForAnswers({ purpose: "background", volume: "lead" }, tokens())
		quiet.map((recipe) => recipe.id).should.not.deepEqual(loud.map((recipe) => recipe.id))
	})

	it("offers everything when nothing has been answered yet", () => {
		narrowForAnswers({}, tokens()).length.should.equal(ASSET_RECIPES.length)
	})

	it("opens on proportions that suit the job", () => {
		const wash = findAssetRecipe("quiet-wash")
		defaultAspect(wash!, { purpose: "background" }).should.equal("16:9")
		// And never on a ratio the recipe was not composed for, whatever the job
		// would prefer.
		const shape = findAssetRecipe("soft-shape")
		shape!.aspects.should.containEql(defaultAspect(shape!, { purpose: "background" }))
	})

	it("proposes a name that reads like the slot, not like the recipe", () => {
		proposeTag(findAssetRecipe("quiet-wash")!, { purpose: "background" }).should.equal("hero-quiet-wash")
		proposeTag(findAssetRecipe("soft-shape")!, { purpose: "accent" }).should.equal("soft-shape")
	})

	it("knows when it has enough to proceed", () => {
		isComplete({}).should.be.false()
		isComplete({ purpose: "background" }).should.be.false()
		isComplete({ purpose: "background", volume: "recede" }).should.be.true()
		// An answer Caret does not recognise is not an answer.
		isComplete({ purpose: "background", volume: "whatever" }).should.be.false()
	})
})

describe("palette derived from the foundation", () => {
	it("puts a dark project on a dark surface, and says so", () => {
		const light = derivePalette(tokens())
		const dark = derivePalette(tokens({ surface: "dark" }))

		light.mode.should.equal("light")
		dark.mode.should.equal("dark")
		hexToHsl(light.surface).l.should.be.above(0.9)
		hexToHsl(dark.surface).l.should.be.below(0.15)
		// The lightness gap between surface and ink is the decision; without it
		// everything lands in the muddy middle.
		Math.abs(hexToHsl(dark.surface).l - hexToHsl(dark.ink).l).should.be.above(0.7)
	})

	it("keeps the brand visible on whichever surface it lands on", () => {
		// A committed seed that is dark is invisible on a dark page, and one that
		// is bright is unusable under text on a light one. Both are the same bug.
		const onDark = derivePalette(tokens({ brand: { seed: "#0b2a6f", scale: {} }, surface: "dark" }))
		hexToHsl(onDark.brand).l.should.be.aboveOrEqual(0.6)

		const onLight = derivePalette(tokens({ brand: { seed: "#9fd0ff", scale: {} } }))
		hexToHsl(onLight.brand).l.should.be.belowOrEqual(0.47)
	})

	it("tints neutrals by the foundation's own character rather than using grey", () => {
		const warm = derivePalette(tokens({ neutral: { character: "warm", scale: {} } }))
		const cool = derivePalette(tokens({ neutral: { character: "cool", scale: {} } }))
		const plain = derivePalette(tokens({ neutral: { character: "true", scale: {} } }))

		hexToHsl(warm.raised).s.should.be.above(0)
		hexToHsl(cool.raised).s.should.be.above(0)
		hexToHsl(plain.raised).s.should.equal(0)
		warm.raised.should.not.equal(cool.raised)
	})

	it("treats a foundation written before the surface field as light", () => {
		derivePalette(tokens()).mode.should.equal("light")
		derivePalette(null).mode.should.equal("light")
	})

	it("round-trips hex through hsl", () => {
		for (const hex of ["#2563eb", "#ffffff", "#000000", "#7f3d0a"]) {
			hslToHex(hexToHsl(hex)).should.equal(hex)
		}
	})
})

describe("generators", () => {
	const palette = derivePalette(tokens())

	it("produce well-formed svg for every generator at every aspect", () => {
		for (const generator of GENERATORS) {
			for (const aspect of Object.values(ASPECTS)) {
				const output = runGenerator(generator.id, {
					palette,
					width: aspect.width,
					height: aspect.height,
					seed: 7,
					params: {},
				})
				output.should.startWith("<svg xmlns=")
				output.should.endWith("</svg>\n")
				output.should.containEql(`viewBox="0 0 ${aspect.width} ${aspect.height}"`)
				output.should.not.containEql("NaN")
				output.should.not.containEql("undefined")
				// e-7 in a coordinate is a float printed at full precision, which
				// makes the committed file re-diff on any refactor.
				output.should.not.match(/e-\d/)
			}
		}
	})

	it("are deterministic — the same seed is the same bytes", () => {
		for (const generator of GENERATORS) {
			const once = runGenerator(generator.id, { palette, width: 800, height: 600, seed: 42, params: {} })
			const twice = runGenerator(generator.id, { palette, width: 800, height: 600, seed: 42, params: {} })
			const other = runGenerator(generator.id, { palette, width: 800, height: 600, seed: 43, params: {} })
			once.should.equal(twice)
			// And a different seed is a different picture, or "variants" is a lie.
			once.should.not.equal(other)
		}
	})

	it("clamp parameters to the range they were designed for", () => {
		// A 400px dot spacing on a 1200px frame is four dots: valid SVG, broken
		// picture. Clamping centrally means no recipe or agent can reach that.
		const absurd = runGenerator("halftone", {
			palette,
			width: 1200,
			height: 800,
			seed: 1,
			params: { spacing: 4000, maxRadius: 99, angle: -900 },
		})
		const clamped = runGenerator("halftone", {
			palette,
			width: 1200,
			height: 800,
			seed: 1,
			params: { spacing: 48, maxRadius: 0.5, angle: -900 },
		})
		absurd.should.equal(clamped)
	})

	it("declare a default inside their own range", () => {
		for (const generator of GENERATORS) {
			for (const [key, spec] of Object.entries(generator.params)) {
				spec.default.should.be.aboveOrEqual(spec.min, `${generator.id}.${key}`)
				spec.default.should.be.belowOrEqual(spec.max, `${generator.id}.${key}`)
			}
		}
	})

	it("keeps transparent generators free of an opaque background", () => {
		for (const generator of GENERATORS.filter((g) => g.transparent)) {
			const output = runGenerator(generator.id, { palette, width: 400, height: 400, seed: 3, params: {} })
			// A full-frame rect filled with the surface colour is exactly the
			// background an overlay must not carry.
			output.should.not.containEql(`fill="${palette.surface}"/><rect`)
			output.should.not.containEql(`<rect width="400" height="400" fill="${palette.surface}"`)
		}
	})

	it("refuses an unknown generator by naming the ones that exist", () => {
		;(() => runGenerator("nope", { palette, width: 10, height: 10, seed: 0, params: {} })).should.throw(
			/No such generator: "nope"\. Known: .*mesh-gradient/,
		)
	})
})

describe("composing variants", () => {
	it("returns complete assets for the generator lane, all different", () => {
		const recipe = findAssetRecipe("quiet-wash")!
		const variants = composeVariants({ recipe, tokens: tokens(), count: 6 })

		variants.should.have.length(6)
		const rendered = new Set(variants.map((variant) => variant.svg))
		rendered.size.should.equal(6)
		for (const variant of variants) {
			variant.request.lane.should.equal("generator")
			variant.svg!.should.startWith("<svg")
		}
	})

	it("gives two recipes on the same generator different pictures", () => {
		// Without a per-recipe seed offset, "try a different recipe" silently
		// returns the previous one whenever both realise onto one generator.
		const a = composeVariants({ recipe: findAssetRecipe("soft-shape")!, tokens: tokens(), count: 1 })
		const b = composeVariants({
			recipe: { ...findAssetRecipe("soft-shape")!, id: "soft-shape-alternate" },
			tokens: tokens(),
			count: 1,
		})
		a[0].svg!.should.not.equal(b[0].svg)
	})

	it("uses the recipe's first declared aspect and refuses to invent one", () => {
		const recipe = findAssetRecipe("section-edge")!
		composeVariants({ recipe, tokens: tokens(), count: 1 })[0].width.should.equal(ASPECTS["21:9"].width)
		composeVariants({ recipe, tokens: tokens(), aspect: "1:1", count: 1 })[0].width.should.equal(ASPECTS["1:1"].width)
		// An aspect nobody declared falls back to the recipe's own default.
		composeVariants({ recipe, tokens: tokens(), aspect: "7:3", count: 1 })[0].width.should.equal(ASPECTS["21:9"].width)
	})

	it("reads the foundation — a dark project gets a dark asset", () => {
		const recipe = findAssetRecipe("quiet-wash")!
		const light = composeVariants({ recipe, tokens: tokens(), count: 1 })[0]
		const dark = composeVariants({ recipe, tokens: tokens({ surface: "dark" }), count: 1 })[0]
		light.svg!.should.not.equal(dark.svg)
		dark.svg!.should.containEql(derivePalette(tokens({ surface: "dark" })).surface)
	})

	it("describes what it produced without asking a model", () => {
		const recipe = findAssetRecipe("technical-grid")!
		const [variant] = composeVariants({ recipe, tokens: tokens(), count: 1 })
		const description = describeVariant(recipe, variant, derivePalette(tokens()))
		description.should.containEql("wide")
		description.should.containEql("light")
		description.should.containEql("Technical grid")
	})
})

describe("recording a generated asset", () => {
	let project: string

	beforeEach(async () => {
		project = await fs.mkdtemp(path.join(os.tmpdir(), "caret-generated-"))
	})

	afterEach(async () => {
		await fs.rm(project, { recursive: true, force: true })
	})

	it("lands as an ordinary asset that carries where it came from", async () => {
		const recipe = findAssetRecipe("quiet-wash")!
		const [variant] = composeVariants({ recipe, tokens: tokens(), count: 1 })

		const result = await addGeneratedAsset({
			projectPath: project,
			tag: "quiet-wash",
			extension: ".svg",
			bytes: Buffer.from(variant.svg!, "utf-8"),
			description: describeVariant(recipe, variant, derivePalette(tokens())),
			alt: "",
			origin: {
				type: "generated",
				lane: "generator",
				producer: "mesh-gradient",
				recipeId: recipe.id,
				answers: { where: "hero" },
				resolved: JSON.stringify(variant.request),
			},
		})

		result.ok.should.be.true()
		const index = await readAssetIndex(project)
		index.assets.should.have.length(1)

		const entry = index.assets[0]
		entry.tag.should.equal("quiet-wash")
		entry.kind.should.equal("vector")
		entry.mime.should.equal("image/svg+xml")
		// Derived by the reindex, not by the generated path — the two must agree.
		entry.hash.should.startWith("sha256:")
		Number(entry.width).should.equal(ASPECTS["16:9"].width)
		entry.description.should.containEql("Quiet colour wash")
		entry.origin.type.should.equal("generated")
		;(entry.origin as { recipeId: string }).recipeId.should.equal("quiet-wash")
		;(entry.origin as { answers: Record<string, string> }).answers.where.should.equal("hero")
	})

	it("does not clobber an earlier run of the same recipe", async () => {
		const recipe = findAssetRecipe("soft-shape")!
		const variants = composeVariants({ recipe, tokens: tokens(), count: 2 })

		for (const variant of variants) {
			await addGeneratedAsset({
				projectPath: project,
				tag: "soft-shape",
				extension: ".svg",
				bytes: Buffer.from(variant.svg!, "utf-8"),
				description: "a shape",
				alt: "",
				origin: { type: "generated", lane: "generator", producer: "organic-shape", recipeId: recipe.id },
			})
		}

		const index = await readAssetIndex(project)
		index.assets.should.have.length(2)
		index.assets
			.map((asset) => asset.tag)
			.sort()
			.should.deepEqual(["soft-shape", "soft-shape-2"])
	})

	it("refuses an empty result rather than indexing a zero-byte file", async () => {
		const result = await addGeneratedAsset({
			projectPath: project,
			tag: "empty",
			extension: ".svg",
			bytes: Buffer.alloc(0),
			description: "",
			alt: "",
			origin: { type: "generated", lane: "generator", producer: "mesh-gradient" },
		})
		result.ok.should.be.false()
		;(await readAssetIndex(project)).assets.should.have.length(0)
	})

	it("leaves nothing behind when the extension is not one the layer serves", async () => {
		const result = await addGeneratedAsset({
			projectPath: project,
			tag: "notes",
			extension: ".txt",
			bytes: Buffer.from("hello"),
			description: "",
			alt: "",
			origin: { type: "generated", lane: "generator", producer: "mesh-gradient" },
		})
		result.ok.should.be.false()
		;(await readAssetIndex(project)).assets.should.have.length(0)
		// The orphan matters: a file in the assets directory that nothing indexes
		// still reaches the user's commit and the sync.
		;(await fs.readdir(path.join(project, ".caret", "assets"))).should.not.containEql("notes.txt")
	})
})
