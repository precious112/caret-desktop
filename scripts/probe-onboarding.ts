/**
 * The new-project onboarding, driven through the real app.
 *
 * Two folders, the two shapes setup takes:
 *
 * 1. An existing Next.js + Tailwind app. It must land on Foundation (reported
 *    as the initial landing), lead with what was detected and three routes,
 *    explain itself on Assets and on the empty canvas instead of locking them,
 *    and — on the from-app route with no backend chosen — offer the connect step
 *    in place. Then the from-app interview runs for real on a FREE model: the
 *    model must read the app and open with what it found, values included.
 * 2. An empty folder: the description box opens directly, its two buttons are
 *    the routes, and both stay disabled until there is something to submit.
 *
 * Costs nothing: a zero-cost model is pinned in the throwaway profile before
 * launch (never a subscription — see verify-support), and the fresh profile
 * keeps the developer's own preferences untouched.
 *
 *   npm run build && npx tsx scripts/probe-onboarding.ts [--skip-model]
 */
import * as child_process from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { _electron as electron, type ElectronApplication, type Page } from "playwright"

import { stopOpencodeServer } from "../src/core/design/agent/opencode/server"
import { computeDrift } from "../src/core/design/sync/drift"
import { resolveVerifyModel } from "./verify-support"

const SHOTS = path.resolve("release/probe-onboarding")
const SKIP_MODEL = process.argv.includes("--skip-model")

const results: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail = ""): void {
	results.push({ name, ok, detail })
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
}

async function shot(page: Page, name: string): Promise<void> {
	await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

async function surface(page: Page): Promise<string | null> {
	return page.getByTestId("app-shell").getAttribute("data-surface")
}

/** Every file's bytes under `root` that `include` admits, as one fingerprint string. */
async function readTree(root: string, include: (relative: string) => boolean): Promise<string> {
	const entries = await fs.readdir(root, { withFileTypes: true, recursive: true })
	const files = entries
		.filter((entry) => entry.isFile())
		.map((entry) =>
			path
				.relative(root, path.join(entry.parentPath ?? root, entry.name))
				.split(path.sep)
				.join("/"),
		)
		.filter(include)
		.sort()
	const parts = await Promise.all(files.map(async (file) => `${file}\n${await fs.readFile(path.join(root, file), "utf-8")}`))
	return parts.join("\n")
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
	for (const [relative, content] of Object.entries(files)) {
		const full = path.join(root, relative)
		await fs.mkdir(path.dirname(full), { recursive: true })
		await fs.writeFile(full, content)
	}
}

/** A small, real-looking app whose look is decided in three different places. */
async function appFixture(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "caret-onboard-app-"))
	await writeFiles(dir, {
		"package.json": JSON.stringify(
			{
				name: "acme-dashboard",
				private: true,
				dependencies: { next: "15.0.0", react: "19.0.0", "react-dom": "19.0.0" },
				devDependencies: { tailwindcss: "4.0.0" },
			},
			null,
			2,
		),
		"app/globals.css": `@import "tailwindcss";

@theme {
  --color-primary: #4f46e5;
  --color-primary-dark: #3730a3;
  --font-sans: "Inter", ui-sans-serif, system-ui;
  --radius-lg: 0.5rem;
}

body {
  background: #f8fafc;
  color: #0f172a;
}
`,
		"app/layout.tsx": `import { Inter } from "next/font/google"
import "./globals.css"

const inter = Inter({ subsets: ["latin"] })

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>{children}</body>
    </html>
  )
}
`,
		"app/orders/page.tsx": `const orders = await fetch("/api/orders").then((r) => r.json())

export default function Orders() {
  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-semibold text-slate-900">All orders</h1>
      <table className="mt-6 w-full text-sm">
        <thead><tr className="text-left text-slate-500"><th>Order</th><th>Customer</th><th>Total</th></tr></thead>
        <tbody>{orders.map((o: any) => <tr key={o.id}><td>{o.id}</td><td>{o.customer}</td><td>{o.total}</td></tr>)}</tbody>
      </table>
    </main>
  )
}
`,
		"app/settings/page.tsx": `export default function Settings() {
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold text-slate-900">Settings</h1>
      <label className="mt-6 block text-sm text-slate-600">Store name<input className="mt-1 block w-full rounded-lg border px-3 py-2" defaultValue="Acme" /></label>
      <button className="mt-6 rounded-lg bg-primary px-4 py-2 text-white">Save</button>
    </main>
  )
}
`,
		"app/page.tsx": `export default function Home() {
  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-3xl font-semibold text-slate-900">Orders</h1>
      <p className="mt-2 text-sm text-slate-500">Everything shipped this week.</p>
      <button className="mt-6 rounded-lg bg-primary px-4 py-2 text-white shadow-none">New order</button>
    </main>
  )
}
`,
	})
	child_process.execSync("git init -q && git add -A && git -c user.email=p@l -c user.name=p commit -qm init --no-verify", {
		cwd: dir,
		stdio: "ignore",
	})
	return dir
}

async function waitForChrome(app: ElectronApplication, project: string): Promise<Page> {
	const deadline = Date.now() + 90_000
	while (Date.now() < deadline) {
		for (const page of app.windows()) {
			if (!page.url().startsWith("file:")) continue
			const title = await page.title().catch(() => "")
			const bar = await page
				.getByTestId("top-bar")
				.textContent({ timeout: 500 })
				.catch(() => "")
			if (bar?.includes(path.basename(project)) || title.includes(path.basename(project))) return page
		}
		await new Promise((resolve) => setTimeout(resolve, 500))
	}
	throw new Error(`no chrome window for ${project}`)
}

async function main(): Promise<void> {
	await fs.rm(SHOTS, { recursive: true, force: true })
	await fs.mkdir(SHOTS, { recursive: true })

	const model = SKIP_MODEL ? null : await resolveVerifyModel()
	await stopOpencodeServer().catch(() => {})
	console.log(model ? `model: ${model.id} (${model.source})` : "model: none — the live interview step is skipped")

	const appDir = await appFixture()
	const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "caret-onboard-fresh-"))
	const userData = await fs.mkdtemp(path.join(os.tmpdir(), "caret-onboard-profile-"))
	// No backend chosen (that is the state the connect step exists for), but the
	// model the backend will use once it is chosen is a free one.
	await fs.writeFile(
		path.join(userData, "preferences.json"),
		JSON.stringify({ telemetryNoticeShown: true, ...(model ? { backendModel: model.id } : {}) }),
	)

	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), `--user-data-dir=${userData}`, appDir],
		env: { ...process.env, NODE_ENV: "test", CARET_DISABLE_TELEMETRY: "1" },
	})
	const mainLog = await fs.open(path.join(SHOTS, "main.log"), "w")
	app.process().stdout?.on("data", (chunk) => void mainLog.write(chunk))
	app.process().stderr?.on("data", (chunk) => void mainLog.write(chunk))

	try {
		const chrome = await waitForChrome(app, appDir)
		const rendererErrors: string[] = []
		chrome.on("pageerror", (err) => rendererErrors.push(err.message))
		await chrome.setViewportSize({ width: 1280, height: 820 }).catch(() => {})
		await chrome.waitForSelector('[data-testid="foundation-entry"]', { timeout: 60_000 })

		// ── 1. landing on an existing app ─────────────────────────────────────
		check("an uncommitted project lands on Foundation", (await surface(chrome)) === "foundation")
		const pill = (await chrome.getByTestId("setup-pill").textContent()) ?? ""
		check("the setup pill says step 1 of 2", pill.includes("step 1 of 2"), pill.trim())
		const detected = (await chrome.getByTestId("foundation-app-detected").textContent()) ?? ""
		check(
			"detection names what is really there",
			detected.includes("Next.js") && detected.includes("Tailwind"),
			detected.replace(/\s+/g, " ").trim(),
		)
		for (const route of ["foundation-route-from-app", "foundation-route-new-look", "foundation-route-manual"]) {
			check(`route offered: ${route}`, (await chrome.getByTestId(route).count()) === 1)
		}
		check("no description box before a route is chosen", (await chrome.getByTestId("foundation-describe").count()) === 0)
		check("the old 'Set your foundations' banner is gone", !(await chrome.content()).includes("Set your foundations before"))
		await shot(chrome, "01-existing-app-landing")

		// ── 2. other tabs explain themselves, nothing is locked ───────────────
		await chrome.getByTestId("top-bar").getByRole("button", { name: "Assets" }).click()
		await chrome.waitForSelector('[data-testid="assets-before-setup"]', { timeout: 10_000 })
		check("Assets explains it depends on the design system", true)
		await shot(chrome, "02-assets-before-setup")
		await chrome.click('[data-testid="assets-look-around"]')
		await chrome.waitForTimeout(500)
		check(
			"'Look around anyway' really opens the library",
			(await chrome.getByTestId("assets-before-setup").count()) === 0 && (await surface(chrome)) === "assets",
		)

		// Foundation's button toggles to the canvas when pressed from Foundation.
		await chrome.getByTestId("top-bar").getByRole("button", { name: "Foundation" }).click()
		await chrome.waitForTimeout(300)
		await chrome.getByTestId("top-bar").getByRole("button", { name: "Foundation" }).click()
		await chrome.waitForSelector('[data-testid="canvas-setup"]', { timeout: 10_000 })
		const canvasVisible = await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows().some((win) =>
				win.contentView.children.some((child: any) => {
					const bounds = child.getBounds?.()
					const [, height] = win.getContentSize()
					return bounds && bounds.y < height && child.webContents?.getURL?.().startsWith("http://localhost")
				}),
			),
		)
		check("the empty canvas shows setup, with the native view parked", !canvasVisible)
		await shot(chrome, "03-canvas-before-setup")
		await chrome.click('[data-testid="canvas-setup-continue"]')
		await chrome.waitForSelector('[data-testid="foundation-entry"]', { timeout: 10_000 })
		check("'Continue setup' returns to Foundation", (await surface(chrome)) === "foundation")

		// A state push must not drag the user back: write a page while on Assets.
		await chrome.getByTestId("top-bar").getByRole("button", { name: "Assets" }).click()
		await chrome.waitForTimeout(300)
		await writeFiles(appDir, {
			".caret/pages/scratch/index.tsx": "export default function Scratch() { return <div>scratch</div> }\n",
			".caret/pages/scratch/meta.json": JSON.stringify({
				id: "scratch",
				title: "Scratch",
				type: "page",
				states: [],
				tags: [],
			}),
		})
		await chrome.waitForTimeout(3_000)
		check("a state push no longer yanks the user back to Foundation", (await surface(chrome)) === "assets")
		const pillAfterPage = (await chrome.getByTestId("setup-pill").textContent()) ?? ""
		check("a page without a design system is still step 1", pillAfterPage.includes("step 1 of 2"), pillAfterPage.trim())
		await fs.rm(path.join(appDir, ".caret/pages/scratch"), { recursive: true, force: true })
		await chrome.getByTestId("setup-pill").click()
		await chrome.waitForSelector('[data-testid="foundation-entry"]', { timeout: 10_000 })
		check("the pill at step 1 leads to Foundation", (await surface(chrome)) === "foundation")

		// ── 3. from-app with no backend: the connect step, in place ───────────
		await chrome.click('[data-testid="foundation-route-from-app"]')
		await chrome.waitForSelector('[data-testid="wizard-needs-backend"]', { timeout: 90_000 })
		const connect = chrome.getByTestId("connect-continue")
		await chrome.waitForSelector('[data-testid="connect-continue"]:not([disabled])', { timeout: 60_000 })
		check("the connect step offers a one-click way on", true, ((await connect.textContent()) ?? "").trim())
		check("the connect step keeps the setup stepper", (await chrome.getByTestId("setup-stepper").count()) === 1)
		await shot(chrome, "04-connect-model")

		if (model) {
			// ── 4. the from-app interview, live ──────────────────────────────────
			await connect.click()
			await chrome.waitForSelector('[data-testid="wizard-thinking"]', { timeout: 20_000 })
			const thinking = (await chrome.getByTestId("wizard-thinking").textContent()) ?? ""
			check(
				"the first turn says it is reading the app",
				thinking.includes("Reading your app"),
				thinking.trim().slice(0, 80),
			)
			await shot(chrome, "05-reading-the-app")

			const first = await Promise.race([
				chrome.waitForSelector('[data-testid="wizard-question"]', { timeout: 420_000 }).then(() => "question" as const),
				chrome.waitForSelector('[data-testid="wizard-error"]', { timeout: 420_000 }).then(() => "error" as const),
				chrome
					.waitForSelector('[data-testid="wizard-needs-backend"]', { timeout: 420_000 })
					.then(() => "blocked" as const),
			]).catch(() => "timeout" as const)
			check("the model produced a first question", first === "question", first)
			if (first === "question") {
				const text = ((await chrome.getByTestId("wizard-question").textContent()) ?? "").replace(/\s+/g, " ")
				await shot(chrome, "06-first-question")
				check(
					"it opens with what it read (the indigo brand)",
					/4f46e5/i.test(text) || /indigo/i.test(text),
					text.slice(0, 200),
				)
				check("it names Inter, which it read from next/font", /inter/i.test(text), "")

				// Confirm what it read, then let it construct from that.
				await chrome.click('[data-testid="wizard-continue"]')
				await chrome.waitForSelector(
					'[data-testid="wizard-finish-now"], [data-testid="wizard-finish"], [data-testid="wizard-error"]',
					{ timeout: 420_000 },
				)
				if (await chrome.getByTestId("wizard-finish-now").count()) await chrome.click('[data-testid="wizard-finish-now"]')
				const finished = await Promise.race([
					chrome.waitForSelector('[data-testid="wizard-finish"]', { timeout: 420_000 }).then(() => "finish" as const),
					chrome.waitForSelector('[data-testid="wizard-error"]', { timeout: 420_000 }).then(() => "error" as const),
				]).catch(() => "timeout" as const)
				check("the from-app interview reaches a proposal", finished === "finish", finished)
				if (finished === "finish") {
					await shot(chrome, "07-proposal")
					await chrome.click('[data-testid="wizard-commit"]')
					const tokens = await (async () => {
						const deadline = Date.now() + 30_000
						while (Date.now() < deadline) {
							try {
								const raw = JSON.parse(
									await fs.readFile(path.join(appDir, ".caret/tokens/foundation.json"), "utf-8"),
								)
								if (raw?.meta?.committed) return raw
							} catch {}
							await new Promise((resolve) => setTimeout(resolve, 500))
						}
						return null
					})()
					check(
						"the commit is filed as read from the app",
						tokens?.meta?.source === "wizard-from-app",
						tokens?.meta?.source,
					)
					check(
						"the brand it read is the brand committed",
						String(tokens?.color?.brand?.seed ?? "").toLowerCase() === "#4f46e5",
						tokens?.color?.brand?.seed,
					)
					check("the body face it read is the face committed", /inter/i.test(tokens?.typography?.fontFamily ?? ""))

					// ── step 2 ──────────────────────────────────────────────────────
					await chrome.waitForFunction(
						() => document.querySelector('[data-testid="setup-pill"]')?.textContent?.includes("step 2 of 2"),
						undefined,
						{ timeout: 20_000 },
					)
					check("the pill moves to step 2", true)
					await chrome.waitForSelector('[data-testid="canvas-setup"]', { timeout: 20_000 })
					const canvasStep = (await chrome.getByTestId("canvas-setup-continue").textContent()) ?? ""
					check(
						"an existing app's step 2 on the canvas is bringing its screens in",
						canvasStep.includes("app's screens"),
						canvasStep.trim(),
					)
					await shot(chrome, "08-canvas-step-2")
					await chrome.click('[data-testid="canvas-setup-continue"]')
					await chrome.waitForSelector('[data-testid="app-import-card"]', { timeout: 20_000 })
					await shot(chrome, "09-ds-import-card")
					await chrome.click('[data-testid="app-import-make-page"]')
					const draft = await chrome.locator('[data-testid="chat-input"]').inputValue({ timeout: 20_000 })
					check("'Make a page' opens the chat seeded, sending nothing", draft === "Make a ", JSON.stringify(draft))
					await shot(chrome, "10-chat-seeded")
					await chrome.getByTestId("top-bar").getByRole("button", { name: "Chat" }).click()

					// ── 5. code → design: the app's screens come in ─────────────────
					const appBefore = await readTree(appDir, (file) => !file.startsWith(".caret") && !file.startsWith(".git"))
					await chrome.waitForSelector('[data-testid="app-import-list"]', { timeout: 30_000 })
					const listed = (await chrome.getByTestId("app-import-list").textContent()) ?? ""
					check(
						"the import lists the app's three screens",
						listed.includes("/orders") && listed.includes("/settings") && listed.includes("Home"),
						listed.replace(/\s+/g, " ").slice(0, 120),
					)
					await shot(chrome, "13-import-offered")
					await chrome.click('[data-testid="app-import-start"]')
					await chrome.waitForSelector('[data-testid="import-pill"]', { timeout: 20_000 })
					check("the top bar says an import is running", true)
					await shot(chrome, "14-import-running")
					await chrome.waitForFunction(() => !document.querySelector('[data-testid="import-pill"]'), undefined, {
						timeout: 900_000,
					})
					const rows = await chrome
						.locator('[data-testid="app-import-rows"] [data-status]')
						.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-status")))
					check(
						"every screen (and the shell) came through",
						rows.every((status) => status === "done"),
						rows.join(","),
					)
					await shot(chrome, "15-import-finished")

					const pages = ["home", "orders", "settings"]
					for (const id of pages) {
						const meta = JSON.parse(
							await fs.readFile(path.join(appDir, `.caret/pages/${id}/meta.json`), "utf-8").catch(() => "{}"),
						)
						check(
							`page "${id}" landed with its provenance`,
							Array.isArray(meta.importedFrom) && meta.importedFrom.length > 0,
							JSON.stringify(meta.importedFrom),
						)
					}
					const shellSource = await fs
						.readFile(path.join(appDir, ".caret/layouts/AppShell.tsx"), "utf-8")
						.catch(() => "")
					check("the shared layout came in once", shellSource.includes("AppShell"))
					const drift = await computeDrift(appDir)
					check(
						"every import reads clean to the sync — nothing would be written back into the app",
						drift.entries.length === 4 && drift.forward === 0 && drift.conflicts === 0,
						`${drift.entries.length} mapped, ${drift.forward} forward, ${drift.clean} clean`,
					)
					const appAfter = await readTree(appDir, (file) => !file.startsWith(".caret") && !file.startsWith(".git"))
					check("the app's own files are byte-identical", appAfter === appBefore)

					await chrome.getByTestId("top-bar").getByRole("button", { name: "Foundation" }).click()
					const badges = await (async () => {
						const deadline = Date.now() + 60_000
						while (Date.now() < deadline) {
							const count = await app.evaluate(async ({ BrowserWindow }) => {
								for (const win of BrowserWindow.getAllWindows()) {
									for (const child of win.contentView.children as any[]) {
										const url = child.webContents?.getURL?.() ?? ""
										if (!url.startsWith("http://127.0.0.1") && !url.startsWith("http://localhost")) continue
										return child.webContents.executeJavaScript(
											"document.querySelectorAll('[data-testid=\"canvas-imported-badge\"]').length",
										)
									}
								}
								return 0
							})
							if (count >= 3) return count
							await new Promise((resolve) => setTimeout(resolve, 1000))
						}
						return 0
					})()
					check("the canvas marks imported pages as from your app", badges >= 3, `${badges} badges`)

					// The canvas is a native view chrome screenshots cannot see; capture
					// it directly so the imported pages themselves can be looked at.
					await new Promise((resolve) => setTimeout(resolve, 8_000))
					const png = await app.evaluate(async ({ BrowserWindow }) => {
						for (const win of BrowserWindow.getAllWindows()) {
							for (const child of win.contentView.children as any[]) {
								const url = child.webContents?.getURL?.() ?? ""
								if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
									return (await child.webContents.capturePage()).toPNG().toString("base64")
								}
							}
						}
						return null
					})
					if (png) await fs.writeFile(path.join(SHOTS, "15b-canvas-imported.png"), Buffer.from(png, "base64"))
					for (const id of ["home", "orders", "settings"]) {
						const source = await fs
							.readFile(path.join(appDir, `.caret/pages/${id}/index.tsx`), "utf-8")
							.catch(() => "")
						await fs.writeFile(path.join(SHOTS, `page-${id}.tsx.txt`), source)
					}
					await fs.writeFile(path.join(SHOTS, "AppShell.tsx.txt"), shellSource)
				}
			}
			if (first === "error") await shot(chrome, "06-error")
		}

		check("no renderer errors on the app project", rendererErrors.length === 0, rendererErrors.join("; "))

		// ── 5. a fresh folder ─────────────────────────────────────────────────
		const opened = await chrome.evaluate(
			async (target) => Boolean(await (window as any).caret.invoke("project:open", target)),
			freshDir,
		)
		check("a fresh folder opens", opened)
		const fresh = await waitForChrome(app, freshDir)
		await fresh.setViewportSize({ width: 1280, height: 820 }).catch(() => {})
		await fresh.waitForSelector('[data-testid="foundation-entry"]', { timeout: 60_000 })
		check("a fresh folder lands on Foundation too", (await surface(fresh)) === "foundation")
		check("no app is claimed for an empty folder", (await fresh.getByTestId("foundation-app-detected").count()) === 0)
		check("the description box is the first thing", (await fresh.getByTestId("foundation-describe").count()) === 1)
		check(
			"no Back on the first screen of a fresh folder",
			(await fresh.getByTestId("foundation-describe-back").count()) === 0,
		)
		check(
			"both routes are disabled until there is a description",
			(await fresh.getByTestId("foundation-mode-collaborative").isDisabled()) &&
				(await fresh.getByTestId("foundation-mode-manual").isDisabled()),
		)
		await fresh.fill('[data-testid="foundation-describe"]', "A booking site for a small climbing gym. Friendly, a bit loud.")
		check("the routes enable once described", !(await fresh.getByTestId("foundation-mode-collaborative").isDisabled()))
		await shot(fresh, "16-fresh-describe")
		await fresh.click('[data-testid="foundation-mode-manual"]')
		const prefilled = await fresh.locator("textarea").first().inputValue({ timeout: 20_000 })
		check(
			"'Set it by hand' carries the description into the editor",
			prefilled.includes("climbing gym"),
			prefilled.slice(0, 50),
		)
		await shot(fresh, "17-fresh-manual")
	} finally {
		await app.close().catch(() => {})
		await mainLog.close().catch(() => {})
		await fs.rm(appDir, { recursive: true, force: true }).catch(() => {})
		await fs.rm(freshDir, { recursive: true, force: true }).catch(() => {})
		await fs.rm(userData, { recursive: true, force: true }).catch(() => {})
	}

	const failed = results.filter((result) => !result.ok)
	console.log(`\n${results.length - failed.length}/${results.length} passed — screenshots in ${SHOTS}`)
	process.exit(failed.length ? 1 : 0)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
