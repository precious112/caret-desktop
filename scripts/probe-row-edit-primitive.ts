/**
 * Reproduces the field failure: inline text edit on a `.map()` over PLAIN
 * STRINGS errors with "The data changed since this row was rendered" on a
 * fresh page, first attempt — while the resolver, unit-tested with the same
 * inputs, edits cleanly. Something between the page and the resolver sends a
 * wrong value; this probe drives the REAL gesture in the REAL app and captures
 * the exact payload the canvas sends (the `[caret-grab] edit-text: sending`
 * console line).
 *
 *   npm run build && npx tsx scripts/probe-row-edit-primitive.ts
 */
import * as child_process from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { _electron as electron } from "playwright"

import { ensureCaretDirectoryExists } from "../src/core/design/scaffold"

// The exact shape from the field (Crema's tasting tags), with big chips so the
// unscaled iframe click still lands on the target.
const PAGE = `export default function Chips() {
  return (
    <div className="p-12">
      <h1 data-caret-id="chips-title" className="text-3xl">Chips</h1>
      <div className="mt-8 flex flex-wrap gap-4">
        {["Bright", "Fruity", "Balanceed", "Sweet"].map((tag, i) => (
          <span data-caret-id="span-3"
            key={tag}
            className={"cursor-pointer rounded-full border px-12 py-6 text-2xl " + (i === 0 ? "border-blue-600" : "border-neutral-300")}
          >
            {tag}
          </span>
        ))}
      </div>
    </div>
  )
}
`

async function main(): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "caret-row-probe-"))
	await ensureCaretDirectoryExists(dir)
	const pageDir = path.join(dir, ".caret", "pages", "chips")
	await fs.mkdir(pageDir, { recursive: true })
	const pagePath = path.join(pageDir, "index.tsx")
	await fs.writeFile(pagePath, PAGE)
	await fs.writeFile(
		path.join(pageDir, "meta.json"),
		JSON.stringify({ id: "chips", title: "Chips", type: "page", states: ["default"], tags: ["demo"] }, null, 2),
	)
	const git = (args: string) => child_process.execSync(`git ${args}`, { cwd: dir, stdio: "ignore" })
	git("init -q")
	git("config user.email caret@local")
	git("config user.name Caret")
	git("add -A")
	git("commit -qm fixture")

	const userData = await fs.mkdtemp(path.join(os.tmpdir(), "caret-row-probe-profile-"))
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), `--user-data-dir=${userData}`, dir],
		env: { ...process.env, CARET_VERIFY_PROJECT: dir, NODE_ENV: "test" },
	})
	try {
		// Collect every console line from every webContents, main-side. No named
		// helper consts in here — esbuild's __name wrapper does not exist on the
		// Electron side (see the general rules; it cost this probe a run too).
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

		const outcome = await app.evaluate(async ({ BrowserWindow }, pageId) => {
			try {
				// The canvas view, searched across all windows (window [0] is a race).
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

				// Open the page from the grid.
				deadline = Date.now() + 120_000
				let opened = false
				while (Date.now() < deadline && !opened) {
					opened = await wc
						.executeJavaScript(
							`(() => {
									const card = Array.from(document.querySelectorAll('.caret-canvas-frame-title')).find((n) => n.textContent && n.textContent.includes('Chips'))
									if (!card) return false
									card.closest('.caret-canvas-frame').dispatchEvent(new MouseEvent('click', { bubbles: true }))
									return true
								})()`,
						)
						.catch(() => false)
					if (!opened) await new Promise((r) => setTimeout(r, 500))
				}
				if (!opened) return { error: "the Chips card never appeared on the canvas" }

				// The focused frame with all four chips rendered.
				let pageFrame: any = null
				deadline = Date.now() + 60_000
				while (Date.now() < deadline) {
					pageFrame =
						wc.mainFrame.frames.find(
							(f: any) => f.url.includes("mode=focused") && f.url.includes(`page=${pageId}`),
						) ?? null
					if (pageFrame) {
						const chips = await pageFrame
							.executeJavaScript(`document.querySelectorAll('[data-caret-id="span-3"]').length`)
							.catch(() => 0)
						if (chips === 4) break
					}
					await new Promise((r) => setTimeout(r, 300))
				}
				if (!pageFrame) return { error: "the focused chips page never became a frame" }
				await pageFrame.executeJavaScript(`((window).__REACT_GRAB__?.activate?.(), true)`).catch(() => {})
				await new Promise((r) => setTimeout(r, 800))

				// What does the fresh DOM say the chip's text is? Capture it as evidence.
				const domText = await pageFrame.executeJavaScript(
					`JSON.stringify(document.querySelectorAll('[data-caret-id="span-3"]')[2].textContent)`,
				)

				// Right-click the "Balanceed" chip (index 2) with a real mouse.
				const offset = await wc.executeJavaScript(
					`(() => { const r = document.querySelector('.caret-focused-iframe').getBoundingClientRect(); return { x: r.x, y: r.y } })()`,
				)
				const target = await pageFrame.executeJavaScript(
					`(() => { const r = document.querySelectorAll('[data-caret-id="span-3"]')[2].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`,
				)
				const at = { x: Math.round(offset.x + target.x), y: Math.round(offset.y + target.y) }

				let menuClicked = false
				for (let attempt = 0; attempt < 5 && !menuClicked; attempt++) {
					pageFrame = wc.mainFrame.frames.find((f: any) => f.url.includes(`page=${pageId}`)) ?? pageFrame
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
				if (!menuClicked) return { error: "react-grab's menu never offered Edit text on the chip", domText }

				// Commit the fix with Enter.
				await new Promise((r) => setTimeout(r, 500))
				const committed = await pageFrame.executeJavaScript(
					`(() => {
							const el = document.querySelectorAll('[data-caret-id="span-3"]')[2]
							if (el.contentEditable !== 'true') return 'not-editable: ' + el.contentEditable
							el.textContent = 'Balanced'
							el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
							return 'ok'
						})()`,
				)
				if (committed !== "ok") return { error: `the chip never became contentEditable (${committed})`, domText }

				// Give the round-trip time, then read any visible error surfaces.
				await new Promise((r) => setTimeout(r, 3000))
				const surfaces = await pageFrame
					.executeJavaScript(
						`JSON.stringify({
							fallbackCard: document.querySelector('#caret-ai-edit-fallback')?.textContent?.slice(0, 200) ?? null,
							toast: document.querySelector('[data-caret-toast], .caret-inline-toast')?.textContent?.slice(0, 200) ?? null,
						})`,
					)
					.catch(() => "{}")

				// ── Part 2: force a failure and check the failure UX ─────────────
				// Tamper chip 1's on-screen text (the leftover-state situation),
				// then edit it. The host must refuse (page text ≠ data), the typed
				// text must REVERT to the tampered original, the error must name
				// both values, and exactly ONE surface may show it.
				await pageFrame.executeJavaScript(
					`(document.querySelectorAll('[data-caret-id="span-3"]')[1].textContent = "Tampered", true)`,
				)
				const target2 = await pageFrame.executeJavaScript(
					`(() => { const r = document.querySelectorAll('[data-caret-id="span-3"]')[1].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`,
				)
				const at2 = { x: Math.round(offset.x + target2.x), y: Math.round(offset.y + target2.y) }
				let menu2 = false
				for (let attempt = 0; attempt < 5 && !menu2; attempt++) {
					wc.sendInputEvent({ type: "mouseMove", x: at2.x, y: at2.y })
					await new Promise((r) => setTimeout(r, 300))
					wc.sendInputEvent({ type: "mouseDown", x: at2.x, y: at2.y, button: "right", clickCount: 1 })
					wc.sendInputEvent({ type: "mouseUp", x: at2.x, y: at2.y, button: "right", clickCount: 1 })
					const menuDeadline = Date.now() + 4000
					while (Date.now() < menuDeadline && !menu2) {
						menu2 = await pageFrame
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
						if (!menu2) await new Promise((r) => setTimeout(r, 250))
					}
				}
				if (!menu2) return { error: "part 2: react-grab's menu never offered Edit text", domText, surfaces }
				await new Promise((r) => setTimeout(r, 500))
				const committed2 = await pageFrame.executeJavaScript(
					`(() => {
							const el = document.querySelectorAll('[data-caret-id="span-3"]')[1]
							if (el.contentEditable !== 'true') return 'not-editable'
							el.textContent = 'Frooty'
							el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
							return 'ok'
						})()`,
				)
				if (committed2 !== "ok") return { error: "part 2: chip never became contentEditable", domText, surfaces }
				await new Promise((r) => setTimeout(r, 3000))

				const failureUx = await pageFrame.executeJavaScript(
					`JSON.stringify({
							chipTextAfterFailure: document.querySelectorAll('[data-caret-id="span-3"]')[1].textContent,
							fallbackCard: document.querySelector('#caret-ai-edit-fallback')?.textContent?.slice(0, 250) ?? null,
							pluginErrorToast: !!document.querySelector('[data-caret-toast="error"]'),
							bridgeErrorToastInPage: !!document.querySelector('[data-caret-bridge-toast="error"]'),
						})`,
				)
				const bridgeToastInCanvasDoc = await wc.executeJavaScript(
					`!!document.querySelector('[data-caret-bridge-toast="error"]')`,
				)

				return { ok: true, domText, surfaces, failureUx, bridgeToastInCanvasDoc }
			} catch (err) {
				return { error: err instanceof Error ? err.message : String(err) }
			}
		}, "chips")

		console.log("outcome:", JSON.stringify(outcome, null, 2))

		// The decisive evidence: what did the canvas SEND?
		const logs = await app.evaluate(() => (globalThis as any).__PROBE_LOGS__ as string[])
		const interesting = logs.filter((l) => l.includes("caret-grab") || l.includes("edit"))
		console.log("--- canvas/console lines mentioning edits ---")
		for (const line of interesting.slice(-20)) console.log(line)

		const after = await fs.readFile(pagePath, "utf-8")
		console.log("--- file state ---")
		console.log(after.includes('"Balanced"') ? "FILE EDITED: Balanceed → Balanced ✓" : "FILE UNCHANGED — still Balanceed ✗")
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
