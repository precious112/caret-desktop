/**
 * The shared shapes for the live preview and the finished foundation.
 *
 * Shared with the screen, so it must stay free of Node and of the engine's
 * `@/` paths.
 */

/** What the live preview draws: the parts of a foundation an option changes. */
export interface SpecimenParams {
	displayFamily?: string
	bodyFamily?: string
	surface?: "light" | "dark"
	/**
	 * Accent hex, e.g. the brand colour this option proposes. A preview field —
	 * not the palette's `accent` role, which lives on `FoundationProposal`.
	 */
	accent?: string
	neutral?: "warm" | "cool" | "true" | "slight-tint"
	/** Card/button radius in px. */
	radius?: number
	spacingUnit?: number
	baseSize?: number
	/**
	 * CSS box-shadow the preview card casts — how a depth option shows itself.
	 * Before this existed, a shadow question's three options rendered as three
	 * identical cards (field report), because the spec had no way to differ.
	 */
	shadow?: string
}

/**
 * What the model hands over when it is done deciding.
 *
 * Parameters, never files: the model names families, hexes and characters, and
 * Caret derives every scale itself (`finalize.ts`), so the committed
 * `foundation.json` has exactly the shape the token editor edits.
 */
export interface FoundationProposal {
	displayFamily: string
	displayFallback?: string
	bodyFamily: string
	bodyFallback?: string
	scaleRatio: number
	baseSize: number
	/** Brand hex. */
	brand: string
	/** A supporting colour hex, when the palette has one. */
	secondary?: string
	/** An accent hex used sparingly, when the palette has one. */
	accent?: string
	neutral: "warm" | "cool" | "true" | "slight-tint"
	surface: "light" | "dark"
	semantic?: { success?: string; warning?: string; error?: string; info?: string }
	spacingUnit: number
	radiusCharacter: "sharp" | "soft" | "round" | "pill"
	/** How much depth the interface has. Absent means subtle. */
	elevationCharacter?: "flat" | "subtle" | "pronounced"
	/** The heading weight the foundation allows, e.g. 600. */
	displayWeight?: number
	/** The body weights, usually 400 with 500 for emphasis. */
	bodyWeight?: number
	/** The restraint rule this foundation adopts — carried into the rules files. */
	rule: string
	vibeTags?: string[]
	/** Two or three sentences to the user on what was built and why. */
	summary: string
	/**
	 * Collaborative mode: every coverage area's decision with its reasoning.
	 * Persisted into `meta.decisions` so the reasoning outlives the interview.
	 */
	decisions?: Array<{ area: string; choice: string; reason: string }>
}

/** One definition, in the shared topic rules. */
export { normalizeHex } from "./areas"
