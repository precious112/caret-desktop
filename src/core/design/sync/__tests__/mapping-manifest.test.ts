import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import "should"

import { hashFileContent, manifestPath, pruneManifest, readManifest, recordMappings } from "../mapping-manifest"

describe("mapping manifest — recorded at translation time, never inferred", () => {
	let dir: string

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "manifest-"))
		await fs.mkdir(path.join(dir, ".caret", "pages", "checkout"), { recursive: true })
		await fs.mkdir(path.join(dir, "src", "routes"), { recursive: true })
		await fs.writeFile(path.join(dir, ".caret", "pages", "checkout", "index.tsx"), "design v1")
		await fs.writeFile(path.join(dir, "src", "routes", "checkout.tsx"), "app v1")
	})
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("records a mapping with both sides' content hashes", async () => {
		const result = await recordMappings(
			dir,
			[{ designPath: ".caret/pages/checkout/index.tsx", appPaths: ["src/routes/checkout.tsx"] }],
			"abc123",
		)
		result.recorded.should.equal(1)
		result.refused.length.should.equal(0)

		const manifest = await readManifest(dir)
		manifest.entries.length.should.equal(1)
		const entry = manifest.entries[0]
		entry.designPath.should.equal(".caret/pages/checkout/index.tsx")
		entry.appPaths.should.eql(["src/routes/checkout.tsx"])
		entry.syncedAt?.should.equal("abc123")
		entry.designHash?.should.equal(await hashFileContent(path.join(dir, ".caret", "pages", "checkout", "index.tsx")))
		entry.appHashes["src/routes/checkout.tsx"]?.should.equal(
			await hashFileContent(path.join(dir, "src", "routes", "checkout.tsx")),
		)
	})

	it("upserts by design path — a re-sync replaces the mapping wholesale", async () => {
		await recordMappings(
			dir,
			[{ designPath: ".caret/pages/checkout/index.tsx", appPaths: ["src/routes/checkout.tsx"] }],
			"abc123",
		)
		await fs.writeFile(path.join(dir, "src", "routes", "form.tsx"), "extracted form")
		await recordMappings(
			dir,
			[{ designPath: ".caret/pages/checkout/index.tsx", appPaths: ["src/routes/form.tsx"] }],
			"def456",
		)

		const manifest = await readManifest(dir)
		manifest.entries.length.should.equal(1)
		manifest.entries[0].appPaths.should.eql(["src/routes/form.tsx"])
		manifest.entries[0].syncedAt?.should.equal("def456")
		Object.keys(manifest.entries[0].appHashes).should.eql(["src/routes/form.tsx"])
	})

	it("refuses non-design sources, escapes, and empty app lists — with reasons", async () => {
		const result = await recordMappings(
			dir,
			[
				{ designPath: "src/routes/checkout.tsx", appPaths: ["src/x.tsx"] },
				{ designPath: ".caret/pages/checkout/index.tsx", appPaths: ["../outside.tsx"] },
				{ designPath: ".caret/pages/checkout/index.tsx", appPaths: [] },
			],
			null,
		)
		result.recorded.should.equal(0)
		result.refused.length.should.equal(3)
		result.refused[0].should.containEql("not a design-layer file")
		result.refused[1].should.containEql("not an app file")
	})

	it("hashes a missing claimed file as null instead of refusing the record", async () => {
		const result = await recordMappings(
			dir,
			[{ designPath: ".caret/pages/checkout/index.tsx", appPaths: ["src/routes/not-written-yet.tsx"] }],
			null,
		)
		result.recorded.should.equal(1)
		const manifest = await readManifest(dir)
		;(manifest.entries[0].appHashes["src/routes/not-written-yet.tsx"] === null).should.be.true()
	})

	it("degrades a corrupt manifest to empty instead of crashing the sync", async () => {
		await fs.writeFile(manifestPath(dir), "{ torn")
		const manifest = await readManifest(dir)
		manifest.entries.length.should.equal(0)
	})

	it("prunes entries whose design file was deleted", async () => {
		await recordMappings(
			dir,
			[{ designPath: ".caret/pages/checkout/index.tsx", appPaths: ["src/routes/checkout.tsx"] }],
			null,
		)
		await fs.rm(path.join(dir, ".caret", "pages", "checkout"), { recursive: true })
		const dropped = await pruneManifest(dir)
		dropped.should.equal(1)
		;(await readManifest(dir)).entries.length.should.equal(0)
	})
})
