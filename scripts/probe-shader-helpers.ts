/**
 * Does the sculpted-surface helper set actually compile and draw?
 *
 *   npx tsx scripts/probe-shader-helpers.ts
 *
 * A hand-authored body exercising caretRelief / caretReliefNormal / caretShade,
 * run through the same assemble-and-render path the authoring loop uses. This
 * exists so a broken helper is caught by a five-second script rather than by
 * fourteen model turns all failing to compile for a reason none of them wrote.
 */
import { spawn } from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { buildShaderRenderHtml } from "../src/core/design/asset-library/shader/authoring"
import {
	type ShaderUniform,
	validateFragmentBody,
	validateUniformManifest,
} from "../src/core/design/asset-library/shader/preamble"

const SIZE = { width: 960, height: 600 }
const OUT = path.resolve("release/verify-shots")

/** The reference sculptural body: lit folds, deep shadow, caught highlight. */
const BODY = `vec4 caretMain(vec2 uv) {
	float aspect = u_resolution.x / u_resolution.y;
	vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
	float t = u_time * u_speed;

	vec3 n = caretReliefNormal(p * u_scale, t, u_relief);
	vec2 s = caretShade(n, vec3(-0.7, 0.55, 0.28), 40.0);

	vec3 col = caretPalette(pow(s.x, 1.5), u_shadow, u_base, u_light);
	col += s.y * u_light * 0.7;
	col += u_grain * caretGrain(uv, u_time) * 0.1;
	return vec4(col, 1.0);
}`

const MANIFEST = [
	{ name: "u_speed", type: "float", label: "Speed", default: 0.35, min: 0, max: 2 },
	// The values a model actually reaches for, so the probe tests what the loop
	// will really produce rather than a hand-tuned best case.
	{ name: "u_scale", type: "float", label: "Form scale", default: 1.1, min: 0.5, max: 4 },
	{ name: "u_relief", type: "float", label: "Relief", default: 1.5, min: 0.1, max: 2.5 },
	{ name: "u_grain", type: "float", label: "Grain", default: 0.5, min: 0, max: 1 },
	{ name: "u_shadow", type: "color", label: "Shadow", default: "#05061a" },
	{ name: "u_base", type: "color", label: "Base", default: "#1d2bd6" },
]

async function main(): Promise<void> {
	const bodyCheck = validateFragmentBody(BODY)
	if (!bodyCheck.ok) throw new Error(`the reference body fails validation: ${bodyCheck.reason}`)

	// u_light is referenced by the body, so it must be declared like any other.
	const manifest = validateUniformManifest([
		...MANIFEST,
		{ name: "u_light", type: "color", label: "Light", default: "#a78bfa" },
	])
	if (!manifest.ok) throw new Error(`the reference manifest fails validation: ${manifest.reason}`)
	const uniforms: ShaderUniform[] = manifest.uniforms

	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "caret-helpers-"))
	const htmlPath = path.join(scratch, "shader.html")
	const mainPath = path.join(scratch, "main.js")
	const resultPath = path.join(scratch, "result.json")
	const framePath = path.join(scratch, "frame.png")

	await fs.writeFile(htmlPath, buildShaderRenderHtml(BODY, uniforms, SIZE), "utf-8")
	await fs.writeFile(
		mainPath,
		`const { app, BrowserWindow } = require("electron")
const fs = require("fs")
const finish = (r) => { fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(r)); app.exit(0) }
setTimeout(() => finish({ ok: false, error: "timed out" }), 20000)
app.whenReady().then(async () => {
	try {
		const win = new BrowserWindow({ show: false, width: ${SIZE.width}, height: ${SIZE.height},
			paintWhenInitiallyHidden: true,
			webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
		await win.loadFile(${JSON.stringify(htmlPath)})
		await win.webContents.executeJavaScript("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 200))))")
		const state = await win.webContents.executeJavaScript("window.__caretShader")
		if (!state || state.error) return finish({ ok: false, error: (state && state.error) || "never initialised" })
		await win.webContents.executeJavaScript("window.__caretDrawAt(2.0)")
		await new Promise((r) => setTimeout(r, 150))
		const image = await win.webContents.capturePage()
		fs.writeFileSync(${JSON.stringify(framePath)}, image.toPNG())
		// A lit surface must have a real value range; report it so "it compiled"
		// is never mistaken for "it drew something".
		const bitmap = image.getBitmap()
		let min = 255, max = 0
		for (let i = 0; i < bitmap.length; i += 4) {
			const v = (bitmap[i] + bitmap[i + 1] + bitmap[i + 2]) / 3
			if (v < min) min = v
			if (v > max) max = v
		}
		finish({ ok: true, min: Math.round(min), max: Math.round(max) })
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

	const raw = JSON.parse(await fs.readFile(resultPath, "utf-8").catch(() => '{"ok":false,"error":"no result"}'))
	if (!raw.ok) {
		await fs.rm(scratch, { recursive: true, force: true })
		throw new Error(`the sculpted-surface helpers did not render: ${raw.error}`)
	}

	await fs.mkdir(OUT, { recursive: true })
	const target = path.join(OUT, "shader-helpers-reference.png")
	await fs.copyFile(framePath, target)
	await fs.rm(scratch, { recursive: true, force: true })
	console.log(`helpers compile and draw — luminance ${raw.min}..${raw.max} (a lit surface wants a wide spread)`)
	console.log(`reference frame: ${target}`)
}

main().catch((err) => {
	console.error(err.message ?? err)
	process.exit(1)
})
