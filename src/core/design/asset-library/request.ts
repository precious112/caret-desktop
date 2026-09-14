/**
 * What the user asked for, turned into one request for whichever runner owns it.
 *
 * This replaces recipe *selection*. The old flow asked two questions — what is
 * it for, and how loud should it be — and then picked one of fourteen
 * pre-written blocks of prompt text, each carrying its own hardcoded subject. It
 * could produce six objects. Ask for a paperclip and you got a ceramic vase,
 * because the subject was `[...][variant % 6]` and nothing in the interview ever
 * asked what the thing was.
 *
 * The rule it was built to — "the user is never handed a prompt box" — was the
 * wrong rule, and it overshot a correct argument. The correct argument is about
 * **style**: a non-designer should not be made to describe lighting, framing or
 * mood, because that hands the taste problem back to the person who does not
 * have it. But *what object is it* was never a taste question. It is a content
 * question, and the user is the only party who can possibly answer it. Nobody
 * else knows their contact form needs a paperclip.
 *
 * So: the user says what they want, Caret asks only what it genuinely needs to
 * know, and one prompt is composed from the request, the answers, the
 * foundation, and the constraints below. The user names the thing; Caret still
 * owns how it is lit, framed and coloured.
 *
 * Two kinds of constraint live here and they are not the same:
 *
 * - **Shared quality rules** (`SHARED_AVOID`) apply to every generated image.
 *   They are documented tells, not preferences.
 * - **Hard requirements** are mechanical. A cut-out object *must* be generated
 *   on a flat key colour because `chroma-key.ts` removes that colour by
 *   arithmetic afterwards; a prompt that omits it produces an image with no
 *   alpha. A 3D source image *must* hold one object because Tripo fuses a scene
 *   into a lump. These are not style and they are never negotiable.
 */
import type { CodingBackend } from "../agent/backend"
import type { FoundationTokens } from "../types"
import { foundationWords } from "./raster/palette-words"
import { SLOP_TELLS } from "./recipes"
import type { AssetRecipe, GeneratorPalette, RecipeRequest } from "./types"

/**
 * What the user is making, chosen before they describe it.
 *
 * Picked rather than inferred: opening the generator means already having
 * something in mind, and a model guessing the lane from prose is a guess that
 * can be wrong about which pipeline runs and what it costs.
 */
export type GenerationKind = "image" | "texture" | "mark" | "object3d" | "shader"

export interface AssetRequest {
	kind: GenerationKind
	/** The user's own words. Carried into the prompt unchanged, never paraphrased. */
	text: string
	/**
	 * Whether the result needs a transparent background.
	 *
	 * A property of the image, not a kind of its own: "a paperclip with no
	 * background" is still a photograph. What it switches on is the key-colour
	 * hard requirement below.
	 */
	transparent?: boolean
	/** Answers to the clarifying questions, keyed by question id. */
	answers?: Record<string, string>
}

export interface ClarifyQuestion {
	id: string
	question: string
	/** Why it is being asked. A question without one is a question answered badly. */
	why: string
	/** Fast paths. Free text is always allowed, so these never constrain the answer. */
	suggestions: string[]
}

export interface ClarifyResult {
	/** True when the request as written is already enough to generate well. */
	sufficient: boolean
	questions: ClarifyQuestion[]
}

/**
 * The rules every generated image is held to, whatever it depicts.
 *
 * `SLOP_TELLS` are the artefacts of prompt-box generation. The rest were
 * duplicated across the old recipes one at a time; they are subject-agnostic, so
 * they belong here where a request for something nobody anticipated still gets
 * them.
 */
export const SHARED_AVOID: string[] = [
	// Deal-breakers regardless of any direction: broken pictures, not style.
	"duplicated objects, extra limbs, or geometry that does not resolve",
	"visible screens, or an invented user interface on a device",
]

/**
 * Style defaults, banned only where the user's direction does not ask for
 * them. These used to ride the hard "Do not include" list, and that list was
 * a genre blacklist: "hands touching the subject" forbade a plant app's
 * watering imagery, "a person looking at the camera" forbade portraits, "hard
 * shadows or dramatic theatrical lighting" forbade golden hour — for every
 * user, on every request, last word in the prompt. They exist to protect a
 * one-line prompt from slop defaults, so they now yield explicitly to
 * whatever the direction above them actually says.
 */
export const STYLE_DEFAULT_AVOID: string[] = [
	"lens flare, bokeh sparkles, or light leaks",
	"glowing edges or neon rim lighting",
	"gradient meshes in colours outside the palette",
	"stock-photo business metaphors — handshakes, ladders, lightbulbs, jigsaw pieces",
	"invented logos or illegible text",
	"a person looking at the camera",
	"hands holding or touching the subject",
	"hard shadows or dramatic theatrical lighting",
	"props arranged for the camera — the tidy flat-lay look",
	"the over-processed look sold as cinematic, hyperdetailed or 8k",
]

/** Constraints the matte and 3D reconstruction genuinely require. */
const CUTOUT_AVOID = ["any background other than the plain white it is asked for", "the object cropped by the frame edge"]

const SINGLE_OBJECT_AVOID = [
	"a second object anywhere in the frame",
	"a scene, a room, or any setting around the object",
	"the object cropped by the frame edge",
]

/**
 * How one take differs from the next.
 *
 * Treatment, never subject. Three takes of the thing the user asked for is a
 * choice; three different objects is being handed something you did not ask for
 * and told to pick, which is what the old variant indexing actually did.
 */
const TREATMENTS = [
	"Shot straight on, the subject centred and filling most of the frame.",
	"Shot from a low three-quarter angle, close to the subject.",
	"Shot slightly from above, the subject a little off-centre in the frame.",
]

/** The user's clarifying answers, as sentences a model reads in order. */
function answerWords(answers: Record<string, string> | undefined): string {
	if (!answers) return ""
	return Object.values(answers)
		.map((answer) => answer.trim())
		.filter(Boolean)
		.map((answer) => (answer.endsWith(".") ? answer : `${answer}.`))
		.join(" ")
}

/**
 * Composes the request. Pure — no I/O, no clock, no randomness but `variant`.
 *
 * The user's text leads and is never rewritten: it is the one part of this that
 * only they could have supplied, and paraphrasing it is how a generator starts
 * making something adjacent to what was asked for.
 */
export function composeAssetRequest(
	request: AssetRequest,
	input: { palette: GeneratorPalette; aspect: string; variant: number; tags: string[] },
): RecipeRequest {
	const said = request.text.trim().replace(/\.$/, "")
	const answers = answerWords(request.answers)

	if (request.kind === "shader") {
		// The authored shader lane compiles, renders and critiques, so like the
		// mark it wants a brief. Style guidance lives in the shader system
		// prompt; the brief carries only what the user could know.
		return {
			lane: "authored",
			brief: [`${said}.`, answers].filter(Boolean).join(" "),
			avoid: [...SLOP_TELLS],
		}
	}

	if (request.kind === "mark") {
		// The authored lane renders, screenshots and re-emits, so what it needs is
		// a brief rather than a photographic prompt.
		return {
			lane: "authored",
			brief: [
				`${said}.`,
				answers,
				"Flat vector only: solid fills, no gradients, no photographic effects, no drop shadows.",
				"High contrast, and legible at 20px as well as at full size.",
				`It sits on ${input.palette.surface} and should be drawn in a single colour so it can be recoloured by the page.`,
			]
				.filter(Boolean)
				.join(" "),
			avoid: [...SLOP_TELLS, "lettering unless the mark is a wordmark", "more than one colour"],
		}
	}

	// Everything else composes a photograph. A 3D object starts as one too: Tripo
	// builds from a source image, so the difference is what the image must hold.
	//
	// The prompt is built as PRECEDENCE, not concatenation. The old shape put
	// the user's words, Caret's camera sentence, the palette clamp and a hard
	// ban list side by side as equals — so a user who asked for exactly a hard
	// shadow was followed by "Do not include: hard shadows", and whichever the
	// model obeyed was a coin flip. Three tiers now, each explicitly ranked:
	// the direction (theirs, authoritative), the technical requirements the
	// pipeline itself needs, and defaults that apply only where the direction
	// is silent. A one-line prompt specifies nothing, so every default applies
	// and the slop floor holds; a directed prompt outranks the styling by its
	// own specificity, with no mode and no toggle.
	const singleObject = request.kind === "object3d"
	const cutout = request.kind === "image" && request.transparent === true

	const direction = [`${said}.`, answers].filter(Boolean).join(" ")

	const technical: string[] = []
	if (cutout) {
		// Pure white rather than a key colour. Asked for a specific hex the model
		// returns a flat background of its own choosing — measured at 0% agreement
		// with the colour requested and 100% with itself — and the cutout is then
		// refused for a picture that was perfect. White is not a colour it has to
		// match, so there is nothing to get wrong.
		technical.push(
			"The whole subject is visible in frame.",
			"The background is pure flat white (#ffffff) filling every edge of the frame.",
		)
	} else if (singleObject) {
		technical.push("A single object alone in the frame, the whole object visible, nothing else in the picture.")
	}

	const defaults: string[] = []
	if (cutout) {
		// The old hard mandate ("No shadow, no reflection, no vignette") predates
		// the matte model, which cuts a shadow out as background anyway — so
		// sterile lighting is now only the default, not the law.
		defaults.push("The subject alone and centered. Soft even studio light, no cast shadow, no reflection.")
	} else if (singleObject) {
		defaults.push("Centered, with soft even light from all sides against a plain uncluttered background.")
	} else {
		defaults.push(TREATMENTS[input.variant % TREATMENTS.length])
	}
	// The foundation speaks for anything the direction leaves open, so a
	// request that says nothing about colour still lands on the project's own
	// palette. A cutout is the exception: its background is about to be
	// removed, and palette words there would tint the very white the matte
	// measures against.
	if (!cutout) defaults.push(foundationWords(input.palette))

	const prompt = [
		direction,
		technical.join(" "),
		`Where the description above does not already decide it, default to: ${defaults.join(" ")}`,
		`Unless the description above asks for them, avoid: ${STYLE_DEFAULT_AVOID.join("; ")}.`,
	]
		.filter(Boolean)
		.join("\n\n")

	return {
		lane: "raster",
		prompt,
		avoid: [...SHARED_AVOID, ...(cutout ? CUTOUT_AVOID : []), ...(singleObject ? SINGLE_OBJECT_AVOID : [])],
		aspect: input.aspect,
		transparent: cutout,
	}
}

/** Ratios each kind is worth composing for. The first is the default. */
const ASPECTS_FOR: Record<GenerationKind, string[]> = {
	image: ["3:2", "16:9", "1:1", "4:5", "21:9", "9:16"],
	texture: ["16:9", "3:2", "1:1"],
	mark: ["1:1"],
	object3d: ["1:1"],
	// The poster's ratio only — the live component fills whatever box it gets.
	shader: ["16:10", "21:9", "1:1"],
}

/**
 * The user's request wearing the shape the pipeline already knows how to run.
 *
 * A synthetic recipe rather than a second pipeline. Everything downstream —
 * variant composition, the concurrency pool that keeps the burst under the
 * per-minute quota, chroma-key, the pending store, the provenance record — is
 * already correct and none of it cares where the request came from. The only
 * thing that changes is that `realise` reads what the user said instead of an
 * array index.
 *
 * `use` carries the user's own words because `describeVariant` composes the
 * asset's description from it, and "a paperclip" is a truer description than
 * anything a recipe name could have supplied.
 */
export function recipeForRequest(request: AssetRequest): AssetRecipe {
	const said = request.text.trim()
	return {
		// The text is in the id because the id keys the pending-variant store. Two
		// different requests in one session would otherwise collide there, and the
		// second would accept the first one's picture.
		id: `request:${request.kind}:${fnv1a(said)}`,
		name: said || "Untitled request",
		use: said,
		kind: request.kind === "mark" ? "mark" : request.kind === "shader" ? "gradient" : "photo",
		lane: request.kind === "mark" || request.kind === "shader" ? "authored" : "raster",
		purposes: [request.kind === "mark" ? "mark" : request.kind === "object3d" ? "object3d" : "background"],
		tags: [],
		aspects: ASPECTS_FOR[request.kind],
		realise: (input) => composeAssetRequest(request, input),
		// Composed in by `composeAssetRequest`, which knows whether this is a
		// keyed cutout or a single-object source and what each of those needs.
		avoid: [],
		pairsWith: { palettes: [] },
		rationale: "Composed from what the user asked for.",
	}
}

const CLARIFY_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["sufficient", "questions"],
	properties: {
		sufficient: {
			type: "boolean",
			description: "True when the request as written is already enough to generate a good asset.",
		},
		questions: {
			type: "array",
			maxItems: 3,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "question", "why", "suggestions"],
				properties: {
					id: { type: "string" },
					question: { type: "string" },
					why: { type: "string", description: "What this changes about the result, in the user's language." },
					suggestions: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" } },
				},
			},
		},
	},
} as const

/**
 * Decides whether the request needs anything more, and asks for it if so.
 *
 * Questions are generated against what was actually asked rather than drawn from
 * a fixed list, because the useful question for a paperclip (its finish, whether
 * it grips anything) has nothing in common with the useful question for a
 * building. A fixed set would be the wrong set most of the time.
 *
 * **A failure here is not a blocked user.** No backend configured, a timeout, a
 * malformed answer — all of them mean generate with what we have. Clarification
 * improves a request; it is not permission to make one.
 */
export async function clarifyRequest(input: {
	backend: Pick<CodingBackend, "structured">
	workingDirectory: string
	request: AssetRequest
	tokens: FoundationTokens | null
	model?: string
}): Promise<ClarifyResult> {
	const vibe = input.tokens?.vibe.tags?.join(", ") || "not yet decided"
	const prompt = [
		`Someone is generating ${KIND_WORDS[input.request.kind]} for a design project and has asked for: "${input.request.text.trim()}"`,
		`The project's character is: ${vibe}.`,
		"",
		"Decide whether that request is already enough to produce a good asset.",
		"It is enough when you could brief a photographer or illustrator from it without guessing at anything that would change the result.",
		"",
		"If it is not enough, ask at most three questions about what they left out.",
		"Ask only about things that change the asset. Never ask about lighting, colour, mood or composition — the project's foundation already decides those and asking returns a decision the user has already made.",
		"Good questions are about the subject itself and about what the asset is for, because knowing where it sits changes how it should be made.",
		"Every question carries a why, written in plain language, saying what it changes.",
	].join("\n")

	try {
		const result = await input.backend.structured<ClarifyResult>({
			workingDirectory: input.workingDirectory,
			prompt,
			schema: CLARIFY_SCHEMA as unknown as Record<string, unknown>,
			model: input.model,
		})
		const value = result.value
		if (!value || typeof value.sufficient !== "boolean") return { sufficient: true, questions: [] }
		const questions = Array.isArray(value.questions)
			? value.questions.filter((q: ClarifyQuestion) => q?.id && q?.question)
			: []
		// Saying "not sufficient" and then asking nothing is a contradiction, and
		// it would strand the user on a screen with no questions on it.
		return { sufficient: value.sufficient || questions.length === 0, questions }
	} catch {
		return { sufficient: true, questions: [] }
	}
}

/** FNV-1a, so the same request produces the same id across processes. */
function fnv1a(text: string): string {
	let hash = 0x811c9dc5
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193) >>> 0
	}
	return hash.toString(36)
}

const KIND_WORDS: Record<GenerationKind, string> = {
	image: "a photograph or image",
	texture: "a texture or pattern",
	mark: "a logo or mark",
	object3d: "a 3D object",
	shader: "an animated background shader",
}
