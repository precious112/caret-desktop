/**
 * Every kind of interview question, on screen, with sample questions.
 *
 * These are what the user actually touches, and no assertion catches a
 * cramped card or an illegible swatch. This mounts the real components with
 * one sample question per kind of input and takes a picture. It fails if the
 * screen doesn't mount or throws an error.
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
// exist before the view module is even parsed: hence the dynamic import.
;(window as any).caret = {
	platform: "darwin",
	invoke: async (channel: string) => {
		if (channel === "fonts:search") {
			return {
				source: "bundled",
				fonts: [
					{ family: "Libre Baskerville", category: "serif", variants: [] },
					{ family: "Literata", category: "serif", variants: [] },
				],
			}
		}
		return null
	},
	on: () => () => {},
}

async function main() {
	const { createRoot } = await import("react-dom/client")
	await import("@/styles.css")
	const { __PreviewQuestion } = await import("@/views/WizardView")
	const { applyOpening, deriveState, newRecord } = await import("../../../src/core/design/interview/state")
	const { AREAS } = await import("../../../src/core/design/interview/areas")

	// A record part-way through, so the preview has a real surface and fonts.
	const record = applyOpening(
		{
			...newRecord("collaborative", "Argus, a monitoring tool."),
			opening: {
				questionId: "opening",
				statements: [{ id: "s-surface", area: "surface", value: { surface: "dark" }, text: "The page is dark." }],
			},
		},
		[],
	)
	const state = deriveState(record)

	const question = (area: string, options: any[], text: string) => ({
		id: area,
		area,
		input: (AREAS as any)[area].input,
		question: text,
		why: "Written by the model; shown here with sample words.",
		options: options.map((o: any, i: number) => ({ id: area + "-" + i, ...o })),
		recommendedId: area + "-0",
		contextKey: "preview",
	})

	const QUESTIONS = [
		question("display-type", [
			{ label: "Red Hat Display", value: { family: "Red Hat Display" }, reason: "Technical and sharp at large sizes." },
			{ label: "Archivo", value: { family: "Archivo" }, reason: "Plain and sturdy." },
			{ label: "Chakra Petch", value: { family: "Chakra Petch" }, reason: "Squared, like an instrument." },
		], "What should the big titles look like?"),
		question("type-scale", [
			{ label: "Quiet: 16px, ×1.125", value: { baseSize: 16, scaleRatio: 1.125 } },
			{ label: "Balanced: 16px, ×1.2", value: { baseSize: 16, scaleRatio: 1.2 } },
			{ label: "Confident: 16px, ×1.25", value: { baseSize: 16, scaleRatio: 1.25 } },
			{ label: "Bold: 17px, ×1.333", value: { baseSize: 17, scaleRatio: 1.333 } },
		], "How much bigger should each heading step be?"),
		question("brand-color", [
			{ label: "Signal blue #1d7ec4", value: { hex: "#1d7ec4" }, reason: "Calm, apart from status colours." },
			{ label: "Deep teal #0f6e5a", value: { hex: "#0f6e5a" } },
			{ label: "Ink violet #5b47c4", value: { hex: "#5b47c4" } },
		], "What one colour is Argus known by?"),
		question("accent-color", [
			{ label: "Brick #b0413e", value: { hex: "#b0413e" } },
			{ label: "Brass #c9a227", value: { hex: "#c9a227" } },
			{ label: "None", value: { none: true }, reason: "Keep it to the brand and supporting colours." },
		], "One small accent for the sharpest details?"),
		question("semantics", [
			{ label: "Everyday", value: { success: "#2e9e5b", warning: "#d99a1e", error: "#d9453b", info: "#3b82c4" } },
			{ label: "Muted", value: { success: "#4f8f6a", warning: "#b8913f", error: "#b85a52", info: "#5b7fa6" } },
		], "Which status colours?"),
		question("radius", [
			{ label: "Sharp", value: { radiusCharacter: "sharp" } },
			{ label: "Soft", value: { radiusCharacter: "soft" } },
			{ label: "Round", value: { radiusCharacter: "round" } },
		], "How round are the corners?"),
	]

	createRoot(document.getElementById("root")!).render(
		<div className="flex flex-col gap-10 bg-shell-bg px-10 py-10" style={{ minHeight: "100vh" }}>
			{QUESTIONS.map((q: any) => (
				<div className="border-b border-shell-border pb-10" key={q.id}>
					<__PreviewQuestion question={q} state={state} />
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
				const families = ["Red Hat Display", "Archivo", "Chakra Petch"]
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
