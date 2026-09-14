/**
 * The chat's markdown renderer, on screen, at the width it actually gets.
 *
 * A renderer like this typechecks and passes unit tests while still looking
 * wrong — the failures are overflow, cramped rhythm and colour, none of which an
 * assertion catches. So this mounts the real component with the real theme in a
 * 380px column and takes a picture, using the same Vite pipeline the renderer is
 * built with rather than an approximation of it.
 *
 * Costs nothing: no model and no backend. It does start Electron, because that
 * is the engine the chat renders in and Playwright's chromium no longer builds
 * for macOS 13.
 *
 *   npm run preview:markdown        → release/verify-shots/markdown.png
 */

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
// Electron rather than `chromium`: Playwright's own chromium builds no longer
// support macOS 13, and Electron is chromium, is already a dependency, and is
// the engine the chat actually renders in.
import { _electron as electron } from "playwright"
import { createServer } from "vite"

// Mirrors `CHAT_SIDEBAR_WIDTH`, not imported from it: that module reaches
// `window.caret` at import time and this script runs in Node.
const CHAT_SIDEBAR_WIDTH = 380

const OUT = path.resolve("release/verify-shots")

/** Everything a model actually emits into a chat, including the awkward parts. */
const SAMPLE = `Here's what I changed and why.

## Foundation

The scale is **almost monochrome**, so the accent has to do all the work. I kept
*one* tinted surface and made everything else \`--color-shell-*\`.

| Token | Value | Used for |
| --- | --- | --- |
| ink | #0B0D12 | body background |
| surface | #12151C | panels and cards |
| accent | #0B7AFF | links, focus, pending |
| muted | #8B93A7 | secondary text |

### The component

\`\`\`tsx
export function Hero({ title }: { title: string }) {
  return (
    <section className="mx-auto max-w-3xl px-6 py-24 text-center">
      <h1 className="text-5xl font-semibold tracking-tight">{title}</h1>
    </section>
  )
}
\`\`\`

Three things to check:

1. The heading uses \`tracking-tight\`, which reads better at display sizes
2. Padding is asymmetric — more below the fold than above
3. Nothing uses the accent yet

- [ ] confirm contrast on \`muted\` over \`surface\`
- [x] scale checked at 390px

> The chrome exists to frame the work, not to compete with it.

See the [design tokens](https://example.com/tokens) for the full set.
Inline code like \`npm run verify:app\` should sit in the line without breaking it.

---

~~Dropped~~ the second accent. A fence with no language still gets a box:

\`\`\`
CERTIFIED: all 33 scenarios pass
\`\`\`
`

/** A fence the model hasn't finished typing — the streaming case. */
const STREAMING = `Rewriting the hero now.

\`\`\`tsx
export function Hero() {
  return (
    <section className="py-24"`

const ENTRY = `
import { createRoot } from "react-dom/client"
import { Markdown } from "@/views/Markdown"
import "@/styles.css"

const SAMPLE = ${JSON.stringify(SAMPLE)}
const STREAMING = ${JSON.stringify(STREAMING)}

function Panel({ title, text }: { title: string; text: string }) {
	return (
		<div style={{ width: ${CHAT_SIDEBAR_WIDTH} }} className="shrink-0 border-r border-shell-border">
			<div className="border-b border-shell-border px-3.5 py-2 text-[11px] text-shell-muted">{title}</div>
			<div className="px-3.5 py-4 text-[13px]"><Markdown text={text} /></div>
		</div>
	)
}

createRoot(document.getElementById("root")!).render(
	<div className="flex items-start bg-shell-bg" style={{ minHeight: "100vh" }}>
		<Panel title="rendered markdown — 380px" text={SAMPLE} />
		<Panel title="mid-stream, fence still open" text={STREAMING} />
	</div>,
)
`

const HTML = `<!doctype html>
<html><head><meta charset="utf-8" /></head>
<body><div id="root"></div><script type="module" src="/src/__preview-entry.tsx"></script></body></html>`

async function main(): Promise<void> {
	// Served from the renderer's own root rather than a temp directory: module
	// resolution for `react` walks up from the file's location, and a preview
	// living in /tmp cannot see the project's node_modules at all.
	const root = path.resolve("desktop/renderer")
	const htmlPath = path.join(root, "__preview.html")
	const entryPath = path.join(root, "src", "__preview-entry.tsx")
	await fs.writeFile(htmlPath, HTML)
	await fs.writeFile(entryPath, ENTRY)

	const server = await createServer({
		root,
		plugins: [react(), tailwindcss()],
		resolve: { alias: { "@": path.join(root, "src") } },
		// `strictPort` so a stale server on the same port is an error rather than a
		// silent move to the next one — which serves the *previous* run's files to
		// a URL that still looks right.
		server: { port: 5177, strictPort: true },
		logLevel: "warn",
	})
	await server.listen()
	const url = server.resolvedUrls?.local[0]
	if (!url) throw new Error("vite started without a local url")

	const shell = await fs.mkdtemp(path.join(os.tmpdir(), "caret-md-shell-"))
	const mainScript = path.join(shell, "main.js")
	await fs.writeFile(
		mainScript,
		`const { app, BrowserWindow } = require("electron")
app.whenReady().then(() => {
	new BrowserWindow({
		width: ${CHAT_SIDEBAR_WIDTH * 2 + 4},
		height: 1200,
		backgroundColor: "#0b0d12",
	}).loadURL("${url}__preview.html")
})`,
	)

	const browser = await electron.launch({ args: [mainScript], env: { ...process.env, CARET_DISABLE_TELEMETRY: "1" } })
	try {
		const page = await browser.firstWindow({ timeout: 60_000 })
		const errors: string[] = []
		page.on("pageerror", (err) => errors.push(String(err)))
		page.on("console", (message) => message.type() === "error" && errors.push(message.text()))

		// Diagnosed rather than awaited forever: a module that fails to resolve
		// renders an empty body, and a bare `waitForSelector` turns that into a
		// hang with no message.
		const mounted = await page
			.waitForSelector("table", { timeout: 20_000 })
			.then(() => true)
			.catch(() => false)
		if (!mounted) {
			const body = await page.evaluate(() => document.body.innerHTML.slice(0, 600))
			console.log(`the preview did not mount.\n  errors: ${errors.join(" | ") || "(none)"}\n  body: ${body}`)
		}

		await fs.mkdir(OUT, { recursive: true })
		const shot = path.join(OUT, "markdown.png")
		await page.screenshot({ path: shot, fullPage: true })

		// Overflow is the failure this component is most likely to have, and a
		// screenshot alone will not tell you: a table wider than its box looks
		// fine in the picture and clips in the app.
		const overflow = await page.evaluate(() => {
			const bad: string[] = []
			for (const element of Array.from(document.querySelectorAll("body *"))) {
				const el = element as HTMLElement
				const style = getComputedStyle(el)
				const scrolls = style.overflowX === "auto" || style.overflowX === "scroll"
				if (!scrolls && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
					bad.push(`${el.tagName.toLowerCase()}.${el.className}: ${el.scrollWidth}px in ${el.clientWidth}px`)
				}
			}
			return bad.slice(0, 8)
		})

		console.log(`screenshot → ${shot}`)
		if (errors.length) console.log(`\nRENDER ERRORS:\n  ${errors.join("\n  ")}`)
		if (overflow.length) console.log(`\nOVERFLOWING (clipped, not scrollable):\n  ${overflow.join("\n  ")}`)
		else console.log("no element overflows its box outside a scroll container")
	} finally {
		await browser.close()
		await server.close()
		// Only the two files this wrote — `root` is the renderer's real source.
		await fs.rm(htmlPath, { force: true })
		await fs.rm(entryPath, { force: true })
		await fs.rm(shell, { recursive: true, force: true })
	}
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})
