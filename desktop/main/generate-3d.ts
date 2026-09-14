/**
 * Image → 3D, with an LLM deciding how hard to optimize.
 *
 * The pipeline: pick an image asset (uploaded or generated — both are assets by
 * the time this runs, which is why one picker covers both), Tripo builds a
 * draft model from it, the chosen LLM reads the draft's stats and the intended
 * use and decides convert parameters inside a bounded schema, Tripo applies
 * them, and the result lands through the same §4.6 pipeline as everything else.
 *
 * **A paid draft is never thrown away.** The image→model step spends the user's
 * credits; if the optimization step then fails — no backend, a structured-output
 * error, a convert failure — the draft is kept and offered as-is, with the skip
 * recorded. Failing the whole run because the *cheap* step broke would bill the
 * user for nothing, which is the one outcome worse than an unoptimized model.
 */
import * as fs from "fs/promises"
import * as path from "path"

import {
	addGeneratedAsset,
	assetsDirectory,
	findAsset,
	GeminiImages,
	getBackend,
	NO_TRIPO_REASON,
	readAssetIndex,
	resolveTripoConfig,
	TripoClient,
	WEIGHT_BAND,
} from "../../src/core/design"
import { Logger } from "../../src/shared/services/Logger"
import { rasterConfig } from "./generate-assets"
import { compressGlb } from "./glb-compress"
import { cutOutPhotograph } from "./image-post"
import { getPrefs } from "./prefs"
import { getSecret } from "./secrets"
import { canSeeImages } from "./vision-cache"

export interface Model3dProgress {
	stage: string
	detail?: string
}

export interface Model3dOutcome {
	ok: boolean
	draftBytes?: number
	optimizedBytes?: number
	model?: string
	reason?: string
	needsAnotherModel?: boolean
	/** The source failed verification — the fix is a different image, not a retry. */
	badSource?: boolean
}

interface PendingModel {
	bytes: Buffer
	sourceTag: string
	draftBytes: number
	/** How the final bytes were produced from the draft, in plain words. */
	method: string
	/** How many views Tripo was given — 4 is the fidelity path, 1 the fallback. */
	views: number
	taskIds: { draft: string; converted?: string }
	/** Credits the run cost, measured as the wallet delta. Absent when unknown. */
	credits?: number
	at: number
}

/**
 * The turnaround prompts: the same object rotated, on the same white, so the
 * reconstruction never has to invent a side. Proven verbatim (as bottle-
 * specific variants) in the 2026-08-31 experiment.
 */
const VIEW_PROMPTS: Record<"left" | "back" | "right", string> = {
	left: "rotated 90 degrees to its LEFT side view",
	back: "rotated 180 degrees to its BACK view",
	right: "rotated 90 degrees to its RIGHT side view",
}

function viewPrompt(side: "left" | "back" | "right"): string {
	return (
		"This is the same exact object as the reference photo: identical shape, materials, colours, markings, printing and lighting. " +
		`Show the object ${VIEW_PROMPTS[side]}. Any label, pattern or texture continues naturally around the object. ` +
		"Identical scale and framing to the reference, camera at the same height, pure flat white background filling every edge of the frame, " +
		"no shadow, no reflection, nothing else in the picture."
	)
}

/**
 * The three missing views of the turnaround, generated from the source and
 * matted. Not having an image key is a road, not a wall: the caller falls
 * back to the single view and says so.
 */
async function turnaroundViews(
	front: Buffer,
	mime: string,
	onProgress: (update: Model3dProgress) => void,
): Promise<{ ok: true; views: Buffer[] } | { ok: false; reason: string }> {
	const config = rasterConfig()
	if (!config) return { ok: false, reason: "no image key is configured, so the turnaround views cannot be generated" }

	const client = new GeminiImages(config)
	const reference = { mime, base64: front.toString("base64") }
	const views: Buffer[] = []
	for (const side of ["left", "back", "right"] as const) {
		onProgress({ stage: `Composing the ${side} view` })
		const result = await client.generate({ prompt: viewPrompt(side), avoid: [], aspect: "1:1", references: [reference] })
		if (!result.ok) return { ok: false, reason: `the ${side} view failed: ${result.reason}` }
		// A view the matte refuses still works for reconstruction with its white
		// background attached — keep it rather than failing the whole turnaround.
		const keyed = await cutOutPhotograph(result.bytes)
		views.push(keyed.ok ? keyed.bytes : result.bytes)
	}
	return { ok: true, views }
}

/** One held result per project — the flow is one object at a time by design. */
const pending = new Map<string, PendingModel>()

function tripoClient(): TripoClient | null {
	const config = resolveTripoConfig({ apiKey: getSecret("tripoApiKey") })
	return config ? new TripoClient(config) : null
}

export function tripoAvailable(): boolean {
	return tripoClient() !== null
}

export async function generateModel3d(
	projectPath: string,
	sourceTag: string,
	onProgress: (update: Model3dProgress) => void,
): Promise<Model3dOutcome> {
	const client = tripoClient()
	if (!client) return { ok: false, reason: NO_TRIPO_REASON }

	const index = await readAssetIndex(projectPath)
	const source = findAsset(index, sourceTag)
	if (!source) return { ok: false, reason: `No asset tagged "${sourceTag}".` }
	if (source.kind !== "image") {
		return { ok: false, reason: `@${sourceTag} is a ${source.kind} — Tripo takes a raster image as its source.` }
	}

	let bytes: Buffer
	try {
		bytes = await fs.readFile(path.join(assetsDirectory(projectPath), source.file))
	} catch (err) {
		return { ok: false, reason: `Could not read @${sourceTag}: ${err instanceof Error ? err.message : String(err)}` }
	}

	// The verification layer: is this actually one object? Image-to-3D fuses a
	// scene into a single lump, so a workbench full of tools produces a model of
	// nothing — and the check costs one cheap vision turn against the credits the
	// draft would have spent. Skipped honestly when no vision-capable backend is
	// available, because a guard that cannot look should say so, not pretend.
	onProgress({ stage: "Checking the source is a single object" })
	const verdict = await verifySingleObject(projectPath, bytes, source.mime)
	if (verdict.checked && !verdict.singleObject) {
		return {
			ok: false,
			badSource: true,
			reason:
				`@${sourceTag} doesn't look like a single object — the model saw: ${verdict.sees}. ` +
				`3D generation works from one object on a plain background; generate a purpose-made source below, or pick a different image.`,
		}
	}
	if (!verdict.checked) {
		Logger.warn(`[3d] source verification skipped: ${verdict.why}`)
		onProgress({ stage: "Source check skipped", detail: verdict.why })
	}

	// Read before the first paid call, so the delta at the end measures this run.
	// A failure here is "cost unknown", never a failed run: the measurement is a
	// provenance nicety, and the credits are about to be spent either way.
	const balanceBefore = await client.getBalance()
	if (!balanceBefore.ok) Logger.warn(`[3d] could not read the Tripo balance before the run: ${balanceBefore.reason}`)

	// The turnaround. Reconstruction hallucinates every side it never saw —
	// the field failure was a bottle whose back rendered as a blank band — so
	// three more views are composed from the source and all four go to Tripo.
	const turnaround = await turnaroundViews(bytes, source.mime, onProgress)
	if (!turnaround.ok) {
		onProgress({ stage: "Building from the single view", detail: turnaround.reason })
	}

	const progressTap = (update: { stage: string; percent?: number }) =>
		onProgress({ stage: update.stage, detail: update.percent !== undefined ? `${update.percent}%` : undefined })

	let draft: Awaited<ReturnType<typeof client.imageToModel>>
	if (turnaround.ok) {
		onProgress({ stage: "Uploading the four views to Tripo" })
		const tokens: string[] = []
		for (const [index, view] of [bytes, ...turnaround.views].entries()) {
			const uploaded = await client.uploadImage(view, index === 0 ? source.mime : "image/png")
			if (!uploaded.ok) return { ok: false, reason: uploaded.reason }
			tokens.push(uploaded.value)
		}
		onProgress({ stage: "Tripo is building the model from four views", detail: "This is the slow step — a few minutes." })
		draft = await client.multiviewToModel(tokens as [string, string, string, string], progressTap)
	} else {
		onProgress({ stage: "Uploading the source image to Tripo" })
		const uploaded = await client.uploadImage(bytes, source.mime)
		if (!uploaded.ok) return { ok: false, reason: uploaded.reason }
		onProgress({ stage: "Tripo is building the model", detail: "This is the slow step — a few minutes." })
		draft = await client.imageToModel(uploaded.value, source.mime, progressTap)
	}
	if (!draft.ok) return { ok: false, reason: draft.reason }

	const draftBytes = draft.value.bytes.length
	Logger.info(`[3d] draft for @${sourceTag}: ${Math.round(draftBytes / 1024)}KB (${turnaround.ok ? 4 : 1} views)`)

	// Optimization is COMPRESSION first — Draco geometry + WebP textures encode
	// the same detail smaller (measured: 57MB → 4.6MB, visually identical),
	// where Tripo's convert destroys detail to fit (the melted-label look).
	// The destructive convert survives only as the escalation for a draft that
	// is still over the weight band after real compression, and its output is
	// compressed too. Every failure from here keeps the best bytes so far —
	// the draft is paid for and is never thrown away.
	onProgress({ stage: "Compressing the model", detail: "Draco geometry + WebP textures — nothing destroyed" })
	let final = draft.value.bytes
	let method = "the draft as Tripo produced it"
	let convertedTaskId: string | undefined
	let skipNote = ""

	const compressed = await compressGlb(draft.value.bytes)
	if (compressed.ok && compressed.bytes.length < final.length) {
		final = compressed.bytes
		method = "Draco + WebP compression of the full-quality draft"
	} else if (!compressed.ok) {
		skipNote = `Compression failed (${compressed.reason}), so the draft was kept.`
	}

	if (final.length > WEIGHT_BAND.maxBytes) {
		onProgress({
			stage: "Still over the weight band — converting",
			detail: `${Math.round(final.length / 1_000_000)}MB → 100k faces, 2048px textures, then compressed again`,
		})
		const converted = await client.convertModel(draft.value.taskId, { faceLimit: 100_000, textureSize: 2048 }, progressTap)
		if (converted.ok) {
			const recompressed = await compressGlb(converted.value.bytes)
			const candidate = recompressed.ok ? recompressed.bytes : converted.value.bytes
			if (candidate.length < final.length) {
				final = candidate
				method = "convert to 100k faces / 2048px textures, then Draco + WebP compression"
				convertedTaskId = converted.value.taskId
			}
		} else {
			skipNote = `The escalation convert failed (${converted.reason}); kept ${method}.`
		}
	}

	// After the last paid call. Both reads succeeding and the wallet having
	// moved is the only state in which the number means anything.
	let credits: number | undefined
	if (balanceBefore.ok) {
		const balanceAfter = await client.getBalance()
		if (balanceAfter.ok && balanceBefore.value - balanceAfter.value > 0) {
			credits = balanceBefore.value - balanceAfter.value
			Logger.info(`[3d] the run cost ${credits} credits (wallet ${balanceBefore.value} → ${balanceAfter.value})`)
		}
	}

	pending.set(projectPath, {
		bytes: final,
		sourceTag,
		draftBytes,
		method,
		views: turnaround.ok ? 4 : 1,
		taskIds: { draft: draft.value.taskId, ...(convertedTaskId ? { converted: convertedTaskId } : {}) },
		...(credits !== undefined ? { credits } : {}),
		at: Date.now(),
	})

	if (skipNote) Logger.warn(`[3d] ${skipNote}`)
	return {
		ok: true,
		draftBytes,
		optimizedBytes: final.length,
		model: method,
		...(skipNote ? { reason: skipNote } : {}),
	}
}

/** Commits the held model. The glb never round-trips through the renderer. */
export async function acceptModel3d(projectPath: string, tag: string): Promise<{ ok: boolean; tag?: string; error?: string }> {
	const held = pending.get(projectPath)
	if (!held) return { ok: false, error: "No generated model is waiting. Generate one first." }

	const description = `3D model built from @${held.sourceTag} (${held.views === 4 ? "four-view turnaround" : "single view"}), shrunk by ${held.method}.`

	const result = await addGeneratedAsset({
		projectPath,
		tag: tag.trim() || `${held.sourceTag}-3d`,
		extension: ".glb",
		bytes: held.bytes,
		description,
		alt: "",
		origin: {
			type: "generated",
			lane: "model3d",
			producer: "tripo",
			answers: { source: held.sourceTag },
			...(held.credits !== undefined
				? {
						cost: {
							unit: "credits" as const,
							amount: held.credits,
							note: "measured as the Tripo wallet balance change across the run",
						},
					}
				: {}),
			resolved: JSON.stringify({
				taskIds: held.taskIds,
				draftBytes: held.draftBytes,
				finalBytes: held.bytes.length,
				views: held.views,
				method: held.method,
				weightBand: { minBytes: WEIGHT_BAND.minBytes, maxBytes: WEIGHT_BAND.maxBytes },
			}),
		},
	})

	if (result.ok) pending.delete(projectPath)
	return result.ok ? { ok: true, tag: result.entry.tag } : { ok: false, error: result.reason }
}

export function discardModel3d(projectPath: string): void {
	pending.delete(projectPath)
}

type SourceVerdict = { checked: true; singleObject: boolean; sees: string } | { checked: false; why: string }

/**
 * Asks the session's vision to look at the source before Tripo spends on it.
 *
 * The same probe pattern as the vision check, and for the same reason: parsing
 * a constrained first word out of a real look at the pixels. `structured()`
 * cannot carry an image, so this is a session turn, not a schema call.
 */
async function verifySingleObject(projectPath: string, image: Buffer, mime: string): Promise<SourceVerdict> {
	const prefs = getPrefs()
	if (!prefs.backendId) return { checked: false, why: "no coding backend is configured" }

	const model = prefs.laneModels.model3d?.trim() || prefs.backendModel || ""
	const vision = await canSeeImages(prefs.backendId, model, projectPath)
	if (!vision.sees) return { checked: false, why: "the selected model cannot be shown images" }

	const backend = await getBackend(prefs.backendId)
	if (!backend) return { checked: false, why: `the "${prefs.backendId}" backend is unavailable` }

	let session: Awaited<ReturnType<typeof backend.startSession>> | null = null
	let answer = ""
	try {
		session = await backend.startSession({
			workingDirectory: projectPath,
			mode: "read-only",
			model: model || undefined,
			title: "caret source check",
		})
		for await (const event of session.send({
			text:
				"This image is a candidate source for image-to-3D reconstruction, which needs ONE main object on a simple background. " +
				"First word of your reply, exactly: SINGLE if it shows one main object, MULTIPLE if several distinct objects, SCENE if it is a scene, landscape, texture or background. " +
				"Then, after a dash, one short sentence describing what you see.",
			images: [`data:${mime};base64,${image.toString("base64")}`],
		})) {
			if (event.type === "text" || event.type === "done") answer += event.text
		}
	} catch (err) {
		return { checked: false, why: err instanceof Error ? err.message : String(err) }
	} finally {
		await session?.close().catch(() => {})
	}

	const first =
		answer
			.trim()
			.split(/[\s—-]+/)[0]
			?.toUpperCase() ?? ""
	const sees =
		answer
			.trim()
			.replace(/^\w+\s*[—-]?\s*/, "")
			.slice(0, 200) || answer.trim().slice(0, 200)
	if (first === "SINGLE") return { checked: true, singleObject: true, sees }
	if (first === "MULTIPLE" || first === "SCENE") return { checked: true, singleObject: false, sees }
	// An answer outside the vocabulary is a check that did not happen, not a
	// verdict — refusing the user's image on a garbled reply would be guessing.
	return { checked: false, why: `the model answered outside the expected vocabulary: "${answer.trim().slice(0, 80)}"` }
}
