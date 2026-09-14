/**
 * Curated shape and density presets.
 *
 * Radius and spacing are where "I'll just pick something" does the most quiet
 * damage, because the failure is not any single value — it is *inconsistency*.
 * A 6px radius here and an 8px there, padding that is 13px because it looked
 * right once. Each preset below is internally consistent, so picking one makes
 * every later decision follow.
 */

export interface ShapePreset {
	id: string
	name: string
	feel: string
	tags: string[]
	radius: { character: "sharp" | "soft" | "round" | "pill"; scale: number[] }
	spacing: { baseUnit: 4 | 8; scale: number[] }
	/** Body size in px. Density shows up here as much as in spacing. */
	baseSize: number
	rationale: string
}

export const SHAPE_PRESETS: ShapePreset[] = [
	{
		id: "sharp-dense",
		name: "Sharp and dense",
		feel: "Square corners, tight spacing. Lots of information on screen.",
		tags: ["technical", "dense", "dashboard", "data", "enterprise", "serious", "precise"],
		radius: { character: "sharp", scale: [0, 2, 2, 4, 4, 9999] },
		spacing: { baseUnit: 4, scale: [0, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48] },
		baseSize: 14,
		rationale:
			"Near-square corners and a 14px body read as a professional tool. Dense layouts need small radii — a large radius on a small element wastes the corner and looks soft against neighbouring hard edges.",
	},
	{
		id: "soft-comfortable",
		name: "Soft and comfortable",
		feel: "Gently rounded, normal spacing. The safe middle.",
		tags: ["neutral", "product", "saas", "clean", "flexible", "modern", "friendly"],
		radius: { character: "soft", scale: [0, 2, 4, 8, 12, 9999] },
		spacing: { baseUnit: 4, scale: [0, 1, 2, 4, 6, 8, 12, 16, 24, 32, 48, 64] },
		baseSize: 15,
		rationale:
			"The default that is actually defensible. An 8px radius on cards and buttons is small enough to look deliberate rather than bubbly, and a 15px body is comfortable without shouting.",
	},
	{
		id: "round-airy",
		name: "Round and airy",
		feel: "Generously rounded, lots of breathing room.",
		tags: ["friendly", "consumer", "warm", "marketing", "wellness", "playful", "calm"],
		radius: { character: "round", scale: [0, 4, 8, 16, 24, 9999] },
		spacing: { baseUnit: 8, scale: [0, 2, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128] },
		baseSize: 16,
		rationale:
			"Larger radii need larger spacing or the rounding eats the padding and elements look cramped. An 8px base unit keeps that relationship honest as things scale up.",
	},
	{
		id: "editorial-open",
		name: "Editorial and open",
		feel: "Barely rounded, very generous space. Built for reading.",
		tags: ["editorial", "content", "reading", "publishing", "premium", "calm", "considered"],
		radius: { character: "sharp", scale: [0, 0, 2, 4, 8, 9999] },
		spacing: { baseUnit: 8, scale: [0, 2, 4, 8, 16, 24, 32, 48, 64, 96, 128, 160] },
		baseSize: 17,
		rationale:
			"Reading wants a larger body size and much more vertical space than software conventionally uses. Near-square corners keep the focus on the text rather than on the containers.",
	},
	{
		id: "pill-expressive",
		name: "Pill and expressive",
		feel: "Fully rounded buttons, confident spacing.",
		tags: ["bold", "consumer", "playful", "launch", "expressive", "creative", "mobile"],
		radius: { character: "pill", scale: [0, 4, 8, 16, 32, 9999] },
		spacing: { baseUnit: 4, scale: [0, 1, 2, 4, 8, 12, 16, 24, 32, 48, 64, 96] },
		baseSize: 16,
		rationale:
			"Fully rounded works on buttons and pills specifically, not on cards — a pill-shaped card reads as a mistake. The scale keeps large radii available for the elements that want them without applying them everywhere.",
	},
]

export function findPreset(id: string): ShapePreset | undefined {
	return SHAPE_PRESETS.find((p) => p.id === id)
}

/** Ranks presets by tag overlap. Shortlists; never decides. */
export function narrowPresets(tags: string[], limit = 3): ShapePreset[] {
	if (tags.length === 0) return SHAPE_PRESETS.slice(0, limit)
	const wanted = new Set(tags.map((t) => t.toLowerCase()))
	return [...SHAPE_PRESETS]
		.map((preset) => ({ preset, score: preset.tags.filter((t) => wanted.has(t)).length }))
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((entry) => entry.preset)
}
