/**
 * Separating a photographic subject from a plain white background.
 *
 * §4.7's transparency rule: a genuine photographic cutout is keyed against a
 * flat background **Caret chose at generation time** — no matting model, no
 * licence, and reliable precisely because the background is ours. The recipe
 * asks the image model for the object on this exact colour; this module removes
 * it. Pure pixel arithmetic, so the same input always cuts the same way and the
 * whole thing is testable without a model or a window.
 *
 * Two honesty rules shape the implementation:
 *
 * - **The background is measured, not assumed.** The model was asked for a hex
 *   and returns something *near* it. The border ring is sampled, checked against
 *   the requested key, and the measured colour is what gets keyed — keying the
 *   requested colour instead leaves a halo of the difference.
 * - **A background that is not there is a refusal, not a bad cutout.** If the
 *   border does not agree with the key, or keying removes almost nothing or
 *   almost everything, the caller gets a sentence with the measured numbers in
 *   it. A silently wrong cutout would land in the user's git history.
 */
/** A key colour: the hex the model is asked for, and the words the prompt uses. */
export interface KeyableImage {
	/** Raw pixel data, 4 bytes per pixel, straight (non-premultiplied) alpha. */
	data: Uint8Array
	width: number
	height: number
	/** Channel order of `data`. Electron bitmaps are BGRA; canvases are RGBA. */
	order: "rgba" | "bgra"
}

export type KeyOutResult =
	| {
			ok: true
			/** Fraction of pixels made fully transparent. Recorded, and gated below. */
			cut: number
	  }
	| { ok: false; reason: string }

/** How closely the border must match the requested key to count as background. */
const BORDER_AGREEMENT = 0.85
/** Chromaticity distance within which a border pixel agrees with the key. */
const AGREE_DISTANCE = 0.09
/** Full transparency at or below this chromaticity distance from the measured key. */
const NEAR = 0.035
/** Full opacity at or above this distance; linear alpha in between. */
const FAR = 0.11
/** Below this, the "background" barely existed; above, the subject went with it. */
const MIN_CUT = 0.15
const MAX_CUT = 0.985

/**
 * Removes the keyed background in place.
 *
 * Distances are measured in **chromaticity** (colour independent of
 * brightness), which is what makes the key tolerant of the gentle shading a
 * model puts on even a "perfectly flat" background: a darker corner of the
 * green is still the same green. Edge pixels get their contamination unmixed
 * rather than merely faded — a semi-transparent pixel is a blend of subject and
 * background, and leaving the background's share in the colour is the green
 * fringe every naive key produces.
 */
/** Anything this bright on every channel is background, not subject. */
const WHITE_FLOOR = 238
/** How much of the border ring must be near-white before we trust it. */
const BORDER_WHITE = 0.9

/**
 * Removes a flat white background by flooding inward from the frame edge.
 *
 * **This replaced chroma-key, and it replaced it because chroma-key could not
 * succeed.** Asking for an exact hex asks the model for the one thing it will
 * not reliably give: told to paint `#00b140` it returns a perfectly flat green
 * of its own choosing — measured at 0% agreement with the requested colour and
 * 100% agreement with itself — and the gate then threw away a flawless cutout.
 * Nothing about the picture was wrong; the test was.
 *
 * White needs no agreement, because "pure white" is not a colour the model has
 * to match, it is the absence of one. Measured on a real generation: the
 * background came back at 253 and the brightest steel on the subject reached
 * 222, a gap no threshold has trouble with.
 *
 * **Enclosed white counts as background too.** Flooding only from the frame edge
 * is the tidier rule and it is wrong for this lane: on a paperclip, a ring, a
 * mug handle or a pair of scissors the holes *are* background, they are simply
 * unreachable from outside. Measured on a real paperclip, edge-only flooding
 * left both loops filled in. The cost is a white region that genuinely belongs
 * to the subject — a paper label, a painted panel — and the trade is worth it
 * here, because a lane whose premise is "an object with no background" meets
 * holes far more often than it meets white subjects. The disaster case is caught
 * rather than shipped: a white mug on white cuts ~99% of the frame and is
 * refused by `MAX_CUT` as the subject having gone with the background.
 */
export function removeFlatBackground(image: KeyableImage): KeyOutResult {
	const { data, width, height } = image
	if (data.length < width * height * 4) {
		return { ok: false, reason: "The pixel buffer is smaller than the image it claims to be." }
	}
	const [R, B] = image.order === "bgra" ? [2, 0] : [0, 2]
	const isBackground = (i: number) => data[i + R] >= WHITE_FLOOR && data[i + 1] >= WHITE_FLOOR && data[i + B] >= WHITE_FLOOR

	// The border has to actually be the background. If it is not, the model put
	// the subject against something else and cutting from the edge would eat it.
	let white = 0
	let seen = 0
	for (let y = 0; y < height; y++) {
		const edge = y < 2 || y >= height - 2
		for (let x = 0; x < width; x++) {
			if (!edge && x >= 2 && x < width - 2) continue
			seen++
			if (isBackground((y * width + x) * 4)) white++
		}
	}
	const agreement = seen > 0 ? white / seen : 0
	if (agreement < BORDER_WHITE) {
		return {
			ok: false,
			reason:
				`The model did not put the subject on a plain white background — only ${Math.round(agreement * 100)}% ` +
				`of the frame's edge is white. Generate again rather than keeping a bad cutout.`,
		}
	}

	let cut = 0
	for (let i = 0; i < width * height * 4; i += 4) {
		if (!isBackground(i)) continue
		data[i] = 0
		data[i + 1] = 0
		data[i + 2] = 0
		data[i + 3] = 0
		cut++
	}

	const fraction = cut / (width * height)
	if (fraction < MIN_CUT) {
		return {
			ok: false,
			reason: `Only ${Math.round(fraction * 100)}% of the frame was background — the subject fills it, so there is nothing to cut out.`,
		}
	}
	if (fraction > MAX_CUT) {
		return {
			ok: false,
			reason: `${Math.round(fraction * 100)}% of the frame was removed — the subject went with the background.`,
		}
	}
	return { ok: true, cut: fraction }
}
