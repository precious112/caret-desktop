/**
 * Does an external commit flip the mounted entry screen to the DS view?
 *
 * Reproduces the exact sequence certification scenario `o` failed on: the app
 * boots on an UNCOMMITTED fixture (auto-opens Foundation → entry screen), then
 * a foundation is committed from outside the renderer (here: written straight
 * to disk with a committed `meta`, which is what `commit_foundation` produces).
 * The watcher must push new project state and the entry screen must yield to
 * the design-system view without any user action.
 *
 *   npm run build && npx tsx scripts/probe-ds-flip.ts
 */
import * as child_process from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { _electron as electron } from "playwright"

import { withDerivedScales, writeFoundationTokens } from "../src/core/design"
import { ensureCaretDirectoryExists } from "../src/core/design/scaffold"

async function main(): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "caret-ds-flip-"))
	await ensureCaretDirectoryExists(dir)
	const git = (args: string) => child_process.execSync(`git ${args}`, { cwd: dir, stdio: "ignore" })
	git("init -q")
	git("config user.email caret@local")
	git("config user.name Caret")
	git("add -A")
	git("commit -qm fixture")

	const userData = await fs.mkdtemp(path.join(os.tmpdir(), "caret-ds-flip-profile-"))
	const app = await electron.launch({
		// The fixture rides as a positional arg — that is what opens the project.
		args: [path.resolve("out/main/index.js"), `--user-data-dir=${userData}`, dir],
		env: { ...process.env, CARET_VERIFY_PROJECT: dir, NODE_ENV: "test" },
	})
	try {
		// `firstWindow` is a race — the canvas view and hidden windows are all
		// candidates. The chrome is the one whose document is the renderer bundle.
		let chrome = await app.firstWindow({ timeout: 60_000 })
		const deadline = Date.now() + 120_000
		while (Date.now() < deadline) {
			const found = app.windows().find((page) => !page.url().startsWith("http://127.0.0.1"))
			if (found) {
				chrome = found
				const mounted = await found
					.waitForSelector('[data-testid="top-bar"]', { timeout: 5_000 })
					.then(() => true)
					.catch(() => false)
				if (mounted) break
			}
			await new Promise((resolve) => setTimeout(resolve, 1_000))
		}
		console.log(`windows: ${app.windows().map((page) => page.url().slice(0, 60))}`)
		chrome.on("console", (m) => m.type() === "error" && console.log(`[renderer error] ${m.text()}`))
		chrome.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`))
		// A cold fixture installs the design shell's dependencies before the
		// project state that mounts the top bar ever lands.
		await chrome.waitForSelector('[data-testid="top-bar"]', { timeout: 300_000 })

		const ids = () =>
			chrome.evaluate(() =>
				[...document.querySelectorAll("[data-testid]")].map((el) => el.getAttribute("data-testid")).join(", "),
			)

		// Give the auto-open a moment, then record the pre-commit state.
		await chrome.waitForTimeout(4_000)
		console.log(`before commit: ${await ids()}`)

		// First, the suite's scenario-g move: an UNCOMMITTED hand edit, plain write.
		const tokensPath = path.join(dir, ".caret", "tokens", "foundation.json")
		const tokens = JSON.parse(await fs.readFile(tokensPath, "utf-8"))
		tokens.color.brand.seed = "#ff6b6b"
		await fs.writeFile(tokensPath, JSON.stringify(tokens, null, 2))
		console.log("hand-edited (uncommitted), waiting a beat")
		await chrome.waitForTimeout(5_000)
		console.log(`after hand edit: ${await ids()}`)

		// Then commit the way commit_foundation does: derived + meta, atomic write.
		const committed = JSON.parse(await fs.readFile(tokensPath, "utf-8"))
		committed.color.brand.seed = "#b45309"
		committed.color.brand.scale = {}
		const derived = withDerivedScales(committed)
		derived.meta = { committed: true, committedAt: new Date().toISOString(), source: "agent", rule: "probe" }
		await writeFoundationTokens(dir, derived)
		console.log("committed foundation externally (atomic)")

		for (let tick = 0; tick < 30; tick++) {
			await chrome.waitForTimeout(1_000)
			const now = await ids()
			const flipped = now.includes("design-system-view")
			if (tick % 5 === 0 || flipped) console.log(`t+${tick + 1}s: ${now.slice(0, 200)}`)
			if (flipped) {
				console.log("FLIPPED — the entry screen yielded to the DS view")
				// A picture for the eyes-on pass: scroll the lower sections into view.
				await chrome.evaluate(() => {
					document.querySelector('[data-testid="ds-section-spacing"]')?.scrollIntoView()
				})
				await chrome.waitForTimeout(500)
				await chrome.screenshot({ path: "release/verify-shots/ds-spacing-corners.png" })
				console.log("screenshot → release/verify-shots/ds-spacing-corners.png")
				return
			}
		}
		console.log("NEVER FLIPPED — the renderer did not react to the external commit")
	} finally {
		await app.close().catch(() => {})
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
		await fs.rm(userData, { recursive: true, force: true }).catch(() => {})
	}
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})
