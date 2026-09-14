/**
 * `foundation.json` → Tailwind's own theme.
 *
 * This file is the bridge whose absence broke the whole colour story. The rules
 * hand every agent the brand scale and say "style from these tokens", agents do
 * the Tailwind-idiomatic thing and write `text-brand-950` — and Tailwind v4,
 * finding no `--color-brand-950` in any `@theme`, generates **no CSS**. The
 * class is inert, the page renders in inherited colours, and on a dark-seeded
 * project nobody can even see that the foundation was never applied.
 *
 * The fix is not a Caret-private colour scheme; it is defining Caret's tokens
 * into Tailwind's theme system, where a custom scale is exactly as first-class
 * as the stock palette. One scheme — Tailwind's — with `foundation.json` as its
 * source of truth:
 *
 *   @theme { --color-brand-950: #030303; }   →   text-brand-950 just works
 *
 * Written as its own file (`caret-theme.css`, imported by `global.css`) so a
 * token change can regenerate it alone and arrive as a CSS hot update instead
 * of a shell rebuild.
 */
import { generateNeutralScale } from "../token-scales"
import type { FoundationTokens } from "../types"

/** Kept in sync with the healer's ignore list — this file is Caret's, not content. */
export const THEME_CSS_FILENAME = "caret-theme.css"

/**
 * The webfont `@import`, alone in its own file.
 *
 * CSS requires `@import` to precede every other statement, and that rule applies
 * to the file the bundler *produces*, not the one you wrote. `caret-theme.css`
 * is inlined into `global.css` after `@import "tailwindcss"` expands to the whole
 * preflight, so a font import living in the theme lands thousands of lines deep
 * and PostCSS drops it with "@import must precede all other statements" — the
 * faces are named in `--font-sans` and never fetched, so every page silently
 * renders in the fallback. Kept separate (rather than inlined into `global.css`)
 * so a typeface change still regenerates one small file and arrives as a hot
 * update.
 */
export const FONTS_CSS_FILENAME = "caret-fonts.css"

/** `"Instrument Serif"` needs quoting in CSS; `Georgia, serif` must not get one pair around the lot. */
function cssFontFamily(family: string, fallback: string): string {
	const quoted = /[^a-zA-Z0-9-]/.test(family) ? `"${family}"` : family
	return `${quoted}, ${fallback}`
}

/** Google Fonts URL for the families the foundation names, weights the pages actually use. */
export function foundationFontsCss(tokens: FoundationTokens): string {
	const families = [...new Set([tokens.typography.fontFamily, tokens.typography.displayFamily].filter(Boolean))] as string[]
	if (families.length === 0) return ""
	// A foundation that names its weights fetches exactly those (plus the
	// conventional pair so emphasis never synthesizes); one that doesn't gets
	// the historical broad set.
	const declared = tokens.typography.weights
	const weights = declared
		? [...new Set([...declared.display, ...declared.body, 400, 700])].filter((w) => Number.isFinite(w)).sort((a, b) => a - b)
		: [400, 500, 600, 700, 800, 900]
	const query = families
		.map((family) => `family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@${weights.join(";")}`)
		.join("&")
	return `@import url("https://fonts.googleapis.com/css2?${query}&display=swap");\n`
}

/**
 * Line height belongs to the size, not to a global constant: body sizes want
 * room to read, display sizes want to sit tight. Derived from the pixel size so
 * a foundation with an unusual ratio still gets sensible pairs.
 */
function lineHeightFor(sizePx: number): number {
	if (sizePx < 20) return 1.5
	if (sizePx < 28) return 1.4
	if (sizePx < 40) return 1.25
	return 1.1
}

/** Radius scale positions ↔ Tailwind utility names. Index 0 is `none` and the last is `full`, neither of which needs a theme entry. */
const RADIUS_LABELS: Array<[index: number, label: string]> = [
	[1, "sm"],
	[2, "md"],
	[3, "lg"],
	[4, "xl"],
]

/**
 * The generated theme. Every axis the foundation decides is defined INTO
 * Tailwind's theme, so pages reference tokens by name (`bg-brand-500`,
 * `text-neutral-600`, `text-2xl`, `rounded-lg`) and a token edit restyles
 * everything already generated via one CSS hot update — the live binding that
 * makes a correction stick. Spacing stays on Tailwind's default `--spacing`:
 * `p-4` means 16px in every agent's training data, and redefining the unit
 * would silently shift every page authored before the change.
 */
export function foundationThemeCss(tokens: FoundationTokens): string {
	const lines: string[] = []

	for (const [step, value] of Object.entries(tokens.color.brand.scale ?? {})) {
		lines.push(`  --color-brand-${step}: ${value};`)
	}
	// The seed itself as the bare `brand` utility (`text-brand`, `bg-brand`) —
	// the scale may be empty on a hand-rolled foundation, the seed never is.
	if (tokens.color.brand.seed) lines.push(`  --color-brand: ${tokens.color.brand.seed};`)

	// Optional palette roles, same treatment as brand. No shadowing concern:
	// Tailwind has no stock `secondary`/`accent` colour scale.
	for (const role of ["secondary", "accent"] as const) {
		const entry = tokens.color[role]
		if (!entry?.seed) continue
		for (const [step, value] of Object.entries(entry.scale ?? {})) {
			lines.push(`  --color-${role}-${step}: ${value};`)
		}
		lines.push(`  --color-${role}: ${entry.seed};`)
	}

	// The foundation's neutral deliberately shadows Tailwind's stock `neutral`:
	// a warm- or cool-tinted grey is a foundation decision, and an agent writing
	// `text-neutral-600` should land on it rather than on the untinted default.
	// Foundations written before the derivation pass carry an empty scale, so
	// derive here as well — the theme is regenerated far more often than the
	// tokens file is rewritten.
	const neutralScale = Object.keys(tokens.color.neutral?.scale ?? {}).length
		? tokens.color.neutral.scale
		: generateNeutralScale(tokens.color.neutral?.character ?? "true", { brandSeed: tokens.color.brand.seed })
	for (const [step, value] of Object.entries(neutralScale)) {
		lines.push(`  --color-neutral-${step}: ${value};`)
	}

	for (const [name, value] of Object.entries(tokens.color.semantic ?? {})) {
		lines.push(`  --color-${name}: ${value};`)
	}

	// Contrast-guaranteed foregrounds: `text-on-brand` beats reaching for white.
	if (tokens.color.on) {
		for (const [name, value] of Object.entries(tokens.color.on)) {
			if (!value) continue
			const slug = name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
			lines.push(`  --color-on-${slug}: ${value};`)
		}
	}

	const body = cssFontFamily(tokens.typography.fontFamily, tokens.typography.fallback)
	const display = tokens.typography.displayFamily
		? cssFontFamily(tokens.typography.displayFamily, tokens.typography.displayFallback || tokens.typography.fallback)
		: body
	lines.push(`  --font-sans: ${body};`)
	lines.push(`  --font-display: ${display};`)

	// The type scale: `text-xl` follows the foundation's ratio, not Tailwind's
	// default steps. Each size carries its own line height — from the tokens
	// when the foundation names them, otherwise derived, so leading is never the
	// default pair computed for a different size.
	for (const [label, raw] of Object.entries(tokens.typography.scale ?? {})) {
		const size = typeof raw === "number" ? raw : Number.parseFloat(String(raw))
		if (!Number.isFinite(size) || size <= 0) continue
		lines.push(`  --text-${label}: ${size}px;`)
		const leading = tokens.typography.leadings?.[label]
		lines.push(`  --text-${label}--line-height: ${typeof leading === "number" ? leading : lineHeightFor(size)};`)
	}
	if (tokens.typography.tracking?.display) {
		lines.push(`  --tracking-display: ${tokens.typography.tracking.display};`)
	}

	// Radius character: `rounded-sm` … `rounded-xl` follow the foundation, so
	// flipping `soft` to `round` re-corners every page live.
	const radiusScale = tokens.radius?.scale ?? []
	for (const [index, label] of RADIUS_LABELS) {
		const value = radiusScale[index]
		if (typeof value === "number" && Number.isFinite(value) && value < 9999) {
			lines.push(`  --radius-${label}: ${value}px;`)
		}
	}

	// Elevation: `shadow-raised`/`shadow-floating`/`shadow-overlay` come from the
	// foundation, deliberately shadowing Tailwind's stock ladder — a shadow is a
	// design decision, tinted by this project's neutral, not a stock grey.
	if (tokens.elevation?.scale) {
		const shadowNames: Array<[keyof typeof tokens.elevation.scale, string]> = [
			["raised", "sm"],
			["raised", "raised"],
			["floating", "md"],
			["floating", "floating"],
			["overlay", "lg"],
			["overlay", "overlay"],
		]
		for (const [key, alias] of shadowNames) {
			const value = tokens.elevation.scale[key]
			if (value) lines.push(`  --shadow-${alias}: ${value};`)
		}
	}

	// Hairlines and the focus ring.
	if (tokens.border) {
		lines.push(`  --color-border: ${tokens.border.color};`)
		lines.push(`  --border-width: ${tokens.border.width}px;`)
		lines.push(`  --color-ring: ${tokens.border.focusRing.color};`)
		lines.push(`  --ring-width: ${tokens.border.focusRing.width}px;`)
	}

	// Micro-interaction timing: every transition uses these; choreography stays
	// with the pages.
	if (tokens.motion) {
		lines.push(`  --duration-fast: ${tokens.motion.durations.fast}ms;`)
		lines.push(`  --duration-base: ${tokens.motion.durations.base}ms;`)
		lines.push(`  --duration-slow: ${tokens.motion.durations.slow}ms;`)
		lines.push(`  --ease-standard: ${tokens.motion.easing.standard};`)
		lines.push(`  --ease-decelerate: ${tokens.motion.easing.decelerate};`)
	}

	return `/* GENERATED by Caret from tokens/foundation.json — do not edit; edit the foundation. */
@theme {
${lines.join("\n")}
}

:root {
  --caret-font-family: ${body};
  --caret-font-display: ${display};
  --caret-font-base: ${tokens.typography.baseSize || 16}px;
}
`
}
