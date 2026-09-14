/**
 * The mark target's prompt language — the pure half, kept apart from the
 * electron-importing loop so its lessons can be pinned by unit tests.
 *
 * Both lessons were measured (caret-learning/mark-probe, 2026-08-31, against a
 * real project palette), not asserted:
 *
 * 1. **Ask for a trademark, not an illustration.** "A flat vector logo mark:
 *    {brief}" hands the brief over literally and returns clip-art — the brief
 *    must be framed as an idea a studio reduces to a symbol.
 * 2. **No photograph language, and constraints stated positively.** The prompt
 *    used to end with `foundationWords()` — "deep shadows, a single soft light
 *    source, most of the frame in shadow" — which contradicted its own
 *    avoid-list and measurably produced glows, vignettes and one printed
 *    business-card mockup the list explicitly banned. The image model has no
 *    negative-prompt channel; describing what IS there beats banning what
 *    isn't. The foundation binds to a mark through its colours and surface
 *    hex, and through nothing else.
 */
import type { GeneratorPalette } from "../../src/core/design"

/**
 * The design directions the takes explore.
 *
 * Three takes used to be three rolls of ONE prompt, which is why they came
 * back near-identical — the model has one first idea per brief, and asking
 * three times gets it three times. A studio explores distinct *approaches* to
 * the same idea and puts them side by side, so each take gets its own
 * direction, and the cursor rotates so "fresh options" brings approaches not
 * yet seen rather than rerolls.
 *
 * The label ships to the UI: naming the approach on the card is the
 * difference between three pictures and three design decisions.
 */
export interface MarkDirection {
	id: string
	label: string
	prompt: string
}

export const MARK_DIRECTIONS: MarkDirection[] = [
	{
		id: "geometric",
		label: "Geometric",
		prompt:
			"Design direction — geometric construction: bold solid forms built on true circles, arcs and straight edges, " +
			"near-symmetric, heavy and stable, with the confidence of a foundry or shipping-line trademark.",
	},
	{
		id: "negative-space",
		label: "Negative space",
		prompt:
			"Design direction — negative space: one solid container shape (a circle, roundel or square) with the subject " +
			"cut cleanly out of it, so the drawing is made by what is missing rather than by what is added.",
	},
	{
		id: "monoline",
		label: "Monoline",
		prompt:
			"Design direction — monoline: the subject drawn as a single continuous stroke of perfectly even weight, open " +
			"and dynamic, with cleanly cut ends and no filled areas at all.",
	},
	{
		id: "silhouette",
		label: "Bold silhouette",
		prompt:
			"Design direction — bold silhouette: the subject as one confident solid shape with no interior detail except " +
			"a single decisive cut or gap, filling the frame with a heavy, unmistakable outline.",
	},
	{
		id: "modular",
		label: "Modular",
		prompt:
			"Design direction — modular system: the whole mark assembled from a small kit of one repeated shape (the same " +
			"circle, wedge or bar) used several times at different sizes or rotations, so the construction reads as rational.",
	},
	{
		id: "concentric",
		label: "Concentric",
		prompt:
			"Design direction — concentric: the subject expressed as nested rings, arcs or bands at one consistent stroke " +
			"weight, radiating from a common centre, with the idea carried by where the rings break.",
	},
]

/**
 * Which directions the next batch gets, per project. Rotating means "fresh
 * options" is genuinely fresh, and the pool covers two full rounds before
 * anything repeats.
 */
const directionCursor = new Map<string, number>()

export function nextDirections(projectPath: string, count: number): MarkDirection[] {
	const start = directionCursor.get(projectPath) ?? 0
	directionCursor.set(projectPath, (start + count) % MARK_DIRECTIONS.length)
	return Array.from({ length: count }, (_, i) => MARK_DIRECTIONS[(start + i) % MARK_DIRECTIONS.length])
}

/** The prompt one target candidate is generated from. See the module doc. */
export function targetPrompt(brief: string, palette: GeneratorPalette, direction: MarkDirection): string {
	return [
		"A logo mark by a world-class brand identity studio, presented as the finished flat vector symbol.",
		`The idea behind the mark: ${brief.trim()}.`,
		"The studio reduces that idea to its simplest, boldest geometric essence — the way iconic modernist trademarks reduce — so it reads as a designed symbol, never as a picture of the thing.",
		direction.prompt,
		`The whole image is exactly three flat solid colours: the mark's shapes in ${palette.brand} and ${palette.ink}, on a plain ${palette.surface} background that fills every edge of the frame.`,
		"Every shape is a flat solid fill drawn with compass-and-ruler precision — perfectly smooth curves, straight cuts, crisp corners; the exact look of a finished SVG file, matte and print-ready.",
		"The construction is deliberate: one consistent stroke logic throughout, optically balanced, the mark centred in the square frame filling about two thirds of it with generous even margins.",
		"The silhouette alone is recognisable, and every element is bold enough to stay legible at 24 pixels.",
	].join(" ")
}

/**
 * The short negative tail. Kept to the three failure modes that persist even
 * against a strong positive prompt; everything else this list used to carry is
 * now stated positively in `targetPrompt`, because the measured pattern was
 * the positive language winning whenever the two disagreed.
 */
export const TARGET_AVOID = [
	"letters, numbers or typography",
	"gradients, glow, shadows or 3D rendering",
	"photographic elements, mockups or scenery",
]
