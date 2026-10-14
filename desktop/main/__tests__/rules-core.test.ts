import { strict as assert } from "assert"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { addPromotedRule, ensureCaretDirectoryExists, writeAssetIndex, writePageMeta } from "../../../src/core/design"
import type { AssetEntry } from "../../../src/core/design/assets/types"
import { buildCore, buildDesignLayer, buildFoundationContext } from "../rules/context"

/**
 * What loads every time has a fixed size. The core goes into AGENTS.md,
 * CLAUDE.md and an always-on Cursor rule, and Codex silently cuts an AGENTS.md
 * past 32 KiB — so the core must stay small, and must not grow with the
 * project: a thousand assets and two hundred pages cost a count, not a list.
 */
describe("the rules core", () => {
	let empty: string
	let big: string

	before(async () => {
		empty = await fs.mkdtemp(path.join(os.tmpdir(), "caret-core-empty-"))
		big = await fs.mkdtemp(path.join(os.tmpdir(), "caret-core-big-"))
		await ensureCaretDirectoryExists(empty)
		await ensureCaretDirectoryExists(big)
		const assets = Array.from(
			{ length: 1000 },
			(_, i) =>
				({
					tag: `asset-${i}`,
					file: `asset-${i}.png`,
					kind: "image",
					mime: "image/png",
					width: 1600,
					height: 900,
					bytes: 123_456,
					alt: `A photograph number ${i} of something on the page`,
					description: `A long description of asset ${i}, the kind a vision model writes, with colour and composition notes.`,
					origin: { type: "upload" },
					addedAt: "2026-10-14T00:00:00Z",
				}) as unknown as AssetEntry,
		)
		await writeAssetIndex(big, { version: 1, assets })
		for (let i = 0; i < 200; i++) {
			await writePageMeta(big, `page-${i}`, {
				id: `page-${i}`,
				title: `Page ${i}`,
				type: "page",
				states: ["default"],
				tags: ["marketing"],
			})
		}
		for (let i = 0; i < 40; i++)
			await addPromotedRule(big, `Standing correction number ${i}: never do the thing ${i}.`, "manual" as never)
	})

	after(async () => {
		await fs.rm(empty, { recursive: true, force: true })
		await fs.rm(big, { recursive: true, force: true })
	})

	it("stays under 200 lines and well under Codex's 32 KiB", async () => {
		for (const project of [empty, big]) {
			const core = await buildCore(project)
			assert.ok(core.split("\n").length < 200, `core is ${core.split("\n").length} lines`)
			assert.ok(Buffer.byteLength(core) < 16 * 1024, `core is ${Buffer.byteLength(core)} bytes`)
		}
	})

	it("is the same size for a thousand assets and two hundred pages as for an empty project", async () => {
		const small = await buildCore(empty)
		const large = await buildCore(big)
		// Only the counts differ ("0 assets" vs "1000 assets").
		assert.ok(
			Math.abs(Buffer.byteLength(large) - Buffer.byteLength(small)) < 40,
			`${Buffer.byteLength(small)} vs ${Buffer.byteLength(large)}`,
		)
		assert.ok(!large.includes("asset-17"), "the core lists assets")
		assert.ok(!large.includes("page-17"), "the core lists pages")
		assert.ok(large.includes("1000 assets") && large.includes("200 pages"), "the core does not give the counts")
	})

	it("tells every agent to read the design layer's rules first", async () => {
		assert.ok((await buildCore(empty)).includes("read `.caret/AGENTS.md`"))
	})

	it("keeps what every tool reply carries fixed-size too", async () => {
		const small = JSON.stringify(await buildFoundationContext(empty))
		const large = JSON.stringify(await buildFoundationContext(big))
		assert.ok(Math.abs(large.length - small.length) < 40, `${small.length} vs ${large.length}`)
	})

	it("puts the standing corrections in the design layer's rules, not the core", async () => {
		assert.ok(!(await buildCore(big)).includes("Standing correction number 3:"))
		assert.ok((await buildDesignLayer(big)).includes("Standing correction number 3:"))
	})
})
