/**
 * A contact sheet of every recipe's variants, for looking at.
 *
 * Unit tests can prove a generator is deterministic, well-formed and clamped.
 * They cannot tell you it looks like a screensaver. This exists so the recipes
 * get reviewed the way they will be used — as pictures, side by side, against a
 * real foundation — and so a change to a generator can be compared against what
 * it replaced rather than argued about.
 *
 *   npx tsx scripts/preview-generators.ts [--dark] [--out <file.png>]
 *
 * Rendered in **Electron**, not Playwright's Chromium: Playwright cannot install
 * a browser on every platform this repo is developed on, and Electron is already
 * a dependency with a Chromium inside it. It is also the engine the canvas
 * actually uses, so what this sheet shows is what the app will show.
 */
import { spawn } from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { ASSET_RECIPES, composeVariants, derivePalette } from "../src/core/design/asset-library"
import type { FoundationTokens } from "../src/core/design/types"

const dark = process.argv.includes("--dark")
const outIndex = process.argv.indexOf("--out")
const out = path.resolve(outIndex > -1 ? process.argv[outIndex + 1] : `generator-preview${dark ? "-dark" : ""}.png`)

const tokens: FoundationTokens = {
	vibe: { description: "a tool for technical teams", tags: ["technical", "precise", "dense"] },
	color: {
		brand: { seed: "#2563eb", scale: {} },
		neutral: { character: dark ? "cool" : "warm", scale: {} },
		semantic: { success: "#16a34a", warning: "#ca8a04", error: "#dc2626", info: "#2563eb" },
		surface: dark ? "dark" : "light",
	},
	typography: { fontFamily: "Inter", fallback: "system-ui", scaleRatio: 1.25, baseSize: 16, scale: {} },
	spacing: { baseUnit: 4, scale: [0, 4, 8] },
	radius: { character: "soft", scale: [0, 4, 8] },
}

function buildHtml(): string {
	const palette = derivePalette(tokens)
	const rows = ASSET_RECIPES.map((recipe) => {
		const variants = composeVariants({ recipe, tokens, count: 4 })
		const cells = variants
			.map((variant) => {
				const encoded = Buffer.from(variant.svg ?? "", "utf-8").toString("base64")
				// Each cell takes the recipe's own ratio. A square recipe shown in a
				// 16:9 cell is cropped, and the first version of this sheet made the
				// blobs look clipped when the generator was fine — a review tool that
				// invents defects is worse than none.
				return (
					`<div class="cell" style="aspect-ratio:${variant.width} / ${variant.height}">` +
					`<img src="data:image/svg+xml;base64,${encoded}" alt=""/></div>`
				)
			})
			.join("")
		return `<section><h2>${recipe.name} <em>${recipe.use}</em></h2><div class="row">${cells}</div></section>`
	}).join("")

	// The page itself is the project's own surface, because a transparent
	// overlay previewed on white is not a preview of that overlay.
	return `<!doctype html><meta charset="utf-8"><style>
	body { margin: 0; padding: 28px; background: ${palette.surface}; color: ${palette.ink};
	       font: 13px ui-sans-serif, system-ui, sans-serif; }
	h2 { font-size: 13px; font-weight: 600; margin: 0 0 8px; }
	h2 em { font-weight: 400; font-style: normal; opacity: 0.55; margin-left: 8px; }
	section { margin-bottom: 26px; }
	.row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
	.row { align-items: start; }
	.cell { overflow: hidden; border-radius: 6px;
	        outline: 1px solid ${palette.ink}22; background: ${palette.raised}; }
	.cell img { width: 100%; height: 100%; object-fit: fill; display: block; }
	</style><body>${rows}</body>`
}

/** The Electron main process, written out so this stays a single file to run. */
function mainScript(htmlPath: string, target: string): string {
	return `const { app, BrowserWindow } = require("electron")
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
	const win = new BrowserWindow({ width: 1180, height: 900, show: false, webPreferences: { offscreen: false } })
	await win.loadFile(${JSON.stringify(htmlPath)})
	// Grow the window to the document so the capture is the whole sheet — there
	// is no fullPage screenshot here, only what the viewport holds.
	const height = await win.webContents.executeJavaScript("document.body.scrollHeight")
	win.setContentSize(1180, Math.min(4000, Math.ceil(height)))
	await new Promise((resolve) => setTimeout(resolve, 400))
	const image = await win.webContents.capturePage()
	require("fs").writeFileSync(${JSON.stringify(target)}, image.toPNG())
	app.exit(0)
})
`
}

async function main(): Promise<void> {
	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "caret-preview-"))
	const htmlPath = path.join(scratch, "sheet.html")
	const mainPath = path.join(scratch, "main.js")
	await fs.writeFile(htmlPath, buildHtml(), "utf-8")
	await fs.writeFile(mainPath, mainScript(htmlPath, out), "utf-8")

	const electron = path.join(process.cwd(), "node_modules", ".bin", "electron")
	await new Promise<void>((resolve, reject) => {
		const child = spawn(electron, [mainPath], { stdio: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "0" } })
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`electron exited ${code}`))))
		child.on("error", reject)
	})

	await fs.rm(scratch, { recursive: true, force: true })
	console.log(`wrote ${out}`)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
