/**
 * Colour distance for the slop list's exact values.
 *
 * The checker AI never judges a hex code: "is #F5F0E6 the reported cream?" is a
 * measurement, so code answers it. CIE76 ΔE in Lab is enough to say "close to a
 * reported value"; neutrals get a tighter rule because they are crowded (every
 * off-white is within a few ΔE of every other) and warmth is what tells a cream
 * from a grey.
 */

export interface Rgb {
	r: number
	g: number
	b: number
}

export interface Lab {
	L: number
	a: number
	b: number
}

/** `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`; anything else is null. Alpha is ignored. */
export function parseHex(value: string): Rgb | null {
	const match = String(value)
		.trim()
		.toLowerCase()
		.match(/^#([0-9a-f]{3,8})$/)
	if (!match) return null
	let hex = match[1]
	if (hex.length === 3 || hex.length === 4) {
		hex = hex
			.split("")
			.map((c) => c + c)
			.join("")
	}
	if (hex.length !== 6 && hex.length !== 8) return null
	return {
		r: Number.parseInt(hex.slice(0, 2), 16),
		g: Number.parseInt(hex.slice(2, 4), 16),
		b: Number.parseInt(hex.slice(4, 6), 16),
	}
}

function linear(channel: number): number {
	const c = channel / 255
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function toLab({ r, g, b }: Rgb): Lab {
	const R = linear(r)
	const G = linear(g)
	const B = linear(b)
	const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
	const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047)
	const y = f(R * 0.2126 + G * 0.7152 + B * 0.0722)
	const z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883)
	return { L: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) }
}

export function deltaE(one: Rgb, two: Rgb): number {
	const a = toLab(one)
	const b = toLab(two)
	return Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b)
}

/** How colourful, independent of lightness. */
export function chroma(colour: Rgb): number {
	const lab = toLab(colour)
	return Math.hypot(lab.a, lab.b)
}

/** Greys, near-blacks and off-whites (creams included). */
export function isNeutral(colour: Rgb): boolean {
	const lab = toLab(colour)
	return Math.hypot(lab.a, lab.b) < 14 || lab.L < 12
}

/**
 * Near-black, grey and plain white say nothing about a habit: every page has
 * them. A reported value like that (`#000` listed under glows) never counts.
 */
export function isUninformative(colour: Rgb): boolean {
	return toLab(colour).L < 15 || chroma(colour) < 2
}

/** The distance when `colour` is close to `target`, else null. */
export function closeMatch(colour: Rgb, target: Rgb): number | null {
	const d = deltaE(colour, target)
	if (isNeutral(target)) return d <= 6 && Math.abs(chroma(colour) - chroma(target)) <= 4 ? d : null
	return d <= 8 ? d : null
}

/** The same colour for practical purposes: what "the user chose this" allows. */
export function sameColour(one: Rgb, two: Rgb): boolean {
	return deltaE(one, two) <= 3
}

/** Every hex code written in a piece of text. */
export function hexesIn(text: string): string[] {
	return String(text).match(/#(?:[0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-f])/gi) ?? []
}
