/**
 * Whether Playwright sees the canvas view (a WebContentsView) as a page of its
 * own, so tests can click inside it with locators.
 */
import * as fs from "fs/promises"
import * as path from "path"
import { buildProject, freshProfile, launchApp, reapOrphanedBackends, waitFor } from "./verify-kit"

async function main(): Promise<void> {
	reapOrphanedBackends()
	const project = await buildProject()
	const dir = path.join(project, ".caret", "pages", "home")
	await fs.mkdir(dir, { recursive: true })
	await fs.writeFile(path.join(dir, "index.tsx"), "export default function Home() { return <main><h1>Home</h1></main> }\n")
	await fs.writeFile(
		path.join(dir, "meta.json"),
		JSON.stringify({ id: "home", title: "Home", type: "page", states: [], tags: [] }),
	)
	const launched = await launchApp({ project, userData: await freshProfile(), logFile: "/tmp/probe/canvas-page.log" })
	try {
		// The canvas reloads once while the preview starts, so look it up afresh each time.
		const found = await waitFor(
			"the canvas as a page, showing its cards",
			async () => {
				for (const page of launched.app.context().pages()) {
					if (!page.url().startsWith("http://127.0.0.1")) continue
					const cards = await page
						.locator(".caret-canvas-frame")
						.count()
						.catch(() => 0)
					if (cards > 0) return { page, cards }
				}
				return null
			},
			180_000,
			async () =>
				launched.app
					.context()
					.pages()
					.map((p) => p.url())
					.join(", "),
		)
		await found.page.locator(".caret-canvas-frame").first().click()
		await found.page.waitForSelector(".caret-focused-iframe", { timeout: 30_000 })
		console.log("canvas page:", found.page.url(), found.cards, "cards; clicking one opened the focused page")
	} finally {
		await launched.close()
		reapOrphanedBackends()
	}
}
main()
	.catch((e) => {
		console.error(e.message)
		process.exitCode = 1
	})
	.finally(() => setTimeout(() => process.exit(), 500))
