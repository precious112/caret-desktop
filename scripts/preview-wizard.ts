/**
 * Every wizard widget, on screen, with scripted questions.
 *
 * The widget suite is the feature — the model composes questions, but these
 * components are what the user actually touches, and no assertion catches a
 * cramped card or an illegible swatch. This mounts the real components with
 * one hand-written question per kind and takes a picture.
 *
 * Costs nothing: no model, no backend. `window.caret` is shimmed before the
 * view module loads, because the renderer's ipc module reads it at import time.
 *
 *   npm run preview:wizard        → release/verify-shots/wizard.png
 */

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { _electron as electron } from "playwright"
import { createServer } from "vite"

const OUT = path.resolve("release/verify-shots")

const ENTRY = `
// The ipc module dereferences window.caret at import time, so the shim has to
// exist before the view module is even parsed — hence the dynamic import.
;(window as any).caret = {
	platform: "darwin",
	invoke: async (channel: string, ...args: any[]) => {
		if (channel === "fonts:search") {
			return [
				{ family: "Fraunces", category: "serif", variants: [] },
				{ family: "Sora", category: "sans-serif", variants: [] },
				{ family: "IBM Plex Mono", category: "monospace", variants: [] },
			]
		}
		return null
	},
	on: () => () => {},
}

async function main() {
	const { createRoot } = await import("react-dom/client")
	await import("@/styles.css")
	const { __PreviewQuestion } = await import("@/views/WizardView")
	const { FoundationEntry } = await import("@/views/FoundationEntry")

	const base = { surface: "dark", neutral: "cool", accent: "#22d3ee", radius: 4, spacingUnit: 4, baseSize: 14, displayFamily: "Space Grotesk", bodyFamily: "Inter" }

	const QUESTIONS: any[] = [
		{
			id: "assume", kind: "assumptions",
			question: "Here's what I took from your description — right?",
			why: "Confirming these means I don't have to ask about them.",
			options: [
				{ id: "a1", label: "This is a tool people keep open all day, so it should be quiet and dense", reason: "you said agents live in it" },
				{ id: "a2", label: "Dark interface first — light mode can come later", reason: "you said dark, calm" },
				{ id: "a3", label: "Nothing playful: no rounded bubbles, no bright gradients" },
			],
		},
		{
			id: "font", kind: "font", other: "font",
			question: "How should the words look?",
			why: "This is read for hours, so the body face matters more than the headline.",
			options: [
				{ id: "f1", label: "Space Grotesk", reason: "technical without being cold — fits a tool devs respect", spec: { bodyFamily: "Inter" } },
				{ id: "f2", label: "Instrument Serif", reason: "editorial, calmer, but unusual for a dashboard", spec: { bodyFamily: "Inter" } },
				{ id: "f3", label: "IBM Plex Sans", reason: "engineered feel, pairs with your data tables", spec: { bodyFamily: "IBM Plex Sans" } },
			],
			recommendedId: "f1",
		},
		{
			id: "brand", kind: "color", other: "color",
			question: "Which colour is yours?",
			why: "It gets used sparingly — mostly the primary action and focus states.",
			options: [
				{ id: "c1", label: "Signal cyan", hex: "#22d3ee", reason: "reads as live data against a dark surface" },
				{ id: "c2", label: "Deep blue", hex: "#2563eb", reason: "quieter, more institutional" },
				{ id: "c3", label: "Amber", hex: "#f59e0b", reason: "warmer, but competes with your warning states" },
			],
			recommendedId: "c1",
		},
		{
			id: "density", kind: "scale",
			question: "How tight should the information sit?",
			why: "Support agents scan this for eight hours; density is comfort, not style.",
			leftLabel: "Compact", rightLabel: "Airy",
			steps: [
				{ label: "Dense", spec: { spacingUnit: 4, baseSize: 13, radius: 2 } },
				{ label: "Comfortable", spec: { spacingUnit: 4, baseSize: 14, radius: 4 } },
				{ label: "Relaxed", spec: { spacingUnit: 8, baseSize: 15, radius: 8 } },
				{ label: "Open", spec: { spacingUnit: 8, baseSize: 16, radius: 12 } },
			],
			defaultStep: 1,
		},
		{
			id: "surfaces", kind: "chips", other: "text",
			question: "What does the product actually include?",
			why: "A marketing page and a data table want different defaults.",
			options: [
				{ id: "s1", label: "Dashboard" }, { id: "s2", label: "Data tables" }, { id: "s3", label: "Settings & forms" },
				{ id: "s4", label: "Marketing site" }, { id: "s5", label: "Docs" },
			],
			recommendedId: "s1",
		},
		{
			id: "name", kind: "text",
			question: "What's it called?",
			why: "So the previews say your name instead of placeholder words.",
			placeholder: "e.g. Dispatch",
		},
	]

	createRoot(document.getElementById("root")!).render(
		<div className="flex flex-col gap-10 bg-shell-bg px-10 py-10" style={{ minHeight: "100vh" }}>
			{/* The entry flow: describe, then the three-door chooser. */}
			<div className="border-b border-shell-border pb-10">
				<FoundationEntry onManual={() => {}} onStarted={() => {}} projectPath="/tmp/preview" />
			</div>
			<div className="border-b border-shell-border pb-10">
				<FoundationEntry
					__previewDescription="A dashboard where support teams triage tickets all day. Dark, calm, serious."
					onManual={() => {}}
					onStarted={() => {}}
					projectPath="/tmp/preview"
				/>
			</div>
			{QUESTIONS.map((question, index) => (
				<div className="border-b border-shell-border pb-10" key={question.id}>
					<__PreviewQuestion base={base} index={index} question={question} />
				</div>
			))}
		</div>,
	)
}
void main()
`

const HTML = `<!doctype html>
<html><head><meta charset="utf-8" /></head>
<body><div id="root"></div><script type="module" src="/src/__wizard-preview-entry.tsx"></script></body></html>`

async function main(): Promise<void> {
	const root = path.resolve("desktop/renderer")
	const htmlPath = path.join(root, "__wizard-preview.html")
	const entryPath = path.join(root, "src", "__wizard-preview-entry.tsx")
	await fs.writeFile(htmlPath, HTML)
	await fs.writeFile(entryPath, ENTRY)

	const server = await createServer({
		root,
		plugins: [react(), tailwindcss()],
		resolve: { alias: { "@": path.join(root, "src") } },
		server: { port: 5178, strictPort: true },
		logLevel: "warn",
	})
	await server.listen()
	const url = server.resolvedUrls?.local[0]
	if (!url) throw new Error("vite started without a local url")

	const shell = await fs.mkdtemp(path.join(os.tmpdir(), "caret-wizard-shell-"))
	const mainScript = path.join(shell, "main.js")
	await fs.writeFile(
		mainScript,
		`const { app, BrowserWindow } = require("electron")
app.whenReady().then(() => {
	new BrowserWindow({ width: 1080, height: 1200, backgroundColor: "#0b0d12" }).loadURL("${url}__wizard-preview.html")
})`,
	)

	const browser = await electron.launch({ args: [mainScript], env: { ...process.env, CARET_DISABLE_TELEMETRY: "1" } })
	try {
		const page = await browser.firstWindow({ timeout: 60_000 })
		const errors: string[] = []
		page.on("pageerror", (err) => errors.push(String(err)))
		page.on("console", (message) => message.type() === "error" && errors.push(message.text()))

		const mounted = await page
			.waitForSelector('[data-testid="wizard-question"]', { timeout: 20_000 })
			.then(() => true)
			.catch(() => false)
		if (!mounted) {
			const body = await page.evaluate(() => document.body.innerHTML.slice(0, 600))
			console.log(`the preview did not mount.\n  errors: ${errors.join(" | ") || "(none)"}\n  body: ${body}`)
		}

		// Web fonts land async, and `document.fonts.status` reads "loaded" before a
		// face that nothing has *painted in yet* is fetched. Loading each family
		// explicitly is the only wait that proves the specimens show real faces —
		// which is the entire reason this screenshot exists.
		const loaded = await page
			.evaluate(async () => {
				const families = ["Space Grotesk", "Instrument Serif", "IBM Plex Sans", "Inter"]
				const results = await Promise.all(
					families.map((family) =>
						document.fonts.load(`500 21px "${family}"`).then(
							(faces) => [family, faces.length > 0] as const,
							() => [family, false] as const,
						),
					),
				)
				return results.filter(([, ok]) => !ok).map(([family]) => family)
			})
			.catch(() => ["(font check itself failed)"])
		if (loaded.length) console.log(`FONTS NOT LOADED: ${loaded.join(", ")} — the specimens below show fallbacks`)

		await fs.mkdir(OUT, { recursive: true })
		const shot = path.join(OUT, "wizard.png")
		await page.screenshot({ path: shot, fullPage: true })
		console.log(`screenshot → ${shot}`)
		if (errors.length) console.log(`\nRENDER ERRORS:\n  ${errors.join("\n  ")}`)
	} finally {
		await browser.close()
		await server.close()
		await fs.rm(htmlPath, { force: true })
		await fs.rm(entryPath, { force: true })
		await fs.rm(shell, { recursive: true, force: true })
	}
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})
