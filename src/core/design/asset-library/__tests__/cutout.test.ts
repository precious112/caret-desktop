/**
 * Separating a subject from a plain white background.
 *
 * This replaced chroma-key, which could not succeed: asked to paint an exact
 * hex the model returns a flat background of its own choosing, measured on a
 * real generation at 0% agreement with the colour requested and 100% with
 * itself. A flawless cutout was refused for failing a test of the instruction
 * rather than of the picture.
 */
import { strict as assert } from "assert"

import { removeFlatBackground } from "../raster/cutout"

/** An RGBA frame: white everywhere, with `paint` allowed to draw on it. */
function frame(width: number, height: number, paint?: (x: number, y: number) => [number, number, number] | null) {
	const data = new Uint8Array(width * height * 4)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4
			const drawn = paint?.(x, y) ?? null
			const [r, g, b] = drawn ?? [255, 255, 255]
			data[i] = r
			data[i + 1] = g
			data[i + 2] = b
			data[i + 3] = 255
		}
	}
	return { data, width, height, order: "rgba" as const }
}

const alphaAt = (image: ReturnType<typeof frame>, x: number, y: number) => image.data[(y * image.width + x) * 4 + 3]

describe("removeFlatBackground", () => {
	it("cuts the background and leaves the subject alone", () => {
		// A grey block in the middle, the case that failed live: steel is mid-grey
		// and nowhere near white, so nothing about it is ambiguous.
		const image = frame(64, 64, (x, y) => (x >= 20 && x < 44 && y >= 20 && y < 44 ? [160, 160, 160] : null))
		const result = removeFlatBackground(image)
		assert.ok(result.ok, `refused: ${!result.ok && result.reason}`)
		assert.equal(alphaAt(image, 2, 2), 0, "a corner of the background survived")
		assert.equal(alphaAt(image, 32, 32), 255, "the subject was cut away with the background")
	})

	it("cuts white enclosed by the subject, because those are holes", () => {
		// A paperclip's loops, a ring, a mug handle. Measured on a real paperclip,
		// flooding only from the frame edge left both loops filled with white.
		const image = frame(64, 64, (x, y) => {
			const inside = x >= 16 && x < 48 && y >= 16 && y < 48
			if (!inside) return null
			const hole = x >= 28 && x < 36 && y >= 28 && y < 36
			return hole ? [255, 255, 255] : [120, 120, 120]
		})
		const result = removeFlatBackground(image)
		assert.ok(result.ok, `refused: ${!result.ok && result.reason}`)
		assert.equal(alphaAt(image, 31, 31), 0, "a hole through the subject stayed opaque")
		assert.equal(alphaAt(image, 20, 20), 255, "the subject was cut away")
		assert.equal(alphaAt(image, 1, 1), 0, "the background survived")
	})

	it("refuses when the subject is not on white at all", () => {
		// Cutting from the edge of a photograph that has no plain background would
		// eat whatever happens to be at the frame's edge.
		const image = frame(64, 64, () => [40, 90, 140])
		const result = removeFlatBackground(image)
		assert.ok(!result.ok)
		assert.match(result.reason, /plain white/)
	})

	it("refuses when the subject fills the frame, leaving nothing to cut", () => {
		// Inset by exactly the border ring the check reads, so this fails on the
		// cut fraction rather than on the border — those are different facts, and a
		// fixture that conflates them proves neither.
		const image = frame(64, 64, (x, y) => (x >= 2 && x < 62 && y >= 2 && y < 62 ? [90, 90, 90] : null))
		const result = removeFlatBackground(image)
		assert.ok(!result.ok)
		assert.match(result.reason, /nothing to cut out/)
	})

	it("refuses when everything went with the background", () => {
		const image = frame(64, 64)
		const result = removeFlatBackground(image)
		assert.ok(!result.ok)
		assert.match(result.reason, /went with the background/)
	})

	it("reads bgra buffers, which is what Electron hands it", () => {
		const image = frame(64, 64, (x, y) => (x >= 20 && x < 44 && y >= 20 && y < 44 ? [160, 160, 160] : null))
		const result = removeFlatBackground({ ...image, order: "bgra" })
		assert.ok(result.ok, `refused: ${!result.ok && result.reason}`)
		assert.equal(alphaAt(image, 32, 32), 255)
	})
})
