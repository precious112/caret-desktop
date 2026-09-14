/**
 * Probe: the settle script in VIEWPORT mode (the checks/overlay paths; the
 * screenshot path uses fullPage mode — `probe-fullpage-capture.ts` covers it)
 * against a real page carrying two <model-viewer>s — an eager in-frame hero,
 * and a lazy one that sits outside the captured frame and therefore NEVER
 * loads (model-viewer's lazy observer never fires for it).
 *
 * Reproduces the 2026-09-03 field failure: the settle used to wait on that
 * never-loading viewer until the full 30s deadline, then report it "still
 * loading" under a fabricated name ("/%3Cmodel-viewer%3E" — the tag-name
 * fallback piped through new URL(), because React sets `src` as a property
 * and getAttribute("src") is null). An agent then investigated a broken
 * asset that did not exist.
 *
 * Needs a running design shell serving the page:
 *   cd <project>/.caret && ./node_modules/.bin/vite --port 5199 --strictPort
 *
 * Asserts:
 *   1. settle returns fast — it does not burn the deadline on the lazy viewer
 *   2. the report is a clean { broken: [] } — no fabricated names
 *   3. the eager hero viewer HAS loaded by the time settle returns (the wait
 *      still covers what is actually in the frame)
 */
import { chromium } from "playwright-core"
import { settleScript } from "../desktop/main/page-settle"

const SHELL = process.env.SHELL_URL || "http://127.0.0.1:5199"
const PAGE_ID = process.env.PAGE_ID || "fold-landing"
const DEADLINE_MS = 30_000

async function main() {
	const browser = await chromium.launch({ channel: "chrome" })
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
	await page.goto(`${SHELL}/?page=${encodeURIComponent(PAGE_ID)}&isolated=1`)

	const started = Date.now()
	const report = await page.evaluate(settleScript(DEADLINE_MS))
	const elapsed = Date.now() - started

	// React writes `loading`/`src` as PROPERTIES on the upgraded element, so
	// read properties — the attributes are null (that miss is what fabricated
	// the "<model-viewer>" name in the old report).
	const viewerState: Array<{ loading: string; loaded: boolean; top: number }> = await page.evaluate(
		`[...document.querySelectorAll("model-viewer")].map((v) => ({
			loading: v.loading,
			loaded: !!v.loaded,
			top: Math.round(v.getBoundingClientRect().top),
		}))`,
	)

	console.log("settle elapsed:", elapsed, "ms")
	console.log("report:", JSON.stringify(report))
	console.log("viewers:", JSON.stringify(viewerState))

	const failures: string[] = []
	if (elapsed > DEADLINE_MS - 2000)
		failures.push(`settle burned the deadline (${elapsed}ms) — still waiting on the lazy viewer`)
	if (JSON.stringify((report as { broken: string[] }).broken) !== "[]")
		failures.push(`report is not clean: ${JSON.stringify(report)}`)
	const eager = viewerState.find((v) => v.loading === "eager")
	if (!eager?.loaded) failures.push("the eager hero viewer had not loaded when settle returned")
	const lazy = viewerState.find((v) => v.loading === "lazy")
	if (!lazy) failures.push("precondition broken: page has no lazy viewer — probe proves nothing")
	else if (lazy.loaded) failures.push("precondition broken: the lazy viewer loaded anyway — probe proves nothing")

	await browser.close()
	if (failures.length) {
		console.error("PROBE FAILED:\n - " + failures.join("\n - "))
		process.exit(1)
	}
	console.log("PROBE PASSED")
}

main()
