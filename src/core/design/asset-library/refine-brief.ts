/**
 * The rebuild stage: an amateur's request becomes a craft-quality brief.
 *
 * The clarify step asks what was left out; this is what happens to the answers.
 * The old shape glued the raw text and the raw answers together and hoped —
 * which protected a pro's words but handed an amateur's words to the generator
 * exactly as typed, and "a logo of an ember" typed by someone who is not a
 * designer generates like it was written by someone who is not a designer.
 *
 * So a model rewrites the request into a polished brief, under two hard rules:
 *
 * 1. **Every decision the user made survives verbatim in meaning** — subject,
 *    named colours, named composition, anything they chose. Craft is added only
 *    where they were silent. This is the same precedence law the composer
 *    already applies, moved up to writing time.
 * 2. **The rebuilt brief is shown to the user, editable, before anything is
 *    generated.** Nothing is rewritten behind anyone's back — it is rewritten
 *    in front of them, in the prompt box they already own. A pro reads it and
 *    sees their direction intact; a beginner reads it and learns what a real
 *    brief looks like.
 *
 * The playbook differs per kind because the craft differs per kind: a logo
 * brief is geometry, a photograph brief is light, a 3D brief is one clean
 * object. The governing principle, ordered above all craft: **clarification
 * adds and sharpens; it never subtracts.** Grammar fixed, vague words made
 * precise, page-placement answers translated into composition — and every
 * piece of information the user supplied carried through, exclusions
 * included. Positive phrasing is preferred because ban-lists measurably lose
 * with the image model, but a constraint is rephrased, never dropped.
 *
 * **A failure here is a skipped step, never a blocked user.** No backend, a
 * timeout, malformed output — all of them mean generate with the words we
 * have. Same honesty rule as the clarifier.
 */
import type { CodingBackend } from "../agent/backend"
import type { FoundationTokens } from "../types"
import type { AssetRequest } from "./request"

/** What the rebuild returns: the brief, ready for the editable prompt box. */
export interface RefinedBrief {
	prompt: string
}

const REFINE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["prompt"],
	properties: {
		prompt: {
			type: "string",
			description: "The rebuilt brief, ready to be used as the generation prompt. Plain prose, no headings.",
		},
	},
} as const

/**
 * The craft each kind's brief is written with.
 *
 * Deliberately stated as principles of the craft, never as reactions to past
 * failures: a rule phrased around one incident's vocabulary teaches the model
 * that incident instead of the craft, and this prompt's first version did
 * exactly that.
 */
const PLAYBOOKS: Record<AssetRequest["kind"], string> = {
	mark: [
		"This brief is for a LOGO MARK. The generator downstream already fixes the colours, the background and the",
		"flat-vector treatment from the project's design system, so the brief is ONLY the construction of the symbol:",
		"- Reduce the idea to a symbol: name the shapes, their count, and how they meet ('two overlapping circles',",
		"  'one ring broken at the top') rather than describing the object the idea comes from.",
		"- Derive the geometry from this subject. A construction that could belong to any brand is a miss.",
		"- Edges and curves are drawn with compass-and-ruler precision - perfect circles, true arcs, straight cuts,",
		"  crisp corners - unless the user asked for a hand-drawn character in their own words.",
		"- One idea, executed once. The silhouette alone must carry it, and every element must survive at 20 pixels.",
		"- Use negative space deliberately where it serves the mark.",
	].join("\n"),
	image: [
		"This brief is for a PHOTOGRAPH. The generator downstream already supplies the project's palette and key as",
		"defaults, so the brief is the shot itself:",
		"- One subject, and say exactly what is in the frame - then say what fills the rest of the frame in positive",
		"  words ('behind it only darkness', 'a vast empty white wall').",
		"- Give it a light: one named source, its direction and temperature, and what happens where it does not reach.",
		"- Give it a camera when it helps: lens feel (macro, 85mm portrait, wide), distance, angle.",
		"- Name the surfaces and materials that matter - they are what makes a picture feel expensive.",
		"- Keep the user's mood words; sharpen vague ones into physical ones ('cozy' becomes 'one warm low light,",
		"  deep soft shadows').",
	].join("\n"),
	texture: [
		"This brief is for a repeating TEXTURE. Keep it about the material and the scale of its detail, evenly",
		"distributed, with no focal point and no single object - it must read as a surface, not a picture.",
	].join("\n"),
	object3d: [
		"This brief is for the SOURCE IMAGE of a 3D MODEL - a photograph of one object that reconstruction will turn",
		"into a mesh:",
		"- One complete object, fully inside the frame, nothing else pictured. Describe its exact form the way an",
		"  industrial designer would: primary volumes, profile, proportions, how parts meet.",
		"- Name the materials and finishes (matte black aluminium, brushed steel) - the texture comes from them.",
		"- The brief must state that the object carries no text, lettering or printed detail: reconstruction smears",
		"  print. Branding the user asked for becomes simple embossed geometry.",
		"- Favour solid, self-supporting forms. Thin wires, glass and fur reconstruct badly; steer the form toward",
		"  what a mesh can hold without changing what the user asked for.",
	].join("\n"),
	shader: [
		"This brief is for an ANIMATED BACKGROUND SHADER, written as what a viewer sees:",
		"- Describe the motion's speed and restraint explicitly - the best background motion is noticed on the",
		"  second look.",
		"- Name what moves and what stays still; one kind of motion, not three.",
		"- If page text will sit over it, name where the motion must stay quiet - the text itself is HTML, never",
		"  part of the shader.",
	].join("\n"),
}

/**
 * Rebuilds the request into the brief a professional would have written.
 *
 * The prompt's architecture follows one principle the field taught twice:
 * **clarification adds and sharpens; it never subtracts.** The first version
 * asked for an improved rewrite under a 90-word cap and got exactly what that
 * asks for - briefs that fit the cap by dropping the user's constraints ("no
 * hardware, no text" vanished from a 3D brief), and page-placement answers
 * painted into the picture as literal headlines, because the answers arrived
 * stripped of their questions. The contract below is ordered above the craft,
 * the cap is gone, and answers travel WITH their questions so the model can
 * tell a fact about the page from a fact about the picture.
 *
 * Returns null on ANY failure - the caller generates with the raw text, and
 * nobody waits on a step that only exists to improve things.
 */
export async function refineBrief(input: {
	backend: Pick<CodingBackend, "structured">
	workingDirectory: string
	request: AssetRequest
	tokens: FoundationTokens | null
	model?: string
}): Promise<RefinedBrief | null> {
	const { request } = input
	// Keys are the clarify QUESTIONS where the caller has them (the generate
	// surface passes question text; older callers pass opaque ids, which format
	// the same way and simply carry less context).
	const exchanges = Object.entries(request.answers ?? {})
		.map(([question, answer]) => ({ question: question.trim(), answer: answer.trim() }))
		.filter((entry) => entry.answer.length > 0)

	const vibe = input.tokens?.vibe.tags?.join(", ") || "not yet decided"
	const prompt = [
		"You are a senior art director. Rewrite the request below into the brief a professional would hand an",
		"image maker, folding in what the clarifying answers settled.",
		"",
		`THE REQUEST: "${request.text.trim()}"`,
		...(exchanges.length > 0
			? [
					"",
					"CLARIFYING QUESTIONS AND THE USER'S ANSWERS:",
					...exchanges.flatMap((entry) =>
						entry.question ? [`Q: ${entry.question}`, `A: ${entry.answer}`] : [`A: ${entry.answer}`],
					),
				]
			: []),
		`THE PROJECT'S CHARACTER: ${vibe}.`,
		"",
		"THE CONTRACT - these outrank everything below:",
		"1. Preserve every piece of information. Every subject, constraint, exclusion, colour, material, framing",
		"   and proportion in the request and answers appears in your brief - reworded freely, dropped never.",
		"   Fixing grammar and replacing vague words with precise ones is your job; losing a detail is failure.",
		"2. An exclusion is a decision. Where the user ruled something out ('no hardware', 'no text'), carry the",
		"   exclusion - as a positive statement when one exists ('one uninterrupted surface'), plainly stated",
		"   when not. Never delete a constraint because it is phrased negatively.",
		"3. Facts about the page shape the frame, never the picture. Answers about where the asset will live - a",
		"   hero, a banner, a tile, text sitting over it - become aspect, composition and reserved empty space",
		"   only. Text that will sit over the image is added later in HTML: write 'a calm empty area with nothing",
		"   in it', and never place words, headlines or lettering into the image itself.",
		"4. Add craft only where the user was silent, from the playbook below. If the request is already precise",
		"   and complete, your changes are grammar, clarity and the answers' additions - nothing else.",
		"5. One subject. Never swap it for another and never add a second one.",
		"",
		"CRAFT FOR THIS KIND:",
		PLAYBOOKS[request.kind],
		"",
		"OUTPUT: one paragraph of plain prose the user will read and edit - no headings, no bullet points, no",
		"meta-talk about prompts. As long as it needs to be to carry everything; never shortened by dropping",
		"information.",
	].join("\n")

	try {
		const result = await input.backend.structured<RefinedBrief>({
			workingDirectory: input.workingDirectory,
			prompt,
			schema: REFINE_SCHEMA as unknown as Record<string, unknown>,
			model: input.model,
		})
		const rebuilt = result.value?.prompt?.trim()
		if (!rebuilt) return null
		return { prompt: rebuilt }
	} catch {
		return null
	}
}
