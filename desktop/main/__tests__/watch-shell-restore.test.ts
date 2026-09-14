/**
 * The healer's obligation to the shell's own files.
 *
 * `vite.config.ts` and `global.css` ARE the Tailwind/Vite setup, and writes to
 * the design layer are auto-approved — so nothing surfaced a bad write to one
 * of them, and it stayed broken until the next project open regenerated it.
 * The healer now restores a drifted shell file mid-session; the content
 * compare is the loop guard, so a file that already matches is left alone.
 */
import { strict as assert } from "assert"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { entryFileSources, viteConfigSource } from "../../../src/core/design"
import { WatchAndHeal } from "../watch-and-heal"

async function makeProject(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "caret-shell-restore-"))
	await fs.mkdir(path.join(root, ".caret", "pages"), { recursive: true })
	return root
}

async function waitFor(check: () => Promise<boolean>, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms
	while (Date.now() < deadline) {
		if (await check()) return true
		await new Promise((r) => setTimeout(r, 100))
	}
	return false
}

describe("WatchAndHeal, shell files", () => {
	const started: WatchAndHeal[] = []

	afterEach(async () => {
		for (const w of started.splice(0)) await w.stop()
	})

	it("restores a rewritten global.css and vite.config.ts to their generated content", async () => {
		const root = await makeProject()
		const globalCss = path.join(root, ".caret", "global.css")
		const viteConfig = path.join(root, ".caret", "vite.config.ts")
		await fs.writeFile(globalCss, entryFileSources()["global.css"])
		await fs.writeFile(viteConfig, viteConfigSource())

		const healer = new WatchAndHeal({ projectPath: root })
		started.push(healer)
		healer.start()
		// Let the initial scan finish so the writes below arrive as change events.
		await new Promise((r) => setTimeout(r, 1500))

		await fs.writeFile(globalCss, '@import "tailwindcss";\n/* scan set gone */\n')
		await fs.writeFile(viteConfig, "export default {}\n")

		assert.ok(
			await waitFor(async () => (await fs.readFile(globalCss, "utf-8")) === entryFileSources()["global.css"], 8000),
			"a rewritten global.css was never restored",
		)
		assert.ok(
			await waitFor(async () => (await fs.readFile(viteConfig, "utf-8")) === viteConfigSource(), 8000),
			"a rewritten vite.config.ts was never restored",
		)
	})

	it("leaves a matching shell file untouched — the compare is the loop guard", async () => {
		const root = await makeProject()
		const globalCss = path.join(root, ".caret", "global.css")
		await fs.writeFile(globalCss, entryFileSources()["global.css"])

		const healer = new WatchAndHeal({ projectPath: root })
		started.push(healer)
		healer.start()
		await new Promise((r) => setTimeout(r, 1500))

		// Re-write the identical content, as the restore's own write would.
		await fs.writeFile(globalCss, entryFileSources()["global.css"])
		// Give the watcher time to see it and (wrongly) act on it…
		await new Promise((r) => setTimeout(r, 2500))
		const settled = (await fs.stat(globalCss)).mtimeMs
		// …then confirm nothing keeps rewriting the file after that.
		await new Promise((r) => setTimeout(r, 2500))
		assert.equal((await fs.stat(globalCss)).mtimeMs, settled, "a matching shell file was rewritten — restore loop")
		assert.equal(await fs.readFile(globalCss, "utf-8"), entryFileSources()["global.css"])
	})
})
