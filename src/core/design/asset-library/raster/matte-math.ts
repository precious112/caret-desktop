/**
 * The pixel arithmetic around the cutout model: what goes in, and what the
 * mask does to the image on the way out.
 *
 * BiRefNet does the one thing no threshold can — decide what is *subject* —
 * but everything either side of that decision is deterministic and belongs
 * here, pure and testable: resampling the image into the tensor the network
 * was exported for, resampling its mask back, unmixing the background's share
 * out of every soft edge pixel, and refusing results that say the model did
 * not find a subject to cut.
 *
 * Two lessons from the threshold era are kept on purpose:
 *
 * - **The background is measured, not assumed.** The recipe asks for white and
 *   the model paints something near it. The unmixing below reads the actual
 *   background colour from the pixels the mask calls background — unmixing an
 *   assumed white out of an off-white photograph leaves a rim of the
 *   difference.
 * - **A cut that kept everything or nothing is a refusal, not a result.** The
 *   thresholds match `cutout.ts` so the honesty gate does not move when the
 *   algorithm does.
 */
import type { KeyableImage, KeyOutResult } from "./cutout"

/** ImageNet normalization — what BiRefNet was trained with. */
const MEAN = [0.485, 0.456, 0.406] as const
const STD = [0.229, 0.224, 0.225] as const

/** Below this mask value a pixel is plainly background when measuring its colour. */
const BACKGROUND_MASK = 0.1
/** At or below this alpha (0–255) a pixel is written fully transparent. */
const CLEAR_FLOOR = 8
/** Same honesty gates as the threshold keyer, so refusals mean the same thing. */
const MIN_CUT = 0.15
const MAX_CUT = 0.985

/**
 * Resamples the image into the network's input: CHW float32, RGB, /255,
 * ImageNet-normalized, `side`×`side`. Plain bilinear both ways is what every
 * reference implementation does; the network is trained on squeezed frames.
 */
export function matteInputTensor(image: KeyableImage, side: number): Float32Array {
	const { data, width, height } = image
	const [R, B] = image.order === "bgra" ? [2, 0] : [0, 2]
	const plane = side * side
	const out = new Float32Array(3 * plane)

	for (let y = 0; y < side; y++) {
		const sy = ((y + 0.5) * height) / side - 0.5
		const y0 = Math.max(0, Math.floor(sy))
		const y1 = Math.min(height - 1, y0 + 1)
		const fy = Math.min(1, Math.max(0, sy - y0))
		for (let x = 0; x < side; x++) {
			const sx = ((x + 0.5) * width) / side - 0.5
			const x0 = Math.max(0, Math.floor(sx))
			const x1 = Math.min(width - 1, x0 + 1)
			const fx = Math.min(1, Math.max(0, sx - x0))

			const i00 = (y0 * width + x0) * 4
			const i01 = (y0 * width + x1) * 4
			const i10 = (y1 * width + x0) * 4
			const i11 = (y1 * width + x1) * 4
			const at = y * side + x

			for (const [channel, offset] of [
				[0, R],
				[1, 1],
				[2, B],
			] as const) {
				const top = data[i00 + offset] * (1 - fx) + data[i01 + offset] * fx
				const bottom = data[i10 + offset] * (1 - fx) + data[i11 + offset] * fx
				const value = (top * (1 - fy) + bottom * fy) / 255
				out[channel * plane + at] = (value - MEAN[channel]) / STD[channel]
			}
		}
	}
	return out
}

/** Bilinear read of a square mask at a fractional position in image space. */
function maskAt(mask: Float32Array, side: number, u: number, v: number): number {
	const sx = u * side - 0.5
	const sy = v * side - 0.5
	const x0 = Math.max(0, Math.min(side - 1, Math.floor(sx)))
	const y0 = Math.max(0, Math.min(side - 1, Math.floor(sy)))
	const x1 = Math.min(side - 1, x0 + 1)
	const y1 = Math.min(side - 1, y0 + 1)
	const fx = Math.min(1, Math.max(0, sx - x0))
	const fy = Math.min(1, Math.max(0, sy - y0))
	const top = mask[y0 * side + x0] * (1 - fx) + mask[y0 * side + x1] * fx
	const bottom = mask[y1 * side + x0] * (1 - fx) + mask[y1 * side + x1] * fx
	return top * (1 - fy) + bottom * fy
}

/**
 * Applies the model's mask to the image in place: soft alpha, background
 * unmixed out of every partial pixel, honesty gates on the result.
 *
 * The network's export may emit logits or probabilities depending on who did
 * the export; values outside [0,1] are the tell, and sigmoid is applied only
 * then — squashing an already-squashed mask flattens every edge to ~0.5.
 */
export function applyMatte(image: KeyableImage, mask: Float32Array, maskSide: number): KeyOutResult {
	const { data, width, height } = image
	if (data.length < width * height * 4) {
		return { ok: false, reason: "The pixel buffer is smaller than the image it claims to be." }
	}
	if (mask.length < maskSide * maskSide) {
		return { ok: false, reason: "The mask is smaller than the network's output shape." }
	}

	let lo = Number.POSITIVE_INFINITY
	let hi = Number.NEGATIVE_INFINITY
	for (let i = 0; i < mask.length; i++) {
		if (mask[i] < lo) lo = mask[i]
		if (mask[i] > hi) hi = mask[i]
	}
	const squash = lo < -0.01 || hi > 1.01
	const value = (raw: number) => {
		const v = squash ? 1 / (1 + Math.exp(-raw)) : raw
		return v < 0 ? 0 : v > 1 ? 1 : v
	}

	// First pass: the actual background colour, read from where the mask says
	// background is. Sampled on a grid — the mean of a region needs no census.
	let bgR = 0
	let bgG = 0
	let bgB = 0
	let bgN = 0
	const [R, B] = image.order === "bgra" ? [2, 0] : [0, 2]
	const step = Math.max(1, Math.floor(Math.min(width, height) / 256))
	for (let y = 0; y < height; y += step) {
		for (let x = 0; x < width; x += step) {
			if (value(maskAt(mask, maskSide, (x + 0.5) / width, (y + 0.5) / height)) >= BACKGROUND_MASK) continue
			const i = (y * width + x) * 4
			bgR += data[i + R]
			bgG += data[i + 1]
			bgB += data[i + B]
			bgN++
		}
	}
	if (bgN === 0) {
		return { ok: false, reason: "The cutout model found no background at all — the subject fills the frame edge to edge." }
	}
	bgR /= bgN
	bgG /= bgN
	bgB /= bgN

	// Second pass: alpha and unmixing. A soft-edge pixel is a blend of subject
	// and background; leaving the background's share in its colour is the pale
	// fringe every naive cut produces on a dark page.
	let removed = 0
	for (let y = 0; y < height; y++) {
		const v = (y + 0.5) / height
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4
			const a = value(maskAt(mask, maskSide, (x + 0.5) / width, v))
			const alpha = Math.round(a * 255)
			if (alpha <= CLEAR_FLOOR) {
				data[i] = 0
				data[i + 1] = 0
				data[i + 2] = 0
				data[i + 3] = 0
				removed += 1
				continue
			}
			if (alpha < 255) {
				const unmix = (channel: number, bg: number) => {
					const pure = (data[i + channel] - (1 - a) * bg) / a
					data[i + channel] = pure < 0 ? 0 : pure > 255 ? 255 : Math.round(pure)
				}
				unmix(R, bgR)
				unmix(1, bgG)
				unmix(B, bgB)
				removed += 1 - a
			}
			data[i + 3] = alpha
		}
	}

	const fraction = removed / (width * height)
	if (fraction < MIN_CUT) {
		return {
			ok: false,
			reason: `Only ${Math.round(fraction * 100)}% of the frame was background — the subject fills it, so there is nothing to cut out.`,
		}
	}
	if (fraction > MAX_CUT) {
		return {
			ok: false,
			reason: `${Math.round(fraction * 100)}% of the frame was removed — the cutout model found no subject to keep.`,
		}
	}
	return { ok: true, cut: fraction }
}
