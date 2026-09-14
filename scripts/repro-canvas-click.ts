/**
 * Why a page card on the canvas can be unclickable.
 *
 * `CanvasView` only wires a click handler when the page has a route:
 *
 *     const hasRoute = routes.some(r => r.name === page.id)
 *     <PageThumbnail … onClick={hasRoute ? () => onFocus(page.id) : undefined} />
 *
 * and the two sides of that comparison come from different places. The router's
 * `routes[].name` is the page **directory name**; `pageMetas[].id` is the `id`
 * field inside that page's **meta.json**, falling back to the directory. So a
 * page whose meta.json declares an id that differs from its folder renders
 * perfectly, thumbnails correctly, and silently cannot be opened.
 *
 * This builds one page of each kind and reports, per card, whether it is
 * clickable and whether clicking actually reaches the focused editor.
 *
 * Costs nothing: no model, no backend.
 *
 *   npx tsx scripts/repro-canvas-click.ts
 */
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { _electron as electron } from "playwright"

import { ensureCaretDirectoryExists, RenderingShell } from "../src/core/design"

const page = (title: string) => `export default function Page() {
	return (
		<main data-caret-id="root" style={{ padding: 48, fontFamily: "system-ui" }}>
			<h1 data-caret-id="title">${title}</h1>
			<p data-caret-id="body">Body copy for ${title}.</p>
		</main>
	)
}
`

async function writePage(root: string, dir: string, metaId: string, title: string): Promise<void> {
	const pageDir = path.join(root, ".caret", "pages", dir)
	await fs.mkdir(pageDir, { recursive: true })
	await fs.writeFile(path.join(pageDir, "index.tsx"), page(title))
	await fs.writeFile(
		path.join(pageDir, "meta.json"),
		JSON.stringify({ id: metaId, title, type: "page", states: ["default"], tags: [] }, null, 2),
	)
}

async function main(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "caret-canvasclick-"))
	await ensureCaretDirectoryExists(root)

	// Identical in every way except whether meta.json's id matches the folder.
	await writePage(root, "home", "home", "Matching Id")
	await writePage(root, "about", "about-us", "Mismatched Id")

	console.log(`fixture ${root}\nbooting the shell (first run installs deps, ~60s)…`)
	const shell = new RenderingShell(root)
	const port = await shell.start()
	const url = `http://127.0.0.1:${port}/`
	console.log(`shell at ${url}`)

	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "caret-canvasclick-shell-"))
	const mainScript = path.join(dir, "main.js")
	await fs.writeFile(
		mainScript,
		`const { app, BrowserWindow } = require("electron")
app.whenReady().then(() => { new BrowserWindow({ width: 1400, height: 900 }).loadURL("${url}") })`,
	)

	const browser = await electron.launch({ args: [mainScript], env: { ...process.env, CARET_DISABLE_TELEMETRY: "1" } })
	try {
		const view = await browser.firstWindow({ timeout: 60_000 })
		await view.waitForSelector(".caret-canvas-frame", { timeout: 60_000 })
		await view.waitForTimeout(3000)

		const cards = await view.evaluate(() =>
			Array.from(document.querySelectorAll(".caret-canvas-frame")).map((element) => ({
				title: element.querySelector(".caret-canvas-frame-title")?.textContent ?? "?",
				cursor: getComputedStyle(element as HTMLElement).cursor,
			})),
		)
		console.log("\ncards on the canvas:")
		for (const card of cards) console.log(`  ${card.title.padEnd(16)} cursor=${card.cursor}`)

		// Clicking is the real proof: cursor is only the tell.
		for (const card of cards) {
			await view.click(`.caret-canvas-frame:has-text("${card.title}")`).catch(() => {})
			const focused = await view
				.waitForSelector(".caret-focused-iframe", { timeout: 5000 })
				.then(() => true)
				.catch(() => false)
			console.log(`  clicking "${card.title}" → focused editor ${focused ? "OPENED" : "DID NOT OPEN"}`)
			if (focused) {
				await view.click(".caret-focused-toolbar-btn").catch(() => {})
				await view.waitForTimeout(800)
			}
		}
	} finally {
		await browser.close()
		shell.stop()
		await fs.rm(root, { recursive: true, force: true }).catch(() => {})
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
	}
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})
