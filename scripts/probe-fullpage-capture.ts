/**
 * Probe: the full-page screenshot mechanism, in real Electron, against a real
 * page (fold-landing: eager hero <model-viewer>, a GSAP-pinned scrubbed
 * section with a lazy viewer, once-only scroll reveals).
 *
 * Holds down the claims the frame capture rests on:
 *   1. The window is never resized, so vh-sized sections keep their 900px
 *      basis (innerHeight stays 900 after the settle — needs useContentSize,
 *      without it the "900" window has an 872px viewport under the macOS
 *      title bar).
 *   2. The fullPage settle's scroll sweep wakes lazy assets and plays
 *      once-only entrances before any capture, within the deadline.
 *   3. Scroll-and-shoot frames show scroll-driven content in its true state.
 *      This is why the capture scrolls instead of reading pixels below the
 *      viewport from scroll 0 (CDP captureBeyondViewport): a GSAP-pinned
 *      section has NO static content at its page offsets — its pin spacer
 *      captures as a blank band, which is exactly what the first version of
 *      this probe photographed. Held down by EYES: the probe writes every
 *      frame to /tmp/fullpage-frames/ — look at them; the pinned "Turn"
 *      section must show the model and specs, not blank.
 *
 * Run:  cd <project>/.caret && ./node_modules/.bin/vite --port 5199 &
 *       npx esbuild scripts/probe-fullpage-capture.ts --bundle --platform=node \
 *         --external:electron --outfile=/tmp/probe-fullpage.cjs
 *       npx electron /tmp/probe-fullpage.cjs
 */

import * as fs from "node:fs"
import { app, BrowserWindow } from "electron"
import { settleScript } from "../desktop/main/page-settle"

const SHELL = process.env.SHELL_URL || "http://127.0.0.1:5199"
const PAGE_ID = process.env.PAGE_ID || "fold-landing"
const OUT = "/tmp/fullpage-frames"
const FRAME_H = 900
const SCRUB_SETTLE_MS = 700

app.whenReady().then(async () => {
	const failures: string[] = []
	try {
		const win = new BrowserWindow({
			show: false,
			width: 1440,
			height: FRAME_H,
			useContentSize: true,
			paintWhenInitiallyHidden: true,
			webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
		})
		await win.loadURL(`${SHELL}/?page=${encodeURIComponent(PAGE_ID)}&isolated=1`)

		const t0 = Date.now()
		const report = (await win.webContents.executeJavaScript(settleScript(30_000, { fullPage: true }))) as {
			broken: string[]
			scrollHeight: number
		}
		const settleMs = Date.now() - t0

		const innerH = (await win.webContents.executeJavaScript("innerHeight")) as number
		if (innerH !== FRAME_H) failures.push(`innerHeight is ${innerH}, not ${FRAME_H} — vh basis drifted`)
		if (report.broken.length > 0) failures.push(`broken assets: ${report.broken.join(", ")}`)
		if (settleMs > 25_000) failures.push(`settle burned the deadline (${settleMs}ms)`)
		if (report.scrollHeight <= FRAME_H)
			failures.push(`scrollHeight ${report.scrollHeight} — page has no below-fold content, probe proves nothing`)

		fs.rmSync(OUT, { recursive: true, force: true })
		fs.mkdirSync(OUT, { recursive: true })
		const total = Math.ceil(Math.max(report.scrollHeight, FRAME_H) / FRAME_H)
		const tCap = Date.now()
		for (let i = 0; i < total; i++) {
			const target = Math.max(0, Math.min(i * FRAME_H, report.scrollHeight - FRAME_H))
			const top = (await win.webContents.executeJavaScript(
				`(async () => {
					scrollTo(0, ${target})
					await new Promise((r) => setTimeout(r, ${SCRUB_SETTLE_MS}))
					await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
					return Math.round(scrollY)
				})()`,
			)) as number
			const image = await win.webContents.capturePage()
			if (image.isEmpty()) {
				failures.push(`frame ${i + 1} (y=${top}) came back empty`)
				continue
			}
			fs.writeFileSync(`${OUT}/frame-${i + 1}-y${top}.png`, image.toPNG())
		}
		const captureMs = Date.now() - tCap

		console.log(JSON.stringify({ scrollHeight: report.scrollHeight, totalFrames: total, settleMs, captureMs }))
	} catch (err) {
		failures.push(`probe crashed: ${err instanceof Error ? err.message : String(err)}`)
	}
	if (failures.length) {
		console.error(`PROBE FAILED:\n - ${failures.join("\n - ")}`)
		process.exitCode = 1
	} else {
		console.log(`PROBE PASSED — now LOOK at the frames in ${OUT}`)
	}
	app.quit()
})
