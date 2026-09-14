import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import "should"

import { computeDrift, partitionWorklist } from "../drift"
import { recordMappings } from "../mapping-manifest"

describe("drift detection — hashes both ways, inference nowhere", () => {
	let dir: string
	const designPath = ".caret/pages/checkout/index.tsx"
	const appPath = "src/routes/checkout.tsx"

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "drift-"))
		await fs.mkdir(path.join(dir, ".caret", "pages", "checkout"), { recursive: true })
		await fs.mkdir(path.join(dir, "src", "routes"), { recursive: true })
		await fs.writeFile(path.join(dir, designPath), "design v1")
		await fs.writeFile(path.join(dir, appPath), "app v1")
		await recordMappings(dir, [{ designPath, appPaths: [appPath] }], "abc123")
	})
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("classifies an untouched mapping as clean", async () => {
		const report = await computeDrift(dir)
		report.clean.should.equal(1)
		report.entries[0].classification.should.equal("clean")
	})

	it("design moved, app still → forward", async () => {
		await fs.writeFile(path.join(dir, designPath), "design v2")
		const report = await computeDrift(dir)
		report.forward.should.equal(1)
		report.entries[0].designChanged.should.be.true()
		report.entries[0].changedAppPaths.length.should.equal(0)
	})

	it("app moved, design still → app-drift, naming the moved file", async () => {
		await fs.writeFile(path.join(dir, appPath), "app v2 — someone edited the app directly")
		const report = await computeDrift(dir)
		report.appDrift.should.equal(1)
		report.entries[0].classification.should.equal("app-drift")
		report.entries[0].changedAppPaths.should.eql([appPath])
	})

	it("both moved → conflict, never merged here", async () => {
		await fs.writeFile(path.join(dir, designPath), "design v2")
		await fs.writeFile(path.join(dir, appPath), "app v2")
		const report = await computeDrift(dir)
		report.conflicts.should.equal(1)
		report.entries[0].classification.should.equal("conflict")
	})

	it("a deleted app file is drift — removal is movement too", async () => {
		await fs.rm(path.join(dir, appPath))
		const report = await computeDrift(dir)
		report.appDrift.should.equal(1)
		report.entries[0].changedAppPaths.should.eql([appPath])
	})

	it("a deleted design file is forward movement — deletions sync like edits", async () => {
		await fs.rm(path.join(dir, designPath))
		const report = await computeDrift(dir)
		report.forward.should.equal(1)
	})
})

describe("partitionWorklist — the manifest makes the worklist exact", () => {
	let dir: string
	const designPath = ".caret/pages/checkout/index.tsx"
	const appPath = "src/routes/checkout.tsx"

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "partition-"))
		await fs.mkdir(path.join(dir, ".caret", "pages", "checkout"), { recursive: true })
		await fs.mkdir(path.join(dir, "src", "routes"), { recursive: true })
		await fs.writeFile(path.join(dir, designPath), "design v1")
		await fs.writeFile(path.join(dir, appPath), "app v1")
		await recordMappings(dir, [{ designPath, appPaths: [appPath] }], "abc123")
	})
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("drops verified-already-translated files even when the bookmark says changed", async () => {
		// The forgot-complete_sync case: git-since-bookmark reports the file, the
		// manifest knows the translation already happened.
		const partition = await partitionWorklist(dir, [designPath])
		partition.alreadyTranslated.should.eql([designPath])
		partition.toSync.length.should.equal(0)
	})

	it("keeps genuinely moved design files, and passes unmapped files through", async () => {
		await fs.writeFile(path.join(dir, designPath), "design v2")
		const partition = await partitionWorklist(dir, [designPath, ".caret/pages/new-page/index.tsx"])
		partition.toSync.should.eql([designPath, ".caret/pages/new-page/index.tsx"])
	})

	it("holds conflicts out of the forward worklist", async () => {
		await fs.writeFile(path.join(dir, designPath), "design v2")
		await fs.writeFile(path.join(dir, appPath), "app v2")
		const partition = await partitionWorklist(dir, [designPath])
		partition.conflicts.should.eql([designPath])
		partition.toSync.length.should.equal(0)
	})

	it("classifies app-only movement as reverse-sync material, not forward work", async () => {
		await fs.writeFile(path.join(dir, appPath), "app v2")
		const partition = await partitionWorklist(dir, [designPath])
		partition.appDrifted.should.eql([designPath])
		partition.toSync.length.should.equal(0)
	})
})

describe("framework checkpoint — the mapping layer does not care what the app is written in", () => {
	let dir: string
	const designPath = ".caret/pages/checkout/index.tsx"

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "framework-"))
		await fs.mkdir(path.join(dir, ".caret", "pages", "checkout"), { recursive: true })
		await fs.mkdir(path.join(dir, "src", "routes"), { recursive: true })
		await fs.writeFile(path.join(dir, designPath), "design v1")
	})
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("records, detects drift, and partitions over a Vue app", async () => {
		const vuePath = "src/routes/Checkout.vue"
		await fs.writeFile(path.join(dir, vuePath), "<template><div>checkout</div></template>")
		await recordMappings(dir, [{ designPath, appPaths: [vuePath] }], "abc")
		;(await computeDrift(dir)).clean.should.equal(1)

		await fs.writeFile(path.join(dir, vuePath), "<template><div>edited directly</div></template>")
		const report = await computeDrift(dir)
		report.appDrift.should.equal(1)
		report.entries[0].changedAppPaths.should.eql([vuePath])

		const partition = await partitionWorklist(dir, [designPath])
		partition.appDrifted.should.eql([designPath])
	})

	it("records, detects drift, and partitions over a Svelte app", async () => {
		const sveltePath = "src/routes/checkout/+page.svelte"
		await fs.mkdir(path.join(dir, "src", "routes", "checkout"), { recursive: true })
		await fs.writeFile(path.join(dir, sveltePath), "<script></script><div>checkout</div>")
		await recordMappings(dir, [{ designPath, appPaths: [sveltePath] }], "abc")

		await fs.writeFile(path.join(dir, designPath), "design v2")
		await fs.writeFile(path.join(dir, sveltePath), "<script></script><div>both moved</div>")
		const report = await computeDrift(dir)
		report.conflicts.should.equal(1)

		const partition = await partitionWorklist(dir, [designPath])
		partition.conflicts.should.eql([designPath])
	})
})
