/**
 * The healer's obligation at open.
 *
 * A page can be unhealed before Caret ever runs: cloned from a teammate, pulled
 * from a branch, written by an agent while the app was closed. `ignoreInitial`
 * means the watcher emits nothing for those files — and because chokidar's
 * initial scan is asynchronous, "those files" includes anything written while it
 * runs. That left them permanently unhealed: no caret-ids, so every click on the
 * page resolved to nothing.
 *
 * The suite hid it for months because the scenario that writes an unhealed page
 * ran minutes after launch, long past the race. Run first, it failed every time.
 */
import { strict as assert } from "assert"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { WatchAndHeal } from "../watch-and-heal"

const UNHEALED = `export default function About() {
  return (
    <div>
      <h1>About</h1>
    </div>
  )
}
`

async function makeProject(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "caret-heal-open-"))
	await fs.mkdir(path.join(root, ".caret", "pages", "about"), { recursive: true })
	return root
}

describe("WatchAndHeal, at open", () => {
	const started: WatchAndHeal[] = []

	afterEach(async () => {
		for (const w of started.splice(0)) await w.stop()
	})

	it("heals a page that was already on disk before the watcher started", async () => {
		const root = await makeProject()
		const page = path.join(root, ".caret", "pages", "about", "index.tsx")
		await fs.writeFile(page, UNHEALED)

		const healer = new WatchAndHeal({ projectPath: root })
		started.push(healer)
		healer.start()

		const deadline = Date.now() + 8000
		let healed = ""
		while (Date.now() < deadline) {
			healed = await fs.readFile(page, "utf-8")
			if (healed.includes("data-caret-id")) break
			await new Promise((r) => setTimeout(r, 100))
		}
		assert.ok(healed.includes("data-caret-id"), "a page present at open was never healed")
	})

	it("writes nothing when the project on disk is already healed", async () => {
		const root = await makeProject()
		const page = path.join(root, ".caret", "pages", "about", "index.tsx")
		await fs.writeFile(page, UNHEALED)

		// First pass heals it.
		const first = new WatchAndHeal({ projectPath: root })
		started.push(first)
		first.start()
		const deadline = Date.now() + 8000
		while (Date.now() < deadline) {
			if ((await fs.readFile(page, "utf-8")).includes("data-caret-id")) break
			await new Promise((r) => setTimeout(r, 100))
		}
		await first.stop()
		const healedText = await fs.readFile(page, "utf-8")
		const healedAt = (await fs.stat(page)).mtimeMs

		// Second open must be a no-op: the sweep runs on every start, so a
		// project that is already healed has to be read and left alone. A rewrite
		// here would trigger HMR and a provenance entry on every single open.
		const second = new WatchAndHeal({ projectPath: root })
		started.push(second)
		second.start()
		await new Promise((r) => setTimeout(r, 3000))

		assert.equal(await fs.readFile(page, "utf-8"), healedText, "the second open rewrote an already-healed page")
		assert.equal((await fs.stat(page)).mtimeMs, healedAt, "the second open touched the file")
	})
})
