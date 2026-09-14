/**
 * The questions Caret asks before generating an asset.
 *
 * **Two, and both about the job rather than the look.** The project's
 * foundation already settled how things should feel — palette, surface,
 * neutral character, vibe tags — so asking again would be asking the user to
 * repeat a decision they already made, in vocabulary they do not have. What the
 * foundation cannot know is what this particular asset is *for* and how loudly
 * it should behave, which is exactly what these two ask.
 *
 * This is Phase 6.5's mechanism transplanted and the justification transplants
 * with it: answer questions, look at candidates, point at one. No prompt box at
 * any step, including this one — a free-text "describe the image you want"
 * would return the taste problem to the person who does not have it.
 */
import type { FoundationTokens } from "../types"
import { FREE_LANES } from "./lanes"
import { ASSET_RECIPES, runnableRecipes } from "./recipes"
import type { AssetPurpose, AssetRecipe } from "./types"

export interface GenerationChoice {
	id: string
	label: string
	/** One line under the label, in the user's language. */
	hint: string
	/** Purposes this answer allows. Empty means it does not filter by purpose. */
	purposes: AssetPurpose[]
	/** Vibe tags this answer contributes, on top of the project's own. */
	tags: string[]
}

export interface GenerationQuestion {
	id: string
	question: string
	/** Why it is being asked / what it affects. */
	why: string
	choices: GenerationChoice[]
}

export const GENERATION_QUESTIONS: GenerationQuestion[] = [
	{
		id: "purpose",
		question: "What is it for?",
		why: "This decides the shape and the proportions more than anything about style does.",
		choices: [
			{
				id: "background",
				label: "The background of a hero or a section",
				hint: "Something with a headline or a screenshot sitting on top of it.",
				purposes: ["background"],
				tags: [],
			},
			{
				id: "overlay",
				label: "A texture to lay over an image",
				hint: "Takes the digital edge off a photograph or a flat block of colour.",
				purposes: ["overlay"],
				tags: [],
			},
			{
				id: "accent",
				label: "A shape or an edge treatment",
				hint: "Behind an illustration, an empty state, or in a corner that needs weight.",
				purposes: ["accent"],
				tags: [],
			},
			{
				id: "divider",
				label: "The join between two sections",
				hint: "Where one band of a long page meets the next.",
				purposes: ["divider"],
				tags: [],
			},
			{
				id: "mark",
				label: "A logo or a mark",
				hint: "Drawn as vector by a model that is shown its own work and corrects it.",
				purposes: ["mark"],
				tags: [],
			},
			{
				id: "cutout",
				label: "An object with no background",
				hint: "A product-style shot cut out clean, ready to sit on any surface.",
				purposes: ["cutout"],
				tags: [],
			},
			{
				id: "object3d",
				label: "A 3D object",
				hint: "Built from an image in your library, then optimized so it doesn't weigh the page down.",
				purposes: ["object3d"],
				tags: [],
			},
		],
	},
	{
		id: "volume",
		question: "How much should it draw attention?",
		why: "The same recipe can recede or lead. This is the one thing the foundation cannot decide for a single asset.",
		choices: [
			{
				id: "recede",
				label: "It should recede",
				hint: "You want the content on top of it to be the thing people see.",
				purposes: [],
				tags: ["calm", "minimal", "considered", "clean"],
			},
			{
				id: "balanced",
				label: "Somewhere in the middle",
				hint: "Noticeable if you look, invisible if you do not.",
				purposes: [],
				tags: ["neutral", "product", "modern"],
			},
			{
				id: "lead",
				label: "It should lead",
				hint: "This is the thing people see first.",
				purposes: [],
				tags: ["bold", "expressive", "creative", "loud"],
			},
		],
	},
]

/** Answers keyed by question id, valued by choice id. */
export type GenerationAnswers = Record<string, string>

export function findChoice(questionId: string, choiceId: string): GenerationChoice | undefined {
	return GENERATION_QUESTIONS.find((question) => question.id === questionId)?.choices.find((choice) => choice.id === choiceId)
}

/**
 * Recipes worth offering, given the answers and the project's own foundation.
 *
 * Purpose **filters** and tags **rank**. That split is deliberate: a section
 * divider offered as a hero background is not a worse match, it is the wrong
 * object, and no amount of tag overlap should be able to promote it. Vibe tags
 * are a preference and behave like one.
 */
export function narrowForAnswers(
	answers: GenerationAnswers,
	tokens: FoundationTokens | null,
	lanes: ReadonlySet<string> = FREE_LANES,
): AssetRecipe[] {
	const purposes = new Set<AssetPurpose>()
	const tags: string[] = [...(tokens?.vibe.tags ?? [])]

	for (const question of GENERATION_QUESTIONS) {
		const choice = findChoice(question.id, answers[question.id] ?? "")
		if (!choice) continue
		for (const purpose of choice.purposes) purposes.add(purpose)
		tags.push(...choice.tags)
	}

	const wanted = new Set(tags.map((tag) => tag.toLowerCase()))
	const pool = runnableRecipes(lanes).filter(
		(recipe) => purposes.size === 0 || recipe.purposes.some((purpose) => purposes.has(purpose)),
	)

	return [...pool]
		.map((recipe) => {
			const matched = recipe.tags.filter((tag) => wanted.has(tag)).length
			return { recipe, matched, specificity: recipe.tags.length > 0 ? matched / recipe.tags.length : 0 }
		})
		.sort((a, b) => b.matched - a.matched || b.specificity - a.specificity)
		.map((scored) => scored.recipe)
}

/**
 * The proportions to offer first, by what the asset is for.
 *
 * A default rather than a decision: every recipe declares the ratios it was
 * composed for, and the user picks among those. What this avoids is opening on
 * a square when they said "hero background", which makes the first thing they
 * see wrong for no reason.
 */
export function defaultAspect(recipe: AssetRecipe, answers: GenerationAnswers): string {
	const preferred: Record<string, string[]> = {
		background: ["16:9", "21:9", "3:2"],
		overlay: ["16:9", "3:2", "1:1"],
		accent: ["1:1", "4:5", "3:2"],
		divider: ["21:9", "16:9"],
		cutout: ["1:1", "4:5", "3:2"],
	}
	const wanted = preferred[answers.purpose ?? ""] ?? []
	return wanted.find((aspect) => recipe.aspects.includes(aspect)) ?? recipe.aspects[0]
}

/** A tag proposed for a generated asset, from the recipe and what it is for. */
export function proposeTag(recipe: AssetRecipe, answers: GenerationAnswers): string {
	const purpose = answers.purpose
	// Led by the purpose rather than the recipe, because that is how the user
	// will look for it later: "the hero background", not "the quiet colour wash".
	// Cutout takes no prefix: its recipes already carry the word in their ids.
	const prefix = purpose === "background" ? "hero" : purpose === "divider" ? "divider" : purpose === "overlay" ? "grain" : ""
	return [prefix, recipe.id].filter(Boolean).join("-").slice(0, 40).replace(/-+$/, "")
}

/** Whether every question has an answer Caret recognises. */
export function isComplete(answers: GenerationAnswers): boolean {
	return GENERATION_QUESTIONS.every((question) => Boolean(findChoice(question.id, answers[question.id] ?? "")))
}

/** Every recipe, for the "show me everything" escape hatch. */
export function allRunnableRecipes(): AssetRecipe[] {
	return ASSET_RECIPES.filter((recipe) => recipe.lane === "generator")
}
