/**
 * Where the visible pixels of an image actually sit.
 *
 * The bound exists so geometry handed to a model points at the object in a
 * cutout PNG rather than the transparent margins around it — a clip "centered"
 * by its frame is off-center by exactly the asymmetry of its padding.
 */
import { strict as assert } from "assert"

import { alphaBounds, worthIndexing } from "../raster/alpha-bounds"

/** A transparent frame with `paint` returning an alpha per pixel. */
function frame(width: number, height: number, paint?: (x: number, y: number) => number) {
	const data = new Uint8Array(width * height * 4)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4
			data[i] = 128
			data[i + 1] = 128
			data[i + 2] = 128
			data[i + 3] = paint?.(x, y) ?? 0
		}
	}
	return { data, width, height, order: "rgba" as const }
}

describe("alphaBounds", () => {
	it("bounds a centered opaque square exactly", () => {
		const image = frame(64, 64, (x, y) => (x >= 20 && x < 44 && y >= 24 && y < 40 ? 255 : 0))
		assert.deepEqual(alphaBounds(image), { x: 20, y: 24, width: 24, height: 16 })
	})

	it("returns null for a fully transparent buffer", () => {
		assert.equal(alphaBounds(frame(32, 32)), null)
	})

	it("bounds a fully opaque buffer edge to edge", () => {
		assert.deepEqual(alphaBounds(frame(32, 16, () => 255)), { x: 0, y: 0, width: 32, height: 16 })
	})

	it("catches a single opaque border pixel", () => {
		const image = frame(32, 32, (x, y) => (x === 0 && y === 31 ? 255 : 0))
		assert.deepEqual(alphaBounds(image), { x: 0, y: 31, width: 1, height: 1 })
	})

	it("ignores faint matting residue below the visibility floor", () => {
		// Keying leaves alpha 1-15 smeared across "empty" areas; a bound that
		// honoured them would hug the residue, not the subject.
		const image = frame(64, 64, (x, y) => {
			if (x >= 30 && x < 34 && y >= 30 && y < 34) return 255
			return 8
		})
		assert.deepEqual(alphaBounds(image), { x: 30, y: 30, width: 4, height: 4 })
	})

	it("reads only the alpha channel, so BGRA and RGBA bound identically", () => {
		const paint = (x: number, y: number) => (x >= 10 && x < 20 && y >= 5 && y < 25 ? 255 : 0)
		const rgba = frame(32, 32, paint)
		const bgra = { ...frame(32, 32, paint), order: "bgra" as const }
		assert.deepEqual(alphaBounds(rgba), alphaBounds(bgra))
	})

	it("refuses a buffer smaller than the image it claims to be", () => {
		assert.equal(alphaBounds({ data: new Uint8Array(16), width: 8, height: 8, order: "rgba" }), null)
	})
})

describe("worthIndexing", () => {
	it("stores a bound that insets meaningfully", () => {
		assert.ok(worthIndexing({ x: 10, y: 10, width: 44, height: 44 }, 64, 64))
	})

	it("skips an edge-to-edge bound — absence means box center IS visual center", () => {
		assert.ok(!worthIndexing({ x: 0, y: 0, width: 64, height: 64 }, 64, 64))
	})

	it("skips a bound inside the 2% jitter that every anti-aliased edge has", () => {
		assert.ok(!worthIndexing({ x: 1, y: 1, width: 98, height: 98 }, 100, 100))
	})

	it("stores a bound that insets on one side only", () => {
		// A subject flush against three edges still has a wrong box center.
		assert.ok(worthIndexing({ x: 0, y: 0, width: 64, height: 40 }, 64, 64))
	})
})
