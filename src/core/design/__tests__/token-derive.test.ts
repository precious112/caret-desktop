/**
 * The scale algorithms and the derivation pass.
 *
 * The old colour ramp's defect was structural: steps 50–500 tinted toward
 * white, so `brand-500` — the step every Tailwind-trained agent treats as "the
 * brand colour" — was a pastel, with a hard jump to 600. These tests pin the
 * repaired contract: the seed IS 500, lightness is monotonic end to end, and
 * every consequence (neutral ramp, on-colours, elevation, motion, leadings) is
 * derived rather than left empty.
 */
import assert from "assert"

import { leadingFor, withDerivedScales } from "../derive"
import { contrastRatio, generateNeutralScale, generateTokenScale, hexToHsl } from "../token-scales"
import type { FoundationTokens } from "../types"

const STEPS = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"]

/** Realistic brand seeds, including the two from the field that exposed the pastel bug. */
const SEEDS = ["#f59e0b", "#b45309", "#2563eb", "#16a34a", "#dc2626", "#7c3aed", "#0ea5e9", "#171717"]

function baseTokens(): FoundationTokens {
	return {
		vibe: { description: "A quiet reading app", tags: ["calm", "warm"] },
		color: {
			brand: { seed: "#b45309", scale: {} },
			neutral: { character: "warm", scale: {} },
			semantic: { success: "#16a34a", warning: "#ca8a04", error: "#dc2626", info: "#2563eb" },
			surface: "light",
		},
		typography: { fontFamily: "Inter", fallback: "system-ui, sans-serif", scaleRatio: 1.25, baseSize: 16, scale: {} },
		spacing: { baseUnit: 8, scale: [0, 2, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128] },
		radius: { character: "soft", scale: [0, 2, 4, 8, 12, 9999] },
	}
}

describe("generateColorScale", () => {
	it("puts the seed itself at 500 — the step agents treat as the brand colour", () => {
		for (const seed of ["#f59e0b", "#b45309", "#2563eb", "#7c3aed"]) {
			const scale = generateTokenScale("color", seed, { steps: 11 })
			assert.equal(scale["500"], seed, `${seed} did not land at 500`)
		}
	})

	it("is monotonic in lightness from 50 to 950, for realistic and extreme seeds alike", () => {
		for (const seed of [...SEEDS, "#fefefe", "#050505"]) {
			const scale = generateTokenScale("color", seed, { steps: 11 })
			for (let i = 1; i < STEPS.length; i++) {
				const prev = hexToHsl(scale[STEPS[i - 1]]).l
				const curr = hexToHsl(scale[STEPS[i]]).l
				assert.ok(prev >= curr - 0.001, `${seed}: step ${STEPS[i]} (${curr}) is lighter than ${STEPS[i - 1]} (${prev})`)
			}
		}
	})

	it("has no pastel discontinuity: 500 sits between 400 and 600, near the seed's own lightness", () => {
		const scale = generateTokenScale("color", "#f59e0b", { steps: 11 })
		const l400 = hexToHsl(scale["400"]).l
		const l500 = hexToHsl(scale["500"]).l
		const l600 = hexToHsl(scale["600"]).l
		assert.ok(l400 > l500 && l500 > l600, "500 is not between its neighbours")
		assert.ok(Math.abs(l500 - hexToHsl("#f59e0b").l) < 0.01, "500 drifted from the seed")
	})
})

describe("generateNeutralScale", () => {
	it("gives each character its own tint, and `true` a pure grey", () => {
		const warm = generateNeutralScale("warm")
		const cool = generateNeutralScale("cool")
		const pure = generateNeutralScale("true")
		assert.notEqual(warm["600"], cool["600"], "warm and cool neutrals are identical")
		const { s } = hexToHsl(pure["600"])
		assert.ok(s < 0.01, "`true` neutral is tinted")
		assert.ok(hexToHsl(warm["600"]).s > 0.01, "warm neutral carries no tint")
	})

	it("tints slight-tint from the brand seed's hue", () => {
		const tinted = generateNeutralScale("slight-tint", { brandSeed: "#dc2626" })
		const hue = hexToHsl(tinted["500"]).h
		assert.ok(hue < 30 || hue > 330, `slight-tint hue ${hue} is nowhere near the red seed`)
	})
})

describe("withDerivedScales", () => {
	it("fills every empty ramp and derives every consequence", () => {
		const out = withDerivedScales(baseTokens())
		assert.equal(out.color.brand.scale["500"], "#b45309")
		assert.ok(Object.keys(out.color.neutral.scale).length === 11, "neutral ramp not derived")
		assert.ok(out.color.on?.brand && out.color.on.surface && out.color.on.surfaceMuted, "on-colours missing")
		assert.equal(out.elevation?.character, "subtle")
		assert.ok(out.elevation?.scale.raised.includes("rgba"), "elevation strings not derived")
		assert.ok(out.border?.color, "border not derived")
		assert.ok(out.motion, "motion not derived")
		assert.ok(out.typography.leadings?.base, "leadings not derived")
	})

	it("preserves a hand-tweaked ramp step — choices survive, consequences are recomputed", () => {
		const tokens = baseTokens()
		tokens.color.brand.scale = { 500: "#123456" } as FoundationTokens["color"]["brand"]["scale"]
		const out = withDerivedScales(tokens)
		assert.equal(out.color.brand.scale["500"], "#123456", "a non-empty ramp was regenerated")
	})

	it("keeps a set elevation character and border widths, but re-derives their colours", () => {
		const tokens = baseTokens()
		tokens.elevation = { character: "pronounced", scale: { flat: "", raised: "", floating: "", overlay: "" } }
		tokens.border = { width: 2, color: "#ff0000", focusRing: { color: "#ff0000", width: 3 } }
		const out = withDerivedScales(tokens)
		assert.equal(out.elevation?.character, "pronounced")
		assert.ok(out.elevation?.scale.overlay.includes("rgba"), "pronounced scale not derived")
		assert.equal(out.border?.width, 2)
		assert.equal(out.border?.focusRing.width, 3)
		assert.notEqual(out.border?.color, "#ff0000", "border colour did not follow the palette")
		assert.equal(out.border?.focusRing.color, tokens.color.brand.seed)
	})

	it("pairs an on-colour that clears WCAG 4.5:1 against every realistic seed", () => {
		for (const seed of SEEDS) {
			const tokens = baseTokens()
			tokens.color.brand = { seed, scale: {} }
			const out = withDerivedScales(tokens)
			const ratio = contrastRatio(out.color.on?.brand ?? "", seed)
			assert.ok(ratio >= 4.5, `${seed}: on-brand ${out.color.on?.brand} only reaches ${ratio.toFixed(2)}:1`)
		}
	})

	it("keeps muted text legible on both surfaces", () => {
		for (const surface of ["light", "dark"] as const) {
			const tokens = baseTokens()
			tokens.color.surface = surface
			const out = withDerivedScales(tokens)
			const scale = out.color.neutral.scale as Record<string, string>
			const bg = surface === "dark" ? scale["950"] : scale["50"]
			const ratio = contrastRatio(out.color.on?.surfaceMuted ?? "", bg)
			assert.ok(ratio >= 4.5, `${surface}: muted text only reaches ${ratio.toFixed(2)}:1`)
		}
	})

	it("derives motion from the vibe — calm projects move slower than dense ones", () => {
		const calm = withDerivedScales(baseTokens())
		const dense = baseTokens()
		dense.vibe.tags = ["dense", "technical"]
		const snappy = withDerivedScales(dense)
		assert.ok((calm.motion?.durations.base ?? 0) > (snappy.motion?.durations.base ?? 0), "vibe did not move the timing")
	})
})

describe("leadingFor", () => {
	it("loosens monotonically from display sizes down to body sizes", () => {
		const sizes = [64, 40, 28, 20, 16, 12]
		const leadings = sizes.map(leadingFor)
		for (let i = 1; i < leadings.length; i++) {
			assert.ok(leadings[i] >= leadings[i - 1], `leading tightened as size shrank: ${sizes[i]}px`)
		}
	})
})
