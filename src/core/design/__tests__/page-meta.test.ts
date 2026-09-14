/**
 * A page's identity is its directory, not its meta.json.
 *
 * The folder name is the import path and the URL route. When `meta.json`
 * claimed a different id, everything downstream broke *quietly*: the canvas
 * card rendered and thumbnailed but had no click handler (the canvas decides
 * that with `routes.some(r => r.name === page.id)`, where the route name is the
 * folder), `<a href="/id">` went nowhere, flow steps referencing it dangled,
 * and `get_screenshot` missed. AI-written meta.json is exactly how that
 * happens, and none of it produced an error anywhere.
 */
import { strict as assert } from "assert"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { listPages, readPageMeta } from "../page-meta"

async function fixture(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "caret-pagemeta-"))
}

async function writePage(root: string, dir: string, meta: unknown): Promise<void> {
	const pageDir = path.join(root, ".caret", "pages", dir)
	await fs.mkdir(pageDir, { recursive: true })
	await fs.writeFile(path.join(pageDir, "index.tsx"), "export default function P() { return null }\n")
	if (meta !== undefined) await fs.writeFile(path.join(pageDir, "meta.json"), JSON.stringify(meta, null, 2))
}

describe("readPageMeta", () => {
	it("takes the id from the directory, overriding a meta.json that disagrees", async () => {
		const root = await fixture()
		await writePage(root, "about", { id: "about-us", title: "About", type: "page", states: [], tags: [] })

		const meta = await readPageMeta(root, "about")

		assert.equal(meta?.id, "about", "the stored id won, which makes the page unopenable on the canvas")
		assert.equal(meta?.title, "About", "the rest of the meta was discarded along with it")
		await fs.rm(root, { recursive: true, force: true })
	})

	it("still fills in every other field it is missing", async () => {
		const root = await fixture()
		await writePage(root, "home", { title: "Home" })

		const meta = await readPageMeta(root, "home")

		assert.deepEqual(meta, { id: "home", title: "Home", type: "page", states: [], tags: [] })
		await fs.rm(root, { recursive: true, force: true })
	})

	it("carries variantOf through normalization — every hide-takes filter depends on it", async () => {
		const root = await fixture()
		await writePage(root, "home--v1", { title: "Home — take 1", variantOf: "home" })
		await writePage(root, "home", { title: "Home" })

		const meta = await readPageMeta(root, "home--v1")
		assert.equal(
			meta?.variantOf,
			"home",
			"variantOf was dropped — design checks, sync and rules would all see takes as pages",
		)

		const visible = (await listPages(root)).filter((p) => !p.variantOf)
		assert.deepEqual(
			visible.map((p) => p.id),
			["home"],
			"the take survived the standard exclusion filter",
		)
		await fs.rm(root, { recursive: true, force: true })
	})

	it("returns null on unparseable json rather than inventing a page", async () => {
		const root = await fixture()
		const pageDir = path.join(root, ".caret", "pages", "broken")
		await fs.mkdir(pageDir, { recursive: true })
		await fs.writeFile(path.join(pageDir, "meta.json"), "{ not json")

		assert.equal(await readPageMeta(root, "broken"), null)
		await fs.rm(root, { recursive: true, force: true })
	})
})

describe("listPages", () => {
	it("reports every page under its directory name, however meta.json is written", async () => {
		const root = await fixture()
		await writePage(root, "home", { id: "home", title: "Home", type: "page", states: [], tags: [] })
		await writePage(root, "about", { id: "about-us", title: "About", type: "page", states: [], tags: [] })
		await writePage(root, "contact", undefined) // no meta.json at all

		const ids = (await listPages(root)).map((page) => page.id).sort()

		assert.deepEqual(ids, ["about", "contact", "home"])
		await fs.rm(root, { recursive: true, force: true })
	})
})
