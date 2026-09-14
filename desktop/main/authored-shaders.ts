/**
 * Background shaders: a model authoring GLSL inside a compile-and-look loop.
 *
 * The mark loop's shape (emit → render → look → correct), with the one
 * advantage the SVG lane never had: a shader's first failure mode is a COMPILE
 * ERROR, and `getShaderInfoLog` is precise, line-numbered, machine-checked
 * feedback. Fed back verbatim it corrects the model faster than any picture,
 * so the picture round spends its budget on taste rather than syntax.
 *
 * Between compile and critique sits the timidity gate: a frame whose luminance
 * spread is below `SHADER_MIN_LUMINANCE_SPREAD` is bounced back automatically
 * — a compiling flat wash is still the failure the taste rules name, and the
 * user should be grilled for requirements, never shown a blank rectangle.
 *
 * The render window is NOT the mark's: shaders need JavaScript on (a shader IS
 * a program) and `offscreen: true` off (probe-shader.ts measured it capturing
 * frozen pixels). The page is Caret-built, the GLSL is validated before it
 * gets near a template literal, and the window is destroyed in a finally.
 */

import { BrowserWindow } from "electron"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { BackendSession, FoundationTokens } from "../../src/core/design"
import { derivePalette, foundationWords, getBackend } from "../../src/core/design"
import { type AssetRequest, composeAssetRequest, recipeForRequest } from "../../src/core/design/asset-library/request"
import {
	buildShaderRenderHtml,
	type ExtractedShader,
	extractShaderReply,
	SHADER_COMPILE_RETRIES,
	SHADER_CRITIQUE_TIMES,
	SHADER_MIN_LUMINANCE_SPREAD,
	SHADER_SYSTEM_PROMPT,
	shaderCompileFixPrompt,
	shaderCritiquePrompt,
	shaderFlatPrompt,
	shaderOpeningPrompt,
	shaderRejectionPrompt,
} from "../../src/core/design/asset-library/shader/authoring"
import { runnerVersionOf, SHADER_RUNNER_SOURCE, SHADER_RUNNER_VERSION } from "../../src/core/design/authoring/shader-runner"
import { Logger } from "../../src/shared/services/Logger"
import { getPrefs } from "./prefs"
import { canSeeImages } from "./vision-cache"

/** Preview render size — the critique frames and the picker strip. */
const FRAME_SIZE = { width: 640, height: 400 }
/** The poster asset. 16:10, the lane's default aspect. */
const POSTER_SIZE = { width: 1600, height: 1000 }

export interface ShaderRequest {
	projectPath: string
	/** The composed request: the user's words plus their clarify answers. */
	request: AssetRequest
	tokens: FoundationTokens | null
	/** Overrides the project's backend model for this lane only. */
	modelOverride?: string
	/**
	 * Iteration: the current shader and what the user wants changed. The
	 * opening prompt becomes an EDIT of this fragment rather than a fresh
	 * attempt — everything the current version got right survives the note.
	 */
	seed?: { fragment: string; uniforms: ExtractedShader["uniforms"]; note: string }
	/** Called as the loop moves; round updates carry the frame being judged. */
	onProgress?(update: { stage: string; round?: number; previewPng?: Buffer }): void
}

export interface ShaderOutcome {
	/** The fragment body — the part the model wrote. */
	fragment: string
	/** The knob manifest, as validated. */
	uniforms: ExtractedShader["uniforms"]
	rounds: number
	model: string
	/** Frames at the critique timestamps, for the picker strip. */
	framePngs: Buffer[]
	/** Luminance spread of the final render. */
	range: { min: number; max: number }
}

export type ShaderResult = { ok: true; shader: ShaderOutcome } | { ok: false; reason: string; needsAnotherModel?: boolean }

/**
 * Runs the loop and returns the best shader that compiled.
 *
 * "That compiled" is load-bearing, same as the mark's "that rendered": a
 * critique correction that breaks the compile never replaces a round that
 * worked.
 */
export async function authorShader(request: ShaderRequest): Promise<ShaderResult> {
	const prefs = getPrefs()
	const backendId = prefs.backendId
	if (!backendId) {
		return { ok: false, reason: "Writing a shader needs a coding backend. Open Settings → Backend to set one up." }
	}
	const model = request.modelOverride?.trim() || prefs.backendModel || ""

	// Same posture as marks: a model that cannot see costs one tiny probe
	// rather than a critique round spent flattering frames it never saw.
	const vision = await canSeeImages(backendId, model, request.projectPath)
	if (!vision.sees) return { ok: false, reason: vision.reason, needsAnotherModel: true }

	const backend = await getBackend(backendId)
	if (!backend) return { ok: false, reason: `No backend called "${backendId}" is available.` }

	const palette = derivePalette(request.tokens)
	const recipe = recipeForRequest(request.request)
	const composed = composeAssetRequest(request.request, {
		palette,
		aspect: recipe.aspects[0],
		variant: 0,
		tags: [],
	})
	const brief = composed.lane === "authored" ? composed.brief : request.request.text.trim()

	const progress = request.onProgress ?? (() => {})
	let session: BackendSession | null = null
	let best: { shader: ExtractedShader; frames: Buffer[]; range: { min: number; max: number } } | null = null
	let rounds = 0

	try {
		progress({ stage: request.seed ? "Asking the model to apply your note" : "Asking the model for a first attempt" })
		session = await backend.startSession({
			workingDirectory: request.projectPath,
			// It writes GLSL into Caret's scaffold; it does not touch the repo.
			mode: "read-only",
			model: model || undefined,
			title: "caret shader",
			systemPrompt: SHADER_SYSTEM_PROMPT,
		})

		const opening = request.seed
			? [
					`The shader below is the current version of "${brief}". The user has looked at it running and asks for one change:`,
					"",
					`USER'S NOTE: ${request.seed.note}`,
					"",
					"Edit the current shader to apply the note — keep everything the note does not mention exactly as it is, including the knob manifest unless the note demands a new knob. Reply in the same format as always: the manifest JSON and the ```glsl block.",
					"",
					"Current manifest:",
					JSON.stringify({ uniforms: request.seed.uniforms }),
					"",
					"Current fragment:",
					"```glsl",
					request.seed.fragment,
					"```",
				].join("\n")
			: shaderOpeningPrompt(brief, foundationWords(palette), [palette.brand, palette.brandQuiet, palette.surface])
		let reply = await turn(session, { text: opening })

		// The machine-checkable half: extraction, compile, and the timidity gate.
		// Each failure goes back in the model's own terms; the budget is shared
		// because to the user they are all "it is still thinking".
		let fixes = 0
		while (fixes <= SHADER_COMPILE_RETRIES) {
			rounds += 1
			const extracted = extractShaderReply(reply)
			if (!extracted.ok) {
				fixes += 1
				if (fixes > SHADER_COMPILE_RETRIES) break
				progress({ stage: `Round ${rounds}: the reply was rejected — asking again` })
				reply = await turn(session, { text: shaderRejectionPrompt(extracted.reason) })
				continue
			}
			const rendered = await renderShaderFrames(extracted.shader, FRAME_SIZE, SHADER_CRITIQUE_TIMES)
			if (!rendered.ok) {
				fixes += 1
				if (fixes > SHADER_COMPILE_RETRIES) break
				progress({ stage: `Round ${rounds}: the shader did not compile — sending the error back` })
				reply = await turn(session, { text: shaderCompileFixPrompt(rendered.error ?? "") })
				continue
			}
			if (rendered.range.max - rendered.range.min < SHADER_MIN_LUMINANCE_SPREAD) {
				fixes += 1
				if (fixes > SHADER_COMPILE_RETRIES) break
				progress({ stage: `Round ${rounds}: it rendered nearly flat — asking for real light and shadow` })
				reply = await turn(session, { text: shaderFlatPrompt(rendered.range) })
				continue
			}
			best = { shader: extracted.shader, frames: rendered.frames, range: rendered.range }
			progress({ stage: `Round ${rounds} compiled`, round: rounds, previewPng: rendered.frames[1] ?? rendered.frames[0] })
			break
		}
		if (!best) return { ok: false, reason: "The model never produced a shader that compiled and showed something." }

		// The taste round: the model looks at its own frames. One round; the
		// marks loop measured most of the gain in the first look.
		progress({ stage: "Showing the model its own frames" })
		reply = await turn(session, {
			text: shaderCritiquePrompt(brief),
			images: best.frames.map((frame) => `data:image/png;base64,${frame.toString("base64")}`),
		})
		rounds += 1
		const corrected = extractShaderReply(reply)
		if (corrected.ok) {
			const rendered = await renderShaderFrames(corrected.shader, FRAME_SIZE, SHADER_CRITIQUE_TIMES)
			if (rendered.ok && rendered.range.max - rendered.range.min >= SHADER_MIN_LUMINANCE_SPREAD) {
				best = { shader: corrected.shader, frames: rendered.frames, range: rendered.range }
				progress({
					stage: `Round ${rounds} corrected`,
					round: rounds,
					previewPng: rendered.frames[1] ?? rendered.frames[0],
				})
			} else {
				Logger.info("[shaders] the critique correction regressed — keeping the pre-critique shader")
			}
		}
	} catch (err) {
		if (!best) return { ok: false, reason: err instanceof Error ? err.message : String(err) }
		Logger.warn(`[shaders] the loop ended early but had a usable shader: ${err}`)
	} finally {
		await session?.close().catch(() => {})
	}

	return {
		ok: true,
		shader: {
			fragment: best.shader.body,
			uniforms: best.shader.uniforms,
			rounds,
			model: model || "(backend default)",
			framePngs: best.frames,
			range: best.range,
		},
	}
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
 * Compiles and renders one shader in a hidden window, in-process.
 *
 * The scripts render in a spawned Electron because they run under tsx; main is
 * already Electron, so this is the same page in a directly-owned window. The
 * deadline-and-destroy discipline is design-checks': no hang may wedge the
 * generate flow, and no window may outlive its render.
 */
async function renderShaderFrames(
	shader: ExtractedShader,
	size: { width: number; height: number },
	timestamps: number[],
): Promise<{ ok: true; frames: Buffer[]; range: { min: number; max: number } } | { ok: false; error?: string }> {
	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "caret-shader-"))
	const htmlPath = path.join(scratch, "shader.html")
	await fs.writeFile(htmlPath, buildShaderRenderHtml(shader.body, shader.uniforms, size), "utf-8")

	let window: BrowserWindow | null = null
	try {
		const work = (async () => {
			window = new BrowserWindow({
				show: false,
				width: size.width,
				height: size.height,
				paintWhenInitiallyHidden: true,
				webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
			})
			await window.loadFile(htmlPath)
			await window.webContents.executeJavaScript(
				"new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 200))))",
			)
			const state = (await window.webContents.executeJavaScript("window.__caretShader")) as {
				ready?: boolean
				error?: string
			} | null
			if (!state?.ready) return { ok: false as const, error: state?.error ?? "the shader page never initialised" }

			const frames: Buffer[] = []
			let range: { min: number; max: number } | null = null
			for (const t of timestamps) {
				await window.webContents.executeJavaScript(`window.__caretDrawAt(${t})`)
				await new Promise((resolve) => setTimeout(resolve, 120))
				const image = await window.webContents.capturePage()
				frames.push(image.toPNG())
				if (!range) {
					const bitmap = image.getBitmap()
					let min = 255
					let max = 0
					for (let i = 0; i < bitmap.length; i += 4) {
						const v = (bitmap[i] + bitmap[i + 1] + bitmap[i + 2]) / 3
						if (v < min) min = v
						if (v > max) max = v
					}
					range = { min: Math.round(min), max: Math.round(max) }
				}
			}
			return { ok: true as const, frames, range: range ?? { min: 0, max: 255 } }
		})()

		return await Promise.race([
			work,
			new Promise<{ ok: false; error: string }>((resolve) =>
				setTimeout(() => resolve({ ok: false, error: "the shader render did not settle within 20s" }), 20_000),
			),
		])
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) }
	} finally {
		if (window && !(window as BrowserWindow).isDestroyed()) (window as BrowserWindow).destroy()
		await fs.rm(scratch, { recursive: true, force: true }).catch(() => {})
	}
}

// ── hold / accept / discard ─────────────────────────────────────────────────

interface PendingShader {
	outcome: ShaderOutcome
	subject: string
	answers: Record<string, string> | undefined
	at: number
}

/** One held shader per project, same lifetime rules as the mark's. */
const pendingShaders = new Map<string, PendingShader>()

export function holdShader(
	projectPath: string,
	held: { outcome: ShaderOutcome; subject: string; answers?: Record<string, string> },
): void {
	pendingShaders.set(projectPath, { ...held, answers: held.answers, at: Date.now() })
}

export function discardShader(projectPath: string): void {
	pendingShaders.delete(projectPath)
}

/**
 * Re-enters the authoring loop on the held shader with the user's note.
 *
 * The iteration door the lane was missing: "slower, more layered, less
 * green" edits the CURRENT fragment rather than rolling a new one, so
 * everything the current version got right survives. A success replaces the
 * held shader; a failure leaves it exactly as it was, so a bad note costs
 * nothing but the attempt.
 */
export async function refineHeldShader(
	projectPath: string,
	note: string,
	tokens: FoundationTokens | null,
	modelOverride?: string,
	onProgress?: ShaderRequest["onProgress"],
): Promise<ShaderResult> {
	const held = pendingShaders.get(projectPath)
	if (!held) return { ok: false, reason: "No shader is waiting to refine. Generate one first." }

	const result = await authorShader({
		projectPath,
		request: { kind: "shader", text: held.subject, answers: held.answers },
		tokens,
		modelOverride,
		seed: { fragment: held.outcome.fragment, uniforms: held.outcome.uniforms, note },
		onProgress,
	})
	if (result.ok) {
		holdShader(projectPath, { outcome: result.shader, subject: held.subject, answers: held.answers })
	}
	return result
}

/** Knob defaults with the user's live-preview tuning applied. */
function withTuned(
	uniforms: ShaderOutcome["uniforms"],
	tuned: Record<string, number | string> | undefined,
): ShaderOutcome["uniforms"] {
	if (!tuned) return uniforms
	return uniforms.map((uniform) =>
		tuned[uniform.name] !== undefined && typeof tuned[uniform.name] === typeof uniform.default
			? { ...uniform, default: tuned[uniform.name] }
			: uniform,
	)
}

/**
 * Commits the held shader: the runner healed into `.caret/lib/`, the instance
 * component written into `.caret/components/shaders/`, and the poster indexed
 * as an ordinary asset whose description names its live twin.
 */
export async function acceptShader(
	projectPath: string,
	tag: string,
	tuned?: Record<string, number | string>,
): Promise<{ ok: boolean; tag?: string; componentPath?: string; error?: string }> {
	const rawHeld = pendingShaders.get(projectPath)
	if (!rawHeld) return { ok: false, error: "No shader is waiting. Generate one first." }
	// The user's live-preview tuning becomes the shipped defaults — the knobs
	// they set while watching the animation are the taste decision.
	const held: PendingShader = {
		...rawHeld,
		outcome: { ...rawHeld.outcome, uniforms: withTuned(rawHeld.outcome.uniforms, tuned) },
	}

	const cleanTag = (tag.trim() || "shader").replace(/[^a-z0-9-]/gi, "-").toLowerCase()

	// The runner ships with the boot-generated canvas set now (see
	// generateCanvasFiles — .caret/lib is cleared at every project open, which
	// is how the first live accept lost its runner on the next launch). This
	// write is the belt for the one gap left: accepting into a project whose
	// shell was generated by a build older than the runner's arrival there.
	const libDir = path.join(projectPath, ".caret", "lib")
	const runnerPath = path.join(libDir, "CaretShader.tsx")
	await fs.mkdir(libDir, { recursive: true })
	const existing = await fs.readFile(runnerPath, "utf-8").catch(() => null)
	const existingVersion = existing === null ? null : runnerVersionOf(existing)
	if (existing === null || existingVersion === null || existingVersion < SHADER_RUNNER_VERSION) {
		await fs.writeFile(runnerPath, SHADER_RUNNER_SOURCE, "utf-8")
	}

	const componentsDir = path.join(projectPath, ".caret", "components", "shaders")
	await fs.mkdir(componentsDir, { recursive: true })
	const componentName = `${cleanTag
		.split("-")
		.filter(Boolean)
		.map((part) => part[0].toUpperCase() + part.slice(1))
		.join("")}Shader`
	const componentPath = path.join(componentsDir, `${cleanTag}.tsx`)
	await fs.writeFile(componentPath, instanceSource(componentName, held), "utf-8")

	const { addGeneratedAsset } = await import("../../src/core/design")
	const posterResult = await renderShaderFrames(
		{ body: held.outcome.fragment, uniforms: held.outcome.uniforms },
		POSTER_SIZE,
		[2.0],
	)
	const poster = posterResult.ok ? posterResult.frames[0] : (held.outcome.framePngs[1] ?? held.outcome.framePngs[0])

	const result = await addGeneratedAsset({
		projectPath,
		tag: cleanTag,
		extension: ".png",
		bytes: poster,
		description: `A still of an animated background shader: ${held.subject}. The LIVE version is the component at .caret/components/shaders/${cleanTag}.tsx — place that, not this image, when motion is wanted; its colors and motion are tunable props.`,
		alt: held.subject,
		origin: {
			type: "generated",
			lane: "authored",
			producer: held.outcome.model,
			answers: { asked: held.subject, ...(held.answers ?? {}) },
			resolved: JSON.stringify({
				component: `.caret/components/shaders/${cleanTag}.tsx`,
				rounds: held.outcome.rounds,
				range: held.outcome.range,
				uniforms: held.outcome.uniforms,
			}),
		},
	})
	if (!result.ok) return { ok: false, error: result.reason }

	pendingShaders.delete(projectPath)
	return { ok: true, tag: result.entry.tag, componentPath: path.relative(projectPath, componentPath) }
}

/**
 * The instance file a project receives: small, readable, and every knob a
 * literal in the props object so the param substrate can splice it.
 */
function instanceSource(componentName: string, held: PendingShader): string {
	const props = held.outcome.uniforms
		.map((uniform) => {
			const value = typeof uniform.default === "string" ? JSON.stringify(uniform.default) : String(uniform.default)
			const bounds = uniform.type === "float" && uniform.min !== undefined ? ` (${uniform.min}–${uniform.max})` : ""
			return `\t\t\t\t${uniform.name}: ${value}, // ${uniform.label}${bounds}`
		})
		.join("\n")

	return `// Generated by Caret from: "${held.subject.replace(/"/g, "'")}"
// The fragment is yours to edit; the knobs below are live props.
import CaretShader from "../../lib/CaretShader"

const FRAGMENT = \`${held.outcome.fragment}\`

export default function ${componentName}({ className }: { className?: string }) {
	return (
		<CaretShader
			fragment={FRAGMENT}
			uniforms={{
${props}
			}}
			className={className}
		/>
	)
}
`
}
