/**
 * Can a hidden Electron window render WebGL2 and hand back real pixels?
 *
 *   npx tsx scripts/probe-shader.ts
 *
 * The shader authoring loop's existential question, asked before any of the
 * loop is built: authored-marks renders in a hidden window with JavaScript
 * off, but a shader IS a program — the window must run JS, drive WebGL2, and
 * `capturePage` must see the result even though nothing is on screen. Hidden
 * windows are exactly where Chromium likes to throttle painting and park the
 * GPU, so this probes three configurations and reports which ones produce
 * (a) non-blank pixels and (b) pixels that CHANGE between two captures — a
 * static screenshot of an animated shader is only half an answer, because the
 * critique loop wants frames at different timestamps.
 *
 * Same split as probe-mark: plain `tsx` orchestrates, each render spawns a
 * fresh Electron with a tiny plain-JS main. No backend, no model, no cost.
 */
import { spawn } from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

const SIZE = 480
const OUT = path.resolve("release/verify-shots")

/** A minimal animated WebGL2 gradient — the shape every authored shader will have. */
const PROBE_PAGE = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;width:${SIZE}px;height:${SIZE}px;overflow:hidden}canvas{width:100%;height:100%;display:block}</style>
<canvas id="c" width="${SIZE}" height="${SIZE}"></canvas>
<script>
const gl = document.getElementById("c").getContext("webgl2", { preserveDrawingBuffer: true })
window.__PROBE = { ok: false, error: null, frames: 0 }
if (!gl) {
	window.__PROBE.error = "webgl2 context unavailable"
} else {
	const vs = "#version 300 es\\nvoid main(){vec2 p=vec2[](vec2(-1.,-1.),vec2(3.,-1.),vec2(-1.,3.))[gl_VertexID];gl_Position=vec4(p,0.,1.);}"
	const fs = "#version 300 es\\nprecision highp float;uniform float u_time;uniform vec2 u_resolution;out vec4 o;" +
		"void main(){vec2 uv=gl_FragCoord.xy/u_resolution;o=vec4(0.5+0.5*sin(u_time+uv.x*4.0),0.5+0.5*sin(u_time*1.3+uv.y*5.0),0.7,1.0);}"
	const compile = (type, src) => {
		const s = gl.createShader(type)
		gl.shaderSource(s, src)
		gl.compileShader(s)
		if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "compile failed")
		return s
	}
	try {
		const program = gl.createProgram()
		gl.attachShader(program, compile(gl.VERTEX_SHADER, vs))
		gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs))
		gl.linkProgram(program)
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "link failed")
		gl.useProgram(program)
		const uTime = gl.getUniformLocation(program, "u_time")
		gl.uniform2f(gl.getUniformLocation(program, "u_resolution"), ${SIZE}, ${SIZE})
		const started = performance.now()
		const draw = () => {
			gl.uniform1f(uTime, (performance.now() - started) / 1000)
			gl.viewport(0, 0, ${SIZE}, ${SIZE})
			gl.drawArrays(gl.TRIANGLES, 0, 3)
			window.__PROBE.frames += 1
			window.__PROBE.ok = true
			requestAnimationFrame(draw)
		}
		draw()
	} catch (err) {
		window.__PROBE.error = String(err && err.message || err)
	}
}
</script>`

interface ProbeConfig {
	name: string
	/** Lines placed before app.whenReady in the generated main. */
	appSetup: string
	/** Extra webPreferences. */
	webPreferences: string
}

const CONFIGS: ProbeConfig[] = [
	{
		name: "hidden-window",
		appSetup: "",
		webPreferences: "",
	},
	{
		name: "offscreen",
		appSetup: "",
		webPreferences: "offscreen: true,",
	},
	{
		name: "no-hw-accel",
		appSetup: "app.disableHardwareAcceleration()",
		webPreferences: "",
	},
]

interface ProbeResult {
	name: string
	ok: boolean
	detail: string
}

async function probe(config: ProbeConfig): Promise<ProbeResult> {
	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "caret-shader-probe-"))
	const mainPath = path.join(scratch, "main.js")
	const resultPath = path.join(scratch, "result.json")
	const frameA = path.join(scratch, "a.png")
	const frameB = path.join(scratch, "b.png")

	await fs.writeFile(
		mainPath,
		`const { app, BrowserWindow } = require("electron")
const fs = require("fs")
${config.appSetup}
const finish = (result) => {
	fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result))
	app.exit(0)
}
setTimeout(() => finish({ ok: false, detail: "timed out after 20s" }), 20000)
app.whenReady().then(async () => {
	try {
		const win = new BrowserWindow({
			show: false,
			width: ${SIZE},
			height: ${SIZE},
			paintWhenInitiallyHidden: true,
			webPreferences: {
				${config.webPreferences}
				contextIsolation: true,
				nodeIntegration: false,
				backgroundThrottling: false,
			},
		})
		await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(${JSON.stringify(PROBE_PAGE)}))

		// Two rAFs then a beat, the settle the real loop would use.
		await win.webContents.executeJavaScript(
			"new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 300))))"
		)
		const state = await win.webContents.executeJavaScript("window.__PROBE")
		if (!state || !state.ok) return finish({ ok: false, detail: (state && state.error) || "the probe script never drew" })

		const a = await win.webContents.capturePage()
		await new Promise((r) => setTimeout(r, 400))
		const b = await win.webContents.capturePage()
		const frames = await win.webContents.executeJavaScript("window.__PROBE.frames")

		const bitmapA = a.getBitmap()
		const bitmapB = b.getBitmap()
		let blank = true
		for (let i = 4; i < bitmapA.length; i += 4) {
			if (bitmapA[i] !== bitmapA[0] || bitmapA[i + 1] !== bitmapA[1] || bitmapA[i + 2] !== bitmapA[2]) { blank = false; break }
		}
		let moved = false
		for (let i = 0; i < bitmapA.length && !moved; i += 4) {
			if (Math.abs(bitmapA[i] - bitmapB[i]) > 3) moved = true
		}
		fs.writeFileSync(${JSON.stringify(frameA)}, a.toPNG())
		fs.writeFileSync(${JSON.stringify(frameB)}, b.toPNG())
		finish({
			ok: !blank && moved,
			detail: blank ? "captured pixels are blank" : moved ? "pixels present and animating (" + frames + " frames drawn)" : "pixels present but frozen between captures",
		})
	} catch (err) {
		finish({ ok: false, detail: String(err && err.message || err) })
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

	let result: ProbeResult
	try {
		const raw = JSON.parse(await fs.readFile(resultPath, "utf-8"))
		result = { name: config.name, ok: raw.ok === true, detail: String(raw.detail ?? "") }
	} catch {
		result = { name: config.name, ok: false, detail: "electron exited without writing a result" }
	}

	if (result.ok) {
		await fs.mkdir(OUT, { recursive: true })
		await fs.copyFile(frameA, path.join(OUT, `shader-probe-${config.name}-a.png`)).catch(() => {})
		await fs.copyFile(frameB, path.join(OUT, `shader-probe-${config.name}-b.png`)).catch(() => {})
	}
	await fs.rm(scratch, { recursive: true, force: true })
	return result
}

async function main(): Promise<void> {
	console.log(`probing WebGL2 in hidden Electron windows (${SIZE}px, three configurations)\n`)
	const results: ProbeResult[] = []
	for (const config of CONFIGS) {
		process.stdout.write(`${config.name.padEnd(16)} … `)
		const result = await probe(config)
		results.push(result)
		console.log(`${result.ok ? "OK " : "NO "} ${result.detail}`)
	}

	const usable = results.filter((r) => r.ok)
	console.log(
		usable.length > 0
			? `\n${usable.length}/${results.length} configurations usable — frames written to ${OUT}. Prefer "${usable[0].name}".`
			: `\nno configuration produced animated pixels — the authoring loop must fall back to compile-checking only on this machine`,
	)
	process.exit(usable.length > 0 ? 0 : 2)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
