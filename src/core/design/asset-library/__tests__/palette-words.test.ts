/**
 * The palette's jurisdiction in a photograph prompt: the setting, never the
 * subject.
 *
 * The failure this holds down shipped to a real project: a photograph of a
 * green plant was sent "at most one small accent of green, occupying a few
 * percent of the frame if it appears at all. Muted, desaturated overall." —
 * an instruction to suppress the subject's own colour and drain the frame,
 * for every image, in every project. The palette may claim the environment
 * and the grade; the subject keeps the colours it actually has.
 */
import { strict as assert } from "assert"

import { foundationWords, paletteWords } from "../raster/palette-words"
import type { GeneratorPalette } from "../types"

const WARM_DARK: GeneratorPalette = {
	surface: "#0A0A0A",
	raised: "#1d1717",
	ink: "#F5F5F5",
	brand: "#2f6b4a",
	brandQuiet: "#1d4530",
	mode: "dark",
}

describe("paletteWords", () => {
	it("scopes the palette to the setting and leaves the subject its own colours", () => {
		const words = paletteWords(WARM_DARK)
		assert.ok(/setting|surfaces around/i.test(words), "the palette claims more than the environment")
		assert.ok(/subject itself keeps its own true colours/i.test(words), "the subject's colours are not protected")
	})

	it("no longer desaturates every photograph as universal law", () => {
		const words = paletteWords(WARM_DARK)
		assert.ok(!/muted, desaturated overall/i.test(words), "the blanket desaturation clamp is back")
	})

	it("names the accent as welcome, not capped at a few percent of the frame", () => {
		const words = paletteWords(WARM_DARK)
		assert.ok(!/few percent/i.test(words), "the subject-starving accent cap is back")
		assert.ok(/green/.test(words), "a saturated brand hue goes unmentioned")
	})

	it("keeps the surface key sentence, which is integration rather than taste", () => {
		assert.ok(/low-key/i.test(foundationWords(WARM_DARK)), "a dark project lost its low-key guidance")
	})
})
