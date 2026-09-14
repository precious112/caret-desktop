/**
 * Shared render path for the shader probes: assemble a body with the CURRENT
 * scaffold, compile it in a hidden Electron window, capture deterministic
 * frames, and write the gallery index.
 *
 * Shared rather than copied because the scaffold is the thing under
 * development: the authoring loop and the re-render probe must agree about how
 * a shader is built, or "the gallery improved" stops meaning anything.
 */
import { spawn } from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { buildShaderRenderHtml, type ExtractedShader } from "../src/core/design/asset-library/shader/authoring"

export const FRAME_SIZE = { width: 640, height: 400 }
export const POSTER_SIZE = { width: 1600, height: 1000 }
export const GALLERY_OUT = path.resolve("release/shader-gallery")

export interface RenderOutcome {
	ok: boolean
	/** The GLSL compiler's own words, when !ok. */
	error?: string
	/** One PNG per requested timestamp, in order, when ok. */
	frames: Buffer[]
	/** Luminance spread of the first frame — a flat wash betrays itself here. */
	range?: { min: number; max: number }
}

/**
 * Compiles and renders one shader in a fresh hidden-window Electron.
 *
 * `probe-shader.ts` certified this exact window configuration; `offscreen:
 * true` is deliberately absent, because it captured frozen pixels.
 */
export async function renderShader(
	shader: ExtractedShader,
	size: { width: number; height: number },
	timestamps: number[],
): Promise<RenderOutcome> {
	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "caret-shader-"))
	const htmlPath = path.join(scratch, "shader.html")
	const mainPath = path.join(scratch, "main.js")
	const resultPath = path.join(scratch, "result.json")

	await fs.writeFile(htmlPath, buildShaderRenderHtml(shader.body, shader.uniforms, size), "utf-8")
	await fs.writeFile(
		mainPath,
		`const { app, BrowserWindow } = require("electron")
const fs = require("fs")
const finish = (r) => { fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(r)); app.exit(0) }
setTimeout(() => finish({ ok: false, error: "render timed out after 20s" }), 20000)
app.whenReady().then(async () => {
	try {
		const win = new BrowserWindow({
			show: false,
			width: ${size.width},
			height: ${size.height},
			paintWhenInitiallyHidden: true,
			webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
		})
		await win.loadFile(${JSON.stringify(htmlPath)})
		await win.webContents.executeJavaScript(
			"new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 200))))"
		)
		const state = await win.webContents.executeJavaScript("window.__caretShader")
		if (!state || state.error) return finish({ ok: false, error: (state && state.error) || "the shader page never initialised" })

		const frames = []
		let range = null
		for (const t of ${JSON.stringify(timestamps)}) {
			await win.webContents.executeJavaScript("window.__caretDrawAt(" + t + ")")
			await new Promise((r) => setTimeout(r, 120))
			const image = await win.webContents.capturePage()
			frames.push(image.toPNG().toString("base64"))
			if (!range) {
				const bitmap = image.getBitmap()
				let min = 255, max = 0
				for (let i = 0; i < bitmap.length; i += 4) {
					const v = (bitmap[i] + bitmap[i + 1] + bitmap[i + 2]) / 3
					if (v < min) min = v
					if (v > max) max = v
				}
				range = { min: Math.round(min), max: Math.round(max) }
			}
		}
		finish({ ok: true, frames, range })
	} catch (err) {
		finish({ ok: false, error: String((err && err.message) || err) })
	}
})
`,
		"utf-8",
	)

	const electron = path.join(process.cwd(), "node_modules", ".bin", "electron")
	await new Promise<void>((resolve) => {
		const child = spawn(electron, [mainPath], { stdio: "ignore" })
		child.on("exit", () => resolve())
		child.on("error", () => resolve())
	})

	try {
		const raw = JSON.parse(await fs.readFile(resultPath, "utf-8"))
		return {
			ok: raw.ok === true,
			error: raw.error ? String(raw.error) : undefined,
			frames: Array.isArray(raw.frames) ? raw.frames.map((f: string) => Buffer.from(f, "base64")) : [],
			range: raw.range ?? undefined,
		}
	} catch {
		return { ok: false, error: "electron exited without writing a result", frames: [] }
	} finally {
		await fs.rm(scratch, { recursive: true, force: true })
	}
}

/** The same page the renderer compiled, plus a clock. It animates. */
export function liveHtml(shader: ExtractedShader): string {
	return (
		buildShaderRenderHtml(shader.body, shader.uniforms, FRAME_SIZE) +
		`\n<script>
const start = () => {
	if (!window.__caretShader.ready) { setTimeout(start, 50); return }
	const t0 = performance.now()
	const loop = () => { window.__caretDrawAt((performance.now() - t0) / 1000); requestAnimationFrame(loop) }
	loop()
}
start()
</script>`
	)
}

export function slugOf(brief: string): string {
	return brief
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 48)
}

/**
 * Rebuilds index.html from what is ON DISK, so earlier runs and re-renders all
 * show up, and the luminance spread of each is stated — the number that tells a
 * flat wash from a lit surface without squinting.
 */
export async function writeGalleryIndex(): Promise<number> {
	const entries: Array<{ slug: string; brief: string; rounds: number; range?: { min: number; max: number } }> = []
	for (const dirent of await fs.readdir(GALLERY_OUT, { withFileTypes: true })) {
		if (!dirent.isDirectory()) continue
		try {
			const meta = JSON.parse(await fs.readFile(path.join(GALLERY_OUT, dirent.name, "shader.json"), "utf-8"))
			entries.push({
				slug: dirent.name,
				brief: String(meta.brief),
				rounds: Number(meta.rounds) || 0,
				range: meta.range,
			})
		} catch {}
	}
	entries.sort((a, b) => a.brief.localeCompare(b.brief))

	const index = `<!doctype html><meta charset="utf-8"><title>Caret shader gallery</title>
<style>
body{font:14px/1.5 system-ui;margin:32px;background:#fafafa;color:#18181b}
h1{font-size:18px;font-weight:600} p.note{color:#52525b;max-width:70ch}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(460px,1fr));gap:24px;margin-top:24px}
figure{margin:0;background:#fff;border:1px solid #e4e4e7;border-radius:10px;overflow:hidden}
iframe{width:100%;height:290px;border:0;display:block;background:#000}
figcaption{padding:10px 14px;color:#52525b}
figcaption b{color:#18181b;font-weight:600}
code{font:12px ui-monospace,monospace;color:#71717a}
</style>
<h1>Caret shader gallery — ${entries.length} shaders, written by the model against Caret's scaffold</h1>
<p class="note">Every panel below is live WebGL, animating. The brief is what a user would type; the GLSL was written by the model, the helpers and runner by Caret. "Range" is the luminance spread of the first frame — a wide spread means real light and shadow, a narrow one is the flat-wash failure.</p>
<div class="grid">
${entries
	.map(
		(e) =>
			`<figure><iframe src="${e.slug}/live.html" loading="lazy"></iframe><figcaption><b>${e.brief}</b><br>${e.rounds} round(s)${e.range ? ` · range <code>${e.range.min}..${e.range.max}</code>` : ""} · <a href="${e.slug}/poster.png">poster</a></figcaption></figure>`,
	)
	.join("\n")}
</div>`
	await fs.writeFile(path.join(GALLERY_OUT, "index.html"), index, "utf-8")
	return entries.length
}
