export interface VibeDescriptor {
	description: string
	tags: string[]
}

export interface ColorScale {
	50: string
	100: string
	200: string
	300: string
	400: string
	500: string
	600: string
	700: string
	800: string
	900: string
	950: string
}

/** A colour the palette names: one chosen seed, everything else derived. */
export interface ColorRole {
	seed: string
	scale: Partial<ColorScale>
}

/**
 * Foreground colours guaranteed to read on their backgrounds. Never chosen —
 * Caret picks each one by WCAG contrast (≥ 4.5:1 wherever the ramp allows) so
 * "text on brand" is a token, not a habit of reaching for white.
 */
export interface OnColors {
	brand: string
	secondary?: string
	accent?: string
	/** Text on the project's surface. */
	surface: string
	/** De-emphasised text that still clears contrast on the surface. */
	surfaceMuted: string
}

export interface ColorTokens {
	brand: ColorRole
	/** A supporting colour, when the palette has one. Same shape as brand. */
	secondary?: ColorRole
	/** An accent used sparingly, when the palette has one. Same shape as brand. */
	accent?: ColorRole
	neutral: {
		character: "warm" | "cool" | "true" | "slight-tint"
		scale: Partial<ColorScale>
	}
	/** Derived, never asked — see {@link OnColors}. */
	on?: OnColors
	/**
	 * Whether this project is built on light or dark surfaces.
	 *
	 * Optional because foundations written before this field existed do not carry
	 * it; everything that reads it treats absent as `light`. The wizard has always
	 * *asked* — the palette recipes each declare a surface and `FoundationProposal`
	 * requires one — but until Phase 6.7 the answer was dropped in `finalize`, so
	 * nothing downstream could act on it. Generated assets are the first thing that
	 * genuinely cannot: an image composed for a white page is wrong on a dark one
	 * in a way no amount of description repairs.
	 */
	surface?: "light" | "dark"
	semantic: {
		success: string
		warning: string
		error: string
		info: string
	}
}

export interface TypographyTokens {
	fontFamily: string
	fallback: string
	/**
	 * The heading face, when it differs from the body. Optional and additive —
	 * foundations written before the wizard existed have only `fontFamily`, and
	 * everything that reads tokens treats the display pair as body-when-absent.
	 */
	displayFamily?: string
	displayFallback?: string
	scaleRatio: number
	baseSize: number
	scale: Record<string, number>
	/**
	 * Unitless line height per scale step — display sizes sit tight (~1.1), body
	 * sizes get room to read (~1.5). Derived from the sizes; a hand-set value for
	 * a step survives because derivation only fills steps the scale has and the
	 * leadings lack.
	 */
	leadings?: Record<string, number>
	/**
	 * The weights this foundation allows, per role — a restraint decision, and
	 * also what the webfont import actually fetches. Absent means the historical
	 * default set (400–900).
	 */
	weights?: { display: number[]; body: number[] }
	/** Letter-spacing for large display sizes, e.g. "-0.02em". */
	tracking?: { display?: string }
}

/**
 * How much depth the interface has. The character is a choice (flat design vs
 * shadowed); the shadow strings are derived from it, tinted by the neutral and
 * adjusted for the surface.
 */
export interface ElevationTokens {
	character: "flat" | "subtle" | "pronounced"
	scale: {
		flat: string
		raised: string
		floating: string
		overlay: string
	}
}

/** Hairlines and the focus ring. Colours derived from neutral and brand. */
export interface BorderTokens {
	width: number
	color: string
	focusRing: { color: string; width: number }
}

/**
 * Micro-interaction timing only — hovers, menus, modals. Choreography is design
 * content and belongs to the pages, not the foundation. Always derived from the
 * vibe; never an interview question.
 */
export interface MotionTokens {
	durations: { fast: number; base: number; slow: number }
	easing: { standard: string; decelerate: string }
}

/**
 * Who committed this foundation and why it looks the way it does. Doubles as
 * the "a person actually chose this" marker that separates a real foundation
 * from the scaffold default — and as the only place the interview's reasoning
 * survives the commit.
 */
export interface FoundationMeta {
	committed: true
	committedAt: string
	source: "wizard" | "wizard-collaborative" | "manual" | "agent"
	/** The one-sentence restraint rule the foundation adopts. */
	rule?: string
	/** Two or three sentences to the user on what was built and why. */
	summary?: string
	/** Collaborative interviews record every decision with its reasoning. */
	decisions?: Array<{ area: string; choice: string; reason: string }>
}

export interface SpacingTokens {
	baseUnit: 4 | 8
	scale: number[]
}

export interface RadiusTokens {
	character: "sharp" | "soft" | "round" | "pill"
	scale: number[]
}

export interface FoundationTokens {
	vibe: VibeDescriptor
	color: ColorTokens
	typography: TypographyTokens
	spacing: SpacingTokens
	radius: RadiusTokens
	elevation?: ElevationTokens
	border?: BorderTokens
	motion?: MotionTokens
	meta?: FoundationMeta
}

export interface PageMeta {
	id: string
	title: string
	type: string
	states: string[]
	tags: string[]
	/**
	 * Set on a generate-and-pick take: the page this one is a variant OF. Variant
	 * pages are transient working copies — the canvas grid, the rules context and
	 * the sync inventory all exclude them; only the compare surface shows them.
	 */
	variantOf?: string
}

export interface FlowStep {
	page: string
	label?: string
	next: string[]
	onError?: string[]
}

export interface FlowDefinition {
	id: string
	name: string
	description?: string
	steps: FlowStep[]
	/** Set by the rendering shell when the flow file is corrupt/invalid. */
	invalid?: boolean
	error?: string
}

export interface SyncState {
	lastSyncedCommit: string | null
}

export type DesignContext = "implementation" | "design"
