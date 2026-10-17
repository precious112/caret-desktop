/**
 * Captures the canvas with an element selected, so the property sidebar can be
 * looked at (the app checks' screenshots can't see the canvas view).
 *
 *   npx tsx scripts/probe-inspector-look.ts <project> <pageId> "<start of an element's text>"
 */
import * as child_process from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { freshProfile, launchApp, reapOrphanedBackends } from "./verify-kit"

const [source, pageId, textStart] = process.argv.slice(2)
const OUT = path.resolve("release/probe-inspector")

async function main(): Promise<void> {
	reapOrphanedBackends()
	await fs.mkdir(OUT, { recursive: true })
	const project = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "caret-look-")), path.basename(source))
	child_process.execFileSync("cp", ["-cR", source, project])
	const launched = await launchApp({ project, userData: await freshProfile(), logFile: path.join(OUT, "main.log") })
	try {
		const result = await launched.app.evaluate(
			async ({ BrowserWindow }, args: { pageId: string; textStart: string; out: string }) => {
				let wc: any = null
				for (let i = 0; i < 240 && !wc; i++) {
					for (const win of BrowserWindow.getAllWindows()) {
						const view = ((win?.contentView?.children ?? []) as any[]).find(
							(v) => v.webContents && v.webContents.getURL().startsWith("http://127.0.0.1"),
						)
						if (view) wc = view.webContents
					}
					if (!wc) await new Promise((r) => setTimeout(r, 500))
				}
				if (!wc) return "no canvas"
				let frame: any = null
				for (let i = 0; i < 240 && !frame; i++) {
					frame = wc.mainFrame.frames.find((f: any) => f.url.includes("mode=focused")) ?? null
					if (!frame)
						await wc
							.executeJavaScript(
								`(() => { const f = Array.from(document.querySelectorAll('.caret-canvas-frame')).find((x) => x.querySelector('iframe')?.src?.includes('page=${args.pageId}')); if (f) f.click(); return !!f })()`,
							)
							.catch(() => false)
					await new Promise((r) => setTimeout(r, 500))
				}
				if (!frame) return "no focused page"
				await new Promise((r) => setTimeout(r, 4000))
				await frame.executeJavaScript(`(window.__REACT_GRAB__?.activate?.(), true)`)
				const point = await frame.executeJavaScript(
					`(() => { const el = Array.from(document.querySelectorAll('[data-caret-id]')).filter((n) => (n.textContent || '').trim().startsWith(${JSON.stringify(args.textStart)})).pop(); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`,
				)
				if (!point) return "no element"
				const box = await wc.executeJavaScript(
					`(() => { const r = document.querySelector('.caret-focused-iframe').getBoundingClientRect(); return { x: r.x, y: r.y } })()`,
				)
				const at = { x: Math.round(box.x + point.x), y: Math.round(box.y + point.y) }
				wc.sendInputEvent({ type: "mouseMove", x: at.x - 10, y: at.y })
				wc.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y })
				await new Promise((r) => setTimeout(r, 300))
				wc.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 })
				wc.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount: 1 })
				await new Promise((r) => setTimeout(r, 2500))
				// Hover something else while selected: nothing should light up.
				wc.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y + 160 })
				wc.sendInputEvent({ type: "mouseMove", x: at.x + 4, y: at.y + 170 })
				await new Promise((r) => setTimeout(r, 600))
				const fs = (process as any).getBuiltinModule("fs")
				fs.writeFileSync(`${args.out}/selected.png`, (await wc.capturePage()).toPNG())
				return "ok"
			},
			{ pageId, textStart, out: OUT },
		)
		console.log(result)
		await launched.chrome.screenshot({ path: path.join(OUT, "chrome.png") })
	} finally {
		await launched.close()
		reapOrphanedBackends()
	}
}

main()
	.catch((err) => {
		console.error(err)
		process.exitCode = 1
	})
	.finally(() => setTimeout(() => process.exit(), 500))
