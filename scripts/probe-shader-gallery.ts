/**
 * The shader taste gate: the full authoring loop, run for real, across a
 * spread of briefs — and a gallery a person can look at before any UI exists.
 *
 *   npx tsx scripts/probe-shader-gallery.ts            # all 8 briefs
 *   npx tsx scripts/probe-shader-gallery.ts "lava lamp for a music app"
 *
 * Writes release/shader-gallery/: per brief, a poster PNG, the critique-round
 * frames, the fragment + manifest, and a live.html where the shader actually
 * ANIMATES — open index.html and judge the motion, because a still of an
 * animated background is only half the evidence.
 *
 * Same split as probe-mark: tsx orchestrates and talks to the backend; every
 * render spawns a fresh Electron with a plain-JS main (the hidden-window
 * config probe-shader.ts certified). Costs real turns on the verify backend,
 * so it is a script, never a suite.
 */
import * as fs from "fs/promises"
import * as path from "path"

import type { BackendSession, FoundationTokens } from "../src/core/design"
import { derivePalette, disposeBackends, foundationWords } from "../src/core/design"
import { probeVision } from "../src/core/design/agent/vision"
import {
	type ExtractedShader,
	extractShaderReply,
	SHADER_COMPILE_RETRIES,
	SHADER_CRITIQUE_TIMES,
	SHADER_SYSTEM_PROMPT,
	shaderCompileFixPrompt,
	shaderCritiquePrompt,
	shaderOpeningPrompt,
	shaderRejectionPrompt,
} from "../src/core/design/asset-library/shader/authoring"
import { FRAME_SIZE, GALLERY_OUT, liveHtml, POSTER_SIZE, renderShader, slugOf, writeGalleryIndex } from "./shader-render"
import { resolveVerifyModel } from "./verify-support"

const BRIEFS = [
	"a slow aurora for a hero section",
	"a grainy warm gradient, calm, like evening light",
	"liquid metal, dark and expensive",
	"drifting topographic contour lines for a section divider",
	"a soft mesh gradient in brand colors for a card surface",
	"dark-mode embers, barely moving",
	"paper texture with a slow light drift",
	"gentle waves of the brand color for a footer",
	// The statement register: bold, sculptural, saturated. Written from a
	// reference sheet of the look this feature is measured against.
	"a bold statement gradient: mint green sweeping into lilac across one huge smooth fold, bright and clean",
	"electric cobalt blue with deep near-black sculptural folds and violet highlights, dramatic",
	"glowing warm yellow into amber and orange, with a dark form pushing in from one corner",
	"a cream-white lit form against near-black, a thin acid-green rim where the light catches its edge",
	"saturated orange into scarlet with heavy film grain, and a lilac wedge in the bottom corner",
	"periwinkle and pale lavender folding across a soft diagonal light, calm and expensive",
]

/** The same foundation probe-mark judges against — a real palette, not neon defaults. */
const tokens: FoundationTokens = {
	vibe: { description: "", tags: [] },
	color: {
		brand: { seed: "#2563eb", scale: {} },
		neutral: { character: "cool", scale: {} },
		semantic: { success: "#16a34a", warning: "#ca8a04", error: "#dc2626", info: "#2563eb" },
		surface: "light",
	},
	typography: { fontFamily: "Inter", fallback: "system-ui", scaleRatio: 1.25, baseSize: 16, scale: {} },
	spacing: { baseUnit: 4, scale: [0, 4, 8] },
	radius: { character: "soft", scale: [0, 4, 8] },
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
 * One brief through the whole loop: emit → (reject/compile-fix)* → critique →
 * best compiling answer. Returns null when nothing ever compiled.
 */
async function authorOne(
	session: BackendSession,
	brief: string,
	colors: string[],
	paletteWords: string,
	vision: boolean,
	log: (line: string) => void,
): Promise<{ shader: ExtractedShader; frames: Buffer[]; rounds: number } | null> {
	let reply = await turn(session, { text: shaderOpeningPrompt(brief, paletteWords, colors) })
	let best: { shader: ExtractedShader; frames: Buffer[] } | null = null
	let rounds = 0

	// Extraction/compile fixes: the machine-checkable half of the loop.
	let fixes = 0
	let current: ExtractedShader | null = null
	while (fixes <= SHADER_COMPILE_RETRIES) {
		rounds += 1
		const extracted = extractShaderReply(reply)
		if (!extracted.ok) {
			log(`  reply rejected: ${extracted.reason}`)
			fixes += 1
			if (fixes > SHADER_COMPILE_RETRIES) break
			reply = await turn(session, { text: shaderRejectionPrompt(extracted.reason) })
			continue
		}
		const rendered = await renderShader(extracted.shader, FRAME_SIZE, SHADER_CRITIQUE_TIMES)
		if (!rendered.ok) {
			log(`  compile failed: ${(rendered.error ?? "").split("\n")[0]}`)
			fixes += 1
			if (fixes > SHADER_COMPILE_RETRIES) break
			reply = await turn(session, { text: shaderCompileFixPrompt(rendered.error ?? "") })
			continue
		}
		current = extracted.shader
		best = { shader: extracted.shader, frames: rendered.frames }
		break
	}
	if (!best || !current) return null

	// The taste round: show the model its own frames. One round — the marks
	// loop measured most of the gain in the first look.
	if (vision) {
		log(`  critique round`)
		reply = await turn(session, {
			text: shaderCritiquePrompt(brief),
			images: best.frames.map((f) => `data:image/png;base64,${f.toString("base64")}`),
		})
		rounds += 1
		const corrected = extractShaderReply(reply)
		if (corrected.ok) {
			const rendered = await renderShader(corrected.shader, FRAME_SIZE, SHADER_CRITIQUE_TIMES)
			// Best COMPILING answer wins — a correction that broke the compile
			// never replaces a round that worked.
			if (rendered.ok) best = { shader: corrected.shader, frames: rendered.frames }
			else log(`  correction did not compile — keeping the pre-critique shader`)
		} else {
			log(`  correction rejected (${corrected.reason}) — keeping the pre-critique shader`)
		}
	}

	return { ...best, rounds }
}

async function main(): Promise<void> {
	const named = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
	const briefs = named.length > 0 ? named : BRIEFS

	const model = await resolveVerifyModel()
	if (!model) throw new Error("no verify backend/model available — set CARET_VERIFY_BACKEND / CARET_VERIFY_MODEL")
	console.log(`backend  ${model.backendId} model ${model.id} (${model.source})`)

	const vision = await probeVision({ backend: model.backend, workingDirectory: process.cwd(), model: model.id })
	console.log(
		vision.sees
			? "vision   the model can be shown its own frames — critique round on"
			: `vision   REFUSED (${vision.reason}) — compile-only, no critique round`,
	)

	const palette = derivePalette(tokens)
	const colors = [palette.brand, palette.brandQuiet, palette.surface]
	const paletteWords = foundationWords(palette)

	await fs.mkdir(GALLERY_OUT, { recursive: true })

	for (const brief of briefs) {
		const slug = slugOf(brief)
		// Resumable: a network abort mid-turn must cost one brief, not the run.
		const done = await fs
			.access(path.join(GALLERY_OUT, slug, "shader.json"))
			.then(() => true)
			.catch(() => false)
		if (done) {
			console.log(`\n▸ ${brief}\n  already in the gallery — skipped (delete the folder to redo)`)
			continue
		}
		console.log(`\n▸ ${brief}`)
		const session = await model.backend.startSession({
			workingDirectory: process.cwd(),
			mode: "read-only",
			model: model.id,
			title: "caret shader gallery",
			systemPrompt: SHADER_SYSTEM_PROMPT,
		})
		try {
			const result = await authorOne(session, brief, colors, paletteWords, vision.sees, (line) => console.log(line))
			if (!result) {
				console.log("  ✗ nothing compiled — skipped")
				continue
			}

			const dir = path.join(GALLERY_OUT, slug)
			await fs.mkdir(dir, { recursive: true })
			for (const [index, frame] of result.frames.entries()) {
				await fs.writeFile(path.join(dir, `frame-${SHADER_CRITIQUE_TIMES[index]}s.png`), frame)
			}
			const poster = await renderShader(result.shader, POSTER_SIZE, [2.0])
			if (poster.ok && poster.frames[0]) await fs.writeFile(path.join(dir, "poster.png"), poster.frames[0])
			await fs.writeFile(path.join(dir, "live.html"), liveHtml(result.shader), "utf-8")
			await fs.writeFile(
				path.join(dir, "shader.json"),
				JSON.stringify(
					{ brief, model: model.id, rounds: result.rounds, uniforms: result.shader.uniforms, body: result.shader.body },
					null,
					2,
				),
			)
			console.log(`  ✓ ${result.rounds} round(s) → ${dir}`)
		} catch (err) {
			console.log(`  ✗ the loop died mid-brief (${err instanceof Error ? err.message : String(err)}) — moving on`)
		} finally {
			await session.close().catch(() => {})
		}
	}

	const total = await writeGalleryIndex()
	console.log(`\n${total} shader(s) in the gallery.`)
	console.log(`open ${path.join(GALLERY_OUT, "index.html")} to rate them — they animate live.`)
}

main()
	.catch((err) => {
		console.error(err)
		process.exitCode = 1
	})
	.finally(async () => {
		// The one lesson every probe here has paid for once: a leaked backend is
		// an agent loop polling a provider forever.
		await disposeBackends().catch(() => {})
	})
