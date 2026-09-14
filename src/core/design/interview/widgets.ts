/**
 * The wizard's widget vocabulary — the contract between the model and the UI.
 *
 * The model runs the interview: it reads the project description and decides
 * what to ask, in its own words, with its own options. What it does *not* get
 * to invent is how a question appears on screen. Every question must be one of
 * the kinds below, each of which has a purpose-built surface in the renderer —
 * specimens for typefaces, swatches plus a real colour picker for colour, a
 * morphing preview for density. A model free to ask anything but bound to
 * render through real components is the whole design: freedom over *what*,
 * none over *how it looks*.
 *
 * Everything here is a wire shape. Validation lives in `conductor.ts` (a turn
 * that is malformed is retried against the validator's own complaint) and in
 * `finalize.ts` (a finish that names impossible values is bounced the same
 * way).
 */

export type WidgetKind =
	| "options" // cards with live previews — the general-purpose pick
	| "color" // swatches + the real picker/hex/eyedropper as "other"
	| "font" // type specimens + Google Fonts search as "other"
	| "scale" // two poles, stepped, specimen morphs live — density, rounding, loudness
	| "chips" // multi-select facts: which surfaces exist, what states matter
	| "text" // one free input, for facts only the user knows
	| "boolean" // two mini-mocks side by side
	| "assumptions" // things inferred from the description, confirmed in one screen

/**
 * What a preview card needs to draw itself. All optional: anything absent is
 * filled from the answers so far, so a colour question previews in the typeface
 * the user already picked.
 */
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

export interface WizardOption {
	id: string
	/** For `font` questions this is the family name, verbatim. */
	label: string
	/** Why this fits *their* product — grounded in the description, no jargon. */
	reason?: string
	/** For `color` options: the colour itself. */
	hex?: string
	spec?: SpecimenParams
}

export interface ScaleStep {
	label: string
	spec?: SpecimenParams
}

export interface WizardQuestion {
	/** Model-chosen slug, unique within the interview. */
	id: string
	kind: WidgetKind
	/** Plain language, addressed to the user. */
	question: string
	/** One line on why this is being asked / what it affects. */
	why?: string
	options?: WizardOption[]
	/** Preselected. Pressing straight through must yield a good foundation. */
	recommendedId?: string
	/**
	 * Collaborative mode only: which coverage areas this question settles.
	 * Sanitized (unknown ids dropped), never rejected over. Absent in ai-led
	 * interviews.
	 */
	covers?: string[]
	/**
	 * DEPRECATED, ignored by the renderer and absent from the schema: the
	 * escape hatch is determined by `kind` + the coverage area in the harness,
	 * never chosen by the model. Kept only so old scratch files still parse.
	 */
	other?: "color" | "font" | "text"
	/** `scale` only. */
	leftLabel?: string
	rightLabel?: string
	steps?: ScaleStep[]
	defaultStep?: number
	/** `text` only. */
	placeholder?: string
	multiline?: boolean
}

export interface AnswerData {
	hex?: string
	family?: string
	px?: number
	ratio?: number
	none?: boolean
}

export interface WizardAnswer {
	questionId: string
	/** Echoed so the model's transcript reads without a lookup. */
	question: string
	kind: WidgetKind
	/**
	 * The pick: an option id, a hex, a family name, a step label, free text, or
	 * a comma-joined list for chips. For assumptions: `id=yes` / `id=<correction>`
	 * pairs, one per line.
	 */
	value: string
	/** The human label of what was picked, when it differs from the value. */
	label?: string
	/** True when the user went through the escape hatch rather than an option. */
	wasOther?: boolean
	/**
	 * The typed payload, written by the WIDGET at the moment of capture — the
	 * hex field writes `hex` after validating it, the font search writes
	 * `family` from the catalogue, a hex-less "none" option writes `none` by
	 * its identity, the numeric inputs write `px`/`ratio`. The ledger consumes
	 * ONLY this — never a regex over `value` or `label`, which is how a colour
	 * named "Nordic Noir" stays a colour and not a "no".
	 */
	data?: AnswerData
	/** True when the user skipped the question: the recommendation stands. */
	skipped?: boolean
}

export interface StoredQA {
	question: WizardQuestion
	answer: WizardAnswer
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

export type WizardTurn = { action: "ask"; question: WizardQuestion } | { action: "finish"; foundation: FoundationProposal }

/**
 * The schema handed to `structured()`.
 *
 * Deliberately looser than the types above: enums pin what enums can pin, and
 * everything cross-field — "a scale question needs steps", "recommendedId must
 * name an option" — is enforced in `validateTurn`, where a violation produces a
 * sentence the retry prompt can quote. A schema strict enough to catch those
 * would reject with a message only a JSON Schema implementer could love.
 */
/**
 * Inlined everywhere it appears rather than `$ref`'d: the schema travels to
 * whichever provider the backend has, and `$ref` support is exactly the kind of
 * corner that varies between them.
 */
const SPEC_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		displayFamily: { type: "string" },
		bodyFamily: { type: "string" },
		surface: { enum: ["light", "dark"] },
		accent: { type: "string" },
		neutral: { enum: ["warm", "cool", "true", "slight-tint"] },
		radius: { type: "number" },
		spacingUnit: { type: "number" },
		baseSize: { type: "number" },
		shadow: { type: "string" },
	},
} as const

export const WIZARD_TURN_SCHEMA: Record<string, unknown> = {
	type: "object",
	required: ["action"],
	additionalProperties: false,
	properties: {
		action: { enum: ["ask", "finish"] },
		question: {
			type: "object",
			required: ["id", "kind", "question"],
			additionalProperties: false,
			properties: {
				id: { type: "string" },
				kind: { enum: ["options", "color", "font", "scale", "chips", "text", "boolean", "assumptions"] },
				question: { type: "string" },
				why: { type: "string" },
				recommendedId: { type: "string" },
				covers: { type: "array", items: { type: "string" } },
				// `other` (the model-chosen escape hatch) is deliberately NOT in the
				// schema: the input surface is determined by `kind` + the coverage
				// area, in the harness. A field here would hand the model a decision
				// it is prone to hallucinate wrong (field-measured: an accent
				// question shipped without a picker).
				leftLabel: { type: "string" },
				rightLabel: { type: "string" },
				defaultStep: { type: "number" },
				placeholder: { type: "string" },
				multiline: { type: "boolean" },
				options: {
					type: "array",
					maxItems: 6,
					items: {
						type: "object",
						required: ["id", "label"],
						additionalProperties: false,
						properties: {
							id: { type: "string" },
							label: { type: "string" },
							reason: { type: "string" },
							hex: { type: "string" },
							spec: SPEC_SCHEMA,
						},
					},
				},
				steps: {
					type: "array",
					maxItems: 7,
					items: {
						type: "object",
						required: ["label"],
						additionalProperties: false,
						properties: { label: { type: "string" }, spec: SPEC_SCHEMA },
					},
				},
			},
		},
		foundation: {
			type: "object",
			required: [
				"displayFamily",
				"bodyFamily",
				"scaleRatio",
				"baseSize",
				"brand",
				"neutral",
				"surface",
				"spacingUnit",
				"radiusCharacter",
				"rule",
				"summary",
			],
			additionalProperties: false,
			properties: {
				displayFamily: { type: "string" },
				displayFallback: { type: "string" },
				bodyFamily: { type: "string" },
				bodyFallback: { type: "string" },
				scaleRatio: { type: "number" },
				baseSize: { type: "number" },
				brand: { type: "string" },
				secondary: { type: "string" },
				accent: { type: "string" },
				neutral: { enum: ["warm", "cool", "true", "slight-tint"] },
				surface: { enum: ["light", "dark"] },
				spacingUnit: { type: "number" },
				radiusCharacter: { enum: ["sharp", "soft", "round", "pill"] },
				elevationCharacter: { enum: ["flat", "subtle", "pronounced"] },
				displayWeight: { type: "number" },
				bodyWeight: { type: "number" },
				rule: { type: "string" },
				vibeTags: { type: "array", items: { type: "string" } },
				summary: { type: "string" },
				decisions: {
					type: "array",
					items: {
						type: "object",
						required: ["area", "choice", "reason"],
						additionalProperties: false,
						properties: {
							area: { type: "string" },
							choice: { type: "string" },
							reason: { type: "string" },
						},
					},
				},
				semantic: {
					type: "object",
					additionalProperties: false,
					properties: {
						success: { type: "string" },
						warning: { type: "string" },
						error: { type: "string" },
						info: { type: "string" },
					},
				},
			},
		},
	},
}

const HEX = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/** `#abc` and `abc123` become `#aabbcc` / `#abc123`; anything else is null. */
export function normalizeHex(value: string | undefined): string | null {
	if (!value) return null
	const match = HEX.exec(value.trim())
	if (!match) return null
	const hex = match[1].toLowerCase()
	return `#${hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex}`
}
