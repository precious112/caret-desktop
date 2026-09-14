/**
 * The bridge from foundation.json into Tailwind's theme.
 *
 * Before this existed, the rules told every agent "style from these tokens",
 * agents wrote `text-brand-950` — the only reasonable reading of a scale named
 * brand — and Tailwind, with no `--color-brand-950` defined anywhere, generated
 * no CSS. Pages silently rendered in inherited colours; on a dark-seeded
 * project the difference was invisible. These tests pin that every name the
 * rules advertise resolves to a real theme entry.
 */
import { strict as assert } from "assert"

import type { FoundationTokens } from "../../types"
import { foundationFontsCss, foundationThemeCss } from "../theme-css"

const TOKENS: FoundationTokens = {
	vibe: { description: "", tags: [] },
	color: {
		brand: { seed: "#0a0a0a", scale: { "50": "#dadada", "500": "#9c9c9c", "950": "#030303" } },
		neutral: { character: "cool", scale: {} },
		semantic: { success: "#16a34a", warning: "#ca8a04", error: "#dc2626", info: "#2563eb" },
	},
	typography: {
		fontFamily: "Archivo",
		fallback: "Helvetica Neue",
		displayFamily: "Instrument Serif",
		displayFallback: "Georgia",
		scaleRatio: 1.25,
		baseSize: 16,
		scale: {},
	},
	spacing: { baseUnit: 4, scale: [] },
	radius: { character: "sharp", scale: [] },
}

describe("foundationThemeCss", () => {
	it("defines every brand step and the bare seed as Tailwind theme colours", () => {
		const css = foundationThemeCss(TOKENS)
		assert.ok(css.includes("@theme {"), "no @theme block — nothing here reaches Tailwind at all")
		assert.ok(css.includes("--color-brand-50: #dadada;"))
		assert.ok(css.includes("--color-brand-950: #030303;"), "the exact class the store's headings use")
		assert.ok(css.includes("--color-brand: #0a0a0a;"), "the bare seed utility is missing")
	})

	it("defines the semantic colours under the names the rules advertise", () => {
		const css = foundationThemeCss(TOKENS)
		for (const name of ["success", "warning", "error", "info"]) {
			assert.ok(css.includes(`--color-${name}:`), `--color-${name} missing — text-${name} would be inert`)
		}
	})

	it("wires both typefaces, quoted where CSS demands it, and imports them", () => {
		const css = foundationThemeCss(TOKENS)
		assert.ok(css.includes(`--font-sans: Archivo, Helvetica Neue;`))
		assert.ok(css.includes(`--font-display: "Instrument Serif", Georgia;`), "a multi-word family must be quoted")

		const fonts = foundationFontsCss(TOKENS)
		assert.ok(fonts.includes("fonts.googleapis.com/css2"), "the faces are named but never fetched")
		assert.ok(fonts.includes("Instrument+Serif"))
	})

	it("keeps the webfont import out of the theme entirely", () => {
		// The theme is inlined into global.css *after* Tailwind's preflight, so an
		// `@import` living in it is thousands of lines deep in the bundled sheet and
		// PostCSS drops it — the faces are declared and never fetched. It belongs in
		// caret-fonts.css, which global.css imports first.
		const css = foundationThemeCss(TOKENS)
		assert.ok(!css.includes("@import"), "an @import here is silently discarded by the bundler")
	})

	it("falls back to the body face when no display face is set", () => {
		const tokens: FoundationTokens = {
			...TOKENS,
			typography: { ...TOKENS.typography, displayFamily: undefined, displayFallback: undefined },
		}
		const css = foundationThemeCss(tokens)
		assert.ok(css.includes("--font-display: Archivo, Helvetica Neue;"))
	})

	it("shadows Tailwind's stock neutral with the foundation's tinted scale", () => {
		const tokens: FoundationTokens = {
			...TOKENS,
			color: { ...TOKENS.color, neutral: { character: "warm", scale: { "100": "#f5f2ef", "600": "#6b6259" } } },
		}
		const css = foundationThemeCss(tokens)
		assert.ok(css.includes("--color-neutral-100: #f5f2ef;"))
		assert.ok(css.includes("--color-neutral-600: #6b6259;"), "text-neutral-600 would fall back to the untinted stock grey")
	})

	it("defines the type scale with a line height per size", () => {
		const tokens: FoundationTokens = {
			...TOKENS,
			typography: { ...TOKENS.typography, scale: { base: 16, "2xl": 31.25, "5xl": 61.04 } },
		}
		const css = foundationThemeCss(tokens)
		assert.ok(css.includes("--text-base: 16px;"))
		assert.ok(css.includes("--text-base--line-height: 1.5;"))
		assert.ok(css.includes("--text-2xl: 31.25px;"), "text-2xl stays on Tailwind's default steps, not the foundation ratio")
		assert.ok(css.includes("--text-2xl--line-height: 1.25;"))
		assert.ok(css.includes("--text-5xl--line-height: 1.1;"), "display sizes need tight leading, not body leading")
	})

	it("defines radius steps from the foundation's character, skipping none and full", () => {
		const tokens: FoundationTokens = {
			...TOKENS,
			radius: { character: "soft", scale: [0, 2, 4, 8, 12, 9999] },
		}
		const css = foundationThemeCss(tokens)
		assert.ok(css.includes("--radius-sm: 2px;"))
		assert.ok(css.includes("--radius-md: 4px;"))
		assert.ok(css.includes("--radius-lg: 8px;"))
		assert.ok(css.includes("--radius-xl: 12px;"))
		assert.ok(!css.includes("--radius-none"), "rounded-none is always 0 — a theme entry is noise")
		assert.ok(!css.includes("9999px"), "rounded-full must not be redefined")
	})

	it("skips type and radius entries when the foundation carries none", () => {
		const css = foundationThemeCss(TOKENS)
		assert.ok(!css.includes("--text-"), "entries invented from an empty scale")
		assert.ok(!css.includes("--radius-"))
	})

	it("survives an empty brand scale — the seed still yields a usable colour", () => {
		const tokens: FoundationTokens = {
			...TOKENS,
			color: { ...TOKENS.color, brand: { seed: "#3b82f6", scale: {} } },
		}
		const css = foundationThemeCss(tokens)
		assert.ok(css.includes("--color-brand: #3b82f6;"))
		assert.ok(!css.includes("--color-brand-"), "steps invented from nowhere")
	})

	it("defines secondary and accent roles only when the palette carries them", () => {
		assert.ok(!foundationThemeCss(TOKENS).includes("--color-secondary"), "a role the palette lacks was invented")
		const tokens: FoundationTokens = {
			...TOKENS,
			color: {
				...TOKENS.color,
				secondary: { seed: "#0ea5e9", scale: { "500": "#0ea5e9" } },
				accent: { seed: "#f59e0b", scale: { "500": "#f59e0b" } },
			},
		}
		const css = foundationThemeCss(tokens)
		assert.ok(css.includes("--color-secondary-500: #0ea5e9;"))
		assert.ok(css.includes("--color-secondary: #0ea5e9;"), "the bare secondary utility is missing")
		assert.ok(css.includes("--color-accent-500: #f59e0b;"))
		assert.ok(css.includes("--color-accent: #f59e0b;"))
	})

	it("derives a tinted neutral at emission time when the stored scale is empty", () => {
		// Real foundations shipped `neutral.scale: {}` for months, so the theme
		// emitted nothing and text-neutral-* fell through to stock grey. The write
		// paths now derive it, but a never-rewritten project regenerates its theme
		// far more often than its tokens file — so emission derives too.
		const css = foundationThemeCss(TOKENS)
		assert.ok(css.includes("--color-neutral-600:"), "an empty neutral scale emitted nothing — stock grey again")
	})

	it("defines on-colours, shadows, borders and motion under the advertised names", () => {
		const tokens: FoundationTokens = {
			...TOKENS,
			color: { ...TOKENS.color, on: { brand: "#fafafa", surface: "#171717", surfaceMuted: "#525252" } },
			elevation: {
				character: "subtle",
				scale: {
					flat: "none",
					raised: "0 1px 2px rgba(0,0,0,0.05)",
					floating: "0 4px 12px rgba(0,0,0,0.08)",
					overlay: "0 16px 40px rgba(0,0,0,0.18)",
				},
			},
			border: { width: 1, color: "#e5e5e5", focusRing: { color: "#0a0a0a", width: 2 } },
			motion: {
				durations: { fast: 150, base: 250, slow: 350 },
				easing: { standard: "cubic-bezier(0.2, 0, 0, 1)", decelerate: "cubic-bezier(0, 0, 0.2, 1)" },
			},
		}
		const css = foundationThemeCss(tokens)
		assert.ok(css.includes("--color-on-brand: #fafafa;"))
		assert.ok(css.includes("--color-on-surface-muted: #525252;"), "the camelCase key must emit as a kebab-case utility")
		assert.ok(css.includes("--shadow-raised:"), "shadow-raised would be inert")
		assert.ok(css.includes("--shadow-md:"), "the stock shadow names must land on foundation values too")
		assert.ok(css.includes("--color-border: #e5e5e5;"))
		assert.ok(css.includes("--duration-base: 250ms;"))
		assert.ok(css.includes("--ease-standard:"))
	})

	it("fetches exactly the weights the foundation names, plus the conventional pair", () => {
		const tokens: FoundationTokens = {
			...TOKENS,
			typography: { ...TOKENS.typography, weights: { display: [800], body: [400, 500] } },
		}
		const fonts = foundationFontsCss(tokens)
		assert.ok(fonts.includes("wght@400;500;700;800"), `unexpected weights query: ${fonts}`)
	})

	it("prefers the foundation's own leadings over the derived pair", () => {
		const tokens: FoundationTokens = {
			...TOKENS,
			typography: { ...TOKENS.typography, scale: { base: 16 }, leadings: { base: 1.65 } },
		}
		const css = foundationThemeCss(tokens)
		assert.ok(css.includes("--text-base--line-height: 1.65;"), "a hand-set leading was overridden by the derivation")
	})
})
