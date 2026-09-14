/**
 * The photograph recipes.
 *
 * These are the ones with actual taste in them, and the ones the plan says the
 * user reviews. A recipe is not "a prompt with blanks" — it is a decision about
 * **what to photograph and how to frame it**, made once, by someone thinking
 * about where the image goes.
 *
 * Three things every recipe here does, and each fixes a specific way generated
 * imagery gives itself away:
 *
 * - **Names a subject that is not a metaphor.** A workbench, a window, a stack
 *   of paper. The handshake / lightbulb / ladder family is what a model reaches
 *   for when asked to illustrate an abstraction, and it is instantly legible as
 *   stock.
 * - **Composes for the slot.** "Empty space in the top-left third so a headline
 *   can sit there" is the whole reason this beats a stock search, and it is
 *   something no prompt box user thinks to ask for.
 * - **Says how it is lit, from the foundation.** Low-key for a dark project,
 *   high-key for a light one, muted either way. This is what stops the image
 *   fighting the page it lands on.
 *
 * The negative list is composed in separately (`SLOP_TELLS`), so it stays
 * legible in the provenance record rather than being woven into prose.
 */
import type { AssetRecipe } from "../types"
import { foundationWords, paletteWords } from "./palette-words"

/** Where the headline goes, in words a model composes to. */
const HEADROOM = "Leave the top-left third deliberately empty and low-contrast so a headline can sit there and stay readable."

/**
 * The source image a 3D model is built from.
 *
 * Not a hero shot — the opposite of one. Image-to-3D reconstruction wants what
 * every other recipe here avoids: one object, dead centre, fully in frame,
 * even light, nothing else in the picture. A scene gives the reconstructor
 * several objects to fuse into one lump, which is exactly the failure the
 * verification layer downstream exists to catch before credits are spent.
 *
 * The subject rotates by variant, so generate-and-pick offers four different
 * objects rather than four angles of one — for a source image the *what* is
 * the choice, and the framing is deliberately identical.
 */
const OBJECT_STUDY: AssetRecipe = {
	id: "object-study",
	name: "Object study",
	use: "A single object on a plain background — the source a 3D model is built from.",
	kind: "photo",
	lane: "raster",
	purposes: ["object3d"],
	tags: ["product", "clean", "modern", "minimal", "consumer"],
	aspects: ["1:1"],
	avoid: [
		"any second object, prop or hand",
		"hard shadows or dramatic lighting",
		"the object cropped by the frame edge",
		"reflections that read as extra geometry",
	],
	pairsWith: { palettes: ["mono-accent", "warm-earth", "quiet-institutional"] },
	rationale:
		"Reconstruction quality is decided by the source: one object, all of it visible, on a background that offers no competing geometry. Deliberately not lit from the foundation's key — a low-key hero treatment hides half the object, and the 3D model of half an object is half a model.",
	realise: ({ palette, variant }) => ({
		lane: "raster",
		prompt: [
			`A product photograph of ${objectOf(variant)}, alone, centered, the whole object visible in frame.`,
			"Seamless plain studio background, soft even light from all sides, only a gentle contact shadow.",
			"No other items, no hands, no props, no text.",
			paletteWords(palette),
		].join(" "),
		avoid: [],
		aspect: "1:1",
		transparent: false,
	}),
}

function objectOf(variant: number): string {
	return [
		"a small ceramic vase with a simple silhouette",
		"a modern table lamp",
		"a pair of over-ear headphones",
		"a potted succulent in a plain pot",
		"a classic wooden chair",
		"a wristwatch on a stand",
	][variant % 6]
}

/**
 * A photographic object with the background removed.
 *
 * The §4.7 transparency rule made concrete: the model never *matts* anything.
 * The prompt asks for the object on a flat key colour Caret chose — green
 * unless this project's own brand is green — and the runner keys that colour
 * out deterministically before the variant is ever shown. What the user picks
 * is the finished cutout on their own surface, not a promise of one.
 *
 * No contact shadow, unlike the object study: a shadow survives the key as a
 * grey-green smear under the object, and a cutout carries its own shadow onto
 * whatever page it lands on anyway.
 */
const PRODUCT_CUTOUT: AssetRecipe = {
	id: "product-cutout",
	name: "Product cutout",
	use: "An object cut out clean — for a hero, a card, or anywhere it sits straight on the page.",
	kind: "photo",
	lane: "raster",
	purposes: ["cutout"],
	tags: ["product", "clean", "modern", "minimal", "consumer", "premium"],
	aspects: ["1:1", "4:5", "3:2"],
	avoid: [
		"any cast shadow or reflection under or behind the object",
		"any second object, prop or hand",
		"the object cropped by the frame edge",
		"the key colour appearing on the object itself",
	],
	pairsWith: { palettes: ["mono-accent", "warm-earth", "quiet-institutional", "deep-technical"] },
	rationale:
		"Plain white, flooded away from the frame edge. The earlier version named an exact hex for the model to paint and keyed that colour out; measured on real generations the model returns a flat background of its own choosing every time — 0% agreement with the colour requested, 100% with itself — so perfect cutouts were refused for failing a test of the instruction rather than of the picture. White is not a colour it has to match. Flooding from the edge rather than thresholding globally keeps white that belongs to the subject, because that white is not reachable from outside.",
	realise: ({ variant }) => ({
		lane: "raster",
		prompt: [
			`A product photograph of ${objectOf(variant)}, alone, centered, the whole object visible in frame.`,
			"The background is pure flat white (#ffffff) filling every edge of the frame, and nothing else is in the picture.",
			"Soft even studio light from all sides. No shadow, no reflection, no vignette.",
		].join(" "),
		avoid: [],
		aspect: "1:1",
		transparent: true,
	}),
}

export const RASTER_RECIPES: AssetRecipe[] = [
	OBJECT_STUDY,
	PRODUCT_CUTOUT,
	{
		id: "workbench",
		name: "Made by hand",
		use: "A hero for something built with care — tools, craft, a product with a maker behind it.",
		kind: "photo",
		lane: "raster",
		purposes: ["background"],
		tags: ["craft", "human", "warm", "organic", "premium", "considered", "editorial"],
		aspects: ["16:9", "21:9", "3:2"],
		avoid: ["hands holding the product", "a person looking at the camera", "brand-new unused tools"],
		pairsWith: { palettes: ["warm-earth", "mono-accent", "quiet-institutional"] },
		rationale:
			"An overhead workbench is the least metaphorical way to say 'somebody made this'. It fails the moment a person enters the frame — then it is a stock photo about teamwork, and the viewer stops looking at the object.",
		realise: ({ palette, variant }) => ({
			lane: "raster",
			prompt: [
				"An overhead photograph of a worn wooden workbench with a few well-used hand tools resting on it.",
				"No people, no hands.",
				angleOf(variant),
				HEADROOM,
				foundationWords(palette),
				"Shot on 35mm film. Natural imperfections, dust and scratches left in.",
			].join(" "),
			avoid: [],
			aspect: "16:9",
			transparent: false,
		}),
	},
	{
		id: "quiet-room",
		name: "A quiet room",
		use: "A hero for something calm — writing, reading, thinking, a tool you live in.",
		kind: "photo",
		lane: "raster",
		purposes: ["background"],
		tags: ["calm", "considered", "minimal", "editorial", "premium", "reading", "publishing"],
		aspects: ["16:9", "21:9", "3:2", "4:5"],
		avoid: ["a styled interior-magazine set", "plants arranged for the photograph", "visible screens"],
		pairsWith: { palettes: ["mono-accent", "quiet-institutional", "warm-earth"] },
		rationale:
			"An empty room with good light carries mood without carrying a subject, which is what a page with a lot of words needs behind it. It fails when it becomes interiors photography — the moment it looks styled, it reads as an advert for the furniture.",
		realise: ({ palette, variant }) => ({
			lane: "raster",
			prompt: [
				"A photograph of a plain, almost empty room with daylight falling across one wall.",
				"No people. Ordinary, slightly imperfect — a lived-in room, not a styled set.",
				angleOf(variant),
				HEADROOM,
				foundationWords(palette),
				"Shot on 35mm film, shallow depth of field.",
			].join(" "),
			avoid: [],
			aspect: "16:9",
			transparent: false,
		}),
	},
	{
		id: "close-material",
		name: "Close on a material",
		use: "A section background or a card image where the subject should not compete with the text.",
		kind: "texture",
		lane: "raster",
		purposes: ["background", "accent"],
		tags: ["premium", "craft", "minimal", "considered", "modern", "clean"],
		aspects: ["16:9", "1:1", "3:2", "21:9"],
		avoid: ["a recognisable object", "a pattern regular enough to read as a tile"],
		pairsWith: { palettes: ["mono-accent", "warm-earth", "deep-technical"] },
		rationale:
			"Macro material — paper, linen, concrete, brushed metal — is the safest photographic background there is, because it has no subject to argue with the content. It fails if it becomes recognisable: once you can name the object, it is a picture of that object.",
		realise: ({ palette, variant }) => ({
			lane: "raster",
			prompt: [
				`An extreme close-up photograph of ${materialOf(variant)}, filling the frame.`,
				"Abstract at this distance — the material should not be identifiable as a specific object.",
				"Raking light across the surface so the texture reads.",
				foundationWords(palette),
				"Shot on medium format. Fine grain.",
			].join(" "),
			avoid: [],
			aspect: "16:9",
			transparent: false,
		}),
	},
	{
		id: "long-view",
		name: "The long view",
		use: "A wide banner where the page needs air — a footer, a section break, a full-bleed strip.",
		kind: "photo",
		lane: "raster",
		purposes: ["background", "divider"],
		tags: ["calm", "premium", "editorial", "minimal", "considered", "serious"],
		aspects: ["21:9", "16:9"],
		avoid: ["a postcard landmark", "a dramatic sunset", "anything a travel brand would use"],
		pairsWith: { palettes: ["mono-accent", "quiet-institutional", "deep-technical"] },
		rationale:
			"A wide, mostly-empty horizon gives a long page somewhere to breathe. It fails as soon as it is somewhere identifiable or the sky is doing something — then it stops being negative space and becomes a photograph people look at.",
		realise: ({ palette, variant }) => ({
			lane: "raster",
			prompt: [
				`A wide photograph of ${horizonOf(variant)}, mostly empty.`,
				"Overcast, flat light. Nowhere identifiable. Nothing dramatic in the sky.",
				"The horizon sits in the lower third; the upper two thirds are close to empty.",
				foundationWords(palette),
				"Shot on 35mm film, slight haze.",
			].join(" "),
			avoid: [],
			aspect: "21:9",
			transparent: false,
		}),
	},
	{
		id: "desk-overhead",
		name: "Work in progress",
		use: "A hero for a tool people work in — something in the middle of being used, not finished.",
		kind: "photo",
		lane: "raster",
		purposes: ["background"],
		tags: ["technical", "precise", "product", "saas", "developer", "modern", "dense"],
		aspects: ["16:9", "3:2", "21:9"],
		avoid: ["a laptop with a fake interface on it", "a tidy flat-lay", "coffee-and-notebook stock"],
		pairsWith: { palettes: ["deep-technical", "mono-accent", "quiet-institutional"] },
		rationale:
			"Paper, notes and half-finished work say 'a tool for doing something' without needing a screenshot. It fails the instant a screen is visible: a model will invent an interface on it, and an invented interface is the single most obvious tell in this whole lane.",
		realise: ({ palette, variant }) => ({
			lane: "raster",
			prompt: [
				"An overhead photograph of a desk mid-work: loose paper, handwritten notes, a pen set down.",
				"No screens of any kind. No people. Deliberately untidy — it is in use, not arranged.",
				angleOf(variant),
				HEADROOM,
				foundationWords(palette),
				"Shot on 35mm film.",
			].join(" "),
			avoid: [],
			aspect: "16:9",
			transparent: false,
		}),
	},
]

/**
 * The only source of variation between raster variants.
 *
 * Deliberately camera decisions rather than subject decisions: five photographs
 * of the same workbench from five angles is a set to choose from, whereas five
 * different subjects is five different recipes and the user is back to
 * guessing. Seeds do not exist here — the model's own sampling supplies the
 * rest of the difference.
 */
function angleOf(variant: number): string {
	return [
		"Shot straight down from directly above.",
		"Shot from a low three-quarter angle, close to the surface.",
		"Shot from the side at table height, the far edge falling out of focus.",
		"Shot from above and slightly to one side, the surface running diagonally across the frame.",
	][variant % 4]
}

function materialOf(variant: number): string {
	return [
		"heavy cotton paper with a deckled edge",
		"coarse linen weave",
		"unpolished concrete",
		"brushed metal with fine directional grain",
		"raw plaster with a hand-trowelled surface",
		"end-grain wood",
	][variant % 6]
}

function horizonOf(variant: number): string {
	return [
		"a flat coastline under low cloud",
		"an empty field meeting the sky",
		"still water with a distant shore",
		"low hills seen from far away through haze",
	][variant % 4]
}
