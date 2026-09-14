/**
 * The render-compare loop, run once, for real.
 *
 *   npx tsx scripts/probe-mark.ts "a compass rose for a navigation tool"
 *
 * Writes every round's render so the *convergence* can be looked at, which is
 * the only thing that tells you whether the loop is doing anything. A single
 * final image proves the plumbing works and says nothing about whether looking
 * at its own output made the model's second attempt better than its first.
 *
 * Runs under plain `tsx`, not inside Electron: the backend session is a CLI
 * child process and needs no window. Only the render step needs Chromium, so
 * each render spawns Electron with a tiny plain-JS main — the same split
 * `preview-generators.ts` uses, and for the same reason: bundling the design
 * core *into* Electron flattens its ESM to CJS and `import.meta.url` collapses
 * to undefined. That approach was tried and deleted; do not resurrect it.
 *
 * This costs real turns on the real backend, so it is a script, never a suite.
 */
import { spawn } from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { BackendSession, FoundationTokens } from "../src/core/design"
import { derivePalette, disposeBackends, foundationWords, getBackend, SLOP_TELLS } from "../src/core/design"
import { probeVision } from "../src/core/design/agent/vision"

const BRIEF = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "a compass rose for a navigation tool"
const ROUNDS = 3
const SIZE = 512
const OUT = path.resolve("release/verify-shots")

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

function extractSvg(reply: string): string | null {
	const match = /<svg[\s\S]*?<\/svg>/i.exec(reply)
	return match ? match[0] : null
}

/**
 * Renders one SVG in a fresh Electron and returns the PNG.
 *
 * The renderer main is plain JS written to a temp directory — Electron cannot
 * load TypeScript, and nothing here needs it to. JavaScript is disabled in the
 * page; the SVG goes in through an `<img>`, so nothing inside it can run.
 */
async function render(svg: string, surface: string): Promise<Buffer | null> {
	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "caret-mark-"))
	const svgPath = path.join(scratch, "mark.svg")
	const outPath = path.join(scratch, "mark.png")
	const mainPath = path.join(scratch, "main.js")

	await fs.writeFile(svgPath, svg, "utf-8")
	await fs.writeFile(
		mainPath,
		`const { app, BrowserWindow } = require("electron")
const fs = require("fs")
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
	const win = new BrowserWindow({ show: false, width: ${SIZE}, height: ${SIZE},
		webPreferences: { offscreen: true, javascript: false } })
	const svg = fs.readFileSync(${JSON.stringify(svgPath)}, "utf-8")
	const html = '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:${SIZE}px;height:${SIZE}px;' +
		'background:${surface};display:grid;place-items:center}img{width:70%;height:70%;object-fit:contain}</style>' +
		'<img src="data:image/svg+xml;base64,' + Buffer.from(svg, "utf-8").toString("base64") + '">'
	await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html))
	await new Promise((resolve) => setTimeout(resolve, 350))
	const image = await win.webContents.capturePage()
	const bitmap = image.getBitmap()
	// Blank means the SVG drew nothing. Report it as such rather than writing it.
	let blank = true
	for (let i = 4; i < bitmap.length; i += 4) {
		if (bitmap[i] !== bitmap[0] || bitmap[i + 1] !== bitmap[1] || bitmap[i + 2] !== bitmap[2]) { blank = false; break }
	}
	if (!blank) fs.writeFileSync(${JSON.stringify(outPath)}, image.toPNG())
	app.exit(blank ? 3 : 0)
})
`,
		"utf-8",
	)

	const electron = path.join(process.cwd(), "node_modules", ".bin", "electron")
	const code = await new Promise<number>((resolve) => {
		const child = spawn(electron, [mainPath], { stdio: "ignore" })
		child.on("exit", (value) => resolve(value ?? 1))
		child.on("error", () => resolve(1))
	})

	const png = code === 0 ? await fs.readFile(outPath).catch(() => null) : null
	await fs.rm(scratch, { recursive: true, force: true })
	return png
}

async function turn(session: BackendSession, input: { text: string; images?: string[] }): Promise<string> {
	let text = ""
	for await (const event of session.send(input)) {
		if (event.type === "text" || event.type === "done") text += event.text
		if (event.type === "error") console.error(`  ! ${event.message}`)
	}
	return text
}

async function main(): Promise<void> {
	const backend = await getBackend("opencode")
	if (!backend) throw new Error("no bundled backend")

	const availability = await backend.availability()
	console.log(`backend  ${backend.displayName} — ${availability.detail}`)
	if (!availability.ready) process.exit(1)

	const vision = await probeVision({ backend, workingDirectory: process.cwd() })
	console.log(`vision   ${vision.sees ? "this model can be shown an image" : `REFUSED — ${vision.reason}`}`)
	if (!vision.sees) process.exit(1)

	const palette = derivePalette(tokens)
	const session = await backend.startSession({
		workingDirectory: process.cwd(),
		mode: "read-only",
		title: "caret mark probe",
		systemPrompt:
			"You are drawing a single vector mark as SVG. Reply with the SVG element and nothing else. " +
			"Square viewBox no wider than 512. Paths and basic shapes only. No text elements. " +
			"Two colours at most. It must read at 24px. You will be shown a picture of what you drew.",
	})

	await fs.mkdir(OUT, { recursive: true })
	console.log(`brief    ${BRIEF}\n`)

	try {
		let reply = await turn(session, {
			text: [
				`Draw a mark for: ${BRIEF}`,
				"",
				`Palette — only these: ${palette.brand}, ${palette.ink}, ${palette.surface}.`,
				foundationWords(palette),
				"",
				`Avoid: ${SLOP_TELLS.join("; ")}.`,
				"",
				"Send the SVG only.",
			].join("\n"),
		})

		for (let round = 1; round <= ROUNDS; round++) {
			const svg = extractSvg(reply)
			if (!svg) {
				console.log(`round ${round}: no <svg> in the reply`)
				break
			}

			const png = await render(svg, palette.surface)
			if (!png) {
				console.log(`round ${round}: did not render`)
				break
			}

			const file = path.join(OUT, `mark-round-${round}.png`)
			await fs.writeFile(file, png)
			await fs.writeFile(path.join(OUT, `mark-round-${round}.svg`), svg)
			console.log(`round ${round}: ${svg.length} bytes of svg → ${file}`)

			if (round === ROUNDS) break

			reply = await turn(session, {
				text: [
					`This is a picture of the SVG you just sent, rendered at ${SIZE}px.`,
					"",
					"Look at the image and answer honestly: what is wrong with it?",
					"- Is anything clipped by the viewBox, or floating off-centre?",
					"- Would the thinnest stroke survive at 24px?",
					"- Are shapes that should align actually aligned?",
					"- Does it read as the thing it is meant to be?",
					`- Does it still serve the brief: ${BRIEF}`,
					"",
					"Then send a corrected SVG. Only the SVG.",
				].join("\n"),
				images: [`data:image/png;base64,${png.toString("base64")}`],
			})
		}
	} finally {
		await session.close().catch(() => {})
		// The one lesson every probe in this repo has already paid for once: a
		// leaked backend is an agent loop polling a provider forever.
		await disposeBackends().catch(() => {})
	}

	console.log("\ndone — compare mark-round-1..3.png")
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
