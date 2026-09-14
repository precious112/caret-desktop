/**
 * Logos and marks: an image model authors the look, a coding model traces it.
 *
 * Two different tasks hide under "can a model draw vector", and only one of
 * them works. **Emitting paths from a description alone** is the case where
 * "models are bad at SVG" is simply true — there is no ground truth, so nothing
 * corrects the first guess, and three rounds of self-critique refine a mediocre
 * first idea into a polished mediocre idea. **Reproducing something it can see**
 * converges, because every round has a reference to be wrong about.
 *
 * So the lane is split along what each model is actually good at. The image
 * model (the raster lane's Gemini adapter) is good at logo *aesthetics* — shape
 * language, proportion, balance — and authors the target as a flat two-colour
 * picture. The coding model is good at *structure* — it decomposes the target
 * into primitives and emits semantic SVG (a <circle>, a symmetric path), which
 * is why the result stays small, editable and token-recolourable where a
 * bitmap tracer would emit path soup. Its one goal, stated in the system
 * prompt and enforced by the loop, is to make its render IDENTICAL to the
 * target: each round it is shown TARGET and YOURS side by side in one
 * composite, names the differences, and corrects.
 *
 * **Caret decides when to stop, not the model.** A model asked "is it close
 * enough yet?" says yes; a pixel comparison does not. Caret measures the
 * similarity of each render against the target and stops on convergence, on
 * plateau, or at the round cap — and keeps the *most similar* renderable SVG,
 * not the most recent one.
 *
 * A backend whose adapter cannot pass images cannot run this lane, and is told
 * so rather than being allowed to loop blind. Likewise a project with no image
 * lane: the target IS the design here, so its absence is a stated failure, not
 * a silent fall-back to drawing from words.
 */
import { BrowserWindow, nativeImage } from "electron"

import type { BackendSession, FoundationTokens } from "../../src/core/design"
import { derivePalette, GeminiImages, getBackend, NO_RASTER_REASON } from "../../src/core/design"
import { Logger } from "../../src/shared/services/Logger"
import { rasterConfig } from "./generate-assets"
import { MARK_DIRECTIONS, type MarkDirection, nextDirections, TARGET_AVOID, targetPrompt } from "./mark-prompt"
import { bitmapSimilarity } from "./pixel-similarity"
import { getPrefs } from "./prefs"
import { stripBackgroundRect } from "./svg-mark"
import { canSeeImages } from "./vision-cache"

/**
 * The round cap. Reproduction needs more looks than invention did (the old
 * loop's three), and the similarity stops below usually end it earlier.
 */
export const MAX_MARK_ROUNDS = 6

/**
 * Wall-clock budget for the whole authoring run, target included. Once spent,
 * the best rendered round SHIPS instead of refining further — a decent mark
 * in eight minutes beats a perfect one that a timeout deletes. Field-measured
 * on test5: target generation queued behind the paced raster lane, six rounds
 * followed, and the MCP ceiling killed two runs at exactly 600s with nothing.
 */
export const MARK_BUDGET_MS = 8 * 60_000

/** Similar enough to stop: further rounds polish pixels nobody can see. */
const SIMILARITY_DONE = 0.97

/**
 * Two consecutive rendered rounds that fail to beat the best by this much are
 * a plateau — the model has stopped finding differences it can fix.
 */
const PLATEAU_EPSILON = 0.005

/** The frame a mark is rendered into for review. Square, because marks are. */
const REVIEW_SIZE = 512

/** The label strip above each panel of the comparison composite. */
const LABEL_HEIGHT = 40

export interface MarkRequest {
	projectPath: string
	/** What the mark is for, in the user's own words from the interview. */
	brief: string
	tokens: FoundationTokens | null
	/**
	 * The user-picked target image. The mark's taste decision lives entirely
	 * in what the target LOOKS like, so the user iterates on target candidates
	 * first and the trace loop reproduces the one they chose. When absent the
	 * loop generates its own single target (the chat lane's shape).
	 */
	target?: { png: Buffer; mime: string }
	/** Overrides the project's backend model for this lane only. */
	modelOverride?: string
	/**
	 * Called as the loop moves. The round updates carry the render itself,
	 * because the only honest way to fill a minute of waiting is to show the
	 * thing the model is looking at while it decides what it got wrong.
	 */
	onProgress?(update: { stage: string; round?: number; previewPng?: Buffer }): void
}

export type MarkResult =
	| { ok: true; svg: string; rounds: number; similarity: number; model: string; transcript: string[]; previewPng: Buffer }
	| { ok: false; reason: string; needsAnotherModel?: boolean }

/**
 * Runs the loop and returns the SVG that came closest to the target.
 *
 * "Closest" is load-bearing: a later round that drifts must not replace an
 * earlier round that matched better, and a later round that emits something
 * broken must not replace one that rendered at all.
 */
export async function authorMark(request: MarkRequest): Promise<MarkResult> {
	const prefs = getPrefs()
	const backendId = prefs.backendId
	if (!backendId) {
		return {
			ok: false,
			reason: "Drawing a mark needs a coding backend. Open Settings → Backend to set one up.",
		}
	}

	const model = request.modelOverride?.trim() || prefs.backendModel || ""

	// Checked before anything is spent, so a model that cannot see costs one
	// tiny probe rather than a target image and six rounds of pretending.
	const vision = await canSeeImages(backendId, model, request.projectPath)
	if (!vision.sees) return { ok: false, reason: vision.reason, needsAnotherModel: true }

	const backend = await getBackend(backendId)
	if (!backend) return { ok: false, reason: `No backend called "${backendId}" is available.` }

	const palette = derivePalette(request.tokens)
	const progress = request.onProgress ?? (() => {})
	// The budget clock starts BEFORE the target: its queue wait behind the
	// paced raster lane is part of what the outer MCP ceiling measures.
	const startedAt = Date.now()

	// The target comes first: it IS the mark, aesthetically. Everything after
	// this is tracing.
	let target: { png: Buffer; mime: string }
	if (request.target) {
		target = request.target
	} else {
		progress({ stage: "Generating the target image" })
		const generated = await generateTarget(request.brief, palette)
		if (!generated.ok) return { ok: false, reason: generated.reason }
		target = generated
	}
	progress({ stage: "Tracing your target as vector — round 1", previewPng: target.png })

	const transcript: string[] = []
	let session: BackendSession | null = null
	let best = ""
	let bestPng: Buffer | null = null
	let bestSimilarity = -1
	let rounds = 0
	let sinceImprovement = 0

	try {
		session = await backend.startSession({
			workingDirectory: request.projectPath,
			// It draws; it does not touch the repository. Read-only is the boundary
			// that makes "let a model run six turns unattended" reasonable at all.
			mode: "read-only",
			model: model || undefined,
			title: "caret mark",
			systemPrompt: SYSTEM_PROMPT,
		})

		let reply = await turn(session, {
			text: openingPrompt(request.brief, palette),
			images: [`data:${target.mime};base64,${target.png.toString("base64")}`],
		})
		transcript.push(reply)

		for (let round = 1; round <= MAX_MARK_ROUNDS; round++) {
			const svg = extractSvg(reply)
			if (!svg) {
				progress({ stage: `Round ${round}: the reply had no SVG — asking again` })
				reply = await turn(session, { text: "That reply contained no <svg> element. Send the SVG itself, nothing else." })
				transcript.push(reply)
				continue
			}

			const png = await renderSvg(svg, palette.surface)
			if (!png) {
				progress({ stage: `Round ${round}: the SVG did not render — asking for a correction` })
				reply = await turn(session, {
					text: "That SVG did not render — a browser could draw nothing from it. Send a corrected version.",
				})
				transcript.push(reply)
				continue
			}

			rounds = round
			const score = similarity(target.png, png)
			if (score > bestSimilarity + PLATEAU_EPSILON) {
				sinceImprovement = 0
			} else {
				sinceImprovement++
			}
			if (score > bestSimilarity) {
				best = svg
				bestPng = png
				bestSimilarity = score
			}
			progress({ stage: `Round ${round}: ${percent(score)} match`, round, previewPng: png })

			if (score >= SIMILARITY_DONE) break
			if (sinceImprovement >= 2) break
			if (round === MAX_MARK_ROUNDS) break
			// Budget spent with a usable mark in hand: ship it rather than let
			// another round push the whole tool past the outer MCP ceiling.
			if (Date.now() - startedAt > MARK_BUDGET_MS) {
				progress({ stage: `Time budget spent — keeping the best so far (${percent(bestSimilarity)})` })
				break
			}

			progress({ stage: `Showing the model the differences (best so far ${percent(bestSimilarity)})` })
			const composite = await renderComposite(target.png, target.mime, png, palette.surface)
			reply = await turn(session, {
				text: differencePrompt(score, round),
				// The composite is one image on purpose: models compare far more
				// reliably within a single frame than across attachments, and it
				// sidesteps any adapter that mishandles multi-image turns.
				images: [`data:image/png;base64,${(composite ?? png).toString("base64")}`],
			})
			transcript.push(reply)
		}
	} catch (err) {
		if (!best) return { ok: false, reason: err instanceof Error ? err.message : String(err) }
		Logger.warn(`[marks] the loop ended early but had a usable mark: ${err}`)
	} finally {
		await session?.close().catch(() => {})
	}

	if (!best || !bestPng) return { ok: false, reason: "The model never produced an SVG that rendered." }
	return {
		ok: true,
		svg: best,
		rounds,
		similarity: bestSimilarity,
		model: model || "(backend default)",
		transcript,
		previewPng: bestPng,
	}
}

/**
 * The target: a flat two-colour picture of the mark, from the raster lane.
 *
 * The prompt pins the things the SVG constraints will need to be true later —
 * exactly two colours, flat shapes, no text — so the tracer is never asked to
 * reproduce something the vector rules forbid.
 */
/**
 * The target stage: candidates the user iterates on BEFORE any tracing.
 *
 * The agreed division: the mark's taste decision is what the target image
 * looks like, so the improvement lane lives here — takes, then refine-by-note
 * against the picked take — and the trace loop afterwards is mechanical
 * reproduction of an approved spec. No notes after tracing; a disliked trace
 * of a liked target is fixed by tracing again, a disliked target by coming
 * back here.
 */
interface HeldMarkTargets {
	brief: string
	candidates: Map<number, { png: Buffer; mime: string; direction: MarkDirection }>
	at: number
}

const pendingTargets = new Map<string, HeldMarkTargets>()

export async function markTargetTakes(
	projectPath: string,
	brief: string,
	tokens: FoundationTokens | null,
	count = 3,
): Promise<Array<{ variant: number; preview: string; direction?: string; error?: string; retryable?: boolean }>> {
	const palette = derivePalette(tokens)
	const config = rasterConfig()
	if (!config) return [{ variant: 0, preview: "", error: NO_RASTER_REASON }]

	const client = new GeminiImages(config)
	const held: HeldMarkTargets = { brief, candidates: new Map(), at: Date.now() }
	pendingTargets.set(projectPath, held)
	const directions = nextDirections(projectPath, count)

	const takes = await Promise.all(
		directions.map(async (direction, variant) => {
			const result = await client.generate({
				prompt: targetPrompt(brief, palette, direction),
				avoid: TARGET_AVOID,
				aspect: "1:1",
			})
			if (!result.ok)
				return { variant, preview: "", direction: direction.label, error: result.reason, retryable: result.retryable }
			held.candidates.set(variant, { png: result.bytes, mime: result.mime, direction })
			return {
				variant,
				preview: `data:${result.mime};base64,${result.bytes.toString("base64")}`,
				direction: direction.label,
			}
		}),
	)
	return takes
}

/** The picked candidate back as the reference, the note as the edit. */
export async function refineMarkTarget(
	projectPath: string,
	sourceVariant: number,
	note: string,
	newVariant: number,
	tokens: FoundationTokens | null,
): Promise<{ variant: number; preview: string; direction?: string; error?: string; retryable?: boolean }> {
	const held = pendingTargets.get(projectPath)
	const source = held?.candidates.get(sourceVariant)
	if (!held || !source)
		return { variant: newVariant, preview: "", error: "That target is no longer held — generate fresh options." }

	const palette = derivePalette(tokens)
	const config = rasterConfig()
	if (!config) return { variant: newVariant, preview: "", error: NO_RASTER_REASON }

	const client = new GeminiImages(config)
	const result = await client.generate({
		prompt:
			`Edit the reference logo image: ${note.trim().replace(/\.$/, "")}. ` +
			`Change only what the instruction names — keep the same flat vector style, the same two colours (${palette.brand} and ${palette.ink}), ` +
			`the same plain ${palette.surface} background, and everything else exactly as the reference has it.`,
		avoid: TARGET_AVOID,
		aspect: "1:1",
		references: [{ mime: source.mime, base64: source.png.toString("base64") }],
	})
	if (!result.ok) return { variant: newVariant, preview: "", error: result.reason, retryable: result.retryable }
	// The refinement inherits its source's direction: a note edits a design,
	// it does not change which approach the design is.
	held.candidates.set(newVariant, { png: result.bytes, mime: result.mime, direction: source.direction })
	return {
		variant: newVariant,
		preview: `data:${result.mime};base64,${result.bytes.toString("base64")}`,
		direction: source.direction.label,
	}
}

/** The candidate the trace loop should reproduce. */
export function heldMarkTarget(projectPath: string, variant: number): { png: Buffer; mime: string } | null {
	return pendingTargets.get(projectPath)?.candidates.get(variant) ?? null
}

async function generateTarget(
	brief: string,
	palette: ReturnType<typeof derivePalette>,
): Promise<{ ok: true; png: Buffer; mime: string } | { ok: false; reason: string }> {
	const config = rasterConfig()
	if (!config) return { ok: false, reason: NO_RASTER_REASON }

	const client = new GeminiImages(config)
	// The single-target path (no user picking) takes the first direction: bold
	// geometric construction is the approach that most reliably survives small
	// sizes, which is the one property a mark nobody reviewed must have.
	const ask = () =>
		client.generate({
			prompt: targetPrompt(brief, palette, MARK_DIRECTIONS[0]),
			avoid: TARGET_AVOID,
			aspect: "1:1",
		})

	let result = await ask()
	if (!result.ok && result.retryable) {
		await new Promise((resolve) => setTimeout(resolve, 6000))
		result = await ask()
	}
	if (!result.ok) return { ok: false, reason: `The target image could not be generated: ${result.reason}` }
	return { ok: true, png: result.bytes, mime: result.mime }
}

const SYSTEM_PROMPT = `You are reproducing a picture of a logo mark as SVG, inside a design tool. Your one goal is that your SVG, rendered, is IDENTICAL to the target picture — same shapes, same proportions, same positions, same colours. You are tracing, not designing: where your render and the target disagree, the target is right.

Rules that are not negotiable:
- Every working reply ENDS with the complete <svg> element. Nothing after the closing tag.
- A square viewBox, no wider than 512.
- TRANSPARENT background — never a rect or path filling the canvas behind the mark. The mark floats on whatever surface the page provides; a baked-in background ships as a coloured box on every other surface.
- Paths and basic shapes only. No <image>, no <foreignObject>, no external references, no scripts.
- No text elements. A font you name will not be present when this renders, and the mark would silently become the fallback face.
- Two colours at most, both from the palette you are given.
- Prefer semantic primitives — <circle>, <rect>, symmetric paths — over freeform point soup. The SVG will be edited by hand later.

You will be shown the target beside a render of what you drew and asked to close the gap. Look at the pictures, not at your intentions.`

function openingPrompt(brief: string, palette: ReturnType<typeof derivePalette>): string {
	return [
		"The attached picture is the target mark. Reproduce it as SVG, identically.",
		"",
		"First, in a few lines, decompose the target's geometry: which primitive shapes make it up, their proportions, and how they sit relative to each other. Getting the structure right in words first is what makes the paths come out right.",
		"",
		`Colours — the target uses these and so must you: ${palette.brand} (the brand colour), ${palette.ink} (ink), on ${palette.surface} (the surface it sits on).`,
		"",
		`For context, the mark is for: ${brief.trim()}`,
		"",
		"Then send the SVG. End with it — nothing after the closing tag.",
	].join("\n")
}

/**
 * The correction prompt. Names the job — eliminate differences — rather than
 * asking "is it good?", because a model judging its own work says yes, and
 * good was the image model's job anyway.
 */
function differencePrompt(score: number, round: number): string {
	return [
		`The attached picture shows the TARGET on the left and YOUR current render on the right. They match ${percent(score)}; round ${round} of at most ${MAX_MARK_ROUNDS}.`,
		"",
		"Name the concrete differences, shape by shape: proportion, position, curvature, stroke weight, colour. Ignore nothing you can see — the differences you do not name are the ones that survive.",
		"",
		"Then send a corrected SVG that eliminates them. End with the SVG, nothing after it.",
	].join("\n")
}

function percent(score: number): string {
	return `${Math.round(Math.max(0, score) * 100)}%`
}

async function turn(session: BackendSession, input: { text: string; images?: string[] }): Promise<string> {
	let text = ""
	for await (const event of session.send(input)) {
		if (event.type === "text" || event.type === "done") text += event.text
		if (event.type === "error" && !event.recoverable) throw new Error(event.message)
	}
	return text
}

/**
 * The first `<svg>…</svg>` in a reply.
 *
 * Tolerant of the decomposition prose the opening prompt asks for and the
 * fences models add anyway — and strict about what it extracts, so nothing
 * after the closing tag ends up in the file.
 */
export function extractSvg(reply: string): string | null {
	const match = /<svg[\s\S]*?<\/svg>/i.exec(reply)
	if (!match) return null

	const svg = match[0]
	// The system prompt rules these out; this is the check that they are actually
	// absent. An emitted <image> or <script> would be a remote fetch or code
	// execution from inside an asset committed to the user's repository.
	if (/<\s*(script|foreignObject|image|iframe|use\b[^>]*href\s*=\s*["']https?:)/i.test(svg)) return null
	if (/\son\w+\s*=/i.test(svg)) return null
	return stripBackgroundRect(svg)
}

/**
 * How alike two pictures are, in [0, 1].
 *
 * Both are resized to 64px and compared channel-wise; that scale keeps the
 * comparison about shapes and colour areas rather than anti-aliasing. The
 * stop thresholds above are calibrated to THIS measure and move with it.
 * The arithmetic lives in `pixel-similarity.ts`, where the unit suite can
 * reach it without electron.
 */
export function similarity(aPng: Buffer, bPng: Buffer): number {
	const size = { width: 64, height: 64 }
	const a = nativeImage.createFromBuffer(aPng).resize(size).toBitmap()
	const b = nativeImage.createFromBuffer(bPng).resize(size).toBitmap()
	return bitmapSimilarity(a, b)
}

/**
 * Renders an SVG offscreen and screenshots it.
 *
 * On the project's surface colour, because a mark judged on white and used on a
 * dark page is a mark nobody checked. The window is sandboxed and never given
 * the SVG as a document — it goes into an `<img>`, so nothing inside it can
 * execute even if the extraction check above ever missed something.
 */
export async function renderSvg(svg: string, surface: string): Promise<Buffer | null> {
	const html =
		`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:${REVIEW_SIZE}px;height:${REVIEW_SIZE}px;` +
		`background:${surface};display:grid;place-items:center}img{width:70%;height:70%;object-fit:contain}</style>` +
		`<img src="data:image/svg+xml;base64,${Buffer.from(svg, "utf-8").toString("base64")}">`
	return capture(html, REVIEW_SIZE, REVIEW_SIZE)
}

/**
 * The side-by-side the model corrects against: TARGET left, YOURS right, both
 * panels at the same scale on the same surface, labelled in the picture itself
 * so the instruction survives any image-handling quirk between here and the
 * model.
 */
export async function renderComposite(
	targetPng: Buffer,
	targetMime: string,
	yoursPng: Buffer,
	surface: string,
): Promise<Buffer | null> {
	const width = REVIEW_SIZE * 2
	const height = REVIEW_SIZE + LABEL_HEIGHT
	const html =
		`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:${width}px;height:${height}px;background:#ffffff;` +
		`font:600 18px system-ui,sans-serif;color:#111}` +
		`.row{display:flex}.cell{width:${REVIEW_SIZE}px}` +
		`.label{height:${LABEL_HEIGHT}px;display:grid;place-items:center;letter-spacing:0.1em}` +
		`img{display:block;width:${REVIEW_SIZE}px;height:${REVIEW_SIZE}px;object-fit:contain;background:${surface}}</style>` +
		`<div class="row">` +
		`<div class="cell"><div class="label">TARGET</div><img src="data:${targetMime};base64,${targetPng.toString("base64")}"></div>` +
		`<div class="cell"><div class="label">YOURS</div><img src="data:image/png;base64,${yoursPng.toString("base64")}"></div>` +
		`</div>`
	return capture(html, width, height)
}

/** Loads static HTML in a sandboxed offscreen window and screenshots it. */
async function capture(html: string, width: number, height: number): Promise<Buffer | null> {
	let window: BrowserWindow | null = null
	try {
		window = new BrowserWindow({
			show: false,
			width,
			height,
			webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true, javascript: false },
		})

		await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
		// Decoding is asynchronous and there is no load event to await through a
		// data URL with javascript disabled, so this waits rather than races.
		await new Promise((resolve) => setTimeout(resolve, 350))

		const image = await window.webContents.capturePage()
		const png = image.toPNG()
		// A blank capture means nothing was drawn — malformed, or entirely
		// outside its own viewBox. Either way it is not a picture.
		return isBlank(image.getBitmap()) ? null : png
	} catch (err) {
		Logger.warn(`[marks] could not render for review: ${err}`)
		return null
	} finally {
		window?.destroy()
	}
}

interface PendingMark {
	svg: string
	subject: string
	rounds: number
	model: string
	at: number
}

/** One held mark per project, same lifetime rules as the raster lane's cache. */
const pendingMarks = new Map<string, PendingMark>()

export function holdMark(projectPath: string, mark: { svg: string; subject: string; rounds: number; model: string }): void {
	pendingMarks.set(projectPath, { ...mark, at: Date.now() })
}

/** Commits the held mark as an ordinary asset. The SVG never left main. */
export async function acceptMark(projectPath: string, tag: string): Promise<{ ok: boolean; tag?: string; error?: string }> {
	const held = pendingMarks.get(projectPath)
	if (!held) return { ok: false, error: "No mark is waiting. Generate one first." }

	const { addGeneratedAsset } = await import("../../src/core/design")
	const result = await addGeneratedAsset({
		projectPath,
		tag: tag.trim() || "mark",
		extension: ".svg",
		bytes: Buffer.from(held.svg, "utf-8"),
		description: `A mark: ${held.subject}. Traced from a generated target by ${held.model} in ${held.rounds} render-compare round(s).`,
		alt: held.subject,
		origin: {
			type: "generated",
			lane: "authored",
			producer: held.model,
			answers: { subject: held.subject },
			resolved: JSON.stringify({ rounds: held.rounds }),
		},
	})

	if (result.ok) pendingMarks.delete(projectPath)
	return result.ok ? { ok: true, tag: result.entry.tag } : { ok: false, error: result.reason }
}

export function discardMark(projectPath: string): void {
	pendingMarks.delete(projectPath)
}

/** True when every pixel matches the first one — nothing was drawn. */
function isBlank(bitmap: Buffer): boolean {
	if (bitmap.length < 8) return true
	for (let i = 4; i < bitmap.length; i += 4) {
		if (bitmap[i] !== bitmap[0] || bitmap[i + 1] !== bitmap[1] || bitmap[i + 2] !== bitmap[2]) return false
	}
	return true
}
