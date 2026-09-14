/**
 * Maximum-fidelity reproduction of the field failure: the user's ACTUAL
 * log-a-brew page (copied verbatim from test2, AppShell included), the real
 * app, a real right-click on the real 70×30px chip — with coordinates mapped
 * through the focused iframe's scale, because the chip is far too small to
 * survive the unscaled-click error that big fixtures hide.
 *
 * The simplified big-chip fixture (probe-row-edit-primitive.ts) PASSES; the
 * user's page FAILS. Whatever differs is in here.
 *
 *   npm run build && npx tsx scripts/probe-row-edit-real-page.ts
 */
import * as child_process from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { _electron as electron } from "playwright"

import { ensureCaretDirectoryExists } from "../src/core/design/scaffold"

const REAL = "/Users/apple/dev/test-frontend/test2/.caret"

async function main(): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "caret-real-row-probe-"))
	await ensureCaretDirectoryExists(dir)

	// The user's page and its one dependency, verbatim.
	await fs.mkdir(path.join(dir, ".caret", "components"), { recursive: true })
	await fs.copyFile(path.join(REAL, "components", "AppShell.tsx"), path.join(dir, ".caret", "components", "AppShell.tsx"))
	const pageDir = path.join(dir, ".caret", "pages", "log-a-brew")
	await fs.mkdir(pageDir, { recursive: true })
	const pagePath = path.join(pageDir, "index.tsx")
	await fs.copyFile(path.join(REAL, "pages", "log-a-brew", "index.tsx"), pagePath)
	await fs.copyFile(path.join(REAL, "pages", "log-a-brew", "meta.json"), path.join(pageDir, "meta.json"))

	const git = (args: string) => child_process.execSync(`git ${args}`, { cwd: dir, stdio: "ignore" })
	git("init -q")
	git("config user.email caret@local")
	git("config user.name Caret")
	git("add -A")
	git("commit -qm fixture")

	const userData = await fs.mkdtemp(path.join(os.tmpdir(), "caret-real-row-probe-profile-"))
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), `--user-data-dir=${userData}`, dir],
		env: { ...process.env, CARET_VERIFY_PROJECT: dir, NODE_ENV: "test" },
	})
	try {
		await app.evaluate(({ webContents, app: electronApp }) => {
			const g = globalThis as any
			g.__PROBE_LOGS__ = []
			for (const wc of webContents.getAllWebContents()) {
				wc.on("console-message", (_e: any, _l: any, message: any) => g.__PROBE_LOGS__.push(String(message)))
			}
			;(electronApp as any).on("web-contents-created", (_e: any, wc: any) => {
				wc.on("console-message", (_ev: any, _lv: any, message: any) => g.__PROBE_LOGS__.push(String(message)))
			})
		})

		const outcome = await app.evaluate(async ({ BrowserWindow }) => {
			try {
				let wc: any = null
				let deadline = Date.now() + 120_000
				while (Date.now() < deadline && !wc) {
					for (const win of BrowserWindow.getAllWindows()) {
						const views = (win.contentView?.children ?? []) as any[]
						const found = views.find(
							(v) =>
								v.webContents &&
								!v.webContents.isDestroyed() &&
								v.webContents.getURL().startsWith("http://127.0.0.1"),
						)
						if (found) wc = found.webContents
					}
					if (!wc) await new Promise((r) => setTimeout(r, 500))
				}
				if (!wc) return { error: "no canvas view appeared" }

				deadline = Date.now() + 120_000
				let opened = false
				while (Date.now() < deadline && !opened) {
					opened = await wc
						.executeJavaScript(
							`(() => {
								const card = Array.from(document.querySelectorAll('.caret-canvas-frame-title')).find((n) => n.textContent && n.textContent.includes('Log a brew'))
								if (!card) return false
								card.closest('.caret-canvas-frame').dispatchEvent(new MouseEvent('click', { bubbles: true }))
								return true
							})()`,
						)
						.catch(() => false)
					if (!opened) await new Promise((r) => setTimeout(r, 500))
				}
				if (!opened) return { error: "the Log a brew card never appeared" }

				let pageFrame: any = null
				deadline = Date.now() + 60_000
				while (Date.now() < deadline) {
					pageFrame =
						wc.mainFrame.frames.find(
							(f: any) => f.url.includes("mode=focused") && f.url.includes("page=log-a-brew"),
						) ?? null
					if (pageFrame) {
						const chips = await pageFrame
							.executeJavaScript(`document.querySelectorAll('[data-caret-id="span-3"]').length`)
							.catch(() => 0)
						if (chips === 8) break
					}
					await new Promise((r) => setTimeout(r, 300))
				}
				if (!pageFrame) return { error: "the focused page never became a frame" }
				await pageFrame.executeJavaScript(`((window).__REACT_GRAB__?.activate?.(), true)`).catch(() => {})
				await new Promise((r) => setTimeout(r, 800))

				// Scroll the chip into view, then map its centre through the iframe's
				// scale — the chip is 70×30, well inside the unscaled-click error.
				await pageFrame.executeJavaScript(
					`(document.querySelectorAll('[data-caret-id="span-3"]')[2].scrollIntoView({ block: "center" }), true)`,
				)
				await new Promise((r) => setTimeout(r, 600))
				const geom = await wc.executeJavaScript(
					`(() => { const r = document.querySelector('.caret-focused-iframe').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width } })()`,
				)
				const inner = await pageFrame.executeJavaScript(
					`(() => { const r = document.querySelectorAll('[data-caret-id="span-3"]')[2].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, innerW: window.innerWidth, text: document.querySelectorAll('[data-caret-id="span-3"]')[2].textContent } })()`,
				)
				const scale = geom.w / inner.innerW
				const at = { x: Math.round(geom.x + inner.x * scale), y: Math.round(geom.y + inner.y * scale) }

				let menuClicked = false
				for (let attempt = 0; attempt < 6 && !menuClicked; attempt++) {
					pageFrame = wc.mainFrame.frames.find((f: any) => f.url.includes("page=log-a-brew")) ?? pageFrame
					wc.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y })
					await new Promise((r) => setTimeout(r, 300))
					wc.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "right", clickCount: 1 })
					wc.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "right", clickCount: 1 })
					const menuDeadline = Date.now() + 4000
					while (Date.now() < menuDeadline && !menuClicked) {
						menuClicked = await pageFrame
							.executeJavaScript(
								`(() => {
									const host = document.querySelector('[data-react-grab]')
									const root = host && host.shadowRoot
									if (!root) return false
									const items = Array.from(root.querySelectorAll('button, [role="menuitem"], div'))
									const item = items.find((n) => n.textContent && n.textContent.trim() === 'Edit text')
									if (!item) return false
									item.click()
									return true
								})()`,
							)
							.catch(() => false)
						if (!menuClicked) await new Promise((r) => setTimeout(r, 250))
					}
				}
				if (!menuClicked)
					return { error: "react-grab's menu never offered Edit text on the chip", chip: inner.text, at, scale }

				await new Promise((r) => setTimeout(r, 500))
				const committed = await pageFrame.executeJavaScript(
					`(() => {
						// The element that ACTUALLY went contentEditable — react-grab hands
						// its own ctx.element to the action; record which one it was.
						const editable = document.querySelector('[contenteditable="true"]')
						if (!editable) return { state: 'nothing-editable' }
						const info = { state: 'ok', tag: editable.tagName, caretId: editable.getAttribute('data-caret-id'), text: editable.textContent }
						editable.textContent = 'Balanced'
						editable.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
						return info
					})()`,
				)
				await new Promise((r) => setTimeout(r, 3000))
				const failureUx = await pageFrame.executeJavaScript(
					`JSON.stringify({
						chipText: document.querySelectorAll('[data-caret-id="span-3"]')[2].textContent,
						fallbackCard: document.querySelector('#caret-ai-edit-fallback')?.textContent?.slice(0, 250) ?? null,
					})`,
				)
				return { ok: true, clicked: inner.text, editable: committed, failureUx }
			} catch (err) {
				return { error: err instanceof Error ? err.message : String(err) }
			}
		})

		console.log("outcome:", JSON.stringify(outcome, null, 2))
		const logs = await app.evaluate(() => (globalThis as any).__PROBE_LOGS__ as string[])
		console.log("--- edit lines ---")
		for (const line of logs.filter((l) => l.includes("edit"))) console.log(line)

		// The contract: the edit lands on the data item of the chip that was
		// ACTUALLY clicked — whichever one the pointer hit — and no other item.
		const after = await fs.readFile(pagePath, "utf-8")
		const clicked = ((outcome as any).clicked ?? "").trim()
		console.log("--- file state ---")
		if (!clicked) {
			console.log("no chip was clicked — see outcome above")
		} else if (after.includes('"Balanced"') && !after.includes(`"${clicked}"`)) {
			console.log(`FILE EDITED ✓ — the clicked chip's item ("${clicked}") became "Balanced"; other items untouched:`)
			console.log(
				after
					.split("\n")
					.find((l) => l.includes('"Balanced"'))
					?.trim(),
			)
		} else {
			console.log(
				`FAILED ✗ — clicked "${clicked}" but the file ${after.includes('"Balanced"') ? "edited a DIFFERENT item" : "was not edited"}`,
			)
		}
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
