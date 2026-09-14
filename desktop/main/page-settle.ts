/**
 * The settle contract every hidden-window render shares: what must have
 * happened before a frame of a design page is worth reading.
 *
 * `did-finish-load` fires well before a page *looks* finished, and each gap
 * between "loaded" and "looks finished" has burned an agent at least once:
 *
 * - **Mount.** The entry awaits the route loader before mounting, so `#root`
 *   is empty well past `did-finish-load`. Every wait below reads the mounted
 *   DOM — sampled too early, the image set is empty, the checks pass
 *   vacuously, and the capture certifies a frame that is still blank.
 * - **Fonts and images.** Webfonts still swapping and images still decoding
 *   read to an agent as "the page is broken" — the most expensive possible
 *   false signal in a loop whose whole point is the agent judging its own
 *   work. Images are re-sampled until the set is stable: they can mount late,
 *   and a cold dev server can take seconds per asset.
 * - **3D models.** `<model-viewer>` paints into a shadow-root canvas only
 *   after its `.glb` arrives; nothing about it ever appears in
 *   `document.images`, so a capture that only waits on images shows the empty
 *   surface underneath — which the agent then reports as "the model doesn't
 *   render" about a page that renders fine.
 * - **WebGL.** A `<canvas>` draws on its own clock after mount; the capture
 *   is compositor-level, so all it needs is a beat for the first real frames.
 *
 * One script, parameterized by deadline, because three call sites carried
 * byte-identical copies that drifted only in their bugs. The screenshot path
 * gives it 30s (its cap is the price of a hang, not of an error — a broken
 * image resolves immediately through the `broken` report); the checks and
 * overlay paths give it a few seconds, enough for the honest cases they read.
 *
 * Returns `{ broken, scrollHeight }` — the page's full height, and only assets
 * that measurably FAILED (a completed image with no pixels: a 404 or decode
 * error). "Still loading" guesses are not reported: a lazy viewer below the
 * fold never loads by design, and one field run watched an agent chase a
 * fabricated "/%3Cmodel-viewer%3E asset" a speculative warning invented for
 * exactly that case.
 *
 * `fullPage` mode serves the frame-by-frame screenshot path: the whole scroll
 * height will be captured (scroll-and-shoot, one viewport frame per scroll
 * stop), so before any waiting it SWEEPS the scroll position down the page
 * once. Lazy content — native loading="lazy" images, <model-viewer>'s
 * lazy/auto loading, once-only scroll entrances — starts loading or playing
 * only when it nears the viewport; the sweep gets all of that going up front
 * so the frame captures never race it. The model wait then covers the full
 * page height, not just the top viewport. The window is NOT resized to the
 * page height: vh-sized sections would balloon with it and the capture would
 * show a layout no user ever sees.
 */
export function settleScript(deadlineMs: number, opts: { fullPage?: boolean } = {}): string {
	return `(async () => {
		const deadline = Date.now() + ${deadlineMs}
		const fullPage = ${opts.fullPage === true}
		const timeLeft = () => Math.max(0, deadline - Date.now())
		const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

		// Mount: the page or its error card, whichever the loader produced.
		while (Date.now() < deadline) {
			const root = document.getElementById("root")
			if (root && root.children.length > 0) break
			await new Promise((r) => setTimeout(r, 50))
		}

		// Full-page capture: sweep the scroll position through the page once so
		// everything that loads "when it comes into view" starts loading now.
		// Re-reads scrollHeight each step — content growing as it loads extends
		// the sweep. Then back to the top, where the capture expects to be.
		if (fullPage) {
			const pageHeight = () => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)
			for (let y = 0; y < pageHeight() && Date.now() < deadline; y += innerHeight) {
				scrollTo(0, y)
				await raf2()
				await new Promise((r) => setTimeout(r, 40))
			}
			scrollTo(0, 0)
			await raf2()
		}

		// Fonts, then every image, looped until the image set is stable.
		while (Date.now() < deadline) {
			await document.fonts.ready
			const seen = [...document.images]
			await Promise.race([
				Promise.all(
					seen.map((img) =>
						img.complete ? null : new Promise((r) => { img.onload = r; img.onerror = r }),
					),
				),
				new Promise((r) => setTimeout(r, timeLeft())),
			])
			await raf2()
			const now = [...document.images]
			if (now.length === seen.length && now.every((img) => img.complete)) break
		}

		// 3D models: wait for the element class to exist, then for each viewer's
		// own load (or error) event. The load event fires only after upgrade, so
		// listeners attached post-whenDefined cannot miss it.
		//
		// Only viewers inside the area that will be CAPTURED, with a source to
		// load: the viewport, or in fullPage mode the whole scroll height. An
		// element outside that area contributes no pixels — and one parked
		// off-canvas (translated out, below a non-swept fold) never loads AT
		// ALL, by design; waiting on it burns the entire deadline on a
		// non-problem. Rects are viewport-relative, and fullPage measures at
		// scrollTop 0, so page-y == rect-y.
		const frameBottom = fullPage ? Math.max(document.documentElement.scrollHeight, innerHeight) : innerHeight
		const inFrame = (el) => {
			const r = el.getBoundingClientRect()
			return r.bottom > 0 && r.right > 0 && r.top < frameBottom && r.left < innerWidth
		}
		const viewers = [...document.querySelectorAll("model-viewer")].filter(
			(v) => inFrame(v) && (v.src || v.getAttribute("src")),
		)
		if (viewers.length > 0) {
			await Promise.race([
				customElements.whenDefined("model-viewer").then(() =>
					Promise.all(
						viewers.map((v) =>
							v.loaded ? null : new Promise((r) => {
								v.addEventListener("load", r, { once: true })
								v.addEventListener("error", r, { once: true })
							}),
						),
					),
				),
				new Promise((r) => setTimeout(r, timeLeft())),
			])
		}

		// WebGL/canvas content: a couple of frames so the compositor holds real
		// pixels, not the clear color.
		if (viewers.length > 0 || document.querySelector("canvas")) {
			await new Promise((r) => setTimeout(r, Math.min(300, timeLeft())))
			await raf2()
		}

		const relative = (src) => { try { return new URL(src, location.href).pathname } catch { return src } }
		return {
			broken: [...document.images].filter((img) => img.complete && img.naturalWidth === 0).map((img) => relative(img.src)),
			scrollHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0, innerHeight),
		}
	})()`
}

/** What `settleScript` resolves to: the page's height, and assets that measurably failed to load. */
export interface SettleReport {
	broken: string[]
	/** Full scroll height in CSS pixels, at least the viewport height. */
	scrollHeight: number
}

export const EMPTY_SETTLE_REPORT: SettleReport = { broken: [], scrollHeight: 0 }
