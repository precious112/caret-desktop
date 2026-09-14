/**
 * Derives full token scales from a single seed value.
 *
 * The wizard asks for one decision per dimension — a brand colour, a base size,
 * a spacing unit, a radius character — and expands each into the scale the
 * design layer actually uses. Keeping the derivation here (rather than asking an
 * agent for it) is what makes the same seed produce the same scale every time.
 */
export type TokenScaleType = "color" | "typography" | "spacing" | "radius"

export function generateTokenScale(
	type: TokenScaleType,
	seedValue: string,
	options: Record<string, unknown> = {},
): Record<string, string> {
	switch (type) {
		case "color":
			return generateColorScale(seedValue, options as { steps?: number })
		case "typography":
			return generateTypographyScale(seedValue, options as { ratio?: number })
		case "spacing":
			return generateSpacingScale(seedValue)
		case "radius":
			return generateRadiusScale(seedValue)
		default:
			throw new Error(`Unknown scale type: ${type}`)
	}
}

const COLOR_LABELS = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"]
const SEED_INDEX = COLOR_LABELS.indexOf("500")

/**
 * The seed IS `500`. The old derivation tinted everything up to 500 toward
 * white, so `brand-500` — the step every Tailwind-trained agent treats as "the
 * brand colour" — came out near-pastel (seed #f59e0b produced 500 #fbd89d) with
 * a hard jump to 600. Now the ramp anchors the seed's own lightness at 500 and
 * interpolates in HSL: 50→400 toward a near-white of the same hue, 600→950
 * toward a deep shade. A seed too light or too dark to anchor a full ramp
 * (lightness outside 0.2–0.85) is nudged into range so the ramp stays
 * monotonic; the untouched seed is still always reachable as bare `brand`.
 */
function generateColorScale(seed: string, options: { steps?: number }): Record<string, string> {
	const steps = options.steps || COLOR_LABELS.length
	const { h, s, l } = hexToHsl(seed)

	const anchorL = Math.min(0.85, Math.max(0.2, l))
	const seedUsable = Math.abs(anchorL - l) < 0.001

	const scale: Record<string, string> = {}
	for (let i = 0; i < Math.min(steps, COLOR_LABELS.length); i++) {
		if (i === SEED_INDEX && seedUsable) {
			scale[COLOR_LABELS[i]] = normalizeHexColor(seed)
			continue
		}
		let lightness: number
		let saturation = s
		if (i <= SEED_INDEX) {
			// 50 → 500: near-white of the seed's hue down to the anchor. The very
			// light end desaturates a touch so 50/100 read as washes, not neon.
			const t = i / SEED_INDEX
			lightness = 0.97 + (anchorL - 0.97) * t
			saturation = s * (0.55 + 0.45 * t)
		} else {
			// 500 → 950: anchor down to a deep shade of the same hue.
			const t = (i - SEED_INDEX) / (COLOR_LABELS.length - 1 - SEED_INDEX)
			lightness = anchorL + (0.1 - anchorL) * t
			saturation = s * (1 - 0.15 * t)
		}
		scale[COLOR_LABELS[i]] = hslToHex(h, saturation, lightness)
	}

	return scale
}

/** Lightness ladder shared by every neutral character — close to Tailwind's own. */
const NEUTRAL_LIGHTNESS = [0.98, 0.96, 0.92, 0.85, 0.72, 0.58, 0.45, 0.32, 0.22, 0.14, 0.08]

/**
 * The tinted grey ramp the neutral character promises. Every foundation names a
 * character ("warm", "cool"…), but until this existed nothing derived a scale
 * from it — `neutral.scale` shipped empty, the theme emitted nothing, and
 * `text-neutral-600` silently fell through to Tailwind's untinted stock grey.
 */
export function generateNeutralScale(
	character: "warm" | "cool" | "true" | "slight-tint",
	options: { brandSeed?: string } = {},
): Record<string, string> {
	let hue = 0
	let sat = 0
	if (character === "warm") {
		hue = 40
		sat = 0.06
	} else if (character === "cool") {
		hue = 220
		sat = 0.06
	} else if (character === "slight-tint") {
		hue = options.brandSeed ? hexToHsl(options.brandSeed).h : 220
		sat = 0.04
	}

	const scale: Record<string, string> = {}
	for (let i = 0; i < COLOR_LABELS.length; i++) {
		scale[COLOR_LABELS[i]] = hslToHex(hue, sat, NEUTRAL_LIGHTNESS[i])
	}
	return scale
}

function generateTypographyScale(baseSize: string, options: { ratio?: number }): Record<string, string> {
	const base = Number.parseFloat(baseSize) || 16
	const ratio = options.ratio || 1.25
	const labels = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl"]
	const baseIndex = labels.indexOf("base")

	const scale: Record<string, string> = {}
	for (let i = 0; i < labels.length; i++) {
		scale[labels[i]] = `${Math.round(base * ratio ** (i - baseIndex) * 100) / 100}px`
	}
	return scale
}

function generateSpacingScale(baseUnit: string): Record<string, string> {
	const base = Number.parseFloat(baseUnit) || 4
	const multipliers = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64]

	const scale: Record<string, string> = {}
	for (const m of multipliers) {
		scale[String(m)] = `${base * m}px`
	}
	return scale
}

function generateRadiusScale(character: string): Record<string, string> {
	const presets: Record<string, number[]> = {
		sharp: [0, 1, 2, 4, 6, 9999],
		soft: [0, 2, 4, 8, 12, 9999],
		round: [0, 4, 8, 12, 16, 9999],
		pill: [0, 4, 8, 16, 24, 9999],
	}
	const values = presets[character] || presets.soft
	const labels = ["none", "sm", "md", "lg", "xl", "full"]

	const scale: Record<string, string> = {}
	for (let i = 0; i < labels.length; i++) {
		scale[labels[i]] = values[i] === 9999 ? "9999px" : `${values[i]}px`
	}
	return scale
}

function rgbToHex(r: number, g: number, b: number): string {
	const clamp = (v: number) => Math.max(0, Math.min(255, v))
	return `#${[clamp(r), clamp(g), clamp(b)].map((v) => v.toString(16).padStart(2, "0")).join("")}`
}

// ─── Colour math shared by the derivations ──────────────────────────────────

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	let value = hex.replace("#", "")
	if (value.length === 3) value = [...value].map((c) => c + c).join("")
	return {
		r: Number.parseInt(value.slice(0, 2), 16) || 0,
		g: Number.parseInt(value.slice(2, 4), 16) || 0,
		b: Number.parseInt(value.slice(4, 6), 16) || 0,
	}
}

function normalizeHexColor(hex: string): string {
	const { r, g, b } = hexToRgb(hex)
	return rgbToHex(r, g, b)
}

export function hexToHsl(hex: string): { h: number; s: number; l: number } {
	const { r, g, b } = hexToRgb(hex)
	const rn = r / 255
	const gn = g / 255
	const bn = b / 255
	const max = Math.max(rn, gn, bn)
	const min = Math.min(rn, gn, bn)
	const l = (max + min) / 2
	if (max === min) return { h: 0, s: 0, l }
	const d = max - min
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
	let h: number
	if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
	else if (max === gn) h = ((bn - rn) / d + 2) / 6
	else h = ((rn - gn) / d + 4) / 6
	return { h: h * 360, s, l }
}

export function hslToHex(h: number, s: number, l: number): string {
	const hue = ((h % 360) + 360) % 360
	const sat = Math.max(0, Math.min(1, s))
	const light = Math.max(0, Math.min(1, l))
	const c = (1 - Math.abs(2 * light - 1)) * sat
	const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
	const m = light - c / 2
	let rn = 0
	let gn = 0
	let bn = 0
	if (hue < 60) [rn, gn, bn] = [c, x, 0]
	else if (hue < 120) [rn, gn, bn] = [x, c, 0]
	else if (hue < 180) [rn, gn, bn] = [0, c, x]
	else if (hue < 240) [rn, gn, bn] = [0, x, c]
	else if (hue < 300) [rn, gn, bn] = [x, 0, c]
	else [rn, gn, bn] = [c, 0, x]
	return rgbToHex(Math.round((rn + m) * 255), Math.round((gn + m) * 255), Math.round((bn + m) * 255))
}

/** WCAG relative luminance. */
export function relativeLuminance(hex: string): number {
	const { r, g, b } = hexToRgb(hex)
	const lin = (v: number) => {
		const c = v / 255
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
	}
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG contrast ratio, 1–21. */
export function contrastRatio(a: string, b: string): number {
	const la = relativeLuminance(a)
	const lb = relativeLuminance(b)
	const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
	return (hi + 0.05) / (lo + 0.05)
}
