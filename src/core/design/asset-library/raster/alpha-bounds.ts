/**
 * Where the visible pixels of an image actually sit.
 *
 * A cutout PNG's frame includes its transparent margins, so anything that
 * aligns by the rendered rect alone — a model told "center the clip on the
 * shirt", or a human reading measured geometry — centers the margins, not the
 * object. This measures the smallest rectangle containing every visibly
 * opaque pixel, once, so the asset index can carry the answer instead of the
 * question.
 *
 * Pure pixel arithmetic in the `cutout.ts` idiom: the same buffer always
 * bounds the same way, testable without a model or a window.
 */
import type { KeyableImage } from "./cutout"

/**
 * Below this alpha a pixel is treated as invisible. Matting and keying leave
 * faint residue in "empty" areas; a bound that honoured alpha=1 would hug the
 * residue, not the subject.
 */
const VISIBLE_ALPHA = 16

/**
 * Bounding box of the visibly opaque pixels, in image pixels.
 *
 * Only the alpha channel is read, so RGBA and BGRA buffers bound identically.
 * Returns null for a fully transparent buffer (or one smaller than its claimed
 * size) — a real state, not an error: the caller simply has nothing to say
 * about visual center.
 */
export function alphaBounds(image: KeyableImage): { x: number; y: number; width: number; height: number } | null {
	const { data, width, height } = image
	if (width <= 0 || height <= 0 || data.length < width * height * 4) return null

	let minX = width
	let minY = height
	let maxX = -1
	let maxY = -1

	for (let y = 0; y < height; y++) {
		const row = y * width * 4
		for (let x = 0; x < width; x++) {
			if (data[row + x * 4 + 3] < VISIBLE_ALPHA) continue
			if (x < minX) minX = x
			if (x > maxX) maxX = x
			if (y < minY) minY = y
			if (y > maxY) maxY = y
		}
	}

	if (maxX < 0) return null
	return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/**
 * The index-worthiness rule: a bound is stored only when it insets from the
 * full frame by more than 2% of the dimension on at least one side. An
 * edge-to-edge opaque image gets no entry — absence means "the box center is
 * the visual center", and storing a full-frame box would make every photo
 * carry a redundant one.
 */
export function worthIndexing(
	bounds: { x: number; y: number; width: number; height: number },
	width: number,
	height: number,
): boolean {
	const insetX = width * 0.02
	const insetY = height * 0.02
	return (
		bounds.x > insetX ||
		bounds.y > insetY ||
		width - (bounds.x + bounds.width) > insetX ||
		height - (bounds.y + bounds.height) > insetY
	)
}
