/**
 * Pure SVG corrections for authored marks, out of `authored-marks.ts` so the
 * unit suite reaches them without electron — the `pixel-similarity` split,
 * for the same reason.
 */

/**
 * Removes a full-canvas background rect, corrected rather than refused.
 *
 * A mark's contract is a transparent glyph that floats on whatever surface a
 * page provides — but models paint the surface they were shown into the file
 * (the Smolder logo shipped with its own `<rect fill="#121212">`, invisible
 * on that dark page and a solid box on any other). Only the unambiguous case
 * is stripped: an UN-ROUNDED rect at the origin covering the whole viewBox.
 * A rounded full-bleed square can be a deliberate badge shape and survives.
 */
export function stripBackgroundRect(svg: string): string {
	const viewBox = /viewBox\s*=\s*["']\s*0[\s,]+0[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(svg)
	if (!viewBox) return svg
	const canvasWidth = Number(viewBox[1])
	const canvasHeight = Number(viewBox[2])

	return svg.replace(/<rect\b[^>]*\/?>(?:\s*<\/rect>)?/gi, (rect) => {
		const attribute = (name: string) => {
			const found = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(rect)
			return found ? found[1] : null
		}
		const width = Number(attribute("width") ?? Number.NaN)
		const height = Number(attribute("height") ?? Number.NaN)
		const x = Number(attribute("x") ?? 0)
		const y = Number(attribute("y") ?? 0)
		const rounded = Number(attribute("rx") ?? 0) > 0 || Number(attribute("ry") ?? 0) > 0
		const coversCanvas =
			!rounded &&
			x <= canvasWidth * 0.02 &&
			y <= canvasHeight * 0.02 &&
			width >= canvasWidth * 0.98 &&
			height >= canvasHeight * 0.98
		return coversCanvas ? "" : rect
	})
}
