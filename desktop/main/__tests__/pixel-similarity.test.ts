/**
 * The mark loop's convergence measure, held down where it can be held down.
 *
 * The loop in authored-marks.ts stops on "similar enough", stops on plateau,
 * and keeps the best round by this number — so the number's behaviour IS the
 * loop's behaviour. What the loop needs from it: identical means 1, disjoint
 * means far from 1, and a small visual change moves it less than a large one
 * (monotonicity is what makes "no improvement for two rounds" meaningful).
 */
import { strict as assert } from "assert"

import { bitmapSimilarity } from "../pixel-similarity"

/** A solid BGRA bitmap of `pixels` pixels. */
function solid(pixels: number, b: number, g: number, r: number): Buffer {
	const buf = Buffer.alloc(pixels * 4)
	for (let i = 0; i < buf.length; i += 4) {
		buf[i] = b
		buf[i + 1] = g
		buf[i + 2] = r
		buf[i + 3] = 255
	}
	return buf
}

describe("bitmapSimilarity", () => {
	it("identical bitmaps are 1", () => {
		const a = solid(64, 30, 60, 90)
		assert.equal(bitmapSimilarity(a, solid(64, 30, 60, 90)), 1)
	})

	it("black vs white is 0", () => {
		assert.equal(bitmapSimilarity(solid(16, 0, 0, 0), solid(16, 255, 255, 255)), 0)
	})

	it("a small shift scores higher than a large one", () => {
		const base = solid(64, 100, 100, 100)
		const near = bitmapSimilarity(base, solid(64, 110, 100, 100))
		const far = bitmapSimilarity(base, solid(64, 200, 180, 160))
		assert.ok(near > far, `near=${near} should beat far=${far}`)
		assert.ok(near < 1, "a real difference must not score 1")
	})

	it("alpha differences are ignored", () => {
		const a = solid(16, 50, 50, 50)
		const b = solid(16, 50, 50, 50)
		for (let i = 3; i < b.length; i += 4) b[i] = 0
		assert.equal(bitmapSimilarity(a, b), 1)
	})

	it("mismatched or empty inputs are 0, not a crash", () => {
		assert.equal(bitmapSimilarity(Buffer.alloc(0), Buffer.alloc(0)), 0)
		assert.equal(bitmapSimilarity(solid(4, 1, 1, 1), solid(8, 1, 1, 1)), 0)
	})
})
