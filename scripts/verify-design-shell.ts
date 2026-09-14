/**
 * Design-shell reliability certification harness.
 *
 * Generates a fixture .caret project from the CURRENT templates, boots the
 * real Vite dev server, drives the canvas in a headless browser, and runs a
 * scenario suite covering both happy paths and adversarial AI-output cases
 * (corrupt flow files, missing page files, corrupt layout, racing writes).
 * Prints a PASS/FAIL certification matrix and exits non-zero on any failure.
 *
 * Usage:
 *   npm run verify:design-shell                # full run (first run installs deps, ~60s)
 *   npm run verify:design-shell -- --keep      # keep the fixture dir for inspection
 *   npm run verify:design-shell -- --node-modules /path/to/.caret/node_modules
 */
import * as child_process from "child_process"
import * as crypto from "crypto"
import * as fsSync from "fs"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { DESIGN_CHECKS_DOM_SCRIPT } from "../src/core/design/design-checks"
import { mutateFlowDefinition } from "../src/core/design/flow-meta"
import { resolveParamsFor } from "../src/core/design/param/edit"
import { PANEL_PROPERTIES } from "../src/core/design/param/params"
import { generateEntryFiles, writeThemeCss } from "../src/core/design/rendering-shell/entry-template"
import { generateViteConfig } from "../src/core/design/rendering-shell/vite-config-template"
import { ensureCaretDirectoryExists } from "../src/core/design/scaffold"
import { solidPng } from "./verify-support"

/** A real decodable PNG — the picker's thumbnail has to actually paint. */
const FIXTURE_PNG = solidPng(240, 135, [20, 24, 33])

// Mirrors REQUIRED_DEPS in rendering-shell/index.ts (which we can't import here
// without dragging in the whole extension graph).
const EXTRA_DEPS: Record<string, string> = {
	"react-grab": "^0.1.37",
	tailwindcss: "^4.1.0",
	"@tailwindcss/vite": "^4.1.0",
	"modern-screenshot": "^4.6.0",
}

const args = process.argv.slice(2)
const KEEP = args.includes("--keep")
const nmFlagIdx = args.indexOf("--node-modules")
const NODE_MODULES_OVERRIDE = nmFlagIdx !== -1 ? args[nmFlagIdx + 1] : null

interface ScenarioResult {
	name: string
	passed: boolean
	detail: string
}

const results: ScenarioResult[] = []
let viteProc: child_process.ChildProcess | null = null
let viteOutput = ""

function log(msg: string) {
	console.log(`[verify] ${msg}`)
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const PAGE_TEMPLATE = (id: string, title: string) => `export default function ${title.replace(/\s/g, "")}() {
  return (
    <div className="min-h-screen bg-white p-8">
      <h1 className="text-3xl font-bold text-zinc-900">${title}</h1>
      <p className="text-zinc-600">Fixture page ${id}.</p>
      <button className="bg-blue-600 text-white px-4 py-2 rounded-lg">Go</button>
      <div style={{ height: 1600 }} />
      <div data-testid="below-fold" style={{ background: "rgb(255,0,255)", width: 320, height: 160 }}>below fold</div>
    </div>
  )
}
`

const FIXTURE_PAGES = [
	{ id: "home", title: "Home" },
	{ id: "about", title: "About" },
	{ id: "contact", title: "Contact" },
	{ id: "dashboard", title: "Dashboard" },
]
// FIXTURE_PAGES plus the pages seeded separately: "listing", "fragmented",
// "renamed" (the folder/meta id mismatch of scenario `p`), "catalog"
// (the .map() list of scenario `x`), and "layouts" (scenario `z`'s six
// resize-resolver cases). This arithmetic
// breaking silently is exactly what happened when `renamed` was added — three
// scenarios failed with "expected 6 frames, got 7" — so if you seed another
// page below, this line is the other half of that change.
const EXTRA_SEEDED_PAGES = 5
const TOTAL_PAGES = FIXTURE_PAGES.length + EXTRA_SEEDED_PAGES

// JSX fragments used to break the source-capture plugin (its old regex only
// matched jsxDEV-only imports). Scenario (o) asserts exact line resolution
// for an element inside a fragment. The h1 below sits on line 5 — keep in
// sync with FRAGMENT_H1_LINE.
const FRAGMENT_PAGE = `export default function Fragmented() {
  return (
    <>
      <div className="min-h-screen bg-white p-8">
        <h1 data-testid="frag-title" data-caret-id="frag-h1" className="text-3xl font-bold text-zinc-900">Fragment Title</h1>
        <p data-caret-id="frag-copy" className="text-zinc-600">Inside a fragment.</p>
      </div>
    </>
  )
}
`
const FRAGMENT_H1_LINE = 5

// Canonical responsive dual-view pattern: mobile cards (md:hidden) + desktop
// table (hidden md:block). Historically broken by react-grab's unlayered
// utility CSS beating the page's layered md:block — scenario (n) locks it.
const RESPONSIVE_PAGE = `export default function Listing() {
  return (
    <div className="min-h-screen bg-white p-8">
      <h1 className="text-2xl font-bold text-zinc-900">Listing</h1>
      <div data-testid="mobile-cards" className="md:hidden space-y-2">
        <div className="p-3 rounded-lg border border-zinc-200">Card A</div>
        <div className="p-3 rounded-lg border border-zinc-200">Card B</div>
      </div>
      <div data-testid="desktop-table" className="hidden md:block">
        <table className="w-full text-left">
          <thead><tr><th className="px-4 py-2">Name</th></tr></thead>
          <tbody><tr><td className="px-4 py-2">Row A</td></tr></tbody>
        </table>
      </div>
    </div>
  )
}
`

const CATALOG_PAGE = `const products = [
  { id: "a", name: "Monolith Trainer", price: 120 },
  { id: "b", name: "Aurora Slip-on", price: 95 },
]

export default function Catalog() {
  return (
    <ul className="min-h-screen bg-white p-8 space-y-2">
      {products.map((product) => (
        <li key={product.id} className="p-3 rounded-lg border border-zinc-200">
          <p data-caret-id="cat-name" className="font-bold">{product.name}</p>
        </li>
      ))}
    </ul>
  )
}
`

// The six layout contexts the size resolver must classify — real DOM, real
// computed styles, the medium the resolver actually runs in.
const LAYOUTS_PAGE = `export default function Layouts() {
  return (
    <div className="min-h-screen bg-white p-8">
      <div data-testid="lay-declared" data-caret-id="lay-declared" className="w-64 bg-zinc-100">declared</div>
      <div className="max-w-[520px]">
        <div>
          <div>
            <div data-testid="lay-chain" className="bg-zinc-100">chained auto</div>
          </div>
        </div>
      </div>
      <div className="flex flex-row gap-3 w-[520px]">
        <div data-testid="lay-flex" data-caret-id="lay-flex" className="flex-1 bg-zinc-100">flex child</div>
        <div className="flex-1">sibling</div>
      </div>
      <div className="grid grid-cols-3 gap-3 w-[520px]">
        <div data-testid="lay-grid" data-caret-id="lay-grid" className="bg-zinc-100">grid item</div>
        <div>b</div>
        <div>c</div>
      </div>
      <div className="relative h-24">
        <div data-testid="lay-abs" className="absolute inset-x-4 top-2 bg-zinc-100">absolute</div>
      </div>
      <div data-testid="lay-fit" className="w-fit bg-zinc-100">hugging width</div>
    </div>
  )
}
`

// One global flow root (home) so the simulate scenario is deterministic.
const FIXTURE_FLOWS: Record<string, object> = {
	"main.flow.json": {
		id: "main",
		name: "Main Flow",
		steps: [
			{ page: "home", next: ["about", "dashboard"] },
			{ page: "about", next: ["contact"] },
		],
	},
	"billing.flow.json": {
		id: "billing",
		name: "Billing",
		steps: [{ page: "dashboard", next: ["about"] }],
	},
}

async function buildFixture(): Promise<{ workspace: string; caretDir: string }> {
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "caret-verify-"))
	const caretDir = await ensureCaretDirectoryExists(workspace)

	const pkgPath = path.join(caretDir, "package.json")
	const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"))
	pkg.dependencies = { ...pkg.dependencies, ...EXTRA_DEPS }
	await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2))

	for (const page of FIXTURE_PAGES) {
		const dir = path.join(caretDir, "pages", page.id)
		await fs.mkdir(dir, { recursive: true })
		await fs.writeFile(path.join(dir, "index.tsx"), PAGE_TEMPLATE(page.id, page.title))
		await fs.writeFile(
			path.join(dir, "meta.json"),
			JSON.stringify({ id: page.id, title: page.title, type: "page", states: [], tags: ["fixture"] }, null, 2),
		)
	}
	const listingDir = path.join(caretDir, "pages", "listing")
	await fs.mkdir(listingDir, { recursive: true })
	await fs.writeFile(path.join(listingDir, "index.tsx"), RESPONSIVE_PAGE)
	await fs.writeFile(
		path.join(listingDir, "meta.json"),
		JSON.stringify({ id: "listing", title: "Listing", type: "page", states: [], tags: ["fixture"] }, null, 2),
	)
	const fragmentedDir = path.join(caretDir, "pages", "fragmented")
	await fs.mkdir(fragmentedDir, { recursive: true })
	await fs.writeFile(path.join(fragmentedDir, "index.tsx"), FRAGMENT_PAGE)
	await fs.writeFile(
		path.join(fragmentedDir, "meta.json"),
		JSON.stringify({ id: "fragmented", title: "Fragmented", type: "page", states: [], tags: ["fixture"] }, null, 2),
	)

	// A page whose meta.json claims an id its folder does not have. AI-written
	// meta.json does this, and it used to render and thumbnail perfectly while
	// being silently impossible to open — see scenario `p`.
	// A .map() list over a same-file data literal, with a TEMPLATE caret-id
	// already in place (the codemod that seeds it lives in the Electron host,
	// which this harness does not run). Scenario `x` edits row 2's text.
	const catalogDir = path.join(caretDir, "pages", "catalog")
	await fs.mkdir(catalogDir, { recursive: true })
	await fs.writeFile(path.join(catalogDir, "index.tsx"), CATALOG_PAGE)
	await fs.writeFile(
		path.join(catalogDir, "meta.json"),
		JSON.stringify({ id: "catalog", title: "Catalog", type: "page", states: [], tags: ["fixture"] }, null, 2),
	)

	const layoutsDir = path.join(caretDir, "pages", "layouts")
	await fs.mkdir(layoutsDir, { recursive: true })
	await fs.writeFile(path.join(layoutsDir, "index.tsx"), LAYOUTS_PAGE)
	await fs.writeFile(
		path.join(layoutsDir, "meta.json"),
		JSON.stringify({ id: "layouts", title: "Layouts", type: "page", states: [], tags: ["fixture"] }, null, 2),
	)

	const renamedDir = path.join(caretDir, "pages", "renamed")
	await fs.mkdir(renamedDir, { recursive: true })
	await fs.writeFile(path.join(renamedDir, "index.tsx"), PAGE_TEMPLATE("renamed", "Renamed"))
	await fs.writeFile(
		path.join(renamedDir, "meta.json"),
		JSON.stringify({ id: "a-different-id", title: "Renamed", type: "page", states: [], tags: ["fixture"] }, null, 2),
	)
	for (const [file, flow] of Object.entries(FIXTURE_FLOWS)) {
		await fs.writeFile(path.join(caretDir, "flows", file), JSON.stringify(flow, null, 2))
	}

	// An asset for the @ picker to autocomplete over. Written as bytes plus an
	// index, exactly as a direct write would arrive, so the fixture exercises
	// the same path a user's own drop produces.
	const assetsDir = path.join(caretDir, "assets")
	await fs.mkdir(assetsDir, { recursive: true })
	await fs.writeFile(path.join(assetsDir, "hero-shot.png"), FIXTURE_PNG)
	await fs.writeFile(
		path.join(assetsDir, "index.json"),
		JSON.stringify(
			{
				version: 1,
				assets: [
					{
						tag: "hero-shot",
						file: "hero-shot.png",
						kind: "image",
						mime: "image/png",
						width: 240,
						height: 135,
						bytes: FIXTURE_PNG.length,
						hash: "sha256:fixture",
						alt: "A workbench",
						description: "wide, dark, empty space top-left",
						origin: { type: "uploaded" },
						addedAt: "2026-08-07T00:00:00Z",
					},
				],
			},
			null,
			2,
		),
	)

	await generateViteConfig(caretDir)
	await generateEntryFiles(caretDir)
	return { workspace, caretDir }
}

async function provisionNodeModules(caretDir: string): Promise<void> {
	const target = path.join(caretDir, "node_modules")
	if (NODE_MODULES_OVERRIDE) {
		log(`linking node_modules from ${NODE_MODULES_OVERRIDE}`)
		await fs.symlink(path.resolve(NODE_MODULES_OVERRIDE), target)
		return
	}
	const pkgText = await fs.readFile(path.join(caretDir, "package.json"), "utf-8")
	const hash = crypto.createHash("sha256").update(pkgText).digest("hex").slice(0, 16)
	const cacheDir = path.join(os.tmpdir(), "caret-design-shell-cache", hash)
	const cachedModules = path.join(cacheDir, "node_modules")

	// A cache that exists is not a cache that works: an interrupted install
	// leaves the directory present and the vite binary absent, and every later
	// run then fails with "vite did not start" — two whole suite runs were lost
	// to exactly that. The binary the suite is about to spawn is the validity
	// check, so a poisoned cache heals itself instead of failing forever.
	if (fsSync.existsSync(cachedModules) && !fsSync.existsSync(path.join(cachedModules, "vite", "bin", "vite.js"))) {
		log(`cached node_modules has no vite entry — discarding poisoned cache: ${cacheDir}`)
		await fs.rm(cacheDir, { recursive: true, force: true })
	}

	if (!fsSync.existsSync(cachedModules)) {
		log(`installing fixture dependencies into cache (first run, ~60s): ${cacheDir}`)
		await fs.mkdir(cacheDir, { recursive: true })
		await fs.writeFile(path.join(cacheDir, "package.json"), pkgText)
		await new Promise<void>((resolve, reject) => {
			const proc = child_process.spawn("npm", ["install", "--no-audit", "--no-fund"], {
				cwd: cacheDir,
				stdio: "inherit",
				shell: true,
			})
			proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`npm install exited ${code}`))))
			proc.on("error", reject)
		})
	} else {
		log(`reusing cached node_modules: ${cachedModules}`)
	}
	await fs.symlink(cachedModules, target)
}

// ---------------------------------------------------------------------------
// Vite
// ---------------------------------------------------------------------------

async function bootVite(caretDir: string): Promise<number> {
	return new Promise((resolve, reject) => {
		// Same shape as RenderingShell.spawnVite: the real entry under node, never
		// the `.bin` shim — a `.cmd` behind an unquoted shell line on Windows.
		const viteEntry = path.join(caretDir, "node_modules", "vite", "bin", "vite.js")
		viteProc = child_process.spawn("node", [viteEntry, "--host", "localhost"], { cwd: caretDir, stdio: "pipe" })
		const timeout = setTimeout(() => reject(new Error(`vite did not start in 60s.\n${viteOutput}`)), 60000)
		viteProc.stdout?.on("data", (d: Buffer) => {
			viteOutput += d.toString()
			const match = viteOutput.match(/Local:\s+http:\/\/localhost:(\d+)/)
			if (match) {
				clearTimeout(timeout)
				resolve(Number.parseInt(match[1], 10))
			}
		})
		viteProc.stderr?.on("data", (d: Buffer) => {
			viteOutput += d.toString()
		})
		viteProc.on("error", reject)
	})
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

async function launchBrowser() {
	const { chromium } = await import("playwright")
	try {
		return await chromium.launch({ headless: true })
	} catch {
		// Installed playwright version may not have its browser downloaded; fall
		// back to whatever revision exists in the ms-playwright cache.
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
				log(`using fallback browser: ${executablePath}`)
				return await chromium.launch({ headless: true, executablePath })
			}
		}
		throw new Error("No Chromium available. Run: npx playwright install chromium")
	}
}

// ---------------------------------------------------------------------------
// Scenario plumbing
// ---------------------------------------------------------------------------

interface Ctx {
	browser: Awaited<ReturnType<typeof launchBrowser>>
	port: number
	workspace: string
	caretDir: string
}

async function openCanvas(ctx: Ctx) {
	const page = await ctx.browser.newPage({ viewport: { width: 1600, height: 1000 } })
	const counters = { navigations: 0, fullReloads: 0, flowsChanged: 0 }
	page.on("framenavigated", (f) => {
		if (f === page.mainFrame()) counters.navigations++
	})
	page.on("websocket", (ws) =>
		ws.on("framereceived", (d) => {
			try {
				const m = JSON.parse(typeof d.payload === "string" ? d.payload : d.payload.toString())
				if (m.type === "full-reload") counters.fullReloads++
				if (m.type === "custom" && m.event === "caret:flows-changed") counters.flowsChanged++
			} catch {}
		}),
	)
	await page.goto(`http://localhost:${ctx.port}/`)
	await page.waitForSelector(".caret-canvas-container", { timeout: 20000 })
	await page.waitForTimeout(2500) // let thumbnails/iframes settle
	return { page, counters }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (await check()) return
		await new Promise((r) => setTimeout(r, 250))
	}
	throw new Error(`timed out waiting for ${label}`)
}

async function scenario(name: string, fn: () => Promise<string>) {
	try {
		const detail = await fn()
		results.push({ name, passed: true, detail })
		log(`PASS ${name}`)
	} catch (err) {
		results.push({ name, passed: false, detail: err instanceof Error ? err.message : String(err) })
		log(`FAIL ${name}: ${err}`)
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	log("building fixture from current templates...")
	const { workspace, caretDir } = await buildFixture()
	fixtureWorkspace = workspace
	log(`fixture: ${caretDir}`)
	await provisionNodeModules(caretDir)

	// (l) needs no browser/server: hammer the flow file with concurrent
	// reassign-style mutation pairs and require valid JSON throughout.
	await scenario("l. 200 concurrent flow mutations keep file valid", async () => {
		for (let i = 0; i < 100; i++) {
			const oldT = i % 2 === 0 ? "about" : "contact"
			const newT = i % 2 === 0 ? "contact" : "about"
			await Promise.all([
				mutateFlowDefinition(workspace, "main", (f) => {
					const s = f.steps.find((s) => s.page === "home")
					if (s) s.next = s.next.filter((p) => p !== oldT)
				}),
				mutateFlowDefinition(workspace, "main", (f) => {
					const s = f.steps.find((s) => s.page === "home")
					if (s && !s.next.includes(newT)) s.next.push(newT)
				}),
			])
			JSON.parse(await fs.readFile(path.join(caretDir, "flows", "main.flow.json"), "utf-8"))
		}
		// restore seed state
		await fs.writeFile(
			path.join(caretDir, "flows", "main.flow.json"),
			JSON.stringify(FIXTURE_FLOWS["main.flow.json"], null, 2),
		)
		return "200 mutation pairs, file parsed valid after every pair"
	})

	log("booting vite...")
	const port = await bootVite(caretDir)
	log(`vite on :${port}`)
	const browser = await launchBrowser()
	const ctx: Ctx = { browser, port, workspace, caretDir }

	await scenario("a. canvas renders all fixture pages", async () => {
		const { page } = await openCanvas(ctx)
		const frames = await page.locator(".caret-canvas-frame").count()
		await page.close()
		if (frames !== TOTAL_PAGES) throw new Error(`expected ${TOTAL_PAGES} frames, got ${frames}`)
		return `${frames} page frames rendered`
	})

	await scenario("b. flow edge create/delete live-update with zero reloads", async () => {
		const { page, counters } = await openCanvas(ctx)
		await page.click('button[title="Show flows"]')
		await page.waitForTimeout(500)
		const dotsBefore = await page.locator(".caret-canvas-flow-overlay circle").count()
		const baseNav = counters.navigations
		// what the extension writes on edge create
		await mutateFlowDefinition(workspace, "billing", (f) => {
			const s = f.steps.find((s) => s.page === "dashboard")
			if (s && !s.next.includes("contact")) s.next.push("contact")
		})
		await waitFor(
			async () => (await page.locator(".caret-canvas-flow-overlay circle").count()) > dotsBefore,
			10000,
			"new edge to appear",
		)
		// edge delete
		await mutateFlowDefinition(workspace, "billing", (f) => {
			const s = f.steps.find((s) => s.page === "dashboard")
			if (s) s.next = s.next.filter((p) => p !== "contact")
		})
		await waitFor(
			async () => (await page.locator(".caret-canvas-flow-overlay circle").count()) === dotsBefore,
			10000,
			"edge to disappear",
		)
		const navDelta = counters.navigations - baseNav
		const reloads = counters.fullReloads
		const flowFile = JSON.parse(await fs.readFile(path.join(caretDir, "flows", "billing.flow.json"), "utf-8"))
		await page.close()
		if (navDelta > 0 || reloads > 0) throw new Error(`navigations=${navDelta} fullReloads=${reloads} (expected 0)`)
		if (flowFile.id !== "billing") throw new Error("flow file invalid after CRUD")
		return `live updates, 0 navigations, 0 full-reloads, ${counters.flowsChanged} flows-changed events`
	})

	await scenario("c. edge endpoints keep clear of connectors and each other", async () => {
		const { page } = await openCanvas(ctx)
		await page.click('button[title="Show flows"]')
		await page.waitForTimeout(500)
		const m = await page.evaluate(() => {
			const dots = [...document.querySelectorAll(".caret-canvas-flow-overlay circle")].map((c) => {
				const r = c.getBoundingClientRect()
				return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
			})
			const conns = [...document.querySelectorAll(".caret-edge-connector")].map((c) => {
				const r = c.getBoundingClientRect()
				return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
			})
			let dc = Number.POSITIVE_INFINITY
			let dd = Number.POSITIVE_INFINITY
			for (const d of dots) for (const c of conns) dc = Math.min(dc, Math.hypot(d.x - c.x, d.y - c.y))
			for (let i = 0; i < dots.length; i++)
				for (let j = i + 1; j < dots.length; j++)
					dd = Math.min(dd, Math.hypot(dots[i].x - dots[j].x, dots[i].y - dots[j].y))
			return { dots: dots.length, dc, dd }
		})
		await page.close()
		if (m.dots === 0) throw new Error("no edge endpoints rendered")
		if (m.dc < 12) throw new Error(`endpoint within ${m.dc.toFixed(1)}px of a connector`)
		if (m.dd < 12) throw new Error(`endpoints within ${m.dd.toFixed(1)}px of each other`)
		return `${m.dots} endpoints; min dist to connector ${m.dc.toFixed(0)}px, between endpoints ${m.dd.toFixed(0)}px`
	})

	await scenario("d. simulate opens at the flow root page", async () => {
		const { page } = await openCanvas(ctx)
		await page.click('button[title="Simulate"]')
		await page.waitForSelector(".caret-simulation-shell", { timeout: 10000 })
		const src = await page.locator(".caret-simulation-iframe").getAttribute("src")
		await page.close()
		if (!src?.includes("page=home")) throw new Error(`simulation started at ${src}, expected page=home (flow root)`)
		return "simulation starts at page=home (the only flow root)"
	})

	await scenario("e. corrupt flow file is visibly flagged, canvas stays alive", async () => {
		const { page, counters } = await openCanvas(ctx)
		await page.click('button[title="Show flows"]')
		await page.waitForTimeout(500)
		const billingPath = path.join(caretDir, "flows", "billing.flow.json")
		const original = await fs.readFile(billingPath, "utf-8")
		const baseNav = counters.navigations
		try {
			await fs.writeFile(billingPath, '{"id": "billing", "name": ') // torn write
			await waitFor(
				async () => (await page.locator(".caret-flow-legend-item.invalid").count()) > 0,
				10000,
				"invalid flow legend entry",
			)
			const warnings = await page.locator(".caret-canvas-warnings").count()
			const mainEdges = await page.locator(".caret-canvas-flow-overlay circle").count()
			const navDelta = counters.navigations - baseNav
			if (warnings === 0) throw new Error("warnings chip not shown")
			if (mainEdges === 0) throw new Error("valid flows stopped rendering")
			if (navDelta > 0) throw new Error("canvas reloaded")
			return "invalid legend entry + warnings chip shown; other flows intact; no reload"
		} finally {
			await fs.writeFile(billingPath, original)
			await page.close()
		}
	})

	await scenario("f. missing index.tsx shows broken-page card, canvas stays alive", async () => {
		const { page } = await openCanvas(ctx)
		const indexPath = path.join(caretDir, "pages", "contact", "index.tsx")
		const original = await fs.readFile(indexPath, "utf-8")
		try {
			await fs.rm(indexPath)
			await waitFor(async () => (await page.locator(".caret-canvas-frame-broken").count()) > 0, 15000, "broken-page card")
			const frames = await page.locator(".caret-canvas-frame").count()
			if (frames !== TOTAL_PAGES) throw new Error(`expected ${TOTAL_PAGES} frames, got ${frames}`)
			return "broken-page card rendered; all other pages still on canvas"
		} finally {
			await fs.writeFile(indexPath, original)
			await page.close()
		}
	})

	await scenario("g. corrupt canvas-layout.json falls back cleanly", async () => {
		const layoutPath = path.join(caretDir, "canvas-layout.json")
		await fs.writeFile(layoutPath, "{{{{ not json")
		try {
			const { page } = await openCanvas(ctx)
			const frames = await page.locator(".caret-canvas-frame").count()
			await page.close()
			if (frames !== TOTAL_PAGES) throw new Error(`canvas broke: ${frames} frames`)
			return "canvas renders in auto layout despite corrupt layout file"
		} finally {
			await fs.rm(layoutPath, { force: true })
		}
	})

	await scenario("g2. layout endpoint rejects garbage writes", async () => {
		const res = await fetch(`http://localhost:${port}/__caret/canvas-layout`, { method: "PUT", body: "garbage" })
		const res2 = await fetch(`http://localhost:${port}/__caret/canvas-layout`, {
			method: "PUT",
			body: JSON.stringify({ mode: "manual", positions: { home: { x: 1, y: Number.NaN } } }),
		})
		const ok = await fetch(`http://localhost:${port}/__caret/canvas-layout`, {
			method: "PUT",
			body: JSON.stringify({ mode: "manual", positions: { home: { x: 1, y: 2 } } }),
		})
		if (res.status !== 400 || res2.status !== 400) throw new Error(`garbage accepted: ${res.status}/${res2.status}`)
		if (ok.status !== 200) throw new Error(`valid payload rejected: ${ok.status}`)
		await fs.rm(path.join(caretDir, "canvas-layout.json"), { force: true })
		return "garbage → 400, NaN positions → 400, valid → 200"
	})

	await scenario("h. edges to missing pages raise the warnings chip", async () => {
		const { page } = await openCanvas(ctx)
		try {
			await mutateFlowDefinition(workspace, "billing", (f) => {
				f.steps.push({ page: "dashboard-v2-does-not-exist", next: ["home"] })
			})
			await waitFor(async () => (await page.locator(".caret-canvas-warnings").count()) > 0, 10000, "warnings chip")
			const text = await page.locator(".caret-canvas-warnings").textContent()
			if (!text?.includes("missing pages")) throw new Error(`chip text: ${text}`)
			return `chip: "${text?.trim()}"`
		} finally {
			await fs.writeFile(
				path.join(caretDir, "flows", "billing.flow.json"),
				JSON.stringify(FIXTURE_FLOWS["billing.flow.json"], null, 2),
			)
			await page.close()
		}
	})

	await scenario("i. react-grab lives only in the focused iframe", async () => {
		const { page } = await openCanvas(ctx)
		const outer = await page.evaluate(() => ({
			toolbars: document.querySelectorAll("[data-react-grab]").length,
			rg: !!(window as any).__REACT_GRAB__,
		}))
		await page.click(".caret-canvas-frame >> nth=0")
		await page.waitForSelector(".caret-focused-iframe", { timeout: 10000 })
		await page.waitForTimeout(3000)
		const innerFrame = page.frames().find((f) => f.url().includes("mode=focused"))
		const inner = innerFrame
			? await innerFrame.evaluate(() => ({
					toolbars: document.querySelectorAll("[data-react-grab]").length,
					rg: !!(window as any).__REACT_GRAB__,
				}))
			: null
		await page.close()
		if (outer.toolbars !== 0 || outer.rg) throw new Error(`canvas doc has react-grab: ${JSON.stringify(outer)}`)
		if (!inner || inner.toolbars !== 1 || !inner.rg) throw new Error(`focused iframe wrong: ${JSON.stringify(inner)}`)
		return "0 instances in canvas doc, 1 in focused iframe"
	})

	await scenario("j. overlay painter screenshot matches the cropped region", async () => {
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
		await page.goto(`http://localhost:${port}/?page=home&mode=focused`)
		await page.waitForSelector(".caret-focused-paint-btn", { timeout: 15000 })
		await page.waitForTimeout(2500)
		await page.evaluate(() => {
			;(window as any).__POSTED__ = []
			window.addEventListener("message", (e) => {
				if (e.data?.type === "overlay-edit")
					(window as any).__POSTED__.push({ shot: e.data.payload?.screenshotDataUrl || "" })
			})
			;(window as any).__REACT_GRAB__?.deactivate?.()
		})
		// crop exactly the blue "Go" button so we can pixel-verify the content
		const target = await page.evaluate(() => {
			const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Go")!
			const r = btn.getBoundingClientRect()
			return { x: r.x, y: r.y, w: r.width, h: r.height }
		})
		await page.click(".caret-focused-paint-btn", { force: true })
		await page.waitForTimeout(400)
		await page.mouse.move(target.x, target.y)
		await page.mouse.down()
		await page.mouse.move(target.x + target.w, target.y + target.h, { steps: 5 })
		await page.mouse.up()
		await page.waitForSelector(".caret-overlay-prompt textarea, .caret-overlay-prompt input", { timeout: 5000 })
		await page.fill(".caret-overlay-prompt textarea, .caret-overlay-prompt input", "make this blue")
		await page.keyboard.press("Enter")
		await waitFor(
			async () => ((await page.evaluate(() => (window as any).__POSTED__)) as any[]).length > 0,
			20000,
			"overlay-edit message",
		)
		const check = await page.evaluate(async () => {
			const shot = (window as any).__POSTED__[0].shot as string
			if (!shot) return { error: "no screenshot" }
			const img = new Image()
			await new Promise((res, rej) => {
				img.onload = res
				img.onerror = rej
				img.src = shot
			})
			const c = document.createElement("canvas")
			c.width = img.width
			c.height = img.height
			const ctx = c.getContext("2d")!
			ctx.drawImage(img, 0, 0)
			// The crop is the blue button: most pixels must be blue-dominant
			// (the white "Go" glyph and rounded corners account for the rest).
			const d = ctx.getImageData(0, 0, img.width, img.height).data
			let blue = 0
			const total = img.width * img.height
			for (let i = 0; i < d.length; i += 4) {
				if (d[i + 2] > 150 && d[i + 2] > d[i] + 60 && d[i + 2] > d[i + 1] + 40) blue++
			}
			return { size: `${img.width}x${img.height}`, blueFraction: blue / total }
		})
		if ("error" in check) throw new Error(String(check.error))
		if (check.blueFraction! < 0.3)
			throw new Error(`only ${Math.round(check.blueFraction! * 100)}% of crop pixels are blue — offset crop?`)

		// --- scrolled crop: paint the magenta marker far below the fold ---
		// This only passes if the crop translates the painted (viewport) rect by the
		// scroll offset onto the full-page capture; otherwise it grabs top content.
		await page.evaluate(() => {
			;(window as any).__POSTED__ = []
		})
		const marker = await page.evaluate(() => {
			const el = document.querySelector('[data-testid="below-fold"]') as HTMLElement
			el.scrollIntoView({ block: "center" })
			const r = el.getBoundingClientRect()
			// The focused page scrolls inside `.caret-focused`, not the window.
			const scroller = document.querySelector(".caret-focused") as HTMLElement
			return { x: r.x, y: r.y, w: r.width, h: r.height, scrollTop: scroller ? scroller.scrollTop : window.scrollY }
		})
		if (marker.scrollTop < 200) throw new Error(`expected the page to scroll for the marker, scrollTop=${marker.scrollTop}`)
		await page.click(".caret-focused-paint-btn", { force: true })
		await page.waitForTimeout(400)
		await page.mouse.move(marker.x + 5, marker.y + 5)
		await page.mouse.down()
		await page.mouse.move(marker.x + marker.w - 5, marker.y + marker.h - 5, { steps: 5 })
		await page.mouse.up()
		await page.waitForSelector(".caret-overlay-prompt textarea, .caret-overlay-prompt input", { timeout: 5000 })
		await page.fill(".caret-overlay-prompt textarea, .caret-overlay-prompt input", "describe this")
		await page.keyboard.press("Enter")
		await waitFor(
			async () => ((await page.evaluate(() => (window as any).__POSTED__)) as any[]).length > 0,
			20000,
			"scrolled overlay-edit message",
		)
		const scrolled = await page.evaluate(async () => {
			const shot = (window as any).__POSTED__[0].shot as string
			if (!shot) return { error: "no screenshot" }
			const img = new Image()
			await new Promise((res, rej) => {
				img.onload = res
				img.onerror = rej
				img.src = shot
			})
			const c = document.createElement("canvas")
			c.width = img.width
			c.height = img.height
			const ctx = c.getContext("2d")!
			ctx.drawImage(img, 0, 0)
			const d = ctx.getImageData(0, 0, img.width, img.height).data
			let magenta = 0
			const total = img.width * img.height
			for (let i = 0; i < d.length; i += 4) {
				if (d[i] > 150 && d[i + 2] > 150 && d[i + 1] < 100) magenta++
			}
			return { size: `${img.width}x${img.height}`, magentaFraction: magenta / total }
		})
		await page.close()
		if ("error" in scrolled) throw new Error(String(scrolled.error))
		if (scrolled.magentaFraction! < 0.3)
			throw new Error(
				`scrolled crop only ${Math.round(scrolled.magentaFraction! * 100)}% magenta — scroll offset not applied to the crop`,
			)
		return `unscrolled ${Math.round(check.blueFraction! * 100)}% blue; scrolled (y=${marker.scrollTop}) ${Math.round(scrolled.magentaFraction! * 100)}% magenta — crop tracks scroll`
	})

	await scenario("k. focused FABs adapt to a light page background", async () => {
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
		await page.goto(`http://localhost:${port}/?page=home&mode=focused`)
		await page.waitForSelector(".caret-focused-fab", { timeout: 15000 })
		await waitFor(
			async () =>
				await page.evaluate(() => document.querySelector(".caret-focused")?.classList.contains("fabs-on-light") || false),
			8000,
			"fabs-on-light class",
		)
		const bg = await page.evaluate(
			() => window.getComputedStyle(document.querySelector(".caret-focused-fab")!).backgroundColor,
		)
		await page.close()
		return `fabs-on-light applied, fab background ${bg}`
	})

	await scenario("m. broken page iframe shows a readable error card", async () => {
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
		await page.goto(`http://localhost:${port}/?page=does-not-exist`)
		await waitFor(
			async () => ((await page.textContent("body")) || "").includes("Page not found"),
			10000,
			"page-not-found card",
		)
		await page.close()
		return "route-not-found error card rendered in isolated page mode"
	})

	await scenario("n. responsive variants work (hidden md:block toggles across viewports)", async () => {
		const readState = async (p: import("playwright").Page) =>
			p.evaluate(() => ({
				table: getComputedStyle(document.querySelector('[data-testid="desktop-table"]')!).display,
				cards: getComputedStyle(document.querySelector('[data-testid="mobile-cards"]')!).display,
			}))
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
		await page.goto(`http://localhost:${port}/?page=listing`)
		await page.waitForSelector('[data-testid="desktop-table"]', { state: "attached", timeout: 15000 })
		const desktop = await readState(page)
		await page.setViewportSize({ width: 390, height: 844 })
		await page.waitForTimeout(500)
		const mobile = await readState(page)
		await page.close()
		if (desktop.table === "none" || desktop.cards !== "none")
			throw new Error(`desktop wrong: table=${desktop.table} cards=${desktop.cards} (md:block must beat hidden)`)
		if (mobile.table !== "none" || mobile.cards === "none")
			throw new Error(`mobile wrong: table=${mobile.table} cards=${mobile.cards}`)
		// Same page in focused mode with react-grab active: responsive variants
		// must still win, and the editor's shadow-root styles must be intact.
		const fpage = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
		await fpage.goto(`http://localhost:${port}/?page=listing&mode=focused`)
		await fpage.waitForSelector('[data-testid="desktop-table"]', { state: "attached", timeout: 15000 })
		await fpage.waitForTimeout(2500)
		const focused = await fpage.evaluate(() => {
			const sr = document.querySelector("[data-react-grab]")?.shadowRoot
			return {
				table: getComputedStyle(document.querySelector('[data-testid="desktop-table"]')!).display,
				editorStyleBytes: sr
					? [...sr.querySelectorAll("style")].reduce((n, s) => n + (s.textContent || "").length, 0)
					: 0,
			}
		})
		await fpage.close()
		if (focused.table === "none") throw new Error("focused mode: md:block still loses to hidden")
		if (focused.editorStyleBytes < 1000)
			throw new Error(`react-grab shadow styles missing (${focused.editorStyleBytes} bytes)`)
		return `desktop: table ${desktop.table}/cards ${desktop.cards}; mobile inverse; focused-mode table ${focused.table}, editor styles ${Math.round(focused.editorStyleBytes / 1024)}KB intact`
	})

	await scenario("o. element click resolves the exact source line (fragment page)", async () => {
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
		await page.goto(`http://localhost:${port}/?page=fragmented&mode=focused`)
		await page.waitForSelector('[data-testid="frag-title"]', { state: "attached", timeout: 15000 })
		await page.waitForTimeout(2500)
		await page.evaluate(() => {
			;(window as any).__SELECTED__ = []
			window.addEventListener("message", (e) => {
				if (e.data?.type === "element-selected") (window as any).__SELECTED__.push(e.data.payload)
			})
		})
		const h1 = await page.evaluate(() => {
			const el = document.querySelector('[data-testid="frag-title"]')!
			const r = el.getBoundingClientRect()
			return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
		})
		await page.mouse.click(h1.x, h1.y)
		await waitFor(
			async () => ((await page.evaluate(() => (window as any).__SELECTED__)) as any[]).length > 0,
			10000,
			"element-selected message",
		)
		// Exactly one, not at-least-one. At top level `window.parent === window`,
		// and the focused view's iframe relay used to re-post every message onto
		// its own window — so each user action reached the host TWICE. In the
		// desktop app that duplicate applied every inline edit twice and corrupted
		// text ("lane" -> "lanes" -> "laness"). One click, one message, is the
		// contract this pins.
		await page.waitForTimeout(600)
		const selected = (await page.evaluate(() => (window as any).__SELECTED__)) as any[]
		const sel = selected[0]
		await page.close()
		if (selected.length !== 1) {
			throw new Error(
				`one click delivered ${selected.length} element-selected messages — the iframe relay is duplicating again`,
			)
		}
		if (!String(sel.filePath).includes("pages/fragmented")) throw new Error(`wrong file: ${JSON.stringify(sel)}`)
		if (sel.lineNumber !== FRAGMENT_H1_LINE)
			throw new Error(`resolved line ${sel.lineNumber}, expected ${FRAGMENT_H1_LINE} (source capture broken?)`)
		return `clicked h1 in a fragment file resolves to ${sel.filePath}:${sel.lineNumber} exactly`
	})

	await scenario("p. a page opens from the canvas even when meta.json disagrees about its id", async () => {
		// The canvas decides a card is openable with
		// `routes.some(r => r.name === page.id)` — route names being folders. When
		// the id came from meta.json instead, a page with a mismatched id rendered
		// and thumbnailed perfectly and silently could not be opened, with no
		// error anywhere. The folder is the identity; this pins that.
		const { page } = await openCanvas(ctx)

		const card = page.locator('.caret-canvas-frame:has-text("Renamed")')
		await card.waitFor({ timeout: 20000 })

		const cursor = await card.evaluate((element) => getComputedStyle(element as HTMLElement).cursor)
		if (cursor !== "pointer") {
			await page.close()
			throw new Error(`the card is not clickable (cursor=${cursor}) — its meta.json id is winning over its folder`)
		}

		await card.click()
		await page.waitForSelector(".caret-focused-iframe", { timeout: 15000 })
		const opened = await page.evaluate(
			() => (document.querySelector(".caret-focused-iframe") as HTMLIFrameElement | null)?.src ?? "",
		)
		await page.close()

		// The folder name is what the route and the editor must both use.
		if (!opened.includes("page=renamed")) throw new Error(`focused the wrong page: ${opened}`)
		return "a folder/meta id mismatch still opens, on the folder's own id"
	})

	await scenario("q. a page added while the canvas is open becomes clickable without a reload", async () => {
		// The reported shape: the agent adds a terms page mid-session, its
		// thumbnail appears (metas refresh over REST), and it cannot be opened —
		// `hasRoute` consulted the routes array from the canvas's initial static
		// import, which nothing ever refreshed. The router module is now
		// self-accepting HMR and announces its routes on every evaluation; this
		// adds a page to the LIVE server and requires the click to work with zero
		// page reloads.
		const { page, counters } = await openCanvas(ctx)
		await page.waitForSelector(".caret-canvas-frame", { timeout: 20000 })
		const navsBefore = counters.navigations

		const termsDir = path.join(ctx.caretDir, "pages", "terms")
		await fs.mkdir(termsDir, { recursive: true })
		await fs.writeFile(path.join(termsDir, "index.tsx"), PAGE_TEMPLATE("terms", "Terms"))
		await fs.writeFile(
			path.join(termsDir, "meta.json"),
			JSON.stringify({ id: "terms", title: "Terms", type: "page", states: [], tags: ["fixture"] }, null, 2),
		)

		const card = page.locator('.caret-canvas-frame:has-text("Terms")')
		await card.waitFor({ timeout: 20000 })

		// Clickability, not just presence — presence was never the bug.
		await waitFor(
			async () => (await card.evaluate((el) => getComputedStyle(el as HTMLElement).cursor)) === "pointer",
			15000,
			"the new page's card to become clickable",
		)
		await card.click()
		await page.waitForSelector(".caret-focused-iframe", { timeout: 15000 })

		const navs = counters.navigations - navsBefore
		await page.close()

		// Cleanup so the fixture stays canonical for anything after us.
		await fs.rm(termsDir, { recursive: true, force: true })

		if (navs > 0) throw new Error(`the route refresh caused ${navs} page reload(s) — the zero-reload contract broke`)
		return "added live, clickable, opened — 0 reloads"
	})

	await scenario("r. @ picks an asset in the instruction box without sending it", async () => {
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
		await page.goto(`http://localhost:${port}/?page=home&mode=focused`)
		await page.waitForSelector(".caret-focused-paint-btn", { timeout: 15000 })
		await page.waitForTimeout(2000)
		await page.evaluate(() => {
			;(window as any).__POSTED__ = []
			window.addEventListener("message", (e) => {
				if (e.data?.type === "overlay-edit") (window as any).__POSTED__.push(e.data.payload?.instruction || "")
			})
			;(window as any).__REACT_GRAB__?.deactivate?.()
		})

		await page.click(".caret-focused-paint-btn", { force: true })
		await page.waitForTimeout(300)
		await page.mouse.move(200, 200)
		await page.mouse.down()
		await page.mouse.move(500, 400, { steps: 5 })
		await page.mouse.up()

		const input = page.locator(".caret-overlay-prompt input, .caret-overlay-prompt textarea")
		await input.waitFor({ timeout: 5000 })
		await input.click()
		await page.keyboard.type("Put @her")

		await page.waitForSelector("[data-caret-asset-picker]", { timeout: 5000 })
		const option = page.locator('[data-caret-asset-option="hero-shot"]')
		await option.waitFor({ timeout: 5000 })

		// The thumbnail decoding is the assertion that the picker's URL is the same
		// one the canvas and the agent use. An <img> that exists but never paints
		// would look identical in a screenshot of the DOM.
		const thumbWidth = await waitFor2(
			async () => {
				const width = await option.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)
				return width > 0 ? width : null
			},
			10000,
			"the picker thumbnail to decode",
		)
		if (thumbWidth !== 240) throw new Error(`the picker thumbnail decoded at ${thumbWidth}px, not the real asset`)

		// **Clicking** the row, which is how a person picks and how this was
		// reported broken: hovering used to rebuild the list, so the element under
		// the cursor was replaced between mousedown and mouseup, no click ever
		// fired, and the bare "@" stayed in the box. Hovering first is the point.
		await option.hover()
		await page.waitForTimeout(150)
		await option.click()
		await page.waitForTimeout(300)
		const afterClick = await input.inputValue()
		if (!afterClick.includes("@hero-shot")) throw new Error(`clicking the row left the box as "${afterClick}"`)

		// Enter must reach the picker before the submit handler on the same
		// element, or choosing an asset also sends a half-written instruction.
		await page.fill(".caret-overlay-prompt input, .caret-overlay-prompt textarea", "")
		await input.click()
		await page.keyboard.type("Put @her")
		await page.waitForSelector("[data-caret-asset-picker]", { timeout: 5000 })
		await page.keyboard.press("Enter")
		await page.waitForTimeout(400)
		const afterPick = await input.inputValue()
		if (!afterPick.includes("@hero-shot")) throw new Error(`the pick did not reach the input: "${afterPick}"`)
		const sentEarly = (await page.evaluate(() => (window as any).__POSTED__)) as string[]
		if (sentEarly.length > 0) throw new Error(`choosing an asset also sent the instruction: ${JSON.stringify(sentEarly)}`)

		await page.keyboard.type("behind the headline")
		await page.keyboard.press("Enter")
		await waitFor(
			async () => ((await page.evaluate(() => (window as any).__POSTED__)) as string[]).length > 0,
			15000,
			"the overlay-edit message",
		)
		const sent = (await page.evaluate(() => (window as any).__POSTED__)) as string[]
		await page.close()
		if (!sent[0].includes("@hero-shot")) throw new Error(`the tag did not survive into the instruction: "${sent[0]}"`)

		return `picked by click and by Enter, neither sent early, instruction carried the tag: "${sent[0]}"`
	})

	await scenario("s. picking in react-grab's own prompt box does not read as 'discard'", async () => {
		// The AI-edit box belongs to react-grab and lives in its shadow root. In
		// prompt mode it watches window pointerdown in the capture phase and reads
		// any press outside its selection as a dismissal — which put "Discard?" on
		// screen when the user clicked an asset. Their escape hatch is an
		// attribute matched through composedPath(), so this asserts the outcome
		// rather than the attribute: no discard prompt, and the tag in the box.
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
		await page.goto(`http://localhost:${port}/?page=home&mode=focused`)
		await page.waitForSelector(".caret-focused-paint-btn", { timeout: 15000 })
		await page.waitForTimeout(2500)

		await page.evaluate(() => {
			;(window as any).__POSTED_AI__ = []
			window.addEventListener("message", (e) => {
				if (e.data?.type === "ai-edit-request") (window as any).__POSTED_AI__.push(e.data.payload?.instruction || "")
			})
			;(window as any).__REACT_GRAB__?.activate?.()
		})
		await page.waitForTimeout(500)

		// Driven through the mouse rather than a locator click: react-grab's overlay
		// sits over the page, so Playwright's actionability check never clears.
		const target = await page.evaluate(() => {
			const el = document.querySelector("h1") as HTMLElement
			const r = el.getBoundingClientRect()
			return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
		})
		await page.mouse.move(target.x, target.y)
		await page.waitForTimeout(300)
		await page.mouse.click(target.x, target.y, { button: "right" })
		await page.waitForTimeout(600)

		const aiEdit = page.getByText("AI Edit", { exact: true }).first()
		try {
			await aiEdit.waitFor({ timeout: 8000 })
		} catch {
			const menu = await page.evaluate(() => {
				const host = document.querySelector("[data-react-grab]") as HTMLElement | null
				return host?.shadowRoot?.textContent?.slice(0, 300) ?? "no shadow root"
			})
			await page.close()
			throw new Error(`react-grab's menu never offered AI Edit. Menu text: ${menu}`)
		}
		await aiEdit.click()

		const promptBox = page.locator("[data-react-grab-input]").first()
		await promptBox.waitFor({ timeout: 8000 })
		await promptBox.click()
		await page.keyboard.type("Put @her")

		await page.waitForSelector("[data-caret-asset-picker]", { timeout: 8000 })
		const option = page.locator('[data-caret-asset-option="hero-shot"]')
		await option.waitFor({ timeout: 8000 })
		// Which events actually carry the picker on their path is the whole question
		// here: react-grab's guard is `composedPath().some(hasAttribute)`, so an
		// event that misses it is an event react-grab will act on.
		await page.evaluate(() => {
			;(window as any).__EV__ = []
			for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "focusout", "blur"]) {
				window.addEventListener(
					type,
					(e: Event) => {
						const onPath = e.composedPath().some((n) => (n as HTMLElement)?.hasAttribute?.("data-caret-asset-picker"))
						;(window as any).__EV__.push(`${type}:${onPath ? "picker" : "elsewhere"}`)
					},
					true,
				)
			}
		})

		const row = await option.evaluate((el) => {
			const r = el.getBoundingClientRect()
			const x = r.x + r.width / 2
			const y = r.y + r.height / 2
			// What the browser would actually deliver a press to. react-grab's
			// overlay sits at the maximum z-index, and losing this hit test is
			// invisible — the popup still paints, it just never receives anything.
			const onTop = document.elementFromPoint(x, y) as HTMLElement | null
			return {
				x,
				y,
				hitsPicker: !!onTop?.closest?.("[data-caret-asset-picker]"),
				onTop: onTop
					? `${onTop.tagName.toLowerCase()}${[...onTop.attributes].map((a) => `[${a.name}]`).join("")}`
					: "nothing",
				stack: document
					.elementsFromPoint(x, y)
					.slice(0, 4)
					.map((n) => (n as HTMLElement).tagName.toLowerCase())
					.join(">"),
				popupRect: (() => {
					const p = document.querySelector("[data-caret-asset-picker]") as HTMLElement | null
					if (!p) return "no popup"
					const b = p.getBoundingClientRect()
					const cs = getComputedStyle(p)
					return `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)} pe=${cs.pointerEvents} disp=${cs.display} vis=${cs.visibility} parent=${p.parentElement?.tagName.toLowerCase()}`
				})(),
				rowRect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
			}
		})
		if (!row.hitsPicker) {
			await page.close()
			throw new Error(
				`${row.onTop} is stacked over the picker (stack ${row.stack}); popup ${row.popupRect}; row ${row.rowRect}`,
			)
		}
		await page.mouse.move(row.x, row.y)
		await page.waitForTimeout(200)
		await page.mouse.click(row.x, row.y)
		await page.waitForTimeout(500)

		const state = await page.evaluate(() => {
			const host = document.querySelector("[data-react-grab]") as HTMLElement | null
			const input = host?.shadowRoot?.querySelector("[data-react-grab-input]") as HTMLTextAreaElement | null
			const popup = document.querySelector("[data-caret-asset-picker]") as HTMLElement | null
			return {
				discarding: (host?.shadowRoot?.querySelectorAll("[data-react-grab-discard-prompt]").length ?? 0) > 0,
				promptBoxPresent: !!input,
				value: input?.value ?? null,
				pickerPresent: !!popup,
				popupHasIgnoreAttr: popup?.hasAttribute("data-react-grab-ignore-events") ?? null,
				posted: (window as any).__POSTED_AI__ ?? [],
				events: (window as any).__EV__ ?? [],
				shadowText: host?.shadowRoot?.textContent?.slice(0, 160) ?? "",
			}
		})
		await page.close()

		if (state.discarding)
			throw new Error(`choosing an asset put react-grab into its discard prompt: ${JSON.stringify(state)}`)
		if (!state.promptBoxPresent) throw new Error(`choosing an asset closed react-grab's prompt box: ${JSON.stringify(state)}`)
		if (!state.value?.includes("@hero-shot")) throw new Error(`the pick did not reach the box: ${JSON.stringify(state)}`)

		return `picked inside react-grab's shadow-root box: "${state.value}", no discard prompt`
	})

	await scenario("t. a token edit restyles a bound page live, with no reload", async () => {
		// Phase 7's live bindings: pages reference `text-brand-500`, the theme
		// defines it from foundation.json, and editing the token restyles every
		// bound element via one CSS hot update. Runs last — it rewrites a fixture
		// page and the foundation.
		const foundationPath = path.join(caretDir, "tokens", "foundation.json")
		const foundation = JSON.parse(await fs.readFile(foundationPath, "utf-8"))
		foundation.color.brand.scale = { "500": "#0b7aff" }
		foundation.color.neutral.scale = { "600": "#5b6472" }
		foundation.typography.scale = { base: 16, "2xl": 31.25 }
		await fs.writeFile(foundationPath, JSON.stringify(foundation, null, 2))
		// What the desktop watcher does on every foundation change.
		await writeThemeCss(caretDir)

		const themeCss = await fs.readFile(path.join(caretDir, "caret-theme.css"), "utf-8")
		for (const expected of [
			"--color-brand-500: #0b7aff;",
			"--color-neutral-600: #5b6472;",
			"--text-2xl: 31.25px;",
			"--radius-lg: 8px;",
		]) {
			if (!themeCss.includes(expected)) throw new Error(`caret-theme.css is missing ${expected}`)
		}

		// Bind an element to the token; HMR delivers the page edit.
		const aboutPath = path.join(caretDir, "pages", "about", "index.tsx")
		const aboutSource = await fs.readFile(aboutPath, "utf-8")
		await fs.writeFile(
			aboutPath,
			aboutSource.replace('<p className="text-zinc-600">', '<p data-testid="bound-copy" className="text-brand-500">'),
		)

		const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
		await page.goto(`http://localhost:${port}/?page=about`)
		await page.waitForSelector('[data-testid="bound-copy"]', { timeout: 15000 })
		await waitFor(
			async () =>
				(await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="bound-copy"]')!).color)) ===
				"rgb(11, 122, 255)",
			15000,
			"text-brand-500 to resolve to the foundation's own colour",
		)

		// A full reload would clear this — the point is a LIVE binding.
		await page.evaluate(() => {
			;(window as any).__NO_RELOAD__ = true
		})

		foundation.color.brand.scale["500"] = "#dc2626"
		await fs.writeFile(foundationPath, JSON.stringify(foundation, null, 2))
		await writeThemeCss(caretDir)

		await waitFor(
			async () =>
				(await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="bound-copy"]')!).color)) ===
				"rgb(220, 38, 38)",
			15000,
			"the bound element to follow the token edit",
		)
		const survived = await page.evaluate(() => (window as any).__NO_RELOAD__ === true)
		await page.close()
		if (!survived) throw new Error("the colour changed, but via a full reload — that is not a live binding")
		return "text-brand-500 followed a token edit through one CSS hot update, no reload"
	})

	await scenario("u. the playground shows skeletons, expands on click, branches down a lineage, and picks", async () => {
		// The pick half of the playground, without a model: seed one round on
		// disk, walk the whole surface. The canvas must show the way-in pill
		// (never an overlay), keep takes out of the grid, show NO original card
		// and NO agent logs, expand a page on click, clear siblings on branch,
		// grow skeletons for the next round, and post variant-pick on a settle.
		// The apply half needs the host router and is certified in verify:app.
		const contactDir = path.join(caretDir, "pages", "contact")
		const startedAt = new Date().toISOString()
		const seedTakeDir = async (n: number) => {
			const dir = path.join(caretDir, "pages", `contact--v${n}`)
			await fs.mkdir(dir, { recursive: true })
			await fs.copyFile(path.join(contactDir, "index.tsx"), path.join(dir, "index.tsx"))
			await fs.writeFile(
				path.join(dir, "meta.json"),
				JSON.stringify({
					id: `contact--v${n}`,
					title: `Contact — take ${n}`,
					type: "page",
					states: [],
					tags: [],
					variantOf: "contact",
				}),
			)
		}
		await seedTakeDir(1)
		await seedTakeDir(2)
		const node = (id: string, parentId: string, angleLabel: string, status: string, error?: string) => ({
			id,
			parentId,
			instruction: "make it feel warmer",
			angle: "a",
			angleLabel,
			label: `Take ${id.slice(-1)}`,
			status,
			...(error ? { error } : {}),
			startedAt,
		})
		const scratch = (nodes: unknown[]) => ({
			version: 2,
			mode: "page",
			pageId: "contact",
			instruction: "make it feel warmer",
			startedAt,
			source: "caret",
			nextTake: 5,
			nodes,
		})
		const round1 = [
			node("contact--v1", "contact", "Restrained", "ready"),
			node("contact--v2", "contact", "Bolder", "ready"),
			node("contact--v3", "contact", "Structural", "failed", "model refused: too spicy"),
		]
		await fs.writeFile(path.join(caretDir, ".variants.json"), JSON.stringify(scratch(round1)))

		const { page } = await openCanvas(ctx)
		try {
			// Non-blocking: canvas mode shows the grid plus a pill, never an overlay.
			await page.waitForSelector('[data-testid="explore-open-pill"]', { timeout: 20000 })
			const gridTakes = await page.evaluate(
				() =>
					Array.from(document.querySelectorAll(".caret-canvas-frame")).filter((f) =>
						(f.textContent || "").includes("take"),
					).length,
			)
			if (gridTakes > 0) throw new Error(`${gridTakes} take(s) leaked into the canvas grid`)

			await page.click('[data-testid="explore-open-pill"]')
			await page.waitForSelector('[data-testid="explore-view"]', { timeout: 10000 })
			await page.waitForSelector('[data-testid="variant-card-contact--v1"]', { timeout: 10000 })

			// No original card, no expand buttons, no agent-log lines, no rail.
			const clutter = await page.evaluate(() => ({
				original: !!document.querySelector('[data-testid="variant-card-contact"]'),
				rail: !!document.querySelector('[data-testid="explore-rail"]'),
				expandButtons: document.querySelectorAll('[data-testid^="explore-expand-"]').length,
				pathsShown: (document.querySelector('[data-testid="explore-view"]')?.textContent || "").includes(".caret/pages/"),
			}))
			if (clutter.original) throw new Error("the original page still gets a card — the exploration is about the takes")
			if (clutter.rail) throw new Error("the tree rail is still rendered")
			if (clutter.expandButtons > 0) throw new Error("Expand buttons still exist — the page itself is the click target")
			if (clutter.pathsShown) throw new Error("file paths are shown on the cards — that is an agent log")

			// The failed take's error is readable in the card, not a tooltip.
			const failedText = await page.evaluate(
				() => document.querySelector('[data-testid="variant-card-contact--v3"]')?.textContent || "",
			)
			if (!failedText.includes("model refused: too spicy")) {
				throw new Error(`failed card shows "${failedText.slice(0, 80)}" — the error message is not readable`)
			}
			// The angle is shown.
			const v2Text = await page.evaluate(
				() => document.querySelector('[data-testid="variant-card-contact--v2"]')?.textContent || "",
			)
			if (!v2Text.includes("Bolder")) throw new Error("the take's angle label is not on its card")

			// Clicking the page expands it to scale 1; Escape comes back.
			await page.click('[data-testid="explore-preview-contact--v1"]')
			await page.waitForSelector('[data-testid="explore-expanded"]', { timeout: 10000 })
			const frameWidth = await page.evaluate(() => {
				const frame = document.querySelector('[data-testid="explore-expanded"] iframe') as HTMLIFrameElement | null
				return frame ? frame.getBoundingClientRect().width : 0
			})
			if (Math.round(frameWidth) !== 1440)
				throw new Error(`expanded frame is ${frameWidth}px wide, expected 1440 (scale 1)`)
			await page.keyboard.press("Escape")
			await page.waitForSelector('[data-testid="variant-card-contact--v1"]', { timeout: 10000 })

			await page.evaluate(() => {
				;(window as any).__POSTED__ = []
				window.addEventListener("message", (e) => {
					if (e.data?.type === "variant-pick" || e.data?.type === "variant-request") {
						;(window as any).__POSTED__.push({ type: e.data.type, payload: e.data.payload })
					}
				})
			})

			// Branch: the passed-over siblings leave the view and a prompt box
			// appears under the pick. Escape un-commits and brings them back.
			await page.click('[data-testid="explore-branch-contact--v2"]')
			await page.waitForSelector('[data-testid="explore-branch-input-contact--v2"]', { timeout: 10000 })
			const siblingsCleared = await page.evaluate(() => !document.querySelector('[data-testid="variant-card-contact--v1"]'))
			if (!siblingsCleared) throw new Error("branching left the passed-over siblings on screen")
			await page.keyboard.press("Escape")
			await page.waitForSelector('[data-testid="variant-card-contact--v1"]', { timeout: 10000 })

			// Branch for real: Enter posts the request and three skeletons grow
			// below the pick while the round registers.
			await page.click('[data-testid="explore-branch-contact--v2"]')
			await page.type('[data-testid="explore-branch-input-contact--v2"]', "even warmer")
			await page.keyboard.press("Enter")
			await waitFor(
				async () =>
					((await page.evaluate(() => (window as any).__POSTED__)) as any[]).some((m) => m.type === "variant-request"),
				10000,
				"the branch variant-request message",
			)
			const branch = ((await page.evaluate(() => (window as any).__POSTED__)) as any[]).find(
				(m) => m.type === "variant-request",
			)
			if (branch.payload?.fromId !== "contact--v2" || branch.payload?.instruction !== "even warmer") {
				throw new Error(`branch posted ${JSON.stringify(branch.payload)} — expected fromId contact--v2`)
			}
			await page.waitForSelector('[data-testid="explore-skeleton-pending-2"]', { timeout: 10000 })

			// The round lands (no host here, so play the router's part): a working
			// child arrives, its REAL skeleton replaces the placeholders, and
			// flipping it ready swaps in the live page.
			await seedTakeDir(4)
			await fs.writeFile(
				path.join(caretDir, ".variants.json"),
				JSON.stringify(scratch([...round1, node("contact--v4", "contact--v2", "Restrained", "working")])),
			)
			await page.waitForSelector('[data-testid="explore-skeleton-contact--v4"]', { timeout: 15000 })
			const ancestorStill = await page.evaluate(() => !!document.querySelector('[data-testid="variant-card-contact--v2"]'))
			if (!ancestorStill) throw new Error("the branched-from take vanished — the lineage must stay visible")

			await fs.writeFile(
				path.join(caretDir, ".variants.json"),
				JSON.stringify(scratch([...round1, node("contact--v4", "contact--v2", "Restrained", "ready")])),
			)
			await page.waitForSelector('[data-testid="explore-preview-contact--v4"]', { timeout: 15000 })

			// Settle on the deep leaf.
			await page.click('[data-testid="variant-use-contact--v4"]')
			// The verdict beat: the winner rings and the passed-over lineage dims
			// BEFORE the pick posts (the settle itself follows ~half a second later).
			const verdict = await page.evaluate(() => ({
				won:
					document.querySelector('[data-testid="variant-card-contact--v4"]')?.className.includes("settling-won") ??
					false,
				lost:
					document.querySelector('[data-testid="variant-card-contact--v2"]')?.className.includes("settling-lost") ??
					false,
			}))
			if (!verdict.won || !verdict.lost) {
				throw new Error(`settle verdict beat missing — ${JSON.stringify(verdict)}`)
			}
			await waitFor(
				async () =>
					((await page.evaluate(() => (window as any).__POSTED__)) as any[]).some((m) => m.type === "variant-pick"),
				10000,
				"the variant-pick message",
			)
			const picked = ((await page.evaluate(() => (window as any).__POSTED__)) as any[]).find(
				(m) => m.type === "variant-pick",
			)
			if (picked.payload?.variantId !== "contact--v4") {
				throw new Error(`picked "${picked.payload?.variantId}", expected contact--v4`)
			}

			// The doors are direct — the door you came through IS the choice. The
			// canvas flask goes straight to "something new": no chooser, no page
			// dropdown restating what you just clicked.
			await page.waitForSelector('[data-testid="explore-enter"]', { timeout: 10000 })
			await page.click('[data-testid="explore-enter"]')
			await page.waitForSelector('[data-testid="explore-start-new"]', { timeout: 10000 })
			const chooserLeftovers = await page.evaluate(
				() =>
					!!document.querySelector('[data-testid="explore-start-page"]') ||
					!!document.querySelector('[data-testid="explore-page-select"]'),
			)
			if (chooserLeftovers)
				throw new Error("the flask door still shows a page chooser — it must go straight to something new")

			// The focused page's Experiment button goes straight to variants of
			// THAT page: just the instruction box, the page already named.
			await page.click('[data-testid="explore-back"]')
			await page.click('.caret-canvas-frame:has-text("Contact")')
			await page.waitForSelector('[data-testid="explore-enter-focused"]', { timeout: 15000 })
			await page.click('[data-testid="explore-enter-focused"]')
			await page.waitForSelector('[data-testid="explore-start-page"]', { timeout: 10000 })
			const pageDoor = await page.evaluate(() => ({
				named: (document.querySelector('[data-testid="explore-start-page"]')?.textContent || "").includes("Contact"),
				hasSelect: !!document.querySelector('[data-testid="explore-page-select"]'),
				hasNewCard: !!document.querySelector('[data-testid="explore-start-new"]'),
			}))
			if (!pageDoor.named) throw new Error("the page door does not name the page it came from")
			if (pageDoor.hasSelect || pageDoor.hasNewCard) {
				throw new Error("the page door still shows a chooser — it must go straight to that page's instruction box")
			}

			return "pill → click-to-expand at scale 1 → branch cleared siblings, grew skeletons, carried fromId → pick posted contact--v4; no original card, no logs, doors land direct"
		} finally {
			await page.close()
			await fs.rm(path.join(caretDir, ".variants.json"), { force: true })
			for (const n of [1, 2, 3, 4]) {
				await fs.rm(path.join(caretDir, "pages", `contact--v${n}`), { recursive: true, force: true })
			}
		}
	})

	await scenario("v. the design-check script finds planted slop tells in a real render", async () => {
		// The checker's DOM half runs inside pages Caret does not control, so it
		// is certified against a real browser render, not a DOM stub. One page,
		// four planted tells; each must be found and nothing else may crash.
		const flawedDir = path.join(caretDir, "pages", "flawed")
		await fs.mkdir(flawedDir, { recursive: true })
		await fs.writeFile(
			path.join(flawedDir, "index.tsx"),
			`export default function Flawed() {
  return (
    <div className="min-h-screen bg-white p-8">
      <h1 className="text-2xl font-bold text-zinc-900">Flawed</h1>
      <div style={{ width: 320, height: 200, background: "#d4d4d4" }} />
      <img src="/caret-assets/hero-shot.png" style={{ width: 600 }} />
      <div>
        <div className="p-4">Exactly the same testimonial text repeated here</div>
        <div className="p-4">Exactly the same testimonial text repeated here</div>
        <div className="p-4">A different card so the container has three children</div>
      </div>
    </div>
  )
}
`,
		)
		await fs.writeFile(
			path.join(flawedDir, "meta.json"),
			JSON.stringify({ id: "flawed", title: "Flawed", type: "page", states: [], tags: [] }),
		)

		// Let Vite notice the new page before the first navigation: the fixture
		// now carries considerably more pages, and a goto that races the route
		// module's invalidation renders an empty document.
		await new Promise((resolve) => setTimeout(resolve, 1500))

		const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
		const pageErrors: string[] = []
		page.on("pageerror", (err) => pageErrors.push(String(err).slice(0, 200)))
		page.on("console", (msg) => {
			if (msg.type() === "error") pageErrors.push(`console: ${msg.text().slice(0, 200)}`)
		})
		try {
			try {
				await waitFor(
					async () => {
						await page.goto(`http://localhost:${port}/?page=flawed`).catch(() => {})
						return await page.evaluate(() => !!document.querySelector("img")).catch(() => false)
					},
					75000,
					"the flawed page to render",
				)
			} catch (err) {
				const body = await page.evaluate(() => document.body?.innerHTML?.slice(0, 300)).catch(() => "unreadable")
				throw new Error(`${err} — pageErrors: ${JSON.stringify(pageErrors.slice(0, 6))} — body: ${body}`)
			}
			await page.waitForFunction(() => [...document.images].every((img) => img.complete), { timeout: 10000 })

			const findings = (await page.evaluate(DESIGN_CHECKS_DOM_SCRIPT)) as Array<{ check: string; severity: string }>
			const found = new Set(findings.map((f) => f.check))
			for (const expected of ["placeholder-box", "missing-alt", "image-upscaled", "identical-cards"]) {
				if (!found.has(expected)) {
					throw new Error(`planted "${expected}" was not found — findings: ${JSON.stringify(findings)}`)
				}
			}
			return `found all four planted tells: ${[...found].join(", ")}`
		} finally {
			await page.close()
			await fs.rm(flawedDir, { recursive: true, force: true })
		}
	})

	await scenario("x. a .map() row stays text-editable and the edit names its row", async () => {
		// Phase 8.6's canvas half: dynamic-text inside an iterator no longer
		// blocks "Edit text" when the element is a rendered row (same template
		// id, several instances) — and the committed edit carries WHICH row, so
		// the host can route the content to that data item. The host's data
		// write is certified in the app suite; here the dynamic-range flag is
		// injected the way the host would send it.
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
		try {
			await page.goto(`http://localhost:${port}/?page=catalog&mode=focused`)
			await page.waitForSelector('[data-caret-id="cat-name"]', { state: "attached", timeout: 15000 })
			await page.waitForTimeout(2500)

			const catalogFile = path.join(caretDir, "pages", "catalog", "index.tsx")
			await page.evaluate((filePath) => {
				;(window as any).__EDITS__ = []
				window.addEventListener("message", (e) => {
					if (e.data?.type === "inline-edit") (window as any).__EDITS__.push(e.data.payload)
				})
				// The host's precompute-result, verbatim shape: the whole file is
				// flagged dynamic-text, which used to disable row editing outright.
				window.postMessage(
					{
						source: "caret-host",
						type: "precompute-result",
						payload: {
							filePath,
							dynamicRanges: [{ startLine: 1, startCol: 0, endLine: 99, endCol: 0, diagnostics: ["dynamic-text"] }],
						},
					},
					"*",
				)
				;(window as any).__REACT_GRAB__?.activate?.()
			}, catalogFile)
			await page.waitForTimeout(500)

			// Right-click ROW 2's name.
			const target = await page.evaluate(() => {
				const rows = document.querySelectorAll('[data-caret-id="cat-name"]')
				const el = rows[1] as HTMLElement
				const r = el.getBoundingClientRect()
				return { x: r.x + r.width / 2, y: r.y + r.height / 2, count: rows.length }
			})
			if (target.count !== 2) throw new Error(`expected 2 rendered rows, got ${target.count}`)
			await page.mouse.move(target.x, target.y)
			await page.waitForTimeout(300)
			await page.mouse.click(target.x, target.y, { button: "right" })

			const editText = page.getByText("Edit text", { exact: true }).first()
			try {
				await editText.waitFor({ timeout: 8000 })
			} catch {
				const menu = await page.evaluate(() => {
					const host = document.querySelector("[data-react-grab]") as HTMLElement | null
					return host?.shadowRoot?.textContent?.slice(0, 300) ?? "no shadow root"
				})
				throw new Error(
					`"Edit text" is not offered on a .map() row — the dynamic-text gate is blocking it. Menu: ${menu}`,
				)
			}
			await editText.click()
			await page.waitForTimeout(400)

			// Now do what a person does: CLICK inside the text to place the
			// cursor, then type. The original version set textContent via script
			// here, and that certified the pipeline while the gesture rotted —
			// react-grab stays armed after every selection, so the cursor click
			// read to it as a grab: "Copied" toast, focus stolen, edit closed
			// after zero keystrokes. The edit action now stands react-grab down
			// until the edit finishes, and this click is what holds that down.
			await page.mouse.click(target.x, target.y)
			await page.waitForTimeout(400)
			const midEdit = await page.evaluate(() => {
				const el = document.querySelectorAll('[data-caret-id="cat-name"]')[1] as HTMLElement
				const host = document.querySelector("[data-react-grab]") as HTMLElement | null
				return {
					stillEditable: el.isContentEditable,
					focused: document.activeElement === el,
					toasted: host?.shadowRoot?.textContent?.includes("Copied") ?? false,
				}
			})
			if (midEdit.toasted) throw new Error("the cursor click was read as a grab — react-grab said Copied mid-edit")
			if (!midEdit.stillEditable || !midEdit.focused) {
				throw new Error(`the cursor click ended the edit: ${JSON.stringify(midEdit)}`)
			}

			// Replace the content by typing. Selection via the DOM (the click
			// above proved the cursor lands; cross-platform select-all keystrokes
			// inside contentEditable are not what this scenario is about).
			await page.evaluate(() => {
				const el = document.querySelectorAll('[data-caret-id="cat-name"]')[1] as HTMLElement
				window.getSelection()?.selectAllChildren(el)
			})
			await page.keyboard.type("Aurora Loafer")
			await page.keyboard.press("Enter")
			await waitFor(
				async () => ((await page.evaluate(() => (window as any).__EDITS__)) as any[]).length > 0,
				8000,
				"the committed row edit to post",
			)
			const edit = ((await page.evaluate(() => (window as any).__EDITS__)) as any[])[0]
			if (edit.caretId !== "cat-name" || edit.instanceIndex !== 1 || edit.newValue !== "Aurora Loafer") {
				throw new Error(`the edit does not name its row: ${JSON.stringify(edit)}`)
			}
			return `row 2 stayed editable under a dynamic-text flag; payload carried caretId=cat-name instanceIndex=1`
		} finally {
			await page.close()
		}
	})

	await scenario("y. shift-click multi-selects, a commit is a bulk edit, and Cmd+Z asks for undo", async () => {
		// Phase 8.7's canvas half: the second click with Shift held grows the
		// selection instead of replacing it, the panel says so, one commit
		// carries every selected element, and the undo keystroke speaks the
		// design-undo message (the host's restore is certified in the app suite).
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
		try {
			await page.goto(`http://localhost:${port}/?page=fragmented&mode=focused`)
			await page.waitForSelector('[data-testid="frag-title"]', { state: "attached", timeout: 15000 })
			await page.waitForTimeout(2500)
			await page.evaluate(() => {
				;(window as any).__MSGS__ = []
				window.addEventListener("message", (e) => {
					if (e.data?.type === "param-edit" || e.data?.type === "design-undo" || e.data?.type === "param-resolve")
						(window as any).__MSGS__.push(e.data)
				})
			})

			const pointFor = async (selector: string) =>
				await page.evaluate((sel) => {
					const el = document.querySelector(sel)!
					const r = el.getBoundingClientRect()
					return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
				}, selector)

			await page.mouse.click(...(Object.values(await pointFor('[data-testid="frag-title"]')) as [number, number]))
			await waitFor(
				async () => await page.evaluate(() => !!document.querySelector("#caret-param-panel")),
				10000,
				"the panel to open on the first selection",
			)

			await page.keyboard.down("Shift")
			await page.mouse.click(...(Object.values(await pointFor('[data-caret-id="frag-copy"]')) as [number, number]))
			await page.keyboard.up("Shift")

			// The announcement renders WITH the rows, and rows render on the host's
			// reply — which this harness plays (real resolver output shape).
			await page.evaluate(() => {
				window.postMessage(
					{
						source: "caret-host",
						type: "param-resolve-result",
						payload: {
							caretId: "frag-copy",
							params: [
								{
									property: "padding",
									type: "length",
									value: null,
									origin: "computed",
									writable: true,
									variant: null,
									utility: null,
								},
							],
						},
					},
					"*",
				)
			})
			try {
				await waitFor(
					async () => await page.evaluate(() => !!document.querySelector('[data-param-input="padding"]')),
					10000,
					"the padding row",
				)
			} catch (err) {
				const diag = await page.evaluate(() => ({
					selectionCount: (document.querySelector("#caret-param-panel") as HTMLElement | null)?.dataset?.selectionCount,
					panelText: document.querySelector("#caret-param-panel")?.textContent?.slice(0, 120),
					resolves: ((window as any).__MSGS__ ?? [])
						.filter((m: any) => m.type === "param-resolve")
						.map((m: any) => m.payload?.caretId),
				}))
				throw new Error(`${err} — diag: ${JSON.stringify(diag)}`)
			}
			const announced = await page.evaluate(
				() => document.querySelector("#caret-param-panel")?.textContent?.includes("2 elements selected") ?? false,
			)
			if (!announced) throw new Error("the panel rendered rows without announcing the 2-element selection")
			await page.evaluate(() => {
				const input = document.querySelector('[data-param-input="padding"]') as HTMLInputElement
				input.focus()
				input.value = "32px"
				input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
			})

			const edit = await waitFor2(
				async () => await page.evaluate(() => (window as any).__MSGS__.find((m: any) => m.type === "param-edit") ?? null),
				8000,
				"the bulk param-edit",
			)
			const payload = edit.payload
			if (
				payload.caretId !== "frag-copy" ||
				!Array.isArray(payload.alsoCaretIds) ||
				payload.alsoCaretIds[0] !== "frag-h1"
			) {
				throw new Error(`the commit is not a bulk edit: ${JSON.stringify(payload)}`)
			}

			// Cmd+Z outside any input speaks the unified undo.
			await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
			await page.keyboard.press("Control+z")
			await waitFor(
				async () => await page.evaluate(() => (window as any).__MSGS__.some((m: any) => m.type === "design-undo")),
				8000,
				"the design-undo message",
			)
			return `2-element selection announced; one commit carried frag-copy + [frag-h1]; Ctrl+Z spoke design-undo`
		} finally {
			await page.close()
		}
	})

	await scenario("z. the size resolver classifies six real layout contexts, both axes", async () => {
		// The resolver's contract is judged in its own medium: a real browser's
		// computed styles and layout algorithms, not a DOM stub. Six contexts ×
		// the axis asymmetry (width:auto fills, height:auto hugs), plus the
		// preview-channel rule (flex/grid preview through a clamp — measured:
		// el.style.width does nothing on a flex-basis:0 child).
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
		try {
			await page.goto(`http://localhost:${port}/?page=layouts&mode=focused`)
			await page.waitForSelector('[data-testid="lay-declared"]', { state: "attached", timeout: 15000 })
			await page.waitForTimeout(1500)

			// No function-valued consts in an evaluate body — esbuild's keepNames
			// wraps them in a __name helper that does not exist in the page.
			const results = await page.evaluate(async () => {
				// Non-literal specifier: this import resolves in the BROWSER against
				// the Vite root; tsc must not try to resolve it from disk.
				const resolverUrl = "/lib/size-resolver.ts"
				// biome-ignore lint/suspicious/noExplicitAny: browser-module boundary
				const mod: any = await import(/* @vite-ignore */ resolverUrl)
				const out: Record<string, { kind: string; chain: number; preview: string }> = {}
				for (const probe of [
					["declaredW", "lay-declared", "width"],
					["chainW", "lay-chain", "width"],
					["chainH", "lay-chain", "height"],
					["flexW", "lay-flex", "width"],
					["flexH", "lay-flex", "height"],
					["gridW", "lay-grid", "width"],
					["gridH", "lay-grid", "height"],
					["absW", "lay-abs", "width"],
					["fitW", "lay-fit", "width"],
				] as Array<[string, string, "width" | "height"]>) {
					const el = document.querySelector(`[data-testid="${probe[1]}"]`)!
					const ctx = mod.resolveSizeContext(el, probe[2])
					out[probe[0]] = { kind: ctx.kind, chain: ctx.chain.length, preview: ctx.previewChannel }
				}
				return out as {
					declaredW: { kind: string; chain: number; preview: string }
					chainW: { kind: string; chain: number; preview: string }
					chainH: { kind: string; chain: number; preview: string }
					flexW: { kind: string; chain: number; preview: string }
					flexH: { kind: string; chain: number; preview: string }
					gridW: { kind: string; chain: number; preview: string }
					gridH: { kind: string; chain: number; preview: string }
					absW: { kind: string; chain: number; preview: string }
					fitW: { kind: string; chain: number; preview: string }
				}
			})

			const cases: Array<[string, { kind: string; chain: number; preview: string }, string, string?]> = [
				["declared width", results.declaredW, "declared"],
				["chained-auto width", results.chainW, "fill-chain"],
				["chained-auto height", results.chainH, "hug"],
				["flex child width", results.flexW, "flex-main", "minmax-clamp"],
				["flex child height", results.flexH, "flex-cross", "size"],
				["grid item width", results.gridW, "grid-track", "minmax-clamp"],
				["grid item height", results.gridH, "grid-row", "minmax-clamp"],
				["absolute width", results.absW, "containing-block"],
				["w-fit width", results.fitW, "content"],
			]
			for (const [name, got, kind, preview] of cases) {
				if (got.kind !== kind) throw new Error(`${name}: expected ${kind}, resolver said ${JSON.stringify(got)}`)
				if (preview && got.preview !== preview) {
					throw new Error(`${name}: expected preview channel ${preview}, got ${JSON.stringify(got)}`)
				}
			}
			if (results.chainW.chain < 3) {
				throw new Error(`the chained-auto case must walk the pass-throughs — chain was ${results.chainW.chain} long`)
			}

			return `six contexts classified correctly on both axes; fill chain walked ${results.chainW.chain} participants; flex/grid preview through the clamp`
		} finally {
			await page.close()
		}
	})

	await scenario("aa. a drag previews through the context's channel and commits once; modes speak intent", async () => {
		// Phase 10.2/10.3: selecting shows handles; dragging a FLEX child
		// previews through the min/max clamp (measured: el.style.width does
		// nothing there) so the box tracks the pointer mid-drag; release sends
		// ONE resize-commit carrying the pointerdown-resolved context; and the
		// mode chips write intent (Fill on a flex child = flex-1, not w-full).
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
		try {
			await page.goto(`http://localhost:${port}/?page=layouts&mode=focused`)
			await page.waitForSelector('[data-testid="lay-flex"]', { state: "attached", timeout: 15000 })
			await page.waitForTimeout(2000)
			await page.evaluate(() => {
				;(window as any).__MSGS__ = []
				window.addEventListener("message", (e) => {
					if (e.data?.type === "resize-commit" || e.data?.type === "param-edit") (window as any).__MSGS__.push(e.data)
				})
			})

			// Select the flex child; the panel and the handles appear.
			const flexPoint = await page.evaluate(() => {
				const el = document.querySelector('[data-testid="lay-flex"]')!
				const r = el.getBoundingClientRect()
				return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width }
			})
			await page.mouse.click(flexPoint.x, flexPoint.y)
			await waitFor(
				async () => await page.evaluate(() => !!document.querySelector("#caret-resize-handles")),
				10000,
				"the resize handles to appear on selection",
			)

			// Drag the right-edge handle +60px.
			const handle = await page.evaluate(() => {
				const host = document.querySelector("#caret-resize-handles")!
				const r = (host.children[0] as HTMLElement).getBoundingClientRect()
				return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
			})
			await page.mouse.move(handle.x, handle.y)
			await page.mouse.down()
			await page.mouse.move(handle.x + 60, handle.y, { steps: 6 })
			await page.waitForTimeout(150)

			// Mid-drag: the box must TRACK the pointer — this is the clamp channel
			// working where el.style.width would have done nothing.
			const midWidth = await page.evaluate(
				() => document.querySelector('[data-testid="lay-flex"]')!.getBoundingClientRect().width,
			)
			if (Math.abs(midWidth - (flexPoint.width + 60)) > 3) {
				throw new Error(
					`mid-drag width ${midWidth}px does not track the pointer (started ${flexPoint.width}px, dragged +60) — the preview channel is dead`,
				)
			}
			await page.mouse.up()

			const commit = await waitFor2(
				async () =>
					await page.evaluate(() => (window as any).__MSGS__.find((m: any) => m.type === "resize-commit") ?? null),
				8000,
				"the single resize-commit on release",
			)
			const c = commit.payload
			if (
				c.caretId !== "lay-flex" ||
				c.axis !== "width" ||
				c.kind !== "flex-main" ||
				Math.abs(c.px - (flexPoint.width + 60)) > 3
			) {
				throw new Error(`the commit does not carry the pointerdown context: ${JSON.stringify(c)}`)
			}
			// And the preview cleaned up: no inline clamp left behind.
			const inline = await page.evaluate(
				() => (document.querySelector('[data-testid="lay-flex"]') as HTMLElement).style.cssText,
			)
			if (/min-width|max-width/.test(inline)) throw new Error(`the preview clamp survived the release: "${inline}"`)

			// Modes render with the panel rows, and rows render on the host's
			// reply — which this harness plays (there is no Electron host here).
			await page.evaluate(() => {
				window.postMessage(
					{
						source: "caret-host",
						type: "param-resolve-result",
						payload: {
							caretId: "lay-flex",
							params: [
								{
									property: "width",
									type: "length",
									value: null,
									origin: "computed",
									writable: true,
									variant: null,
									utility: null,
								},
							],
						},
					},
					"*",
				)
			})
			await waitFor(
				async () => await page.evaluate(() => !!document.querySelector('[data-size-mode="width:fill"]')),
				8000,
				"the sizing mode chips to render",
			)

			// Modes: Fill on a flex child writes INTENT — flex-1, not w-full.
			await page.click('[data-size-mode="width:fill"]')
			const fill = await waitFor2(
				async () =>
					await page.evaluate(
						() =>
							(window as any).__MSGS__.find((m: any) => m.type === "param-edit" && m.payload.property === "flex") ??
							null,
					),
				8000,
				"the Fill mode's param-edit",
			)
			if (fill.payload.token !== "1") throw new Error(`Fill on a flex child wrote ${JSON.stringify(fill.payload)}`)

			return `clamp preview tracked the pointer (+60px), one commit carried kind=flex-main, Fill wrote flex-1`
		} finally {
			await page.close()
		}
	})

	await scenario("bb. 200 artboards: iframes virtualize and the grid stays responsive", async () => {
		// Phase 10.7: a large canvas must not mount every page as a live iframe.
		// 200 pages are seeded; the grid may mount only the ones near the
		// viewport (placeholders elsewhere), and scrolling must stay fluid. The
		// iframe count is the virtualization proof; the frame-time sample is the
		// experience check, with headless-CI headroom in the threshold.
		const pagesDir = path.join(caretDir, "pages")
		const seeded: string[] = []
		try {
			for (let n = 1; n <= 200; n++) {
				const id = `perf-${String(n).padStart(3, "0")}`
				const dir = path.join(pagesDir, id)
				await fs.mkdir(dir, { recursive: true })
				await fs.writeFile(
					path.join(dir, "index.tsx"),
					`export default function Perf${n}() {\n  return <div className="min-h-screen bg-white p-8"><h1>Perf ${n}</h1></div>\n}\n`,
				)
				await fs.writeFile(
					path.join(dir, "meta.json"),
					JSON.stringify({ id, title: `Perf ${n}`, type: "page", states: [], tags: [] }),
				)
				seeded.push(dir)
			}

			const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
			try {
				await page.goto(`http://localhost:${port}/`)
				await waitFor(
					async () =>
						((await page.evaluate(() => document.querySelectorAll(".caret-canvas-frame").length)) as number) >= 200,
					60000,
					"all 200+ cards to appear on the grid",
				)

				// Let the canvas layout settle before counting: the canvas fits all
				// artboards on open, which for 200 pages means ~4% zoom.
				await page.waitForTimeout(1500)
				const mounted = (await page.evaluate(
					() => document.querySelectorAll(".caret-canvas-frame-iframe").length,
				)) as number
				const placeholders = (await page.evaluate(
					() => document.querySelectorAll(".caret-canvas-frame-placeholder").length,
				)) as number
				if (!(mounted === 0 && placeholders > 200)) {
					const diag = await page.evaluate(() => {
						const content = document.querySelector(".caret-canvas-content") as HTMLElement | null
						return {
							transform: content?.style.transform ?? "none",
							window: `${window.innerWidth}x${window.innerHeight}`,
						}
					})
					throw new Error(
						`at fit-zoom every card should be a placeholder: ${mounted} live iframes, ${placeholders} placeholders — ${JSON.stringify(diag)}`,
					)
				}

				// Zoom in: what the user is actually looking at must become real.
				await page.evaluate(async () => {
					const container = document.querySelector(".caret-canvas-container")
					if (!container) return
					for (let step = 0; step < 40; step++) {
						container.dispatchEvent(
							new WheelEvent("wheel", {
								deltaY: -120,
								ctrlKey: true,
								bubbles: true,
								cancelable: true,
								clientX: 700,
								clientY: 500,
							}),
						)
						await new Promise((resolve) => requestAnimationFrame(resolve))
					}
				})
				await page.waitForTimeout(1200)
				const zoomedIn = (await page.evaluate(
					() => document.querySelectorAll(".caret-canvas-frame-iframe").length,
				)) as number
				if (zoomedIn === 0 || zoomedIn > 40) {
					const scale = await page.evaluate(
						() => (document.querySelector(".caret-canvas-content") as HTMLElement | null)?.style.transform ?? "none",
					)
					throw new Error(`zooming in mounted ${zoomedIn} iframes (expected a handful) at ${scale}`)
				}

				// The canvas is a transform-based pan/zoom surface (overflow:hidden),
				// not a scroller — panning is what a user does, so pan by wheel and
				// sample the frame times that gesture actually produces.
				// No function-valued consts in an evaluate body — esbuild's keepNames
				// wraps them in a __name helper that does not exist in the page.
				const timing = (await page.evaluate(async () => {
					const container = document.querySelector(".caret-canvas-container")
					if (!container) return { error: "no canvas container found" }
					const deltas: number[] = []
					let last = performance.now()
					for (let step = 0; step < 60; step++) {
						await new Promise((resolve) => requestAnimationFrame(resolve))
						const now = performance.now()
						deltas.push(now - last)
						last = now
						container.dispatchEvent(
							new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true, clientX: 700, clientY: 500 }),
						)
					}
					deltas.sort((a, b) => a - b)
					return {
						median: deltas[Math.floor(deltas.length / 2)],
						p90: deltas[Math.floor(deltas.length * 0.9)],
					}
				})) as { error?: string; median?: number; p90?: number }
				if (timing.error) throw new Error(timing.error)
				// 60fps is 16.7ms; headless CI gets headroom, but a wedged main
				// thread (every iframe live) measures hundreds of ms per frame.
				if ((timing.median ?? 999) >= 30) {
					throw new Error(
						`panning is not fluid: median frame ${timing.median?.toFixed(1)}ms, p90 ${timing.p90?.toFixed(1)}ms`,
					)
				}

				return `fit-zoom: 0 live iframes for ${placeholders} cards; zoomed in: ${zoomedIn} live; pan median ${timing.median?.toFixed(1)}ms, p90 ${timing.p90?.toFixed(1)}ms`
			} finally {
				await page.close()
			}
		} finally {
			for (const dir of seeded) await fs.rm(dir, { recursive: true, force: true })
		}
	})

	await scenario("cc. the resize verifier confirms, names the constrainer, and never cries wolf", async () => {
		// Phase 10.4's three paths, all in a real browser. The shell has no host,
		// so the commit's write is emulated the way HMR would land it, and the
		// host's edit-result is injected — everything else (snapshot at release,
		// settle protocol, measurement, judgment) is the real code.
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
		try {
			await page.goto(`http://localhost:${port}/?page=layouts&mode=focused`)
			await page.waitForSelector('[data-testid="lay-flex"]', { state: "attached", timeout: 15000 })
			await page.waitForTimeout(2000)
			await page.evaluate(() => {
				;(window as any).__SEL__ = []
				window.addEventListener("message", (e) => {
					if (e.data?.type === "element-selected") (window as any).__SEL__.push(e.data.payload?.caretId ?? "?")
				})
			})

			// A drag on the flex child, released. No host writes the file, so the
			// element stays its original size: the verifier must say so AND name
			// what actually decides the width, from the resolver's chain.
			const dragBy = async (testId: string, dx: number) => {
				// Selection is RETRIED, not assumed: the previous scenario tears down
				// 200 pages, so this page can still be reloading under HMR and
				// swallow a click. What the retry must NOT do is remove the
				// handles between attempts — re-clicking an already-selected
				// element emits no new selection, so the handles never come back
				// and the loop destroys its own success. Instead, if a leftover
				// handle covers the click point, aim slightly inside the element.
				let target = { x: 0, y: 0, width: 0 }
				let selected = ""
				for (let attempt = 0; attempt < 6 && selected !== testId; attempt++) {
					target = await page.evaluate((id) => {
						const el = document.querySelector(`[data-testid="${id}"]`)
						if (!el) return { x: 0, y: 0, width: 0 }
						const r = el.getBoundingClientRect()
						let x = r.x + r.width / 2
						const y = r.y + r.height / 2
						const under = document.elementFromPoint(x, y)
						if (under?.closest("#caret-resize-handles")) x = r.x + Math.min(24, r.width / 4)
						return { x, y, width: r.width }
					}, testId)
					if (target.width === 0) {
						await page.waitForTimeout(300)
						continue
					}
					await page.mouse.click(target.x, target.y)
					const deadline = Date.now() + 4000
					while (Date.now() < deadline && selected !== testId) {
						selected = await page.evaluate(() =>
							document.querySelector("#caret-resize-handles")
								? ((document.querySelector("#caret-param-panel") as HTMLElement | null)?.dataset?.caretId ?? "")
								: "",
						)
						if (selected !== testId) await page.waitForTimeout(200)
					}
				}
				if (selected !== testId) {
					const diag = await page.evaluate((point) => {
						const under = document.elementFromPoint(point.x, point.y) as HTMLElement | null
						return {
							panel: !!document.querySelector("#caret-param-panel"),
							panelId:
								(document.querySelector("#caret-param-panel") as HTMLElement | null)?.dataset?.caretId ?? null,
							handles: !!document.querySelector("#caret-resize-handles"),
							grab: !!(window as any).__REACT_GRAB__,
							selectedMsgs: (window as any).__SEL__?.length ?? -1,
							under: under ? `${under.tagName.toLowerCase()}.${under.className}`.slice(0, 80) : "nothing",
						}
					}, target)
					throw new Error(`meant to drag ${testId}, but ${selected || "nothing"} is selected — ${JSON.stringify(diag)}`)
				}
				const handle = await page.evaluate(() => {
					const r = (
						document.querySelector("#caret-resize-handles")!.children[0] as HTMLElement
					).getBoundingClientRect()
					return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
				})
				await page.mouse.move(handle.x, handle.y)
				await page.mouse.down()
				await page.mouse.move(handle.x + dx, handle.y, { steps: 5 })
				await page.mouse.up()
				return target.width + dx
			}
			// Clear only the verifier's own toasts. An earlier version swept every
			// position:fixed div and took the resize handles with it.
			const clearToasts = async () =>
				await page.evaluate(() => document.querySelectorAll("[data-caret-verify-toast]").forEach((n) => n.remove()))
			const readToast = async (what: string) =>
				await waitFor2(
					async () =>
						await page.evaluate(() => {
							const nodes = Array.from(document.querySelectorAll("[data-caret-verify-toast]"))
							return nodes.length ? (nodes[nodes.length - 1].textContent ?? "") : null
						}),
					10000,
					what,
				)

			await clearToasts()
			await dragBy("lay-flex", 60)
			await page.evaluate(() => {
				window.postMessage({ source: "caret-host", type: "edit-result", payload: { success: true } }, "*")
			})
			const mismatch = await readToast("the mismatch warning naming the constrainer")
			if (!/not \d+px/.test(mismatch) || !/decided by/.test(mismatch)) {
				throw new Error(`the unwritten commit did not report a mismatch with its cause: "${mismatch}"`)
			}

			// Now the clean path: land the size the way the host's write would,
			// and confirm. The siblings SHIFT here (a flex row reflows), and that
			// must NOT be reported — reflow is not damage.
			await clearToasts()
			const wanted = await dragBy("lay-flex", 60)
			await page.evaluate((px) => {
				const el = document.querySelector('[data-testid="lay-flex"]') as HTMLElement
				el.style.minWidth = el.style.maxWidth = `${Math.round(px)}px`
				window.postMessage({ source: "caret-host", type: "edit-result", payload: { success: true } }, "*")
			}, wanted)
			const clean = await readToast("the confirmation")
			if (!clean.includes("✓")) throw new Error(`a landed resize was not confirmed cleanly: "${clean}"`)

			// And real damage: an overlap the node check alone cannot see.
			await clearToasts()
			await page.evaluate(() => {
				const flex = document.querySelector('[data-testid="lay-flex"]') as HTMLElement
				flex.style.removeProperty("min-width")
				flex.style.removeProperty("max-width")
			})
			const gridWanted = await dragBy("lay-grid", 40)
			await page.evaluate((px) => {
				const el = document.querySelector('[data-testid="lay-grid"]') as HTMLElement
				el.style.minWidth = el.style.maxWidth = `${Math.round(px)}px`
				el.style.position = "relative"
				el.style.zIndex = "1"
				window.postMessage({ source: "caret-host", type: "edit-result", payload: { success: true } }, "*")
			}, gridWanted)
			const damaged = await readToast("the neighbourhood warning")
			if (!/overlaps|overflows|shrank/.test(damaged)) {
				throw new Error(`a layout-damaging resize was reported as fine: "${damaged}"`)
			}

			return `mismatch named its constrainer; a landed resize confirmed with siblings reflowing (no false alarm); damage reported as "${damaged.slice(0, 60)}"`
		} finally {
			await page.close()
		}
	})

	await scenario("dd. the layers panel selects an element, and the keyboard map is discoverable", async () => {
		// Phase 10.6/10.8 driven for real: L opens the tree, a row click selects
		// that element (the property panel follows), ? shows the map, Escape
		// closes both.
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
		try {
			await page.goto(`http://localhost:${port}/?page=layouts&mode=focused`)
			await page.waitForSelector('[data-testid="lay-flex"]', { state: "attached", timeout: 15000 })
			await page.waitForTimeout(2000)

			await page.keyboard.press("l")
			await waitFor(
				async () => await page.evaluate(() => !!document.querySelector("#caret-layers-panel")),
				8000,
				"the layers panel to open on L",
			)
			const rows = (await page.evaluate(
				() => document.querySelectorAll("#caret-layers-panel [data-layer]").length,
			)) as number
			if (rows < 3) throw new Error(`the layers panel listed ${rows} elements, expected the page's addressable ones`)

			await page.evaluate(() => {
				;(window as any).__RESOLVES__ = []
				window.addEventListener("message", (e) => {
					if (e.data?.type === "param-resolve") (window as any).__RESOLVES__.push(e.data.payload.caretId)
				})
			})
			await page.click('#caret-layers-panel [data-layer="lay-grid"]')
			const selected = await waitFor2(
				async () => await page.evaluate(() => (window as any).__RESOLVES__?.[0] ?? null),
				8000,
				"the row click to select that element",
			)
			if (selected !== "lay-grid") throw new Error(`clicking the row selected ${selected}`)

			await page.keyboard.press("?")
			await waitFor(
				async () => await page.evaluate(() => !!document.getElementById("caret-shortcuts")),
				8000,
				"the keyboard map on ?",
			)
			const mapText = (await page.evaluate(() => document.getElementById("caret-shortcuts")?.textContent ?? "")) as string
			for (const expected of ["Shift+Click", "undo", "layers"]) {
				if (!mapText.includes(expected)) throw new Error(`the keyboard map does not mention "${expected}"`)
			}

			await page.keyboard.press("Escape")
			await waitFor(
				async () =>
					await page.evaluate(
						() => !document.getElementById("caret-shortcuts") && !document.querySelector("#caret-layers-panel"),
					),
				8000,
				"Escape to close both surfaces",
			)

			return `L listed ${rows} elements, a row click selected lay-grid, ? showed the map, Escape closed both`
		} finally {
			await page.close()
		}
	})

	await scenario("w. property panel opens on selection, renders real Params, and emits param-edit", async () => {
		// The panel's read side is certified against the REAL resolver: the same
		// resolveParamsFor the host runs, applied to the same fixture source, is
		// injected as the host's reply. What the shell cannot provide is the
		// Electron router — everything else (open on select, row rendering from
		// the true Param shape, Enter → param-edit payload) runs for real.
		const fragSource = await fs.readFile(path.join(caretDir, "pages", "fragmented", "index.tsx"), "utf-8")
		const params = resolveParamsFor(fragSource, "pages/fragmented/index.tsx", "frag-h1", PANEL_PROPERTIES, 1440, null)
		if (!params) throw new Error("the resolver found no frag-h1 element in the fixture source")
		const fontSize = params.find((p) => p.property === "font-size")
		if (!fontSize || fontSize.utility !== "text-3xl") {
			throw new Error(`resolver did not surface text-3xl as font-size: ${JSON.stringify(fontSize)}`)
		}

		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
		try {
			await page.goto(`http://localhost:${port}/?page=fragmented&mode=focused`)
			await page.waitForSelector('[data-testid="frag-title"]', { state: "attached", timeout: 15000 })
			await page.waitForTimeout(2500)
			await page.evaluate(() => {
				;(window as any).__PARAM_MSGS__ = []
				window.addEventListener("message", (e) => {
					if (e.data?.type === "param-resolve" || e.data?.type === "param-edit") {
						;(window as any).__PARAM_MSGS__.push(e.data)
					}
				})
			})

			const h1 = await page.evaluate(() => {
				const el = document.querySelector('[data-testid="frag-title"]')!
				const r = el.getBoundingClientRect()
				return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
			})
			await page.mouse.click(h1.x, h1.y)

			// Selection must both open the panel and ask the host for Params.
			await waitFor(
				async () => await page.evaluate(() => !!document.querySelector("#caret-param-panel")),
				10000,
				"the property panel to open on selection",
			)
			const resolveMsg = await waitFor2(
				async () =>
					await page.evaluate(
						() => (window as any).__PARAM_MSGS__.find((m: any) => m.type === "param-resolve") ?? null,
					),
				10000,
				"the panel's param-resolve request",
			)
			if (resolveMsg.payload.caretId !== "frag-h1") {
				throw new Error(`param-resolve asked about ${resolveMsg.payload.caretId}, expected frag-h1`)
			}

			// Play the host: reply with the REAL resolver's output.
			await page.evaluate(
				(injected) => {
					window.postMessage({ source: "caret-host", type: "param-resolve-result", payload: injected }, "*")
				},
				JSON.parse(JSON.stringify({ caretId: "frag-h1", params })),
			)

			await waitFor(
				async () => await page.evaluate(() => !!document.querySelector('[data-param-input="font-size"]')),
				10000,
				"the font-size row to render from the resolver's Params",
			)
			const rowValue = await page.evaluate(
				() => (document.querySelector('[data-param-input="font-size"]') as HTMLInputElement).value,
			)

			// Enter in a row must speak the generalized edit.
			await page.focus('[data-param-input="font-size"]')
			await page.evaluate(() => {
				const input = document.querySelector('[data-param-input="font-size"]') as HTMLInputElement
				input.value = "24px"
			})
			await page.keyboard.press("Enter")
			const editMsg = await waitFor2(
				async () =>
					await page.evaluate(() => (window as any).__PARAM_MSGS__.find((m: any) => m.type === "param-edit") ?? null),
				10000,
				"the param-edit message",
			)
			const e = editMsg.payload
			if (e.caretId !== "frag-h1" || e.property !== "font-size" || e.raw !== "24px" || e.viewportWidth !== 1440) {
				throw new Error(`param-edit payload is wrong: ${JSON.stringify(e)}`)
			}
			return `panel opened, rendered font-size "${rowValue}" from the real resolver, emitted a correct param-edit`
		} finally {
			await page.close()
		}
	})

	await scenario("w2. the property panel sits beside the selection, never on it", async () => {
		// Reported from the field: selecting a hero image in the page's top-right
		// put the panel ON the image — the panel's home corner is exactly where
		// heroes and navs live. The contract: whatever corner or edge the panel
		// picks, its box must not intersect the selected element's box.
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
		try {
			await page.goto(`http://localhost:${port}/?page=fragmented&mode=focused`)
			await page.waitForSelector('[data-testid="frag-title"]', { state: "attached", timeout: 15000 })
			await page.waitForTimeout(2500)

			const overlapAfterSelect = async (placeCss: string): Promise<{ overlap: boolean; panel: string }> => {
				const point = await page.evaluate((css) => {
					const el = document.querySelector('[data-testid="frag-title"]') as HTMLElement
					el.style.cssText += css
					const r = el.getBoundingClientRect()
					return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
				}, placeCss)
				await page.mouse.click(point.x, point.y)
				await waitFor(
					async () => await page.evaluate(() => !!document.querySelector("#caret-param-panel")),
					10000,
					"the property panel to open",
				)
				return await page.evaluate(() => {
					const el = document.querySelector('[data-testid="frag-title"]')!.getBoundingClientRect()
					const p = document.querySelector("#caret-param-panel")!.getBoundingClientRect()
					const overlap = el.left < p.right && el.right > p.left && el.top < p.bottom && el.bottom > p.top
					return {
						overlap,
						panel: `${Math.round(p.left)},${Math.round(p.top)} ${Math.round(p.width)}×${Math.round(p.height)}`,
					}
				})
			}

			// The reported case: the element occupies the panel's home corner.
			const corner = await overlapAfterSelect("position:fixed;top:40px;right:0;left:auto;width:620px;height:320px;")
			if (corner.overlap) throw new Error(`panel covers a top-right selection (panel at ${corner.panel})`)

			// The hard case: the element spans BOTH top corners — the panel must
			// leave the top band entirely rather than pick the covered mirror.
			const banner = await overlapAfterSelect("position:fixed;top:40px;left:0;right:0;width:100%;height:320px;")
			if (banner.overlap) throw new Error(`panel covers a full-width selection (panel at ${banner.panel})`)

			return `top-right selection → panel at ${corner.panel}; full-width selection → panel at ${banner.panel}; no overlap`
		} finally {
			await page.close()
		}
	})

	await browser.close()
}

/** `waitFor` for a value rather than a boolean. */
async function waitFor2<T>(probe: () => Promise<T | null>, timeoutMs: number, what: string): Promise<T> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const value = await probe()
		if (value !== null) return value
		await new Promise((resolve) => setTimeout(resolve, 200))
	}
	throw new Error(`timed out waiting for ${what}`)
}

async function cleanup(workspace: string | null) {
	if (viteProc) {
		viteProc.kill()
		viteProc = null
	}
	if (workspace && !KEEP) {
		await fs.rm(workspace, { recursive: true, force: true }).catch(() => {})
	} else if (workspace) {
		log(`fixture kept at ${workspace}`)
	}
}

let fixtureWorkspace: string | null = null
main()
	.catch((err) => {
		console.error("[verify] harness error:", err)
		results.push({ name: "harness", passed: false, detail: String(err) })
	})
	.finally(async () => {
		await cleanup(fixtureWorkspace)
		const width = Math.max(...results.map((r) => r.name.length)) + 2
		console.log("\n========== DESIGN SHELL RELIABILITY CERTIFICATION ==========")
		for (const r of results) {
			console.log(`${r.passed ? "PASS" : "FAIL"}  ${r.name.padEnd(width)} ${r.detail}`)
		}
		const failed = results.filter((r) => !r.passed)
		console.log("=============================================================")
		console.log(
			failed.length === 0 ? `CERTIFIED: all ${results.length} scenarios pass` : `${failed.length} scenario(s) FAILED`,
		)
		process.exitCode = failed.length === 0 ? 0 : 1
	})
