/**
 * The LLM's half of 3D optimization: deciding, never touching.
 *
 * A language model cannot rewrite mesh binary, and asking it to would produce
 * confident garbage. What it is genuinely good at is the judgment call nobody
 * else in the pipeline can make: *this* object, doing *this* job on a page,
 * with a draft weighing *this* much — how far can the face count and texture
 * drop before the object stops doing its job? The answer differs completely
 * between a hero centrepiece and a small card decoration, and no fixed table
 * captures that.
 *
 * So the model answers inside a bounded schema — the same anti-slop floor as
 * everywhere else — and Tripo's convert task does the actual work. The decision
 * and its reasoning land in provenance, because "why is this 4MB" deserves an
 * answer months later.
 *
 * **The recommended models are the user's own list**, matched against what the
 * backend actually reports rather than hardcoded as ids that go stale the day a
 * provider renames something.
 */
import { type CodingBackend, StructuredOutputError } from "../../agent/backend"

export interface OptimizationDecision {
	faceLimit: number
	textureSize: 512 | 1024 | 2048 | 4096
	reason: string
}

/** The bounds the model answers inside. Published so the UI can show them. */
export const OPTIMIZATION_BOUNDS = {
	faceLimit: { min: 2_000, max: 60_000 },
	textureSizes: [512, 1024, 2048, 4096] as const,
}

/**
 * The weight band an optimized page object should land in.
 *
 * 3–5MB, set by the user after looking at the first results: the 740KB version
 * held its silhouette and lost its *surface* — textures re-baked down to 1024px
 * gave labels a melted look. The binding constraint on quality turned out to be
 * texture resolution, not face count, so the band exists to stop the optimizer
 * winning the size game by losing the object.
 */
export const WEIGHT_BAND = { minBytes: 3 * 1024 * 1024, maxBytes: 5 * 1024 * 1024 }

const DECISION_SCHEMA: Record<string, unknown> = {
	type: "object",
	required: ["faceLimit", "textureSize", "reason"],
	additionalProperties: false,
	properties: {
		faceLimit: {
			type: "integer",
			minimum: OPTIMIZATION_BOUNDS.faceLimit.min,
			maximum: OPTIMIZATION_BOUNDS.faceLimit.max,
		},
		textureSize: { enum: [...OPTIMIZATION_BOUNDS.textureSizes] },
		reason: { type: "string" },
	},
}

export interface OptimizationInput {
	backend: CodingBackend
	workingDirectory: string
	/** The per-task override, or empty for the session model. */
	model?: string
	/** What the draft weighs, so the budget argument is concrete. */
	draftBytes: number
	/** What the object is for, in the user's terms. */
	intendedUse: string
	/** The source image's own description, when it has one — it names the subject. */
	sourceDescription?: string
}

/**
 * Asks the model for convert parameters.
 *
 * Clamped after the fact as well as bounded in the schema, because on backends
 * with no native schema mode the result comes from prompt-and-parse and
 * "schema-valid" is a weaker guarantee — the `emulated` flag exists to say
 * exactly that, and this function honours it.
 */
export async function decideOptimization(input: OptimizationInput): Promise<OptimizationDecision> {
	const result = await input.backend.structured<OptimizationDecision>({
		workingDirectory: input.workingDirectory,
		model: input.model || undefined,
		schema: DECISION_SCHEMA,
		systemPrompt:
			"You are deciding mesh-optimization parameters for a 3D asset that will be embedded in a web page. " +
			"You answer with parameters only; a conversion service applies them.",
		prompt: [
			`A 3D model was generated from an image${input.sourceDescription ? ` of: ${input.sourceDescription}` : ""}.`,
			`Its draft weighs ${Math.round(input.draftBytes / 1024)}KB.`,
			`It will be used as: ${input.intendedUse}.`,
			"",
			"Decide the face limit and texture size for the optimized version. The budget argument:",
			"- Aim for a final file between 3MB and 5MB. Below that band, real damage has been observed: textures re-baked too small give surfaces a dirty look and make printed labels unreadable, like plastic melted under heat.",
			"- Texture resolution is usually the binding constraint on perceived quality, not face count. When trading, keep texture resolution and cut faces.",
			"- 2048 is the ordinary texture answer; 4096 if the object carries text or fine surface detail; 1024 and below only for something small, matte and label-free.",
			"- Silhouette survives decimation; printed detail does not.",
			"",
			"Explain the trade you chose in one or two sentences — it is recorded in the asset's provenance.",
		].join("\n"),
	})

	const value = result.value
	if (
		typeof value?.faceLimit !== "number" ||
		typeof value?.reason !== "string" ||
		!OPTIMIZATION_BOUNDS.textureSizes.includes(value?.textureSize)
	) {
		throw new StructuredOutputError(`the optimization answer was not usable: ${JSON.stringify(value).slice(0, 200)}`)
	}

	return {
		faceLimit: Math.round(
			Math.min(OPTIMIZATION_BOUNDS.faceLimit.max, Math.max(OPTIMIZATION_BOUNDS.faceLimit.min, value.faceLimit)),
		),
		textureSize: value.textureSize,
		reason: value.reason.trim(),
	}
}

/**
 * The user's named list of models suited to this task, as matchers.
 *
 * Matchers rather than ids: "Kimi K3" is `moonshotai/kimi-k3` on one backend
 * and `kimi-k3-instruct` on another, and both should light up. A model that
 * matches nothing is still selectable — recommended is a highlight, not a gate.
 */
export const RECOMMENDED_OPTIMIZER_MATCHERS: Array<{ name: string; pattern: RegExp }> = [
	{ name: "Fable 5", pattern: /fable[-\s]?5/i },
	{ name: "GPT 5.6 Sol", pattern: /gpt[-\s]?5\.6|(^|[^a-z])sol([^a-z]|$)/i },
	{ name: "Kimi K3", pattern: /kimi[-\s]?k3/i },
	{ name: "GLM 5.2", pattern: /glm[-\s]?5\.2/i },
	{ name: "DeepSeek V4 Flash", pattern: /deepseek[-\s]?v4/i },
]

export function isRecommendedOptimizer(idOrLabel: string): boolean {
	return RECOMMENDED_OPTIMIZER_MATCHERS.some((matcher) => matcher.pattern.test(idOrLabel))
}
