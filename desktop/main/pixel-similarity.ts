/**
 * The pure half of the mark loop's convergence measure.
 *
 * Separated from `authored-marks.ts` because that file imports `electron`
 * (nativeImage does the decoding and resizing), and the arithmetic deserves a
 * test that runs where the unit suite runs — in node, on synthetic buffers.
 */

/**
 * How alike two same-sized BGRA bitmaps are, in [0, 1].
 *
 * Channel-wise mean absolute difference over B, G and R; alpha is skipped
 * because both renders are opaque over their surfaces. Crude next to a
 * perceptual metric, and enough: the loop needs a monotonic signal for
 * "closer", not a defensible absolute number.
 */
export function bitmapSimilarity(a: Buffer, b: Buffer): number {
	if (a.length === 0 || a.length !== b.length) return 0

	let sum = 0
	let samples = 0
	for (let i = 0; i < a.length; i += 4) {
		sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
		samples += 3
	}
	return samples === 0 ? 0 : 1 - sum / (samples * 255)
}
