/**
 * Measures how the focused page fits the canvas, with the chat closed and open:
 * the iframe's box, the page's own width, and the canvas view's width.
 *
 *   npx tsx scripts/probe-focused-fit.ts <project> <pageId>
 */
import * as child_process from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { freshProfile, launchApp, reapOrphanedBackends } from "./verify-kit"

const [source, pageId] = process.argv.slice(2)

async function main(): Promise<void> {
	reapOrphanedBackends()
	const project = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "caret-fit-")), path.basename(source))
	child_process.execFileSync("cp", ["-cR", source, project])
	const launched = await launchApp({ project, userData: await freshProfile(), logFile: "/tmp/probe/fit.log" })
	const measure = () =>
		launched.app.evaluate(async ({ BrowserWindow }, id: string) => {
			for (let i = 0; i < 240; i++) {
				for (const win of BrowserWindow.getAllWindows()) {
					const view = ((win?.contentView?.children ?? []) as any[]).find(
						(v) => v.webContents && v.webContents.getURL().startsWith("http://127.0.0.1"),
					)
					if (!view) continue
					const wc = view.webContents
					const frame = wc.mainFrame.frames.find((f: any) => f.url.includes("mode=focused"))
					if (!frame) {
						await wc
							.executeJavaScript(
								`(() => { const f = Array.from(document.querySelectorAll('.caret-canvas-frame')).find((x) => x.querySelector('iframe')?.src?.includes('page=${id}')); if (f) f.click(); return !!f })()`,
							)
							.catch(() => false)
						continue
					}
					const box = await wc.executeJavaScript(
						`(() => { const r = document.querySelector('.caret-focused-iframe').getBoundingClientRect(); return { x: r.x, w: r.width, docW: innerWidth, zoom: devicePixelRatio } })()`,
					)
					const inner = await frame.executeJavaScript(`({ innerWidth, dpr: devicePixelRatio })`)
					return { view: view.getBounds(), zoomFactor: wc.getZoomFactor(), box, inner }
				}
				await new Promise((r) => setTimeout(r, 500))
			}
			return null
		}, pageId)
	try {
		console.log("chat closed", JSON.stringify(await measure()))
		await launched.chrome.getByTestId("top-bar").getByRole("button", { name: "Chat" }).click()
		await launched.chrome.waitForTimeout(1500)
		console.log("chat open", JSON.stringify(await measure()))
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
