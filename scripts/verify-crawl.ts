/**
 * The breakage hunt: walk the whole app the way a curious person would, and
 * fail on anything that breaks.
 *
 *   npm run test:crawl                      every project below
 *   npm run test:crawl -- --project tenon   one
 *
 * For each real project (an instant copy; the original is never touched) it
 * opens Caret, visits every top-bar screen, presses every button there that
 * does no harm, closes what opened, then opens every page on the canvas and
 * comes back. After every single press it checks the app is still well:
 * - no uncaught error and no console error in any window;
 * - no ERROR line in the main process's log;
 * - no crash screen ("Something went wrong") and no page error card;
 * - the window still answers within five seconds.
 *
 * Nothing leaves the machine: links and file dialogs are stubbed and
 * recorded, image calls go to the stand-in image service, page takes to the
 * stand-in, and no AI model is connected, so nothing is spent.
 *
 * A finding names the screen and the button that caused it, so it can be
 * reproduced by hand.
 */
import * as child_process from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { ConsoleMessage, Page } from "playwright"

import { startFakeImageService } from "./fake-image-service"
import { freshProfile, type LaunchedApp, launchApp, reapOrphanedBackends, shot } from "./verify-kit"

const SHOTS = path.resolve("release/crawl-shots")
const PROJECTS: Record<string, string> = {
	tenon: path.join(os.homedir(), "dev/test-frontend/tenon"),
	test4: path.join(os.homedir(), "dev/test-frontend/test4"),
	argus: path.join(os.homedir(), "dev/test-frontend/argus"),
	fresh: "",
}
const args = process.argv.slice(2)
const ONLY = args.includes("--project") ? args[args.indexOf("--project") + 1] : null

/**
 * Buttons never pressed: anything that spends, sends, deletes, signs in,
 * changes the user's tools, or leaves the app. Matched on the visible label.
 */
const DENY = new RegExp(
	`^(${[
		"send",
		"generate",
		"grow",
		"sync",
		"install",
		"set up",
		"remove",
		"delete",
		"discard",
		"keep the original",
		"keep the design",
		"use",
		"use this",
		"add to canvas",
		"add files",
		"reset",
		"clear",
		"sign in",
		"sign out",
		"connect",
		"disconnect",
		"quit",
		"restart",
		"commit",
		"apply",
		"approve",
		"allow",
		"deny",
		"upload",
		"import",
		"export",
		"undo",
		"rollback",
		"start",
		"ask me",
		"write the brief",
		"continue",
		"regenerate",
		"retry",
		"try again",
		"save",
		"paste",
		"stop",
		"cancel generation",
		"run",
		"replace",
		"accept",
		"reject",
		"log in",
		"log out",
		"open in",
		"open folder",
		"reveal",
		"copy",
	].join("|")})\\b`,
	"i",
)

const RECORDER = `(() => {
	if (window.__crawl) return
	window.__crawl = []
	const keep = (kind, text) => window.__crawl.push(kind + ": " + String(text).slice(0, 220))
	window.addEventListener("error", (e) => keep("uncaught", e.message || e.error))
	window.addEventListener("unhandledrejection", (e) => keep("unhandled rejection", (e.reason && (e.reason.message || e.reason)) || ""))
	const original = console.error
	console.error = (...parts) => { keep("console error", parts.map(String).join(" ")); original.apply(console, parts) }
	})()`

/** Buttons whose label sounds risky but which only open a screen. */
const ALLOW_TESTIDS = new Set(["assets-generate", "generate-back", "board-new-prompt"])

interface Finding {
	project: string
	where: string
	what: string
}

async function copyProject(source: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "caret-crawl-"))
	if (!source) {
		const project = path.join(dir, "fresh")
		await fs.mkdir(project)
		return project
	}
	const project = path.join(dir, path.basename(source))
	child_process.execFileSync("cp", ["-cR", source, project])
	return project
}

async function crawl(name: string, source: string, imageService: string): Promise<Finding[]> {
	const findings: Finding[] = []
	const dir = path.join(SHOTS, name)
	await fs.rm(dir, { recursive: true, force: true })
	await fs.mkdir(dir, { recursive: true })
	const project = await copyProject(source)
	const logFile = path.join(dir, "main.log")
	const launched: LaunchedApp = await launchApp({
		project,
		userData: await freshProfile(),
		logFile,
		env: { CARET_TEST_IMAGE_SERVICE: imageService, CARET_TEST_EXPLORE: "800", GEMINI_API_KEY: "", GOOGLE_API_KEY: "" },
	})
	let where = "opening the project"
	const coverage: string[] = []
	const note = (what: string) => {
		if (!findings.some((f) => f.where === where && f.what === what)) findings.push({ project: name, where, what })
	}

	// Leaving the app is recorded, never done.
	await launched.app.evaluate(({ shell, dialog }) => {
		const g = globalThis as unknown as { __left: string[] }
		g.__left = []
		shell.openExternal = async (url: string) => void g.__left.push(`link ${url}`)
		shell.openPath = async (file: string) => {
			g.__left.push(`open ${file}`)
			return ""
		}
		shell.showItemInFolder = (file: string) => void g.__left.push(`reveal ${file}`)
		dialog.showOpenDialog = (async () => {
			g.__left.push("open dialog")
			return { canceled: true, filePaths: [] }
		}) as unknown as typeof dialog.showOpenDialog
		dialog.showSaveDialog = (async () => {
			g.__left.push("save dialog")
			return { canceled: true }
		}) as unknown as typeof dialog.showSaveDialog
		dialog.showMessageBox = (async () => {
			g.__left.push("message box")
			return { response: 0, checkboxChecked: false }
		}) as unknown as typeof dialog.showMessageBox
	})

	const watch = (page: Page, label: string) => {
		page.on("pageerror", (error) => note(`${label} threw: ${error.message.slice(0, 200)}`))
		page.on("console", (message: ConsoleMessage) => {
			if (message.type() !== "error") return
			const text = message.text()
			// A preview inside the canvas being closed mid-load is normal.
			if (/ERR_ABORTED|net::ERR_FAILED .*\/@vite|Failed to load resource: net::ERR_ABORTED/.test(text)) return
			note(`${label} console error: ${text.slice(0, 200)}`)
		})
	}
	const chrome = launched.chrome
	watch(chrome, "main window")
	await chrome.evaluate(RECORDER).catch(() => {})
	const watched = new Set<Page>([chrome])
	const watchNewPages = () => {
		for (const page of launched.app.context().pages()) {
			if (watched.has(page)) continue
			watched.add(page)
			watch(page, page.url().startsWith("http://127.0.0.1") ? "canvas" : "window")
		}
	}

	/**
	 * (RECORDER is defined at the top of the file.) Uncaught errors and console errors, recorded inside the window itself:
	 * the test driver's own error events do not arrive from Electron windows
	 * (a planted error in a click handler went unseen). Installed on every
	 * check, since the canvas reloads.
	 */
	const drain = async (page: Page, label: string) => {
		for (const frame of page.frames()) {
			const got = (await frame
				.evaluate(`(${RECORDER}, (() => { const all = window.__crawl.splice(0); return all })())`)
				.catch(() => [])) as string[]
			for (const line of got) {
				if (/ERR_ABORTED|Download the React DevTools|Warning: /.test(line)) continue
				note(`${label}${frame === page.mainFrame() ? "" : " (a page inside it)"}: ${line}`)
			}
		}
	}

	let logSeen = 0
	const checkHealth = async () => {
		watchNewPages()
		for (const page of launched.app.context().pages()) {
			await drain(page, page === chrome ? "main window" : page.url().startsWith("http://127.0.0.1") ? "canvas" : "window")
		}
		const log = await fs.readFile(logFile, "utf8").catch(() => "")
		const lines = log.split("\n")
		for (const line of lines.slice(logSeen)) {
			if (/\bERROR\b/.test(line)) note(`main log: ${line.slice(0, 240)}`)
		}
		logSeen = lines.length
		const alive = await Promise.race([
			chrome.evaluate(() => document.body.innerText.slice(0, 20000)).catch(() => null),
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
		])
		if (alive === null) {
			note("the main window stopped answering")
			return
		}
		if (/Something went wrong|Unexpected Application Error/i.test(alive)) note("a crash screen is showing")
		for (const page of launched.app.context().pages()) {
			if (!page.url().startsWith("http://127.0.0.1")) continue
			for (const frame of page.frames()) {
				const error = await frame
					.evaluate(
						() => document.querySelector("[data-caret-page-error]")?.getAttribute("data-caret-page-error") ?? null,
					)
					.catch(() => null)
				if (error)
					note(`a page shows its error card (${frame.url().replace(/^https?:\/\/[^/]+/, "")}): ${error.slice(0, 160)}`)
			}
		}
	}

	const surfaceOf = async () =>
		(await chrome
			.getByTestId("app-shell")
			.getAttribute("data-surface")
			.catch(() => null)) ?? "?"

	/** Presses every harmless button on the current screen, once each, coming back after each. */
	const pressEverything = async (surface: string, topLabel: string) => {
		const pressed = new Set<string>()
		for (let round = 0; round < 60; round++) {
			const candidates = await chrome
				.locator('[data-testid="app-shell"] button:visible')
				.evaluateAll((buttons) =>
					buttons
						.filter((b) => !(b as HTMLButtonElement).disabled && !b.closest('[data-testid="top-bar"]'))
						.map((b, index) => {
							// A marker, so the button checked is the button clicked.
							b.setAttribute("data-crawl-id", String(index))
							return {
								index,
								label: (b.getAttribute("aria-label") || b.textContent || b.getAttribute("title") || "")
									.trim()
									.replace(/\s+/g, " ")
									.slice(0, 60),
								testid: b.getAttribute("data-testid") || "",
							}
						}),
				)
				.catch(() => [])
			const next = candidates.find((c) => {
				const key = `${c.testid}|${c.label}`
				return c.label && !pressed.has(key) && (ALLOW_TESTIDS.has(c.testid) || !DENY.test(c.label))
			})
			if (!next) {
				coverage.push(`${topLabel}: ${pressed.size} button(s)`)
				return
			}
			pressed.add(`${next.testid}|${next.label}`)
			if (process.env.CRAWL_VERBOSE) console.log(`    press ${topLabel} › ${next.label} [${next.testid}]`)
			where = `${topLabel} › "${next.label}"${next.testid ? ` (${next.testid})` : ""}`
			const button = chrome.locator(`[data-crawl-id="${next.index}"]`).first()
			await button.click({ timeout: 3000 }).catch(() => {})
			await new Promise((resolve) => setTimeout(resolve, 400))
			await checkHealth()
			// Close whatever opened, and get back to this screen.
			await chrome.keyboard.press("Escape").catch(() => {})
			if ((await surfaceOf()) !== surface) {
				await chrome
					.getByTestId("top-bar")
					.getByRole("button", { name: topLabel, exact: true })
					.click({ timeout: 3000 })
					.catch(() => {})
				await new Promise((resolve) => setTimeout(resolve, 300))
			}
		}
	}

	try {
		where = "opening the project"
		await new Promise((resolve) => setTimeout(resolve, 3000))
		await checkHealth()
		await shot(chrome, dir, "00-open")

		// Every top-bar screen.
		const topLabels = await chrome
			.getByTestId("top-bar")
			.locator("button:visible")
			.evaluateAll((buttons) => buttons.map((b) => (b.textContent || "").trim()).filter((t) => t && t.length < 30))
		for (const label of topLabels) {
			if (DENY.test(label)) continue
			where = `top bar › "${label}"`
			await chrome
				.getByTestId("top-bar")
				.getByRole("button", { name: label, exact: true })
				.first()
				.click({ timeout: 5000 })
				.catch(() => {})
			await new Promise((resolve) => setTimeout(resolve, 800))
			await checkHealth()
			await shot(chrome, dir, `top-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`)
			await pressEverything(await surfaceOf(), label)
		}

		// Every page on the canvas: open it, look, come back.
		where = "the canvas"
		if ((await surfaceOf()) !== "canvas") {
			const foundation = chrome.getByTestId("top-bar").getByRole("button", { name: "Foundation", exact: true })
			if ((await surfaceOf()) === "foundation") await foundation.click().catch(() => {})
		}
		watchNewPages()
		const view = launched.app
			.context()
			.pages()
			.find((page) => page.url().startsWith("http://127.0.0.1"))
		if (view) {
			const cards = await view
				.locator(".caret-canvas-frame")
				.count()
				.catch(() => 0)
			for (let i = 0; i < Math.min(cards, 12); i++) {
				const title = await view
					.locator(".caret-canvas-frame-title")
					.nth(i)
					.innerText()
					.catch(() => `card ${i}`)
				where = `canvas › page "${title}"`
				await view
					.locator(".caret-canvas-frame")
					.nth(i)
					.click({ timeout: 5000 })
					.catch(() => {})
				await view
					.waitForSelector(".caret-focused-iframe", { timeout: 20_000 })
					.catch(() => note("the page did not open"))
				await new Promise((resolve) => setTimeout(resolve, 2500))
				await checkHealth()
				await view
					.locator('button[title="Back to canvas"]')
					.first()
					.click({ timeout: 5000 })
					.catch(() => {})
				await view
					.waitForSelector(".caret-canvas-frame", { timeout: 20_000 })
					.catch(() => note("could not get back to the canvas"))
			}
			await view.screenshot({ path: path.join(dir, "canvas.png") }).catch(() => {})
			coverage.push(`canvas: ${Math.min(cards, 12)} of ${cards} page(s) opened`)

			// The canvas's own controls, on the first page: every screen width,
			// the keyboard map, both Experiment doors and back.
			if (cards > 0) {
				let canvasPresses = 0
				where = "canvas › the first page"
				await view
					.locator(".caret-canvas-frame")
					.first()
					.click({ timeout: 5000 })
					.catch(() => {})
				await view.waitForSelector(".caret-focused-iframe", { timeout: 20_000 }).catch(() => {})
				const widths = await view
					.locator(".caret-focused-viewport-selector button")
					.count()
					.catch(() => 0)
				for (let i = 0; i < widths; i++) {
					const label = await view
						.locator(".caret-focused-viewport-selector button")
						.nth(i)
						.innerText()
						.catch(() => `${i}`)
					where = `canvas › width "${label.trim()}"`
					await view
						.locator(".caret-focused-viewport-selector button")
						.nth(i)
						.click({ timeout: 3000 })
						.catch(() => {})
					await new Promise((resolve) => setTimeout(resolve, 1200))
					await checkHealth()
					canvasPresses++
				}
				where = "canvas › Experiment (from a page) and back"
				await view
					.getByTestId("explore-enter-focused")
					.click({ timeout: 3000 })
					.catch(() => {})
				await view
					.getByTestId("explore-start-page")
					.waitFor({ timeout: 5000 })
					.catch(() => note("the Experiment door did not open"))
				await checkHealth()
				await view
					.getByTestId("explore-back")
					.click({ timeout: 3000 })
					.catch(() => {})
				canvasPresses++
				where = "canvas › the keyboard map"
				const frame = view.frames().find((f) => f.url().includes("mode=focused"))
				await frame?.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "?" }))).catch(() => {})
				await new Promise((resolve) => setTimeout(resolve, 500))
				await checkHealth()
				await frame?.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))).catch(() => {})
				canvasPresses++
				where = "canvas › back to the grid, then Experiment (something new) and back"
				await view
					.locator('button[title="Back to canvas"]')
					.first()
					.click({ timeout: 5000 })
					.catch(() => {})
				await view
					.getByTestId("explore-enter")
					.click({ timeout: 5000 })
					.catch(() => {})
				await view
					.getByTestId("explore-start-new")
					.waitFor({ timeout: 5000 })
					.catch(() => note("the something-new door did not open"))
				await checkHealth()
				await view
					.getByTestId("explore-back")
					.click({ timeout: 3000 })
					.catch(() => {})
				canvasPresses++
				coverage.push(`canvas controls: ${canvasPresses}`)
			}
		} else coverage.push("canvas: not found")

		const left = await launched.app.evaluate(() => (globalThis as unknown as { __left: string[] }).__left)
		console.log(`  ${name}: pressed ${coverage.join("; ")}`)
		console.log(
			`  ${name}: ${left.length} attempt(s) to leave the app, all stubbed${left.length ? ` (${left.slice(0, 4).join("; ")})` : ""}`,
		)
	} catch (err) {
		note(`the walk itself failed: ${err instanceof Error ? err.message : String(err)}`)
	} finally {
		await shot(chrome, dir, "zz-end").catch(() => {})
		await launched.close()
	}
	return findings
}

async function main(): Promise<void> {
	reapOrphanedBackends()
	await fs.stat("out/main/index.js").catch(() => {
		throw new Error("No build: run `npm run test:crawl`, which builds first.")
	})
	const service = await startFakeImageService()
	const all: Finding[] = []
	for (const [name, source] of Object.entries(PROJECTS)) {
		if (ONLY && name !== ONLY) continue
		if (source && !(await fs.stat(source).catch(() => null))) {
			console.log(`\n${name}: skipped (not on this machine)`)
			continue
		}
		console.log(`\n${name}: walking…`)
		const started = Date.now()
		const findings = await crawl(name, source, service.url)
		all.push(...findings)
		console.log(`  ${name}: ${findings.length} finding(s) in ${Math.round((Date.now() - started) / 1000)}s`)
		for (const finding of findings) console.log(`   - ${finding.where}: ${finding.what}`)
	}
	await service.close()
	reapOrphanedBackends()
	await fs.writeFile(path.join(SHOTS, "findings.json"), JSON.stringify(all, null, 2))
	console.log(`\n${all.length} finding(s) in total. Screenshots and logs: ${SHOTS}`)
	process.exitCode = all.length ? 1 : 0
}

main()
	.catch((err) => {
		console.error(err instanceof Error ? err.message : err)
		process.exitCode = 1
	})
	.finally(() => setTimeout(() => process.exit(), 500))
