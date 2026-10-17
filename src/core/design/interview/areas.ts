/**
 * The interview's 12 topics, in the order Caret asks them, and the exact values
 * each one allows.
 *
 * This file is the one place these rules live. The interview engine, the
 * interview screen and the step that saves the foundation all read it, so
 * they cannot disagree about what a valid answer is (they used to: the screen
 * accepted a 22px body size that saving then quietly turned into 20px).
 *
 * Shared with the screen, so it must stay free of Node, of the `@/` path
 * aliases and of anything that only runs in the engine.
 */
import { SHAPE_PRESETS } from "../foundation-library/presets"
import type { SpecimenParams } from "./widgets"

/** The topics, in the order the interview asks them. The ids are saved in foundations: never rename one. */
export const AREA_ORDER = [
	"surface",
	"display-type",
	"body-type",
	"type-scale",
	"brand-color",
	"secondary-color",
	"accent-color",
	"neutral",
	"semantics",
	"spacing",
	"radius",
	"depth",
] as const

export type AreaId = (typeof AREA_ORDER)[number]

export type Neutral = "warm" | "cool" | "true" | "slight-tint"
export type RadiusCharacter = "sharp" | "soft" | "round" | "pill"
export type Elevation = "flat" | "subtle" | "pronounced"

/** The value an answer to each topic carries. */
export interface AreaValues {
	surface: { surface: "light" | "dark" }
	"display-type": { family: string }
	"body-type": { family: string }
	"type-scale": { baseSize: number; scaleRatio: number }
	"brand-color": { hex: string }
	"secondary-color": { hex: string } | { none: true }
	"accent-color": { hex: string } | { none: true }
	neutral: { neutral: Neutral }
	semantics: { success: string; warning: string; error: string; info: string }
	spacing: { spacingUnit: 4 | 8 }
	radius: { radiusCharacter: RadiusCharacter }
	depth: { elevation: Elevation }
}
export type AreaValue<A extends AreaId = AreaId> = AreaValues[A]

/** What Caret can save. Typed values outside these are refused with a reason, never quietly changed. */
export const RANGES = {
	baseSize: { min: 12, max: 20 },
	scaleRatio: { min: 1.05, max: 1.5 },
} as const

/** How a topic's question is shown. */
export type InputKind = "cards" | "color" | "font" | "slider" | "status"

/** The box for typing your own answer, when a topic has one. */
export type OwnInput = "hex" | "font" | "size" | "status-hexes"

export interface AreaSpec {
	id: AreaId
	/** As shown in the Covering list. */
	label: string
	/** As shown in the So far panel. */
	term: string
	input: InputKind
	ownInput: OwnInput | null
	/**
	 * Always asked as its own question when starting from a description: fonts,
	 * colours, sizes and spacing are the user's to choose, never settled by the
	 * opening "here's what I took from your description" screen.
	 */
	mustAsk: boolean
	/** Can be settled on the opening screen when starting from a description. */
	confirmable: boolean
	/** Offers "None" (Caret adds it; the model never has to). */
	allowsNone: boolean
	/** How many options the model must offer, not counting "None". */
	optionCount: readonly [number, number]
	/** For topics with a fixed set of answers, the only values an option may carry. */
	fixedValues?: readonly AreaValue[]
}

export const AREAS: { readonly [A in AreaId]: AreaSpec & { id: A } } = {
	surface: {
		id: "surface",
		label: "light or dark",
		term: "Surface",
		input: "cards",
		ownInput: null,
		mustAsk: false,
		confirmable: true,
		allowsNone: false,
		optionCount: [2, 2],
		fixedValues: [{ surface: "dark" }, { surface: "light" }],
	},
	"display-type": {
		id: "display-type",
		label: "the heading typeface",
		term: "Headings",
		input: "font",
		ownInput: "font",
		mustAsk: true,
		confirmable: false,
		allowsNone: false,
		optionCount: [2, 4],
	},
	"body-type": {
		id: "body-type",
		label: "the body typeface",
		term: "Body",
		input: "font",
		ownInput: "font",
		mustAsk: true,
		confirmable: false,
		allowsNone: false,
		optionCount: [2, 4],
	},
	"type-scale": {
		id: "type-scale",
		label: "type size and weight",
		term: "Sizes",
		input: "slider",
		ownInput: "size",
		mustAsk: true,
		confirmable: false,
		allowsNone: false,
		optionCount: [3, 5],
	},
	"brand-color": {
		id: "brand-color",
		label: "the brand colour",
		term: "Brand",
		input: "color",
		ownInput: "hex",
		mustAsk: true,
		confirmable: false,
		allowsNone: false,
		optionCount: [2, 4],
	},
	"secondary-color": {
		id: "secondary-color",
		label: "a supporting colour",
		term: "Supporting",
		input: "color",
		ownInput: "hex",
		mustAsk: true,
		confirmable: false,
		allowsNone: true,
		optionCount: [2, 3],
	},
	"accent-color": {
		id: "accent-color",
		label: "an accent colour",
		term: "Accent",
		input: "color",
		ownInput: "hex",
		mustAsk: true,
		confirmable: false,
		allowsNone: true,
		optionCount: [2, 3],
	},
	neutral: {
		id: "neutral",
		label: "the greys",
		term: "Greys",
		input: "cards",
		ownInput: null,
		mustAsk: false,
		confirmable: true,
		allowsNone: false,
		optionCount: [2, 4],
		fixedValues: [{ neutral: "cool" }, { neutral: "true" }, { neutral: "warm" }, { neutral: "slight-tint" }],
	},
	semantics: {
		id: "semantics",
		label: "success/warning/error colours",
		term: "Status",
		input: "status",
		ownInput: "status-hexes",
		mustAsk: false,
		confirmable: true,
		allowsNone: false,
		optionCount: [2, 3],
	},
	spacing: {
		id: "spacing",
		label: "density and spacing",
		term: "Spacing",
		input: "cards",
		ownInput: null,
		mustAsk: true,
		confirmable: false,
		allowsNone: false,
		optionCount: [2, 2],
		fixedValues: [{ spacingUnit: 4 }, { spacingUnit: 8 }],
	},
	radius: {
		id: "radius",
		label: "corner rounding",
		term: "Corners",
		input: "cards",
		ownInput: null,
		mustAsk: false,
		confirmable: true,
		allowsNone: false,
		optionCount: [2, 4],
		fixedValues: [
			{ radiusCharacter: "sharp" },
			{ radiusCharacter: "soft" },
			{ radiusCharacter: "round" },
			{ radiusCharacter: "pill" },
		],
	},
	depth: {
		id: "depth",
		label: "shadows and depth",
		term: "Depth",
		input: "cards",
		ownInput: null,
		mustAsk: false,
		confirmable: true,
		allowsNone: false,
		optionCount: [2, 3],
		fixedValues: [{ elevation: "flat" }, { elevation: "subtle" }, { elevation: "pronounced" }],
	},
}

export const isAreaId = (value: unknown): value is AreaId =>
	typeof value === "string" && (AREA_ORDER as readonly string[]).includes(value)

const HEX = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/** `#abc` and `abc123` become `#aabbcc` / `#abc123`; anything else is null. */
export function normalizeHex(value: string | undefined): string | null {
	if (!value) return null
	const match = HEX.exec(value.trim())
	if (!match) return null
	const hex = match[1].toLowerCase()
	return `#${hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex}`
}

const isHex = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/.test(value)
const keysAre = (value: object, keys: string[]) => Object.keys(value).length === keys.length && keys.every((key) => key in value)

/** True when `value` is exactly a valid answer for `area`: right shape, in range, hexes normalised. */
export function isAreaValue<A extends AreaId>(area: A, value: unknown): value is AreaValue<A> {
	if (!value || typeof value !== "object") return false
	const v = value as Record<string, unknown>
	const spec = AREAS[area]
	if (spec.fixedValues) return spec.fixedValues.some((allowed) => sameValue(allowed, value as AreaValue))
	switch (area) {
		case "display-type":
		case "body-type":
			return keysAre(v, ["family"]) && typeof v.family === "string" && v.family.trim().length > 0
		case "type-scale":
			return (
				keysAre(v, ["baseSize", "scaleRatio"]) &&
				Number.isInteger(v.baseSize) &&
				(v.baseSize as number) >= RANGES.baseSize.min &&
				(v.baseSize as number) <= RANGES.baseSize.max &&
				typeof v.scaleRatio === "number" &&
				v.scaleRatio >= RANGES.scaleRatio.min &&
				v.scaleRatio <= RANGES.scaleRatio.max
			)
		case "brand-color":
			return keysAre(v, ["hex"]) && isHex(v.hex)
		case "secondary-color":
		case "accent-color":
			return (keysAre(v, ["hex"]) && isHex(v.hex)) || (keysAre(v, ["none"]) && v.none === true)
		case "semantics":
			return keysAre(v, ["success", "warning", "error", "info"]) && [v.success, v.warning, v.error, v.info].every(isHex)
		default:
			return false
	}
}

/** Two answers are the same value. */
export function sameValue(a: AreaValue, b: AreaValue): boolean {
	const ka = Object.keys(a).sort()
	const kb = Object.keys(b).sort()
	if (ka.join() !== kb.join()) return false
	return ka.every((key) => {
		const x = (a as Record<string, unknown>)[key]
		const y = (b as Record<string, unknown>)[key]
		return typeof x === "string" && typeof y === "string" ? x.toLowerCase() === y.toLowerCase() : x === y
	})
}

/** The card and button corner the preview draws for each character: the foundation's own medium step. */
export function radiusPx(character: RadiusCharacter): number {
	if (character === "pill") return 9999
	const preset = SHAPE_PRESETS.find((p) => p.radius.character === character)
	return preset?.radius.scale[3] ?? 8
}

/** The shadow the preview card casts for each depth. */
export const SHADOW_PREVIEW: Readonly<Record<Elevation, string>> = {
	flat: "none",
	subtle: "0 4px 12px -2px rgba(0, 0, 0, 0.18)",
	pronounced: "0 10px 28px -6px rgba(0, 0, 0, 0.36)",
}

const NEUTRAL_WORDS: Record<Neutral, string> = {
	cool: "Cool",
	true: "True grey",
	warm: "Warm",
	"slight-tint": "Slightly tinted",
}
const RADIUS_WORDS: Record<RadiusCharacter, string> = { sharp: "Sharp", soft: "Soft", round: "Round", pill: "Pill" }
const DEPTH_WORDS: Record<Elevation, string> = { flat: "Flat", subtle: "Subtle", pronounced: "Pronounced" }

/** An answer in a few plain words, as So far and the finish's decisions show it. */
export function describeValue(area: AreaId, value: AreaValue): string {
	const v = value as Record<string, unknown>
	switch (area) {
		case "surface":
			return v.surface === "dark" ? "Dark" : "Light"
		case "display-type":
		case "body-type":
			return String(v.family)
		case "type-scale":
			return `${v.baseSize}px body, headings ×${v.scaleRatio}`
		case "brand-color":
		case "secondary-color":
		case "accent-color":
			return "none" in v ? "None" : String(v.hex)
		case "neutral":
			return NEUTRAL_WORDS[v.neutral as Neutral]
		case "semantics":
			return `${v.success}, ${v.warning}, ${v.error}`
		case "spacing":
			return v.spacingUnit === 4 ? "Tight, 4px base" : "Comfortable, 8px base"
		case "radius": {
			const character = v.radiusCharacter as RadiusCharacter
			return character === "pill" ? "Pill" : `${RADIUS_WORDS[character]}, ${radiusPx(character)}px`
		}
		case "depth":
			return DEPTH_WORDS[v.elevation as Elevation]
	}
}

/** The colours an answer shows as swatches next to its description. */
export function swatchesOf(area: AreaId, value: AreaValue): string[] {
	const v = value as Record<string, unknown>
	if (area === "semantics") return [v.success, v.warning, v.error, v.info] as string[]
	if (typeof v.hex === "string") return [v.hex]
	return []
}

/** What one answer changes in the live preview. */
export function specOf(area: AreaId, value: AreaValue): SpecimenParams {
	const v = value as Record<string, unknown>
	switch (area) {
		case "surface":
			return { surface: v.surface as "light" | "dark" }
		case "display-type":
			return { displayFamily: String(v.family) }
		case "body-type":
			return { bodyFamily: String(v.family) }
		case "type-scale":
			return { baseSize: v.baseSize as number }
		case "brand-color":
		case "secondary-color":
		case "accent-color":
			return typeof v.hex === "string" ? { accent: v.hex } : {}
		case "neutral":
			return { neutral: v.neutral as Neutral }
		case "semantics":
			return {}
		case "spacing":
			return { spacingUnit: v.spacingUnit as number }
		case "radius":
			return { radius: radiusPx(v.radiusCharacter as RadiusCharacter) }
		case "depth":
			return { shadow: SHADOW_PREVIEW[v.elevation as Elevation] }
	}
}
