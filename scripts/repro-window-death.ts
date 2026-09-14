/**
 * Reproduces the window death that killed three certification runs.
 *
 * Signature: a foundation/design write lands → the generated shell's files
 * (global.css, index.html, main.tsx, vite.config.ts) all change at once → vite
 * restarts → within seconds every Playwright handle reports "Target page,
 * context or browser has been closed", while the app process itself stays up.
 *
 * ⚠️ STALE DRIVER: this drove the Presets flow, which was removed with the
 * foundation-entry rework (the tabs are gone; any foundation commit is still
 * the trigger). Before using it again, re-point the clicks below at the
 * design-system view's manual editor (`ds-edit-by-hand` → walk the token
 * wizard to Save) — the write path it exercises is the same.
 *
 * This drives the trigger, then polls window and page state every 500ms and
 * dumps everything main prints. No model, no backend — reproduction costs
 * nothing.
 *
 *   npx tsx scripts/repro-window-death.ts
 */
import * as child_process from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { type ElectronApplication, _electron as electron } from "playwright"

import { ensureCaretDirectoryExists } from "../src/core/design"

const APP_SOURCE = `export default function App() { return <h1>Repro</h1> }\n`
const PAGE_SOURCE = `export default function Home() {\n\treturn <main data-caret-id="home-root"><h1 data-caret-id="home-title">Home</h1></main>\n}\n`

async function buildFixture(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "caret-repro-"))
	await ensureCaretDirectoryExists(dir)
	await fs.mkdir(path.join(dir, "src"), { recursive: true })
	await fs.writeFile(path.join(dir, "src", "App.tsx"), APP_SOURCE)
	const pageDir = path.join(dir, ".caret", "pages", "home")
	await fs.mkdir(pageDir, { recursive: true })
	await fs.writeFile(path.join(pageDir, "index.tsx"), PAGE_SOURCE)
	await fs.writeFile(
		path.join(pageDir, "meta.json"),
		JSON.stringify({ id: "home", title: "Home", type: "page", states: ["default"], tags: [] }, null, 2),
	)
	const git = (args: string) => child_process.execSync(`git ${args}`, { cwd: dir, stdio: "ignore" })
	git("init -q")
	git("config user.email caret@local")
	git("config user.name Caret")
	git("config commit.gpgSign false")
	git("add -A")
	git('commit -q -m "fixture" --no-verify')
	return dir
}

async function main(): Promise<void> {
	const fixture = await buildFixture()
	const userData = await fs.mkdtemp(path.join(os.tmpdir(), "caret-repro-profile-"))
	console.log(`fixture ${fixture}`)

	const app: ElectronApplication = await electron.launch({
		args: [path.resolve("out/main/index.js"), `--user-data-dir=${userData}`, fixture],
		env: { ...process.env, NODE_ENV: "test", CARET_DISABLE_TELEMETRY: "1" },
	})
	app.process().stdout?.on("data", (chunk) => process.stdout.write(`  [main] ${chunk}`))
	app.process().stderr?.on("data", (chunk) => process.stdout.write(`  [main!] ${chunk}`))
	app.on("close", () => console.log(`\n>>> APP PROCESS CLOSED at ${new Date().toLocaleTimeString()}`))
	app.on("window", (page) => {
		console.log(`>>> NEW WINDOW appeared: ${page.url().slice(0, 90)}`)
		page.on("close", () => console.log(`>>> WINDOW CLOSED: ${page.url().slice(0, 90)} at ${new Date().toLocaleTimeString()}`))
		page.on("crash", () =>
			console.log(`>>> RENDERER CRASHED: ${page.url().slice(0, 90)} at ${new Date().toLocaleTimeString()}`),
		)
	})

	const chrome = await app.firstWindow({ timeout: 60_000 })
	chrome.on("close", () => console.log(`>>> CHROME PAGE CLOSED at ${new Date().toLocaleTimeString()}`))
	chrome.on("crash", () => console.log(`>>> CHROME RENDERER CRASHED at ${new Date().toLocaleTimeString()}`))
	console.log(">>> chrome up")

	// Give the design session time to boot vite, as the suite's earlier scenarios do.
	await chrome.waitForTimeout(20_000)

	// Drive the Presets flow to a commit — the exact trigger.
	await chrome.getByTestId("top-bar").getByRole("button", { name: "Foundation" }).click()
	await chrome.click('[data-testid="foundation-tab-presets"]')
	await chrome.waitForSelector('[data-testid="foundation-describe"]', { timeout: 20_000 })
	await chrome.fill('[data-testid="foundation-describe"]', "A dashboard for technical support teams")
	await chrome.click('[data-testid="foundation-begin"]')
	await chrome.waitForSelector('[data-testid="foundation-step"]', { timeout: 30_000 })

	for (let i = 0; i < 8; i++) {
		if (await chrome.getByTestId("foundation-summary").count()) break
		await chrome.click('[data-testid="foundation-continue"]')
		await chrome.waitForTimeout(250)
	}
	await chrome.waitForSelector('[data-testid="foundation-summary"]', { timeout: 20_000 })
	console.log(`>>> committing at ${new Date().toLocaleTimeString()}`)
	await chrome.click('[data-testid="foundation-commit"]')

	// Now watch. 30 seconds of polling: is the page alive? how many windows?
	for (let tick = 0; tick < 60; tick++) {
		await new Promise((resolve) => setTimeout(resolve, 500))
		const alive = await chrome
			.evaluate(() => document.title)
			.then(() => true)
			.catch(() => false)
		const windows = app.windows().length
		if (!alive || tick % 10 === 0) {
			console.log(`  t+${(tick + 1) * 0.5}s  chrome alive=${alive}  windows=${windows}`)
		}
		if (!alive) {
			console.log(">>> REPRODUCED: the chrome page is gone")
			break
		}
	}

	console.log(">>> done, closing")
	await app.close().catch(() => {})
	await fs.rm(fixture, { recursive: true, force: true }).catch(() => {})
	await fs.rm(userData, { recursive: true, force: true }).catch(() => {})
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})
