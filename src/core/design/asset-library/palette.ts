/**
 * `foundation.json` → the five colours a generated asset is allowed to use.
 *
 * **Five, and no more.** The most reliable tell of generated imagery is not the
 * subject, it is that everything is at the same saturation and four hues compete
 * for the same job. The palette recipes already encode the restraint rule for
 * the UI (one accent, used rarely; tinted neutrals; a deliberate lightness gap
 * between surface and text); this is the same rule applied to pictures, which is
 * why the derivation lives here rather than in each generator.
 *
 * Neutrals are derived from the foundation's `neutral.character` rather than
 * read from `neutral.scale`, because that scale is empty in practice — the
 * wizard writes `scale: {}` and lets the theme generator expand it. A pure grey
 * would undo the one decision the character field exists to record.
 */
import type { FoundationTokens } from "../types"
import type { GeneratorPalette } from "./types"

/** Tint applied to the neutral ramp, by character. Degrees on the colour wheel. */
const NEUTRAL_HUE: Record<FoundationTokens["color"]["neutral"]["character"], number | "brand"> = {
	warm: 32,
	cool: 220,
	true: 0,
	"slight-tint": "brand",
}

/** Saturation of the neutral ramp, by character. A tint, never a colour. */
const NEUTRAL_SATURATION: Record<FoundationTokens["color"]["neutral"]["character"], number> = {
	warm: 0.1,
	cool: 0.08,
	true: 0,
	"slight-tint": 0.05,
}

/**
 * The palette a recipe composes against.
 *
 * `surface` is the page this asset will sit on, so an image generated for a dark
 * project is dark to start with rather than dark by post-processing. Absent
 * surface means light: foundations written before the field existed are not
 * evidence of a dark project.
 */
export function derivePalette(tokens: FoundationTokens | null): GeneratorPalette {
	if (!tokens) return DEFAULT_PALETTE

	const mode = tokens.color.surface === "dark" ? "dark" : "light"
	const seed = normalizeHex(tokens.color.brand.seed) ?? DEFAULT_PALETTE.brand
	const brandHsl = hexToHsl(seed)

	const character = tokens.color.neutral.character
	const configuredHue = NEUTRAL_HUE[character] ?? 0
	const hue = configuredHue === "brand" ? brandHsl.h : configuredHue
	const saturation = NEUTRAL_SATURATION[character] ?? 0

	// The lightness gap is the decision. Text at 92% on an 8% surface reads;
	// text at 70% on a 30% surface is the muddy middle every generated image
	// lands in when nobody chose.
	const surfaceL = mode === "dark" ? 0.07 : 0.98
	const raisedL = mode === "dark" ? 0.13 : 0.94
	const inkL = mode === "dark" ? 0.93 : 0.11

	return {
		surface: hslToHex({ h: hue, s: saturation, l: surfaceL }),
		raised: hslToHex({ h: hue, s: saturation, l: raisedL }),
		ink: hslToHex({ h: hue, s: saturation * 0.6, l: inkL }),
		// The brand at the step that actually reads against this surface. On a
		// dark page the committed seed is usually too dark to see, and on a light
		// one usually too bright to sit under text; both are the same mistake.
		brand: hslToHex({ h: brandHsl.h, s: brandHsl.s, l: mode === "dark" ? lift(brandHsl.l, 0.62) : sink(brandHsl.l, 0.46) }),
		brandQuiet: hslToHex({
			h: brandHsl.h,
			s: brandHsl.s * 0.72,
			l: mode === "dark" ? lift(brandHsl.l, 0.34) : sink(brandHsl.l, 0.78),
		}),
		mode,
	}
}

/** What a project with no foundation gets: neutral, cool, light, unopinionated. */
export const DEFAULT_PALETTE: GeneratorPalette = {
	surface: "#fafafa",
	raised: "#f0f1f3",
	ink: "#17181c",
	brand: "#2563eb",
	brandQuiet: "#c7d7f8",
	mode: "light",
}

/** Never darker than `floor`; used to keep a brand step visible on dark surfaces. */
function lift(lightness: number, floor: number): number {
	return Math.max(lightness, floor)
}

/** Never lighter than `ceiling`. */
function sink(lightness: number, ceiling: number): number {
	return Math.min(lightness, ceiling)
}

export function normalizeHex(value: string | undefined | null): string | null {
	if (!value) return null
	const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())
	if (!match) return null
	const hex = match[1].toLowerCase()
	return `#${hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex}`
}

export interface Hsl {
	h: number
	s: number
	l: number
}

export function hexToHsl(hex: string): Hsl {
	const normalized = normalizeHex(hex) ?? "#000000"
	const r = Number.parseInt(normalized.slice(1, 3), 16) / 255
	const g = Number.parseInt(normalized.slice(3, 5), 16) / 255
	const b = Number.parseInt(normalized.slice(5, 7), 16) / 255

	const max = Math.max(r, g, b)
	const min = Math.min(r, g, b)
	const l = (max + min) / 2
	if (max === min) return { h: 0, s: 0, l }

	const d = max - min
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
	let h: number
	if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
	else if (max === g) h = ((b - r) / d + 2) * 60
	else h = ((r - g) / d + 4) * 60

	return { h, s, l }
}

export function hslToHex({ h, s, l }: Hsl): string {
	const hue = ((h % 360) + 360) % 360
	const saturation = clamp01(s)
	const lightness = clamp01(l)

	const c = (1 - Math.abs(2 * lightness - 1)) * saturation
	const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
	const m = lightness - c / 2

	const [r, g, b] =
		hue < 60
			? [c, x, 0]
			: hue < 120
				? [x, c, 0]
				: hue < 180
					? [0, c, x]
					: hue < 240
						? [0, x, c]
						: hue < 300
							? [x, 0, c]
							: [c, 0, x]

	const channel = (value: number) =>
		Math.round((value + m) * 255)
			.toString(16)
			.padStart(2, "0")
	return `#${channel(r)}${channel(g)}${channel(b)}`
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value))
}
