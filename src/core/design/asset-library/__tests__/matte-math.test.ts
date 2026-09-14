/**
 * The deterministic halves of the model cutout: tensor in, mask applied out.
 *
 * The network itself is a 224MB download and stays out of unit tests; what is
 * held down here is everything around it — the maths that failed silently in
 * the threshold era. The shadow-puddle case is the load-bearing test: a soft
 * grey shadow under the subject that no white threshold can separate, cut
 * cleanly because the mask (not a cutoff) says it is background.
 */
import { strict as assert } from "assert"

import { applyMatte, matteInputTensor } from "../raster/matte-math"

/** An RGBA frame: white everywhere, with `paint` allowed to draw on it. */
function frame(width: number, height: number, paint?: (x: number, y: number) => [number, number, number] | null) {
	const data = new Uint8Array(width * height * 4)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4
			const [r, g, b] = paint?.(x, y) ?? [255, 255, 255]
			data[i] = r
			data[i + 1] = g
			data[i + 2] = b
			data[i + 3] = 255
		}
	}
	return { data, width, height, order: "rgba" as const }
}

/** A mask at the image's own size (side × side), from a per-pixel value. */
function mask(side: number, value: (x: number, y: number) => number): Float32Array {
	const out = new Float32Array(side * side)
	for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) out[y * side + x] = value(x, y)
	return out
}

const alphaAt = (image: ReturnType<typeof frame>, x: number, y: number) => image.data[(y * image.width + x) * 4 + 3]
const rgbAt = (image: ReturnType<typeof frame>, x: number, y: number) => {
	const i = (y * image.width + x) * 4
	return [image.data[i], image.data[i + 1], image.data[i + 2]]
}

describe("matteInputTensor", () => {
	it("normalizes a solid colour to the ImageNet-normalized value in every cell", () => {
		const image = frame(8, 8, () => [128, 64, 192])
		const tensor = matteInputTensor(image, 4)
		const expect = [(128 / 255 - 0.485) / 0.229, (64 / 255 - 0.456) / 0.224, (192 / 255 - 0.406) / 0.225]
		for (let channel = 0; channel < 3; channel++) {
			for (let i = 0; i < 16; i++) {
				assert.ok(Math.abs(tensor[channel * 16 + i] - expect[channel]) < 1e-5, `channel ${channel} cell ${i}`)
			}
		}
	})

	it("reads BGRA and RGBA buffers identically", () => {
		const rgba = frame(6, 6, (x) => (x < 3 ? [200, 100, 50] : null))
		const bgra = frame(6, 6, (x) => (x < 3 ? [50, 100, 200] : null))
		const swapped = { ...bgra, order: "bgra" as const }
		assert.deepEqual(Array.from(matteInputTensor(rgba, 4)), Array.from(matteInputTensor(swapped, 4)))
	})
})

describe("applyMatte", () => {
	it("cuts a painted shadow the threshold era shipped, because the mask says background", () => {
		// The test5 failure verbatim: subject in the middle, a soft grey shadow
		// puddle beneath it at 225 — under every white cutoff, fully opaque in
		// the shipped cutouts. The mask covers only the subject.
		const side = 32
		const subject = (x: number, y: number) => x >= 12 && x < 20 && y >= 8 && y < 16
		const shadow = (x: number, y: number) => x >= 8 && x < 24 && y >= 17 && y < 22
		const image = frame(side, side, (x, y) => (subject(x, y) ? [160, 40, 40] : shadow(x, y) ? [225, 225, 225] : null))
		const result = applyMatte(
			image,
			mask(side, (x, y) => (subject(x, y) ? 1 : 0)),
			side,
		)
		assert.ok(result.ok, `refused: ${!result.ok && result.reason}`)
		assert.equal(alphaAt(image, 16, 19), 0, "the shadow puddle survived the cut")
		assert.equal(alphaAt(image, 16, 12), 255, "the subject went with the shadow")
		assert.equal(alphaAt(image, 2, 2), 0, "plain background survived")
	})

	it("unmixes the measured background out of soft edges instead of fading it in place", () => {
		// A half-covered edge pixel photographed over an off-white background is
		// a blend; keeping its colour and halving its alpha leaves a pale fringe.
		// The pure subject colour is recoverable because the background colour is
		// measured from the mask's own background region — 240 here, not an
		// assumed 255.
		const side = 32
		const subject = (x: number) => x >= 12 && x < 20
		const edge = (x: number) => x === 20
		const blend = Math.round(0.5 * 160 + 0.5 * 240)
		const image = frame(side, side, (x) =>
			subject(x)
				? [160, 40, 40]
				: edge(x)
					? [blend, Math.round(0.5 * 40 + 0.5 * 240), Math.round(0.5 * 40 + 0.5 * 240)]
					: [240, 240, 240],
		)
		const result = applyMatte(
			image,
			mask(side, (x) => (subject(x) ? 1 : edge(x) ? 0.5 : 0)),
			side,
		)
		assert.ok(result.ok, `refused: ${!result.ok && result.reason}`)
		assert.equal(alphaAt(image, 20, 16), 128)
		const [r, g, b] = rgbAt(image, 20, 16)
		assert.ok(
			Math.abs(r - 160) <= 6 && Math.abs(g - 40) <= 6 && Math.abs(b - 40) <= 6,
			`fringe not unmixed: rgb(${r},${g},${b})`,
		)
	})

	it("applies sigmoid only when the mask is logits", () => {
		const side = 16
		const subject = (x: number) => x >= 6 && x < 10
		const image = frame(side, side, (x) => (subject(x) ? [30, 30, 30] : null))
		const logits = mask(side, (x) => (subject(x) ? 12 : -12))
		const result = applyMatte(image, logits, side)
		assert.ok(result.ok, `refused: ${!result.ok && result.reason}`)
		assert.equal(alphaAt(image, 8, 8), 255)
		assert.equal(alphaAt(image, 1, 8), 0)
	})

	it("refuses a mask that kept everything — there was no background to find", () => {
		const image = frame(16, 16, () => [90, 90, 90])
		const result = applyMatte(
			image,
			mask(16, () => 1),
			16,
		)
		assert.ok(!result.ok)
	})

	it("refuses a mask that kept nothing — there was no subject to keep", () => {
		const image = frame(16, 16)
		const result = applyMatte(
			image,
			mask(16, () => 0),
			16,
		)
		assert.ok(!result.ok)
		assert.match(!result.ok ? result.reason : "", /no subject/)
	})
})
