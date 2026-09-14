/**
 * Drives Caret's own colour popover (the replacement for the Chromium
 * <input type=color> popup) in the real app, three ways:
 *   1. right-click → Edit color → hex paste + Enter commits ONE write
 *   2. reopen → token swatch click paints INSTANTLY and hands over cleanly
 *   3. left-click select → panel colour edit shows while the selection is
 *      still up (react-grab's !important freeze pins must be released)
 *
 *   npm run build && npx tsx scripts/probe-color-popover.ts
 */
import * as child_process from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { _electron as electron } from "playwright"

import { ensureCaretDirectoryExists } from "../src/core/design/scaffold"

const PAGE = `export default function Page() {
  return (
    <div className="p-12">
      <h1 data-caret-id="title" className="text-3xl">Colour probe</h1>
      <a data-caret-id="cta" href="#" className="mt-8 inline-block rounded-lg bg-error px-12 py-6 text-2xl text-white">Add a bean</a>
    </div>
  )
}
`

async function main(): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "caret-color-probe-"))
	await ensureCaretDirectoryExists(dir)
	const pageDir = path.join(dir, ".caret", "pages", "colorpage")
	await fs.mkdir(pageDir, { recursive: true })
	const pagePath = path.join(pageDir, "index.tsx")
	await fs.writeFile(pagePath, PAGE)
	await fs.writeFile(
		path.join(pageDir, "meta.json"),
		JSON.stringify({ id: "colorpage", title: "Colour probe", type: "page", states: ["default"], tags: ["demo"] }, null, 2),
	)
	const git = (args: string) => child_process.execSync(`git ${args}`, { cwd: dir, stdio: "ignore" })
	git("init -q")
	git("config user.email caret@local")
	git("config user.name Caret")
	git("add -A")
	git("commit -qm fixture")

	const userData = await fs.mkdtemp(path.join(os.tmpdir(), "caret-color-probe-profile-"))
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), `--user-data-dir=${userData}`, dir],
		env: { ...process.env, CARET_VERIFY_PROJECT: dir, NODE_ENV: "test" },
	})
	try {
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
								const card = Array.from(document.querySelectorAll('.caret-canvas-frame-title')).find((n) => n.textContent && n.textContent.includes('Colour probe'))
								if (!card) return false
								card.closest('.caret-canvas-frame').dispatchEvent(new MouseEvent('click', { bubbles: true }))
								return true
							})()`,
						)
						.catch(() => false)
					if (!opened) await new Promise((r) => setTimeout(r, 500))
				}
				if (!opened) return { error: "the page card never appeared" }

				let pageFrame: any = null
				deadline = Date.now() + 60_000
				while (Date.now() < deadline) {
					pageFrame =
						wc.mainFrame.frames.find(
							(f: any) => f.url.includes("mode=focused") && f.url.includes("page=colorpage"),
						) ?? null
					if (pageFrame) {
						const ready = await pageFrame
							.executeJavaScript(`!!document.querySelector('[data-caret-id="cta"]')`)
							.catch(() => false)
						if (ready) break
					}
					await new Promise((r) => setTimeout(r, 300))
				}
				if (!pageFrame) return { error: "the focused page never became a frame" }
				await pageFrame.executeJavaScript(`((window).__REACT_GRAB__?.activate?.(), true)`).catch(() => {})
				await new Promise((r) => setTimeout(r, 800))

				const offset = await wc.executeJavaScript(
					`(() => { const r = document.querySelector('.caret-focused-iframe').getBoundingClientRect(); return { x: r.x, y: r.y } })()`,
				)
				const target = await pageFrame.executeJavaScript(
					`(() => { const r = document.querySelector('[data-caret-id="cta"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`,
				)
				const at = { x: Math.round(offset.x + target.x), y: Math.round(offset.y + target.y) }

				let menuClicked = false
				for (let attempt = 0; attempt < 5 && !menuClicked; attempt++) {
					pageFrame = wc.mainFrame.frames.find((f: any) => f.url.includes("page=colorpage")) ?? pageFrame
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
									const item = items.find((n) => n.textContent && n.textContent.trim() === 'Edit color')
									if (!item) return false
									item.click()
									return true
								})()`,
							)
							.catch(() => false)
						if (!menuClicked) await new Promise((r) => setTimeout(r, 250))
					}
				}
				if (!menuClicked) return { error: "react-grab's menu never offered Edit color" }

				// The popover: present, beside the element (not overlapping, not 0,0),
				// with token swatches and a working hex field.
				await new Promise((r) => setTimeout(r, 600))
				const popover = await pageFrame.executeJavaScript(
					`(() => {
						const pop = document.querySelector('#caret-color-popover')
						if (!pop) return { present: false }
						const p = pop.getBoundingClientRect()
						const e = document.querySelector('[data-caret-id="cta"]').getBoundingClientRect()
						const overlap = e.left < p.right && e.right > p.left && e.top < p.bottom && e.bottom > p.top
						return {
							present: true,
							atOrigin: p.left < 4 && p.top < 4,
							overlap,
							swatches: pop.querySelectorAll('[data-color-token]').length,
							hex: !!pop.querySelector('[data-color-hex]'),
							nativeInput: !!document.querySelector('input[type="color"]'),
						}
					})()`,
				)
				if (!popover.present) return { error: "the colour popover never opened", popover }

				// Paste-style entry: set the hex, one input event, Enter commits.
				const fed = await pageFrame.executeJavaScript(
					`(() => {
						const input = document.querySelector('#caret-color-popover [data-color-hex]')
						if (!input) return false
						const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
						setter.call(input, '9b4708')
						input.dispatchEvent(new Event('input', { bubbles: true }))
						input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
						return true
					})()`,
				)
				if (!fed) return { error: "the hex field would not take a value", popover }

				await new Promise((r) => setTimeout(r, 2500))
				const after = await pageFrame.executeJavaScript(
					`JSON.stringify({
						popoverGone: !document.querySelector('#caret-color-popover'),
						toast: document.querySelector('[data-caret-toast]')?.textContent ?? document.querySelector('#caret-detach-toast')?.textContent ?? null,
					})`,
				)

				// ── Part 2: the swatch-click path must change the screen INSTANTLY ──
				// The field failure: a swatch commit wrote the file correctly but the
				// screen kept the old colour until a stale preview pin dropped.
				// First: 2.5s after part 1's commit, the handover timer must have
				// dropped part 1's pin already — measured BEFORE anything reopens
				// (react-grab re-pins the element itself whenever its UI engages,
				// so this is the one moment OUR pin can be measured alone).
				const inlineBeforeReopen = await pageFrame.executeJavaScript(
					`document.querySelector('[data-caret-id="cta"]').style.backgroundColor || ""`,
				)
				let menu2 = false
				for (let attempt = 0; attempt < 5 && !menu2; attempt++) {
					wc.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y })
					await new Promise((r) => setTimeout(r, 300))
					wc.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "right", clickCount: 1 })
					wc.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "right", clickCount: 1 })
					const menuDeadline = Date.now() + 4000
					while (Date.now() < menuDeadline && !menu2) {
						menu2 = await pageFrame
							.executeJavaScript(
								`(() => {
									const host = document.querySelector('[data-react-grab]')
									const root = host && host.shadowRoot
									if (!root) return false
									const items = Array.from(root.querySelectorAll('button, [role="menuitem"], div'))
									const item = items.find((n) => n.textContent && n.textContent.trim() === 'Edit color')
									if (!item) return false
									item.click()
									return true
								})()`,
							)
							.catch(() => false)
						if (!menu2) await new Promise((r) => setTimeout(r, 250))
					}
				}
				if (!menu2) return { error: "part 2: Edit color menu never appeared", popover, after }
				await new Promise((r) => setTimeout(r, 600))

				const swatchFlow = await pageFrame.executeJavaScript(
					`(() => {
						const el = document.querySelector('[data-caret-id="cta"]')
						const openState = { inlineAtOpen: el.style.backgroundColor || "" }
						const swatch = document.querySelector('#caret-color-popover [data-color-token]')
						if (!swatch) return { error: "no swatch in the popover", openState }
						const hex = swatch.getAttribute('data-color-token')
						swatch.dispatchEvent(new MouseEvent('click', { bubbles: true }))
						return { openState, swatchHex: hex, inlineRightAfterClick: el.style.backgroundColor || "" }
					})()`,
				)
				if (swatchFlow.error) return { error: swatchFlow.error, popover, after }

				await new Promise((r) => setTimeout(r, 2600))
				const handover = await pageFrame.executeJavaScript(
					`(() => {
						const el = document.querySelector('[data-caret-id="cta"]')
						return {
							inlineAfterHandover: el.style.backgroundColor || "",
							computed: window.getComputedStyle(el).backgroundColor,
						}
					})()`,
				)

				// ── Part 3: a PANEL edit must show while the panel is still open ──
				// react-grab freezes the selected element: ~80 computed properties
				// pinned as !important inline styles, which mask any class change
				// HMR applies until deselect. The field report: a text-colour edit
				// said "applied" and only showed after the widget closed. After a
				// successful edit-result the panel now strips the important-priority
				// pins, so the class shows through with the selection still up.
				await pageFrame.executeJavaScript(`((window).__REACT_GRAB__?.activate?.(), true)`).catch(() => {})
				await new Promise((r) => setTimeout(r, 500))
				let panelUp = false
				for (let attempt = 0; attempt < 5 && !panelUp; attempt++) {
					wc.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y })
					await new Promise((r) => setTimeout(r, 300))
					wc.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 })
					wc.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount: 1 })
					const panelDeadline = Date.now() + 3000
					while (Date.now() < panelDeadline && !panelUp) {
						panelUp = await pageFrame
							.executeJavaScript(`!!document.querySelector('#caret-param-panel [data-param-input="color"]')`)
							.catch(() => false)
						if (!panelUp) await new Promise((r) => setTimeout(r, 250))
					}
				}
				if (!panelUp) return { error: "part 3: the param panel never offered a color row", popover, after }

				const fedPanel = await pageFrame.executeJavaScript(
					`(() => {
						const el = document.querySelector('[data-caret-id="cta"]')
						const pinned = []
						for (let i = 0; i < el.style.length; i++) {
							const prop = el.style[i]
							if (el.style.getPropertyPriority(prop) === 'important') pinned.push(prop)
						}
						const input = document.querySelector('#caret-param-panel [data-param-input="color"]')
						const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
						setter.call(input, '#15803d')
						input.dispatchEvent(new Event('input', { bubbles: true }))
						input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
						return { pinsAtSelect: pinned.length, colorPinnedAtSelect: pinned.includes('color') }
					})()`,
				)

				// Poll: the edit lands (write + HMR), pins release, colour shows —
				// all while the panel stays open. 8s covers a slow HMR beat.
				let panelFlow: any = null
				const panelDeadline = Date.now() + 8000
				while (Date.now() < panelDeadline) {
					panelFlow = await pageFrame.executeJavaScript(
						`(() => {
							const el = document.querySelector('[data-caret-id="cta"]')
							let pins = 0
							for (let i = 0; i < el.style.length; i++) {
								if (el.style.getPropertyPriority(el.style[i]) === 'important') pins++
							}
							return {
								panelStillOpen: !!document.querySelector('#caret-param-panel'),
								pinsNow: pins,
								computedColor: window.getComputedStyle(el).color,
							}
						})()`,
					)
					if (panelFlow.computedColor === "rgb(21, 128, 61)" && panelFlow.pinsNow === 0) break
					await new Promise((r) => setTimeout(r, 400))
				}
				panelFlow = { ...fedPanel, ...panelFlow }
				return { ok: true, popover, after, inlineBeforeReopen, swatchFlow, handover, panelFlow }
			} catch (err) {
				return { error: err instanceof Error ? err.message : String(err) }
			}
		})

		console.log("outcome:", JSON.stringify(outcome, null, 2))
		const o = outcome as any
		let failed = !!o.error
		const check = (ok: boolean, good: string, bad: string) => {
			console.log(ok ? `${good} ✓` : `${bad} ✗`)
			if (!ok) failed = true
		}
		console.log("--- swatch-flow verdict ---")
		if (o.swatchFlow && o.handover) {
			// inlineAtOpen is react-grab's own freeze pin — expected, not ours.
			// OUR pin is measured before react-grab re-engages: it must be gone.
			check(o.inlineBeforeReopen === "", "part-1 pin released before reopen", `PART-1 PIN STUCK (${o.inlineBeforeReopen})`)
			check(
				!!o.swatchFlow.inlineRightAfterClick,
				`swatch click painted instantly (${o.swatchFlow.inlineRightAfterClick})`,
				"SWATCH CLICK DID NOT PAINT",
			)
			check(
				o.handover.inlineAfterHandover === "",
				`pin handed over to the class (computed now ${o.handover.computed})`,
				`PIN STUCK (${o.handover.inlineAfterHandover})`,
			)
		}
		console.log("--- panel-flow verdict ---")
		if (o.panelFlow) {
			// If react-grab did not freeze at selection there is nothing to
			// release — report it rather than fail a premise the run lacked.
			if (o.panelFlow.pinsAtSelect === 0) console.log("no freeze pins at selection — nothing to release (informational)")
			else
				check(
					o.panelFlow.pinsNow === 0,
					`freeze pins released after the edit (was ${o.panelFlow.pinsAtSelect})`,
					`FREEZE PINS REMAIN (${o.panelFlow.pinsNow} of ${o.panelFlow.pinsAtSelect})`,
				)
			check(o.panelFlow.panelStillOpen === true, "panel still open", "PANEL CLOSED EARLY")
			check(
				o.panelFlow.computedColor === "rgb(21, 128, 61)",
				"colour shows with the selection still up",
				`COLOUR MASKED (computed ${o.panelFlow.computedColor})`,
			)
		}
		const after = await fs.readFile(pagePath, "utf-8")
		console.log("--- file state ---")
		// Part 1 detaches to bg-[#9b4708]; part 2's first swatch is the error
		// token and re-binds — so bg-error at the END is part 2 working, and
		// part 1's write is evidenced by the detach toast it produced.
		check(String(o.after ?? "").includes("Detached"), "part 1 detached from the token", "PART 1 NEVER DETACHED")
		check(after.includes("bg-error"), "part 2 re-bound to bg-error", `PART 2 DID NOT RE-BIND (${after.match(/bg-\S+/)?.[0]})`)
		check(
			after.includes("text-[#15803d]"),
			"part 3 wrote the text colour",
			`PART 3 DID NOT WRITE (${after.match(/text-\S+/)?.[0]})`,
		)
		if (failed) process.exitCode = 1
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
