/**
 * Reproduces a field report: editing the text of an animated paragraph (a
 * Motion `motion.p` that fades in) on the canvas showed "Page failed to load:
 * Too many re-renders", although the file was fine afterwards.
 *
 * Runs the built Caret on a COPY of a project, opens a page, right-clicks the
 * paragraph, chooses "Edit text", types with real key presses and presses
 * Enter, exactly as a person does. Then it watches the page for the error
 * screen and records every error the page logged.
 *
 *   npx tsx scripts/repro-motion-edit.ts <project> <pageId> "<start of the paragraph's text>"
 */
import * as child_process from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { freshProfile, launchApp, reapOrphanedBackends } from "./verify-kit"

const [source, pageId, textStart] = process.argv.slice(2)
/**
 * edit (default): the canvas text edit, as a person does it.
 * write: no canvas edit; the file is changed on disk and the preview swaps it in.
 * edit-grab-off: the canvas edit, with react-grab kept off while the preview swaps it in.
 * edit-nofreeze: react-grab told not to freeze React updates, and left on throughout.
 */
const MODE = process.env.REPRO_MODE ?? "edit"
const OUT = path.resolve("release/repro-motion-edit")

async function main(): Promise<void> {
	if (!source || !pageId || !textStart) throw new Error('usage: repro-motion-edit.ts <project> <pageId> "<text start>"')
	reapOrphanedBackends()
	await fs.rm(OUT, { recursive: true, force: true })
	await fs.mkdir(OUT, { recursive: true })
	const project = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "caret-repro-")), path.basename(source))
	child_process.execFileSync("cp", ["-cR", source, project])
	const pageFile = path.join(project, ".caret", "pages", pageId, "index.tsx")
	const before = await fs.readFile(pageFile, "utf8")

	const launched = await launchApp({ project, userData: await freshProfile(), logFile: path.join(OUT, "main.log") })
	try {
		const outcome = await launched.app.evaluate(
			async ({ BrowserWindow }, args: { pageId: string; textStart: string; out: string; mode: string; pageFile: string }) => {
				const log: string[] = []
				let canvas: any = null
				const viewDeadline = Date.now() + 120000
				while (Date.now() < viewDeadline && !canvas) {
					for (const win of BrowserWindow.getAllWindows()) {
						const views = (win?.contentView?.children ?? []) as any[]
						const found = views.find(
							(v) => v.webContents && !v.webContents.isDestroyed() && v.webContents.getURL().startsWith("http://127.0.0.1"),
						)
						if (found) canvas = found
					}
					if (!canvas) await new Promise((r) => setTimeout(r, 500))
				}
				if (!canvas) return { error: "the canvas never mounted", log }
				const wc = canvas.webContents
				wc.on("console-message", (_e: unknown, level: number, message: string) => {
					if (level >= 2 || /re-render|failed|error/i.test(message)) log.push(`[console ${level}] ${message.slice(0, 400)}`)
				})

				// Open the page from the canvas grid.
				const findCard = `(() => {
					const frames = Array.from(document.querySelectorAll('.caret-canvas-frame'))
					return frames.find((f) => f.textContent && f.querySelector('.caret-canvas-frame-title')) && frames.find((f) => (f.getAttribute('data-page-id') || f.getAttribute('data-page') || f.querySelector('.caret-canvas-frame-title')?.textContent || '').includes(${JSON.stringify(args.pageId)}) || f.querySelector('iframe')?.src?.includes('page=${args.pageId}')) || frames[0] || null
				})()`
				let deadline = Date.now() + 120000
				let cardReady = false
				while (Date.now() < deadline && !cardReady) {
					cardReady = await wc.executeJavaScript(`!!${findCard}`).catch(() => false)
					if (!cardReady) await new Promise((r) => setTimeout(r, 500))
				}
				if (!cardReady) return { error: "the page's card never appeared", log }
				await wc.executeJavaScript(`(${findCard}).click(), true`)

				let pageFrame: any = null
				deadline = Date.now() + 60000
				while (Date.now() < deadline && !pageFrame) {
					pageFrame = wc.mainFrame.frames.find((f: any) => f.url.includes("mode=focused") && f.url.includes(`page=${args.pageId}`)) ?? null
					if (!pageFrame) await new Promise((r) => setTimeout(r, 250))
				}
				if (!pageFrame) return { error: "the focused page never became a frame", log }

				const locate = `(() => {
					const all = Array.from(document.querySelectorAll('[data-caret-id]'))
					const el = all.filter((n) => (n.textContent || '').trim().startsWith(${JSON.stringify(args.textStart)})).pop()
					if (!el) return null
					el.scrollIntoView({ block: 'center' })
					const r = el.getBoundingClientRect()
					return { id: el.getAttribute('data-caret-id'), x: r.x + Math.min(40, r.width / 2), y: r.y + r.height / 2, w: innerWidth }
				})()`
				let target: any = null
				deadline = Date.now() + 60000
				while (Date.now() < deadline && !target) {
					pageFrame = wc.mainFrame.frames.find((f: any) => f.url.includes(`page=${args.pageId}`)) ?? pageFrame
					target = await pageFrame.executeJavaScript(locate).catch(() => null)
					if (!target) await new Promise((r) => setTimeout(r, 500))
				}
				if (!target) return { error: `no element whose text starts "${args.textStart}"`, log }
				log.push(`target: ${target.id}`)
				// As the page opened, before anything here touched react-grab: did the fade-in play?
				await new Promise((r) => setTimeout(r, 3000))
				log.push(
					`paragraph opacity 3s after the page opened: ${await pageFrame
						.executeJavaScript(`getComputedStyle(document.querySelector('[data-caret-id="${target.id}"]')).opacity`)
						.catch(() => "?")}`,
				)
				// react-grab freezes the page's animations while it is on, so every
				// fade-in stays invisible. Off until the paragraph has faded in, as a
				// person sees it, then on again for the right-click.
				if (args.mode === "edit-nofreeze") {
					await pageFrame
						.executeJavaScript(`((window).__REACT_GRAB__?.setOptions?.({ freezeReactUpdates: false }), (window).__REACT_GRAB__?.activate?.(), true)`)
						.catch(() => {})
				} else {
					await pageFrame.executeJavaScript(`((window).__REACT_GRAB__?.deactivate?.(), true)`).catch(() => {})
				}
				deadline = Date.now() + 20000
				let opacity = "0"
				while (Date.now() < deadline && opacity !== "1") {
					opacity = await pageFrame
						.executeJavaScript(`getComputedStyle(document.querySelector('[data-caret-id="${target.id}"]')).opacity`)
						.catch(() => "0")
					if (opacity !== "1") await new Promise((r) => setTimeout(r, 250))
				}
				log.push(`paragraph opacity with react-grab off: ${opacity}`)
				await pageFrame.executeJavaScript(`((window).__REACT_GRAB__?.activate?.(), true)`).catch(() => {})
				await new Promise((r) => setTimeout(r, 1500))
				target = await pageFrame.executeJavaScript(locate)

				if (args.mode === "write") {
					const fs = (process as any).getBuiltinModule("fs")
					const text = fs.readFileSync(args.pageFile, "utf8")
					fs.writeFileSync(args.pageFile, text.replace("One Docker command", "One Docker command, always"))
					log.push("wrote the change to the file directly")
				}

				// The focused page is scaled into the view: map page points through the scale.
				const frameBox = await wc.executeJavaScript(
					`(() => { const r = document.querySelector('.caret-focused-iframe').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width } })()`,
				)
				const scale = frameBox.w / target.w
				const at = { x: Math.round(frameBox.x + target.x * scale), y: Math.round(frameBox.y + target.y * scale) }

				let menuClicked = false
				for (let attempt = 0; attempt < 5 && !menuClicked; attempt++) {
					wc.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y })
					await new Promise((r) => setTimeout(r, 300))
					wc.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "right", clickCount: 1 })
					wc.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "right", clickCount: 1 })
					await new Promise((r) => setTimeout(r, 700))
					const shot = await wc.capturePage()
					;(process as any).getBuiltinModule("fs").writeFileSync(`${args.out}/after-right-click-${attempt}.png`, shot.toPNG())
					const menuDeadline = Date.now() + 4000
					while (Date.now() < menuDeadline && !menuClicked) {
						menuClicked = await pageFrame
							.executeJavaScript(
								`(() => {
									const host = document.querySelector('[data-react-grab]')
									const root = host && host.shadowRoot
									if (!root) return false
									const item = Array.from(root.querySelectorAll('button, [role="menuitem"], div')).filter((n) => n.textContent && n.textContent.trim() === 'Edit text').pop()
									if (!item) return false
									item.click()
									return true
								})()`,
							)
							.catch(() => false)
						if (!menuClicked) await new Promise((r) => setTimeout(r, 250))
					}
				}
				if (!menuClicked) return { error: "the menu never offered Edit text", log }
				log.push(`clicked at ${JSON.stringify(at)}, scale ${scale.toFixed(3)}, target ${JSON.stringify(target)}`)
				await new Promise((r) => setTimeout(r, 600))
				const editable = await pageFrame.executeJavaScript(
					`(() => { const el = document.querySelector('[data-caret-id="${target.id}"]'); return el ? el.contentEditable : 'gone' })()`,
				)
				log.push(`contentEditable after Edit text: ${editable}`)

				if (args.mode !== "write") {
				// Type like a person: end of the text, then a few characters, then Enter.
				wc.sendInputEvent({ type: "keyDown", keyCode: "End" })
				wc.sendInputEvent({ type: "keyUp", keyCode: "End" })
				for (const ch of " Always.") {
					wc.sendInputEvent({ type: "keyDown", keyCode: ch })
					wc.sendInputEvent({ type: "char", keyCode: ch })
					wc.sendInputEvent({ type: "keyUp", keyCode: ch })
					await new Promise((r) => setTimeout(r, 40))
				}
				await new Promise((r) => setTimeout(r, 300))
				wc.sendInputEvent({ type: "keyDown", keyCode: "Return" })
				wc.sendInputEvent({ type: "char", keyCode: "\r" })
				wc.sendInputEvent({ type: "keyUp", keyCode: "Return" })
				if (args.mode === "edit-grab-off") {
					const offUntil = Date.now() + 5000
					while (Date.now() < offUntil) {
						await pageFrame.executeJavaScript(`((window).__REACT_GRAB__?.deactivate?.(), true)`).catch(() => {})
						await new Promise((r) => setTimeout(r, 50))
					}
					log.push("kept react-grab off while the preview swapped the edit in")
				}
				}

				// Watch for the error screen for 15 seconds after the edit.
				let crashed: string | null = null
				const watchUntil = Date.now() + 15000
				while (Date.now() < watchUntil && !crashed) {
					for (const frame of wc.mainFrame.frames.filter((f: any) => f.url.includes(`page=${args.pageId}`))) {
						const err = await frame
							.executeJavaScript(`document.querySelector('[data-caret-page-error]')?.getAttribute('data-caret-page-error') ?? null`)
							.catch(() => null)
						if (err) crashed = err
					}
					if (!crashed) await new Promise((r) => setTimeout(r, 300))
				}
				return { crashed, log }
			},
			{ pageId, textStart, out: OUT, mode: MODE, pageFile },
		)
		const after = await fs.readFile(pageFile, "utf8")
		console.log(JSON.stringify({ ...outcome, fileChanged: after !== before, typedTextLanded: after.includes("Always.") }, null, 2))
		await launched.chrome.screenshot({ path: path.join(OUT, "after-edit.png") }).catch(() => {})
	} finally {
		await launched.close()
		reapOrphanedBackends()
	}
}

main()
	.catch((err) => {
		console.error(err instanceof Error ? err.message : err)
		process.exitCode = 1
	})
	.finally(() => setTimeout(() => process.exit(), 500))
