/**
 * Fills in everything a foundation implies but nobody should be asked about.
 *
 * A foundation names choices — a brand seed, a neutral character, an elevation
 * character, vibe tags. This module derives their consequences: colour ramps,
 * WCAG-checked foreground pairings, shadow strings, border colours, motion
 * timing, line heights. It runs on every write path (wizard finalize, the
 * manual editor's `tokens:write`, the agent's `commit_foundation`), which is
 * what lets an old foundation self-heal the first time it is touched.
 *
 * The dividing line, and it is load-bearing: **choices are preserved,
 * consequences are recomputed.** A hand-tweaked scale step survives because
 * scales are only filled when empty; on-colours, shadow strings, border
 * colours and motion are pure functions of the choices and are recomputed
 * every time so they can never drift from the palette they were derived from.
 */
import { contrastRatio, generateNeutralScale, generateTokenScale } from "./token-scales"
import type { BorderTokens, ColorTokens, ElevationTokens, FoundationTokens, MotionTokens, OnColors } from "./types"

/** The darkest ink we pair against light backgrounds when the neutral ramp is unavailable. */
const FALLBACK_INK = "#171717"
const FALLBACK_PAPER = "#fafafa"

/** Pick the foreground with the greater WCAG contrast against `background`. */
export function onColorFor(background: string, ink: string = FALLBACK_INK, paper: string = FALLBACK_PAPER): string {
	return contrastRatio(background, ink) >= contrastRatio(background, paper) ? ink : paper
}

function deriveOnColors(color: ColorTokens): OnColors {
	// JSON round-trips make scale keys strings; the numeric-literal keys on
	// ColorScale are a typing nicety, not the runtime shape.
	const neutral = color.neutral.scale as Record<string, string | undefined>
	const ink = neutral["950"] ?? neutral["900"] ?? FALLBACK_INK
	const paper = neutral["50"] ?? FALLBACK_PAPER
	const dark = color.surface === "dark"
	const surfaceBg = dark ? (neutral["950"] ?? "#0a0a0a") : (neutral["50"] ?? "#ffffff")

	// Muted text: the quietest neutral step that still clears 4.5:1 on the
	// surface. Walking from the quiet end guarantees the most muted legal step.
	const mutedCandidates = dark ? ["400", "300", "200", "100", "50"] : ["600", "700", "800", "900", "950"]
	let muted = dark ? paper : ink
	for (const step of mutedCandidates) {
		const candidate = neutral[step]
		if (candidate && contrastRatio(candidate, surfaceBg) >= 4.5) {
			muted = candidate
			break
		}
	}

	const on: OnColors = {
		brand: onColorFor(color.brand.seed, ink, paper),
		surface: dark ? paper : ink,
		surfaceMuted: muted,
	}
	if (color.secondary) on.secondary = onColorFor(color.secondary.seed, ink, paper)
	if (color.accent) on.accent = onColorFor(color.accent.seed, ink, paper)
	return on
}

/**
 * Shadow strings per elevation character, tinted from the neutral ramp so a
 * warm project's shadows are not the same cold grey as everyone else's. Dark
 * surfaces need more alpha for a shadow to register at all.
 */
function deriveElevationScale(character: ElevationTokens["character"], color: ColorTokens): ElevationTokens["scale"] {
	const tint = color.neutral.scale["900"] ?? "#171717"
	const dark = color.surface === "dark"
	const rgb = {
		r: Number.parseInt(tint.slice(1, 3), 16) || 23,
		g: Number.parseInt(tint.slice(3, 5), 16) || 23,
		b: Number.parseInt(tint.slice(5, 7), 16) || 23,
	}
	const shadowBase = dark ? "0, 0, 0" : `${rgb.r}, ${rgb.g}, ${rgb.b}`
	const a = (alpha: number) => (dark ? Math.min(1, alpha * 2.2) : alpha).toFixed(2)

	if (character === "flat") {
		// Flat design still needs overlays to separate from the page.
		return {
			flat: "none",
			raised: "none",
			floating: `0 2px 8px rgba(${shadowBase}, ${a(0.06)})`,
			overlay: `0 12px 32px -8px rgba(${shadowBase}, ${a(0.14)})`,
		}
	}
	if (character === "pronounced") {
		return {
			flat: "none",
			raised: `0 2px 4px rgba(${shadowBase}, ${a(0.08)}), 0 1px 2px rgba(${shadowBase}, ${a(0.06)})`,
			floating: `0 8px 24px -4px rgba(${shadowBase}, ${a(0.14)})`,
			overlay: `0 24px 56px -12px rgba(${shadowBase}, ${a(0.28)})`,
		}
	}
	return {
		flat: "none",
		raised: `0 1px 2px rgba(${shadowBase}, ${a(0.05)})`,
		floating: `0 4px 12px -2px rgba(${shadowBase}, ${a(0.08)})`,
		overlay: `0 16px 40px -8px rgba(${shadowBase}, ${a(0.18)})`,
	}
}

function deriveBorder(color: ColorTokens, existing?: BorderTokens): BorderTokens {
	const dark = color.surface === "dark"
	const borderColor = (dark ? color.neutral.scale["800"] : color.neutral.scale["200"]) ?? (dark ? "#262626" : "#e5e5e5")
	return {
		// Widths are the editable half; colours follow the palette.
		width: existing?.width ?? 1,
		color: borderColor,
		focusRing: { color: color.brand.seed, width: existing?.focusRing.width ?? 2 },
	}
}

/** Tags that read as wanting things quick and tight vs unhurried. */
const SNAPPY_TAGS = new Set(["dense", "pro", "fast", "efficient", "technical", "precise", "sharp", "utilitarian", "data"])
const RELAXED_TAGS = new Set(["calm", "warm", "elegant", "editorial", "serene", "soft", "luxurious", "considered", "quiet"])

function deriveMotion(tags: string[]): MotionTokens {
	const lower = tags.map((t) => t.toLowerCase())
	const snappy = lower.filter((t) => SNAPPY_TAGS.has(t)).length
	const relaxed = lower.filter((t) => RELAXED_TAGS.has(t)).length
	const durations =
		snappy > relaxed
			? { fast: 120, base: 200, slow: 300 }
			: relaxed > snappy
				? { fast: 180, base: 300, slow: 450 }
				: { fast: 150, base: 250, slow: 350 }
	return {
		durations,
		easing: { standard: "cubic-bezier(0.2, 0, 0, 1)", decelerate: "cubic-bezier(0, 0, 0.2, 1)" },
	}
}

/**
 * Line height belongs to the size: body sizes want room to read, display sizes
 * want to sit tight. A step the user already set keeps its value — derivation
 * only fills steps the scale has and the leadings lack.
 */
export function leadingFor(sizePx: number): number {
	if (sizePx < 20) return 1.5
	if (sizePx < 28) return 1.4
	if (sizePx < 40) return 1.25
	return 1.1
}

function isEmpty(scale: Record<string, unknown> | undefined): boolean {
	return !scale || Object.keys(scale).length === 0
}

/**
 * The one normalization every write path runs. Returns a new object; the input
 * is not mutated.
 */
export function withDerivedScales(tokens: FoundationTokens): FoundationTokens {
	const out: FoundationTokens = structuredClone(tokens)

	// Ramps: filled only when empty, so a hand-tweaked step survives.
	if (isEmpty(out.color.brand.scale)) {
		out.color.brand.scale = generateTokenScale("color", out.color.brand.seed, { steps: 11 })
	}
	for (const role of ["secondary", "accent"] as const) {
		const entry = out.color[role]
		if (entry && isEmpty(entry.scale)) {
			entry.scale = generateTokenScale("color", entry.seed, { steps: 11 })
		}
	}
	if (isEmpty(out.color.neutral.scale)) {
		out.color.neutral.scale = generateNeutralScale(out.color.neutral.character, { brandSeed: out.color.brand.seed })
	}
	if (isEmpty(out.typography.scale)) {
		const generated = generateTokenScale("typography", String(out.typography.baseSize || 16), {
			ratio: out.typography.scaleRatio || 1.25,
		})
		const numeric: Record<string, number> = {}
		for (const [label, value] of Object.entries(generated)) numeric[label] = Number.parseFloat(value)
		out.typography.scale = numeric
	}

	// Leadings: fill steps the scale has and the leadings lack.
	const leadings = { ...(out.typography.leadings ?? {}) }
	for (const [label, size] of Object.entries(out.typography.scale)) {
		if (typeof leadings[label] !== "number" && Number.isFinite(size)) leadings[label] = leadingFor(size)
	}
	out.typography.leadings = leadings

	// Consequences: recomputed every time so they can never drift from the
	// palette they were derived from.
	out.color.on = deriveOnColors(out.color)
	const elevationCharacter = out.elevation?.character ?? "subtle"
	out.elevation = { character: elevationCharacter, scale: deriveElevationScale(elevationCharacter, out.color) }
	out.border = deriveBorder(out.color, out.border)
	out.motion = deriveMotion(out.vibe.tags ?? [])

	return out
}
