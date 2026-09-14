/**
 * The generation surface's main-process half.
 *
 * Everything here is cheap and synchronous, which is a property of the
 * generator lane rather than of this file: a recipe card and a variant are both
 * a few hundred bytes of SVG produced from an integer, so the picker can afford
 * to render the *actual* thing at every step instead of a stock preview. The
 * lanes that cost money arrive later and will need a different shape — a job
 * with progress and a failure state — which is why these handlers are named for
 * what they do rather than for the lane that does it.
 *
 * **Nothing touches disk until the user picks one.** Variants are handed to the
 * renderer as inline data URLs; only `accept` writes, and it writes through the
 * §4.6 asset pipeline so a generated asset is an asset like any other.
 */
import * as fs from "fs/promises"
import * as path from "path"

import {
	ASPECTS,
	type AssetRecipe,
	type AssetRequest,
	addGeneratedAsset,
	assetsDirectory,
	type ClarifyResult,
	clarifyRequest,
	composeVariants,
	defaultAspect,
	derivePalette,
	describeVariant,
	FREE_LANES,
	findAsset,
	findAssetRecipe,
	findGenerator,
	GENERATION_QUESTIONS,
	GeminiImages,
	type GenerationAnswers,
	getBackend,
	lanesWithRaster,
	NO_RASTER_REASON,
	narrowForAnswers,
	proposeTag,
	type RefinedBrief,
	readAssetIndex,
	readFoundationTokens,
	recipeForRequest,
	refineBrief,
	resolveRasterConfig,
} from "../../src/core/design"
import { Logger } from "../../src/shared/services/Logger"
import type { GeneratedVariantWire, GenerationQuestionWire, RecipeCardWire, WriteResult } from "../shared/ipc"
import { cutOutPhotograph, postProcessPhotograph } from "./image-post"
import { getPrefs } from "./prefs"
import { getSecret } from "./secrets"

/**
 * The raster lane's credentials, keychain first.
 *
 * The stored key is the shipped path; the environment is the test-only Vertex
 * switch and a fallback for machines with no keychain. Resolved per call rather
 * than cached, so entering a key makes the lane work without a restart — the
 * alternative is a settings field that appears to do nothing.
 */
export function rasterConfig() {
	const prefs = getPrefs()
	return resolveRasterConfig({
		apiKey: getSecret("geminiApiKey"),
		vertexProject: prefs.vertexProject,
		vertexLocation: prefs.vertexLocation,
	})
}

/** How many options the picker shows. Free here, so the number is a taste call. */
const VARIANT_COUNT = 8

/**
 * How many photographs are generated per round.
 *
 * Four, not eight. Every one of these is a paid API call on the user's own key
 * and about fifteen seconds of waiting, so the number that is a taste call in
 * the free lane is a spending decision here. Four is enough to choose from and
 * cheap enough to run again.
 */
const RASTER_VARIANT_COUNT = 4

/**
 * How many image calls are in flight at once.
 *
 * Two, and the number is quota rather than taste. Four at once reliably trips
 * the per-minute image quota on an ordinary project — observed as two of four
 * variants returning "Resource has been exhausted" — and retrying a burst only
 * re-bursts it.
 */
const RASTER_CONCURRENCY = 2

export function generationQuestions(): GenerationQuestionWire[] {
	return GENERATION_QUESTIONS.map((question) => ({
		id: question.id,
		question: question.question,
		why: question.why,
		choices: question.choices.map((choice) => ({ id: choice.id, label: choice.label, hint: choice.hint })),
	}))
}

/**
 * Recipes that fit the answers, each already rendered for this project.
 *
 * The card shows variant 0 at the recipe's own default proportions. Showing
 * every card at one shared ratio would be tidier and would misrepresent half of
 * them — a section divider is 21:9 because that is what it is for.
 */
export async function recipeCards(projectPath: string, answers: GenerationAnswers, kind?: string): Promise<RecipeCardWire[]> {
	const tokens = await readFoundationTokens(projectPath).catch(() => null)

	const palette = derivePalette(tokens)

	const raster = rasterConfig()

	// The catalogue is shown whole and the unavailable ones say why. Quietly
	// offering fewer options than the library has teaches the user nothing about
	// what exists or what it would take to have it.
	const lanes = kind === "texture" ? FREE_LANES : lanesWithRaster(true)
	return narrowForAnswers(answers, tokens, lanes).map((recipe) => {
		const aspect = defaultAspect(recipe, answers)
		const [specimen] = composeVariants({ recipe, tokens, aspect, answers, count: 1 })
		const generator = specimen?.request.lane === "generator" ? findGenerator(specimen.request.generatorId) : undefined
		return {
			id: recipe.id,
			name: recipe.name,
			use: recipe.use,
			kind: recipe.kind,
			aspects: recipe.aspects,
			lane: recipe.lane,
			specimen: dataUrl(specimen?.svg ?? ""),
			surface: palette.surface,
			transparent: generator?.transparent ?? (specimen?.request.lane === "raster" && specimen.request.transparent),
			...(recipe.lane === "raster" && !raster ? { unavailable: NO_RASTER_REASON } : {}),
		}
	})
}

/**
 * Photographs that have been generated but not yet chosen.
 *
 * The generator lane needs nothing like this: `accept` recomposes from the
 * recipe and the seed and gets byte-identical output. **A model's output is not
 * reproducible that way** — asking the same question again costs money and
 * returns a different picture — so the bytes have to survive between "show me
 * options" and "I'll take that one", and this is the only honest place for them
 * to live. In memory rather than on disk: an option nobody picked is not a
 * decision, and writing it into `.caret/` would make it look like one.
 */
const pendingRaster = new Map<
	string,
	{
		bytes: Buffer
		mime: string
		resolved: string
		model: string
		/** The provider's usage report for this call, when it sent one. */
		usage?: { promptTokens: number; outputTokens: number; totalTokens: number }
		/** The whole round this call was part of: every call that returned an image. */
		round?: { calls: number; amount: number }
		at: number
	}
>()

/**
 * One hour. This was ten minutes with the note "long enough to think" — and a
 * real user thought for ten minutes and four seconds: generated a round,
 * asked someone which take to pick, decided, and met the expiry refusal on a
 * picture they had already paid for. Deliberation before spending is the
 * normal case, not a leak. A round is a few megabytes; an hour of holding it
 * is cheaper than one regenerated round, and close-of-picker still discards.
 */
const PENDING_TTL_MS = 60 * 60 * 1000

function pendingKey(projectPath: string, recipeId: string, aspect: string, variant: number): string {
	return `${projectPath}::${recipeId}::${aspect}::${variant}`
}

function prunePending(): void {
	const cutoff = Date.now() - PENDING_TTL_MS
	for (const [key, value] of pendingRaster) {
		if (value.at < cutoff) pendingRaster.delete(key)
	}
}

/** Drops everything a project is holding — called when the picker closes. */
export function discardPending(projectPath: string): void {
	for (const key of pendingRaster.keys()) {
		if (key.startsWith(`${projectPath}::`)) pendingRaster.delete(key)
	}
}

export async function recipeVariants(
	projectPath: string,
	recipeId: string,
	answers: GenerationAnswers,
	aspect: string,
	count = VARIANT_COUNT,
): Promise<GeneratedVariantWire[]> {
	const recipe = findAssetRecipe(recipeId)
	if (!recipe) return []
	const tokens = await readFoundationTokens(projectPath).catch(() => null)
	const palette = derivePalette(tokens)

	if (recipe.lane === "raster") {
		return generateRasterVariants(projectPath, recipe, answers, aspect, tokens, palette.surface)
	}

	return composeVariants({ recipe, tokens, aspect, answers, count }).map((variant) => ({
		variant: variant.variant,
		preview: dataUrl(variant.svg ?? ""),
		width: variant.width,
		height: variant.height,
		surface: palette.surface,
	}))
}

/**
 * Four photographs, in parallel, each with its own failure.
 *
 * Parallel because these are ~15s apiece and four in sequence is a minute of
 * staring at nothing. Per-variant failures rather than one collective one
 * because a content refusal on one framing says nothing about the other three —
 * collapsing them into "generation failed" would throw away three good images
 * to report one bad one.
 */
/**
 * What the style anchor is allowed to contribute.
 *
 * Written as a hard split because the failure it fixes was total: the previous
 * wording ("this must look shot in the same session") produced a second copy of
 * the reference photograph, and every framing decision the user had just made
 * in the clarify questions was silently discarded. The description has to be
 * named as the authority on content, in the same breath as the reference is
 * named as the authority on light.
 */
export const ANCHOR_PREAMBLE = [
	"The attached image is a COLOUR AND LIGHT REFERENCE ONLY — an earlier photograph from the same campaign.",
	"Take from it exactly three things: the quality and direction of the light, the colour grade, and the black level.",
	"Take NOTHING else from it. Its composition, camera distance, crop, subject size, subject position and camera angle are not yours to copy.",
	"Everything about what is photographed and how it is framed comes only from the description below, and where the two disagree the description wins.",
	"This is a different photograph from the same shoot, not another version of the reference.",
].join(" ")

async function generateRasterVariants(
	projectPath: string,
	recipe: AssetRecipe,
	answers: GenerationAnswers,
	aspect: string,
	tokens: Awaited<ReturnType<typeof readFoundationTokens>>,
	surface: string,
	anchor?: { bytes: Buffer; mime: string },
): Promise<GeneratedVariantWire[]> {
	const config = rasterConfig()
	const recipeId = recipe.id
	if (!config) {
		return [{ variant: 0, preview: "", width: 0, height: 0, surface, error: NO_RASTER_REASON }]
	}

	prunePending()
	const client = new GeminiImages(config)
	const composed = composeVariants({ recipe, tokens, aspect, answers, count: RASTER_VARIANT_COUNT })

	// Only what THIS round stored. The map can still hold a previous round's
	// entry under the same key (same recipe, same aspect, a variant that failed
	// this time), and counting it would misstate what this round cost.
	const storedKeys: string[] = []

	const results = await inPool(composed, RASTER_CONCURRENCY, async (variant): Promise<GeneratedVariantWire> => {
		const request = variant.request
		if (request.lane !== "raster") {
			return { variant: variant.variant, preview: "", width: 0, height: 0, surface, error: "not a raster recipe" }
		}

		// Pacing, spacing and backoff retries all live in the client now — one
		// process-wide queue every caller shares. A failure surfacing here means
		// the whole retry budget is spent; `retryable` distinguishes "exhausted
		// right now, worth re-running later" from a refusal that never will be.
		const result = await client.generate({
			// The anchor is a GRADE reference, and saying so is load-bearing.
			// Measured in the field on its first real use: "match the lighting,
			// colour grade and mood — this must look shot in the same session"
			// returned a near-duplicate of the reference, ignoring a described
			// close-up, a described diagonal, and the clarify answers that asked
			// for both. An image model reads an attached picture as "make one of
			// these"; only an explicit split — take the light, take nothing else —
			// leaves the description in charge of what is actually photographed.
			prompt: anchor ? `${ANCHOR_PREAMBLE}\n\n${request.prompt}` : request.prompt,
			avoid: request.avoid,
			aspect: request.aspect,
			...(anchor ? { references: [{ mime: anchor.mime, base64: anchor.bytes.toString("base64") }] } : {}),
		})

		if (!result.ok) {
			Logger.warn(`[generate] raster variant ${variant.variant} failed: ${result.reason}`)
			return {
				variant: variant.variant,
				preview: "",
				width: 0,
				height: 0,
				surface,
				error: result.reason,
				retryable: result.retryable,
			}
		}

		// Keyed recipes are keyed *before* the variant is shown, so the picture
		// the user points at is the finished cutout, not a promise of one. A key
		// that fails is this variant's own error card — the other three are keyed
		// on their own merits.
		let bytes = result.bytes
		let mime = result.mime
		if (request.transparent) {
			const keyed = await cutOutPhotograph(result.bytes)
			if (!keyed.ok) {
				Logger.warn(`[generate] raster variant ${variant.variant} failed keying: ${keyed.reason}`)
				return { variant: variant.variant, preview: "", width: 0, height: 0, surface, error: keyed.reason }
			}
			bytes = keyed.bytes
			mime = "image/png"
		}

		const key = pendingKey(projectPath, recipeId, aspect, variant.variant)
		storedKeys.push(key)
		pendingRaster.set(key, {
			bytes,
			mime,
			resolved: result.resolved,
			model: result.model,
			...(result.usage ? { usage: result.usage } : {}),
			at: Date.now(),
		})

		return {
			variant: variant.variant,
			preview: `data:${mime};base64,${bytes.toString("base64")}`,
			width: variant.width,
			height: variant.height,
			surface,
		}
	})

	// The round's total, stamped onto every survivor. The variants nobody picks
	// were part of the price of the one somebody does, and only this function
	// ever knows how many calls the round actually made.
	const held = storedKeys
		.map((key) => pendingRaster.get(key))
		.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
	const metered = held.filter((entry) => entry.usage)
	if (metered.length > 0) {
		const round = { calls: held.length, amount: metered.reduce((sum, entry) => sum + (entry.usage?.totalTokens ?? 0), 0) }
		for (const entry of held) entry.round = round
	}

	return results
}

/**
 * Runs `work` over `items` with at most `limit` in flight, preserving order.
 *
 * Not an optimisation — a correctness fix. Four image calls fired at once trip
 * the per-minute quota on an ordinary Google Cloud project, and two of every
 * four came back "Resource has been exhausted" in a real run. Retrying a burst
 * just re-burst it. Limiting the burst is the thing that actually helps, and
 * two at a time still halves the wait against running them one by one.
 */
async function inPool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length)
	let next = 0

	const runner = async (): Promise<void> => {
		while (next < items.length) {
			const index = next++
			results[index] = await work(items[index])
		}
	}

	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner))
	return results
}

/**
 * Writes the chosen variant, with provenance complete enough to reproduce it.
 *
 * The variant is **recomposed** here rather than carried back from the
 * renderer. Same recipe, same answers, same seed, so it is byte-identical — and
 * it means the bytes that land on disk were produced by the same code path that
 * produced the picture, instead of by whatever the renderer happened to still
 * be holding.
 */
export async function acceptVariant(
	projectPath: string,
	recipeId: string,
	answers: GenerationAnswers,
	aspect: string,
	variant: number,
	tag: string,
): Promise<WriteResult & { tag?: string }> {
	const recipe = findAssetRecipe(recipeId)
	if (!recipe) return { ok: false, error: `No such recipe: "${recipeId}".` }

	const tokens = await readFoundationTokens(projectPath).catch(() => null)
	if (recipe.lane === "raster") {
		return acceptRasterVariant(projectPath, recipe, answers, aspect, variant, tag, tokens)
	}

	const composed = composeVariants({ recipe, tokens, aspect, answers, count: variant + 1 })[variant]
	if (!composed?.svg) return { ok: false, error: "That option could not be regenerated." }

	const palette = derivePalette(tokens)
	const result = await addGeneratedAsset({
		projectPath,
		tag: tag.trim() || proposeTag(recipe, answers),
		extension: ".svg",
		bytes: Buffer.from(composed.svg, "utf-8"),
		description: describeVariant(recipe, composed, palette),
		alt: "",
		origin: {
			type: "generated",
			lane: "generator",
			producer: composed.request.lane === "generator" ? composed.request.generatorId : recipe.lane,
			recipeId: recipe.id,
			answers,
			// The resolved request, not a prose summary: this is the field somebody
			// reads when they want to know exactly what produced the file.
			resolved: JSON.stringify({ ...composed.request, aspect, variant: composed.variant }),
		},
	})

	return result.ok ? { ok: true, tag: result.entry.tag } : { ok: false, error: result.reason }
}

/**
 * Writes the chosen photograph from the pending set.
 *
 * Deliberately never regenerates. Re-asking the model would spend money to
 * produce a *different* picture from the one the user pointed at, which is the
 * single most surprising thing this surface could do — so an expired pick is a
 * refusal that says to choose again, not a silent substitution.
 */
async function acceptRasterVariant(
	projectPath: string,
	recipe: NonNullable<ReturnType<typeof findAssetRecipe>>,
	answers: GenerationAnswers,
	aspect: string,
	variant: number,
	tag: string,
	tokens: Awaited<ReturnType<typeof readFoundationTokens>>,
): Promise<WriteResult & { tag?: string }> {
	prunePending()
	const held = pendingRaster.get(pendingKey(projectPath, recipe.id, aspect, variant))
	if (!held) {
		return {
			ok: false,
			error: "That image is no longer held in memory. Generate again and pick one — re-asking the model would produce a different picture.",
		}
	}

	const palette = derivePalette(tokens)
	// Refined takes carry variant numbers >= 100 so no fresh round can collide
	// with them — but composeVariants clamps its count, so composing "at" that
	// index is out of bounds, and the first ever refined-take save crashed here
	// on composed.request (field failure, 2026-09-02). A refined take has no
	// composition of its own: it was made from a reference and a note, and its
	// true record is held.resolved. Every variant of one request shares aspect,
	// size and transparency, so the last composable variant's metadata is the
	// honest stand-in.
	const compositions = composeVariants({ recipe, tokens, aspect, answers, count: Math.min(variant + 1, RASTER_VARIANT_COUNT) })
	const composed = compositions[Math.min(variant, compositions.length - 1)]
	if (!composed) return { ok: false, error: "That option could not be reconstructed. Generate again and pick one." }

	// Only now, on the one the user actually chose. Post-processing every variant
	// would spend the work on three pictures nobody keeps. (Keying already
	// happened before the pick — the alpha in the held bytes is the point.)
	const keyed = composed.request.lane === "raster" && composed.request.transparent
	const processed = await postProcessPhotograph(held.bytes, composed.width, composed.height, { preserveAlpha: keyed })
	Logger.info(
		`[generate] ${recipe.id} → ${processed.width}x${processed.height} ${processed.mime}, ` +
			`${Math.round(processed.originalBytes / 1024)}KB → ${Math.round(processed.bytes.length / 1024)}KB`,
	)

	const result = await addGeneratedAsset({
		projectPath,
		tag: tag.trim() || proposeTag(recipe, answers),
		extension: processed.extension,
		bytes: processed.bytes,
		description: describeVariant(recipe, composed, palette),
		alt: "",
		origin: {
			type: "generated",
			lane: "raster",
			producer: held.model,
			recipeId: recipe.id,
			answers,
			// The prompt as sent, negatives included. For a paid lane this is the
			// only record of what the money bought.
			resolved: held.resolved,
			...(held.usage
				? {
						cost: {
							unit: "tokens" as const,
							amount: held.usage.totalTokens,
							...(held.round ? { round: held.round } : {}),
							note: "as metered by the provider's own usage report",
						},
					}
				: {}),
			postProcessed: {
				from: { bytes: processed.originalBytes, mime: held.mime },
				to: { bytes: processed.bytes.length, mime: processed.mime, width: processed.width, height: processed.height },
			},
		},
	})

	if (result.ok) discardPending(projectPath)
	return result.ok ? { ok: true, tag: result.entry.tag } : { ok: false, error: result.reason }
}

/**
 * The user-picked style anchor, resolved from the asset library on disk.
 *
 * By tag, from the index, at generation time — the first version captured the
 * last-saved photo into main-process memory, and it silently vanished on every
 * restart (found because the checkbox disappeared mid-run). The asset already
 * lives in `.caret/assets/`; a pointer to it has no business being ephemeral.
 * A tag that no longer resolves means no anchor, never an error: the takes
 * still generate from the words alone.
 */
async function resolveStyleAnchor(projectPath: string, tag: string): Promise<{ bytes: Buffer; mime: string } | undefined> {
	try {
		const index = await readAssetIndex(projectPath)
		const entry = findAsset(index, tag)
		if (!entry || entry.kind !== "image" || entry.mime === "image/svg+xml") return undefined
		const bytes = await fs.readFile(path.join(assetsDirectory(projectPath), entry.file))
		return { bytes, mime: entry.mime }
	} catch {
		return undefined
	}
}

/** The proposed name for a pick, so the field opens with something usable. */
export function suggestedTag(recipeId: string, answers: GenerationAnswers): string {
	const recipe = findAssetRecipe(recipeId)
	return recipe ? proposeTag(recipe, answers) : ""
}

/**
 * SVG as a data URL, base64 rather than percent-encoded.
 *
 * These carry `#` in every colour and `<`/`>` throughout, and a percent-encoded
 * `data:image/svg+xml,` URL truncates at the first unescaped `#` — silently, as
 * a broken image with no error anywhere.
 */
function dataUrl(svg: string): string {
	if (!svg) return ""
	return `data:image/svg+xml;base64,${Buffer.from(svg, "utf-8").toString("base64")}`
}

/**
 * Three takes of what the user actually asked for.
 *
 * The request wears a synthetic recipe so everything below this line is the
 * code that was already here and already right — the concurrency pool that
 * keeps the burst under the per-minute quota, chroma-key running before the
 * pick so the picture is the finished cutout, the pending store, the round
 * cost. What changed is only where the subject comes from.
 */
export async function requestTakes(
	projectPath: string,
	request: AssetRequest & { styleAnchor?: string },
	aspect: string,
): Promise<GeneratedVariantWire[]> {
	const tokens = await readFoundationTokens(projectPath).catch(() => null)
	const palette = derivePalette(tokens)

	// A texture has no subject to name, so there is nothing for the composer to
	// compose: it is the free deterministic lane, and what varies is parameters.
	// Routing it through the raster lane would spend the user's credits on the
	// one kind that was always meant to cost nothing.
	if (request.kind === "texture") {
		const recipe = textureRecipe(tokens)
		if (!recipe) return []
		return recipeVariants(projectPath, recipe.id, askedAnswers(request), aspect || recipe.aspects[0], 3)
	}

	const recipe = recipeForRequest(request)
	const chosen = aspect || recipe.aspects[0]

	if (recipe.lane !== "raster") {
		// Marks run the authored render-compare loop, which has its own surface
		// and its own progress. Nothing to compose into takes here.
		return []
	}

	// The anchor rides only when the user picked one — a named photo from
	// their own library, chosen in the renderer's dropdown. Reference-image
	// anchoring holds a set's light and grade together far better than
	// repeated prose does.
	const anchor =
		request.styleAnchor && request.kind === "image" && !request.transparent
			? await resolveStyleAnchor(projectPath, request.styleAnchor)
			: undefined
	return generateRasterVariants(projectPath, recipe, askedAnswers(request), chosen, tokens, palette.surface, anchor)
}

/**
 * The texture recipe a request lands on, chosen the same way every time.
 *
 * Deterministic because `accept` has to reach the same one: the take the user
 * pointed at is reproduced from the recipe and the seed, so a different choice
 * here would hand them a different picture than the one they picked.
 */
function textureRecipe(tokens: Awaited<ReturnType<typeof readFoundationTokens>>) {
	return narrowForAnswers({}, tokens, FREE_LANES)[0]
}

/** What was asked, in the shape provenance records. Identical for takes and accept. */
function askedAnswers(request: AssetRequest): GenerationAnswers {
	return { asked: request.text.trim(), ...(request.answers ?? {}) }
}

/** Writes the take the user pointed at, with the request kept verbatim. */
export async function acceptRequestTake(
	projectPath: string,
	request: AssetRequest,
	aspect: string,
	variant: number,
	tag: string,
): Promise<WriteResult & { tag?: string }> {
	const tokens = await readFoundationTokens(projectPath).catch(() => null)

	if (request.kind === "texture") {
		const texture = textureRecipe(tokens)
		if (!texture) return { ok: false, error: "No texture recipe is available." }
		return acceptVariant(projectPath, texture.id, askedAnswers(request), aspect || texture.aspects[0], variant, tag)
	}

	const recipe = recipeForRequest(request)
	const chosen = aspect || recipe.aspects[0]
	if (recipe.lane !== "raster") return { ok: false, error: "That kind is not accepted here." }

	// The answers double as the provenance record of what was asked and what the
	// user replied, and `asked` carries their opening words even when nothing was
	// clarified — that sentence is the one thing only they could have supplied.
	return acceptRasterVariant(projectPath, recipe, askedAnswers(request), chosen, variant, tag, tokens)
}

/**
 * One refined take: the picked take goes back to the model AS THE REFERENCE,
 * with the user's note as the edit instruction.
 *
 * Iteration, not another roll of the dice. Re-rolling from scratch throws
 * away everything a nearly-right take got right; the image model is an
 * editing model, and "harder shadow, label bigger" against the picked take
 * converges where fresh takes wander. The result lands in the pending store
 * under a variant number the renderer chose — unique across rounds — so
 * `acceptRequestTake` works on it unchanged, and provenance carries the
 * refinement chain.
 */
export async function refineRequestTake(
	projectPath: string,
	request: AssetRequest,
	aspect: string,
	sourceVariant: number,
	note: string,
	newVariant: number,
): Promise<GeneratedVariantWire> {
	const tokens = await readFoundationTokens(projectPath).catch(() => null)
	const surface = derivePalette(tokens).surface
	const miss = (error: string, retryable?: boolean): GeneratedVariantWire => ({
		variant: newVariant,
		preview: "",
		width: 0,
		height: 0,
		surface,
		error,
		...(retryable ? { retryable } : {}),
	})

	if (request.kind === "texture") {
		return miss("Textures are free and instant — regenerate with different parameters instead of refining.")
	}
	const config = rasterConfig()
	if (!config) return miss(NO_RASTER_REASON)

	const recipe = recipeForRequest(request)
	if (recipe.lane !== "raster") return miss("Only photographs can be refined here.")
	const chosen = aspect || recipe.aspects[0]

	const source = pendingRaster.get(pendingKey(projectPath, recipe.id, chosen, sourceVariant))
	if (!source) return miss("That take is no longer held — generate a fresh round first.")

	const transparent = request.kind === "image" && request.transparent === true
	const prompt = [
		`Edit the reference image: ${note.trim().replace(/\.$/, "")}.`,
		"Change only what the instruction names — keep the same subject, style, light and framing as the reference everywhere else.",
		...(transparent ? ["The background stays pure flat white (#ffffff) filling every edge of the frame."] : []),
	].join(" ")

	const client = new GeminiImages(config)
	const result = await client.generate({
		prompt,
		avoid: [],
		aspect: chosen,
		references: [{ mime: source.mime, base64: source.bytes.toString("base64") }],
	})
	if (!result.ok) {
		Logger.warn(`[generate] refine of variant ${sourceVariant} failed: ${result.reason}`)
		return miss(result.reason, result.retryable)
	}

	let bytes = result.bytes
	let mime = result.mime
	if (transparent) {
		const keyed = await cutOutPhotograph(result.bytes)
		if (!keyed.ok) return miss(keyed.reason)
		bytes = keyed.bytes
		mime = "image/png"
	}

	pendingRaster.set(pendingKey(projectPath, recipe.id, chosen, newVariant), {
		bytes,
		mime,
		// The chain, not just the last step: months later, "how was this made"
		// includes what it was refined FROM and what was asked of it.
		resolved: `${source.resolved}\n\n[refined from take ${sourceVariant}] ${prompt}`,
		model: result.model,
		...(result.usage ? { usage: result.usage } : {}),
		at: Date.now(),
	})

	const size = ASPECTS[chosen]
	return {
		variant: newVariant,
		preview: `data:${mime};base64,${bytes.toString("base64")}`,
		width: size?.width ?? 0,
		height: size?.height ?? 0,
		surface,
	}
}

/**
 * Whether the request needs anything more before it is worth spending on.
 *
 * Resolved here rather than in the renderer so the backend choice and the
 * project's foundation come from the same place everything else reads them.
 * Any failure means "generate with what we have" — clarification improves a
 * request, it is not permission to make one.
 */
export async function clarifyAssetRequest(projectPath: string, request: AssetRequest): Promise<ClarifyResult> {
	const prefs = getPrefs()
	// No backend chosen yet is the common case on a fresh project, and it must
	// not stop someone generating — they simply get no clarifying questions.
	if (!prefs.backendId) return { sufficient: true, questions: [] }
	let backend
	try {
		backend = getBackend(prefs.backendId)
	} catch {
		return { sufficient: true, questions: [] }
	}

	const tokens = await readFoundationTokens(projectPath).catch(() => null)
	return clarifyRequest({
		backend,
		workingDirectory: projectPath,
		request,
		tokens,
		model: prefs.backendModel || undefined,
	})
}

/**
 * The rebuild stage: the request plus the clarify answers become a polished
 * brief, written per-kind by the model. Null on any failure — the caller
 * generates with the raw text, same honesty rule as the clarifier.
 */
export async function refineAssetBrief(projectPath: string, request: AssetRequest): Promise<RefinedBrief | null> {
	const prefs = getPrefs()
	if (!prefs.backendId) return null
	let backend
	try {
		backend = getBackend(prefs.backendId)
	} catch {
		return null
	}

	const tokens = await readFoundationTokens(projectPath).catch(() => null)
	return refineBrief({
		backend,
		workingDirectory: projectPath,
		request,
		tokens,
		model: prefs.backendModel || undefined,
	})
}
