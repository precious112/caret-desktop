/**
 * A proposal becomes `foundation.json` — in Caret's code, never the model's.
 *
 * The model decides *parameters*: which families, which hex, how dense, how
 * round. Everything derived — the colour scale, the type scale, the spacing and
 * radius arrays — is computed here with the same `generateTokenScale` the token
 * editor uses, so a foundation the wizard built and one built by hand are the
 * same shape and stay editable by the same tools. A model asked to emit the
 * file itself would produce a one-off.
 *
 * Validation here is mechanical, not taste: hexes must parse, numbers must be
 * in ranges where the derivations behave. Violations throw with a sentence the
 * conductor's retry can quote back at the model.
 */
import { withDerivedScales } from "../derive"
import { SHAPE_PRESETS } from "../foundation-library"
import { generateTokenScale } from "../token-scales"
import type { ColorTokens, FoundationTokens } from "../types"
import { type FoundationProposal, normalizeHex } from "./widgets"

export class ProposalError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "ProposalError"
	}
}

/** Sensible semantics for a product that never discussed them. */
const DEFAULT_SEMANTIC = { success: "#16a34a", warning: "#ca8a04", error: "#dc2626", info: "#2563eb" }

const FALLBACK_STACKS: Record<string, string> = {
	sans: "ui-sans-serif, system-ui, sans-serif",
	serif: "ui-serif, Georgia, serif",
	mono: "ui-monospace, monospace",
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value))
}

/** Every scale for a radius character, from the curated presets' own values. */
function radiusScaleFor(character: FoundationProposal["radiusCharacter"]): number[] {
	const preset = SHAPE_PRESETS.find((p) => p.radius.character === character)
	if (preset) return preset.radius.scale
	// A character no preset carries — only possible if the presets change.
	return {
		sharp: [0, 2, 2, 4, 4, 9999],
		soft: [0, 2, 4, 8, 12, 9999],
		round: [0, 4, 8, 16, 24, 9999],
		pill: [0, 4, 8, 16, 32, 9999],
	}[character]
}

function spacingScaleFor(unit: 4 | 8): number[] {
	const preset = SHAPE_PRESETS.find((p) => p.spacing.baseUnit === unit)
	return (
		preset?.spacing.scale ??
		(unit === 4 ? [0, 1, 2, 4, 6, 8, 12, 16, 24, 32, 48, 64] : [0, 2, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128])
	)
}

/** The generator emits px strings; `FoundationTokens.typography.scale` is numeric. */
function numericScale(scale: Record<string, string>): Record<string, number> {
	const out: Record<string, number> = {}
	for (const [key, value] of Object.entries(scale)) out[key] = Number.parseFloat(value)
	return out
}

export interface FinalizedFoundation {
	tokens: FoundationTokens
	name: string
	rule: string
	summary: string
	/** Collaborative interviews: per-area reasoning, destined for `meta.decisions`. */
	decisions?: Array<{ area: string; choice: string; reason: string }>
}

export function finalizeProposal(proposal: FoundationProposal, description: string): FinalizedFoundation {
	const brand = normalizeHex(proposal.brand)
	if (!brand) throw new ProposalError(`"${proposal.brand}" is not a hex colour — use six hex digits like #2563eb.`)

	// Optional palette roles: absent is fine, unparseable is a bounce.
	const roles: Pick<ColorTokens, "secondary" | "accent"> = {}
	for (const role of ["secondary", "accent"] as const) {
		const raw = proposal[role]
		if (raw === undefined || raw === null || raw === "") continue
		const hex = normalizeHex(raw)
		if (!hex) throw new ProposalError(`The ${role} colour "${raw}" is not a hex colour — use six hex digits like #2563eb.`)
		roles[role] = { seed: hex, scale: generateTokenScale("color", hex, { steps: 11 }) }
	}

	if (!proposal.displayFamily?.trim() || !proposal.bodyFamily?.trim()) {
		throw new ProposalError("Both displayFamily and bodyFamily must be real Google Fonts family names.")
	}
	if (!proposal.rule?.trim()) throw new ProposalError("The restraint rule is missing — one sentence on how colour is used.")

	// Clamped rather than refused: the ranges are where the scale derivations
	// stay sane, and a model that says 1.62 meant "dramatic", not "invalid".
	const scaleRatio = clamp(proposal.scaleRatio, 1.05, 1.5)
	const baseSize = Math.round(clamp(proposal.baseSize, 12, 20))
	const spacingUnit: 4 | 8 = proposal.spacingUnit <= 6 ? 4 : 8

	const semantic = { ...DEFAULT_SEMANTIC }
	for (const key of ["success", "warning", "error", "info"] as const) {
		const hex = normalizeHex(proposal.semantic?.[key])
		if (hex) semantic[key] = hex
	}

	// The weights a foundation allows. A named weight is snapped to the real
	// axis; absent means the conventional pair.
	const snapWeight = (value: number | undefined, fallback: number): number => {
		if (typeof value !== "number" || !Number.isFinite(value)) return fallback
		return Math.round(Math.min(900, Math.max(100, value)) / 100) * 100
	}
	const displayWeight = snapWeight(proposal.displayWeight, 600)
	const bodyWeight = snapWeight(proposal.bodyWeight, 400)

	const tokens: FoundationTokens = {
		vibe: {
			description: description.trim() || proposal.summary,
			tags: [...new Set(proposal.vibeTags ?? [])],
		},
		color: {
			brand: { seed: brand, scale: generateTokenScale("color", brand, { steps: 11 }) },
			...roles,
			neutral: { character: proposal.neutral, scale: {} },
			semantic,
			surface: proposal.surface === "dark" ? "dark" : "light",
		},
		typography: {
			fontFamily: proposal.bodyFamily.trim(),
			fallback: proposal.bodyFallback?.trim() || FALLBACK_STACKS.sans,
			displayFamily: proposal.displayFamily.trim(),
			displayFallback: proposal.displayFallback?.trim() || FALLBACK_STACKS.sans,
			scaleRatio,
			baseSize,
			scale: numericScale(generateTokenScale("typography", String(baseSize), { ratio: scaleRatio })),
			weights: {
				display: [displayWeight],
				body: bodyWeight === 500 ? [400, 500] : [...new Set([bodyWeight, 500])].sort((a, b) => a - b),
			},
		},
		spacing: { baseUnit: spacingUnit, scale: spacingScaleFor(spacingUnit) },
		radius: { character: proposal.radiusCharacter, scale: radiusScaleFor(proposal.radiusCharacter) },
		elevation: proposal.elevationCharacter
			? { character: proposal.elevationCharacter, scale: { flat: "", raised: "", floating: "", overlay: "" } }
			: undefined,
	}

	return {
		// The derivation pass fills the neutral ramp, on-colours, elevation
		// strings, border, motion and leadings — consequences, not choices.
		tokens: withDerivedScales(tokens),
		name: `${proposal.displayFamily.trim()} · ${proposal.bodyFamily.trim()}`,
		rule: proposal.rule.trim(),
		summary: proposal.summary?.trim() ?? "",
		decisions: proposal.decisions?.length ? proposal.decisions : undefined,
	}
}
