/**
 * The screenshot settle must wait for what pages actually contain.
 *
 * The field failure: the agent screenshots a page with a 3D model, the
 * capture races the `.glb` (or fires before React has even mounted — the old
 * settle sampled `document.images` pre-mount, saw an empty set, and exited on
 * iteration one), and the agent concludes "the model doesn't render" about a
 * page that renders fine. This boots the real shell with a page carrying an
 * <img>, a <canvas> and a <model-viewer> with a real (tiny, generated) .glb,
 * runs the REAL `settleScript` in a browser document, and asserts everything
 * it promises to wait for actually loaded — plus that a genuinely broken
 * image is reported rather than hidden. No model anywhere; costs nothing.
 *
 *   npx tsx scripts/probe-screenshot-settle.ts
 */
import * as child_process from "child_process"
import * as fsSync from "fs"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { settleScript } from "../desktop/main/page-settle"
import { RenderingShell } from "../src/core/design/rendering-shell"
import { ensureCaretDirectoryExists } from "../src/core/design/scaffold"
import { solidPng } from "./verify-support"

/** A minimal valid glTF 2.0 binary: one untextured triangle. */
function tinyGlb(): Buffer {
	const json = JSON.stringify({
		asset: { version: "2.0" },
		buffers: [{ byteLength: 36 }],
		bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 }],
		accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }],
		meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
		nodes: [{ mesh: 0 }],
		scenes: [{ nodes: [0] }],
		scene: 0,
	})
	const jsonPadded = Buffer.from(json + " ".repeat((4 - (Buffer.byteLength(json) % 4)) % 4))
	const bin = Buffer.alloc(36)
	const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0]
	positions.forEach((v, i) => bin.writeFloatLE(v, i * 4))

	const chunk = (type: number, body: Buffer) => {
		const header = Buffer.alloc(8)
		header.writeUInt32LE(body.length, 0)
		header.writeUInt32LE(type, 4)
		return Buffer.concat([header, body])
	}
	const jsonChunk = chunk(0x4e4f534a, jsonPadded)
	const binChunk = chunk(0x004e4942, bin)
	const glbHeader = Buffer.alloc(12)
	glbHeader.writeUInt32LE(0x46546c67, 0)
	glbHeader.writeUInt32LE(2, 4)
	glbHeader.writeUInt32LE(12 + jsonChunk.length + binChunk.length, 8)
	return Buffer.concat([glbHeader, jsonChunk, binChunk])
}

const PAGE = `import "@google/model-viewer"
export default function Page() {
	return (
		<main className="p-8">
			<img src="/caret-assets/dot.png" alt="dot" width={240} height={135} />
			<canvas width={200} height={100} />
			{/* @ts-ignore */}
			<model-viewer src="/caret-assets/tri.glb" style={{ width: "400px", height: "300px" }} />
		</main>
	)
}
`

const BROKEN_IMG_PAGE = `export default function Page() {
	return <main className="p-8"><img src="/caret-assets/nope.png" alt="missing" /></main>
}
`

async function launchBrowser() {
	const { chromium } = await import("playwright")
	try {
		return await chromium.launch({ headless: true })
	} catch {
		const cacheRoot = path.join(os.homedir(), "Library", "Caches", "ms-playwright")
		const candidates: string[] = []
		for (const dir of fsSync.existsSync(cacheRoot) ? fsSync.readdirSync(cacheRoot) : []) {
			if (dir.startsWith("chromium_headless_shell-")) {
				candidates.push(path.join(cacheRoot, dir, "chrome-mac", "headless_shell"))
				candidates.push(path.join(cacheRoot, dir, "chrome-headless-shell-mac-x64", "chrome-headless-shell"))
			}
			if (dir.startsWith("chromium-")) {
				candidates.push(path.join(cacheRoot, dir, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"))
			}
		}
		for (const executablePath of candidates.reverse()) {
			if (fsSync.existsSync(executablePath)) {
				console.log(`using fallback browser: ${executablePath}`)
				return await chromium.launch({ headless: true, executablePath })
			}
		}
		throw new Error("No Chromium available. Run: npx playwright install chromium")
	}
}

async function page(dir: string, id: string, source: string): Promise<void> {
	const pageDir = path.join(dir, ".caret", "pages", id)
	await fs.mkdir(pageDir, { recursive: true })
	await fs.writeFile(path.join(pageDir, "index.tsx"), source)
	await fs.writeFile(
		path.join(pageDir, "meta.json"),
		JSON.stringify({ id, title: id, type: "page", states: ["default"], tags: [] }),
	)
}

async function main(): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "caret-shotsettle-"))
	child_process.execSync("git init -q", { cwd: dir })
	await ensureCaretDirectoryExists(dir)
	const assets = path.join(dir, ".caret", "assets")
	await fs.mkdir(assets, { recursive: true })
	await fs.writeFile(path.join(assets, "dot.png"), solidPng(240, 135, [20, 24, 33]))
	await fs.writeFile(path.join(assets, "tri.glb"), tinyGlb())
	await page(dir, "visuals", PAGE)
	await page(dir, "brokenimg", BROKEN_IMG_PAGE)

	const shell = new RenderingShell(dir)
	const browser = await launchBrowser()
	const failures: string[] = []
	try {
		await shell.start()
		const url = shell.getUrl()
		if (!url) throw new Error("the shell reported no url")
		console.log(`shell at ${url}`)
		// The viewer the page imports, in the shape the guide prescribes.
		child_process.execSync("npm install --prefix .caret @google/model-viewer --ignore-scripts --no-audit --no-fund", {
			cwd: dir,
			stdio: "ignore",
			timeout: 300_000,
		})

		const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } })

		// --- The 3D page: settle must outlast the .glb, not race it. ----------
		await tab.goto(`${url}?page=visuals&isolated=1`)
		const report = (await tab.evaluate(settleScript(30_000))) as {
			broken: string[]
			pending: string[]
			pendingModels: string[]
		}
		console.log(`settle report: ${JSON.stringify(report)}`)
		if (report.pendingModels.length > 0) failures.push("settle gave up on a 3D model that loads fine")
		if (report.pending.length > 0 || report.broken.length > 0) failures.push("settle misreported a healthy image")

		const modelLoaded = await tab.evaluate("document.querySelector('model-viewer')?.loaded === true")
		console.log(`model-viewer.loaded after settle: ${modelLoaded}`)
		if (!modelLoaded) failures.push("settle returned before the model actually loaded")

		const mounted = await tab.evaluate("document.getElementById('root').children.length > 0")
		if (!mounted) failures.push("settle returned before React mounted — the vacuous-break bug")

		// --- A genuinely broken image must be REPORTED, not waited out. -------
		await tab.goto(`${url}?page=brokenimg&isolated=1`)
		const started = Date.now()
		const brokenReport = (await tab.evaluate(settleScript(30_000))) as { broken: string[] }
		const took = Date.now() - started
		console.log(`broken-image report after ${took}ms: ${JSON.stringify(brokenReport)}`)
		if (brokenReport.broken.length !== 1) failures.push("a 404 image was not reported as broken")
		if (took > 10_000) failures.push("a 404 image burned the deadline instead of resolving through onerror")

		if (failures.length === 0) {
			console.log("\n→ the settle waits for what the page actually contains. PASS")
			process.exitCode = 0
		} else {
			console.log(`\n→ STILL BROKEN:\n${failures.map((f) => `  - ${f}`).join("\n")}`)
			process.exitCode = 1
		}
	} finally {
		await browser.close().catch(() => {})
		await shell.stop()
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
