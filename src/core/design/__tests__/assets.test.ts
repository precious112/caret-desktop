import * as fs from "fs/promises"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as os from "os"
import * as path from "path"
import "should"

import { probeDimensions, probeSvg } from "../assets/probe"
import { expandReferences, fitWarning, summariseForRules } from "../assets/references"
import { describeAsset, postersDirectory, readAssetIndex, reindexAssets, retagAsset, setPoster } from "../assets/store"
import { deriveTag, findTagReferences, uniqueTag, validateTag } from "../assets/tags"
import type { AssetEntry, AssetIndex } from "../assets/types"
import { buildVisualEditPrompt } from "../visual-editing/context-builder"

/** A minimal but genuinely valid PNG header — 3x7, so the numbers are distinctive. */
function pngHeader(width: number, height: number): Buffer {
	const buffer = Buffer.alloc(24)
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
	buffer.writeUInt32BE(13, 8)
	buffer.write("IHDR", 12, "ascii")
	buffer.writeUInt32BE(width, 16)
	buffer.writeUInt32BE(height, 20)
	return buffer
}

function gifHeader(width: number, height: number): Buffer {
	const buffer = Buffer.alloc(10)
	buffer.write("GIF89a", 0, "ascii")
	buffer.writeUInt16LE(width, 6)
	buffer.writeUInt16LE(height, 8)
	return buffer
}

function jpegHeader(width: number, height: number): Buffer {
	// SOI, then a APP0 segment to be skipped, then an SOF0 carrying the size.
	const buffer = Buffer.alloc(31)
	buffer.writeUInt16BE(0xffd8, 0)
	buffer.writeUInt16BE(0xffe0, 2)
	buffer.writeUInt16BE(10, 4)
	buffer.writeUInt16BE(0xffc0, 14)
	buffer.writeUInt16BE(11, 16)
	buffer[18] = 8
	buffer.writeUInt16BE(height, 19)
	buffer.writeUInt16BE(width, 21)
	return buffer
}

describe("asset tags", () => {
	it("accepts kebab-case and rejects everything that would need quoting", () => {
		validateTag("hero-shot").ok.should.be.true()
		validateTag("logo2").ok.should.be.true()
		validateTag("Hero Shot").ok.should.be.false()
		validateTag("hero_shot").ok.should.be.false()
		validateTag("-hero").ok.should.be.false()
		validateTag("hero-").ok.should.be.false()
		validateTag("").ok.should.be.false()
	})

	it("refuses words that read as a category rather than an asset", () => {
		validateTag("image").ok.should.be.false()
		validateTag("everyone").ok.should.be.false()
	})

	it("derives a usable tag from a filename", () => {
		deriveTag("Hero Shot@2x.PNG").should.equal("hero-shot-2x")
		deriveTag("IMG_4821.jpg").should.equal("img-4821")
		deriveTag("....png").should.equal("asset")
	})

	it("disambiguates rather than overwriting", () => {
		uniqueTag("hero", ["hero", "hero-2"]).should.equal("hero-3")
		uniqueTag("hero", []).should.equal("hero")
	})

	it("finds references without matching emails or paths", () => {
		findTagReferences("use @hero-shot here").should.deepEqual(["hero-shot"])
		findTagReferences("mail me at bob@example.com").should.deepEqual([])
		findTagReferences("see ./assets/a@2x.png").should.deepEqual([])
		findTagReferences("@one and @two and @one").should.deepEqual(["one", "two"])
	})
})

describe("dimension probing", () => {
	it("reads PNG, GIF and JPEG headers", () => {
		probeDimensions(pngHeader(2400, 1350), ".png")!.should.deepEqual({ width: 2400, height: 1350 })
		probeDimensions(gifHeader(320, 240), ".gif")!.should.deepEqual({ width: 320, height: 240 })
		probeDimensions(jpegHeader(1024, 768), ".jpg")!.should.deepEqual({ width: 1024, height: 768 })
	})

	it("returns null rather than guessing on a format it cannot read", () => {
		;(probeDimensions(Buffer.from("not an image"), ".avif") === null).should.be.true()
		;(probeDimensions(Buffer.alloc(4), ".png") === null).should.be.true()
	})

	it("prefers an SVG viewBox over a percentage width", () => {
		probeSvg('<svg width="100%" height="100%" viewBox="0 0 64 32"></svg>')!.should.deepEqual({ width: 64, height: 32 })
		probeSvg('<svg width="48" height="24"></svg>')!.should.deepEqual({ width: 48, height: 24 })
		;(probeSvg('<svg width="100%"></svg>') === null).should.be.true()
	})
})

describe("asset index", () => {
	let dir = ""

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "caret-assets-"))
		await fs.mkdir(path.join(dir, ".caret", "assets"), { recursive: true })
	})

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	const write = (name: string, buffer: Buffer) => fs.writeFile(path.join(dir, ".caret", "assets", name), buffer)

	it("indexes files that were written directly, with no tool involved", async () => {
		await write("hero-shot.png", pngHeader(2400, 1350))
		const result = await reindexAssets(dir)

		result.added.should.deepEqual(["hero-shot"])
		result.index.assets[0].width!.should.equal(2400)
		result.index.assets[0].kind.should.equal("image")
		result.index.assets[0].origin.type.should.equal("discovered")
	})

	it("skips unsupported files and says why, rather than indexing them", async () => {
		await write("notes.txt", Buffer.from("hello"))
		const result = await reindexAssets(dir)

		result.index.assets.should.have.length(0)
		result.skipped.should.have.length(1)
		result.skipped[0].reason.should.match(/not a supported asset type/)
	})

	it("keeps a hand-written description when the file's bytes change", async () => {
		await write("hero.png", pngHeader(100, 100))
		await reindexAssets(dir)
		await describeAsset(dir, "hero", { description: "wide, dark, room top-left", alt: "A workbench" })

		await write("hero.png", pngHeader(2400, 1350))
		const result = await reindexAssets(dir)

		result.updated.should.deepEqual(["hero"])
		result.index.assets[0].description.should.equal("wide, dark, room top-left")
		result.index.assets[0].alt.should.equal("A workbench")
		result.index.assets[0].width!.should.equal(2400)
	})

	it("drops entries whose file is gone", async () => {
		await write("gone.png", pngHeader(10, 10))
		await reindexAssets(dir)
		await fs.rm(path.join(dir, ".caret", "assets", "gone.png"))

		const result = await reindexAssets(dir)
		result.removed.should.deepEqual(["gone"])
		result.index.assets.should.have.length(0)
	})

	it("refuses a retag that would collide or is malformed", async () => {
		await write("a.png", pngHeader(10, 10))
		await write("b.png", pngHeader(10, 10))
		await reindexAssets(dir)

		;(await retagAsset(dir, "a", "b")).ok.should.be.false()
		;(await retagAsset(dir, "a", "Not A Tag")).ok.should.be.false()
		;(await retagAsset(dir, "a", "hero-shot")).ok.should.be.true()
		;(await readAssetIndex(dir)).assets.map((x) => x.tag).should.containEql("hero-shot")
	})

	it("survives a corrupt index without throwing", async () => {
		await fs.writeFile(path.join(dir, ".caret", "assets", "index.json"), "{ not json")
		;(await readAssetIndex(dir)).assets.should.have.length(0)
	})

	it("stores a poster frame outside the index, so it never becomes an asset itself", async () => {
		await write("clip.mp4", Buffer.from("not really a video"))
		await reindexAssets(dir)

		const stored = await setPoster(dir, "clip", pngHeader(320, 180))
		stored.ok.should.be.true()

		const index = await readAssetIndex(dir)
		index.assets.should.have.length(1)
		index.assets[0].poster!.should.equal("clip.mp4.png")
		await fs.stat(path.join(postersDirectory(dir), "clip.mp4.png"))

		// The reindex that follows a poster write must not turn the poster into a
		// second entry — a poster with its own @tag is a second name for one thing.
		const after = await reindexAssets(dir)
		after.index.assets.should.have.length(1)
	})

	it("drops a poster when the video it was taken from is replaced", async () => {
		await write("clip.mp4", Buffer.from("first cut"))
		await reindexAssets(dir)
		await setPoster(dir, "clip", pngHeader(320, 180))

		await write("clip.mp4", Buffer.from("a different cut entirely"))
		const result = await reindexAssets(dir)

		result.updated.should.deepEqual(["clip"])
		;(result.index.assets[0].poster === undefined).should.be.true()
	})
})

describe("reference expansion", () => {
	const entry: AssetEntry = {
		tag: "hero-shot",
		file: "hero-shot.png",
		kind: "image",
		mime: "image/png",
		width: 2400,
		height: 1350,
		bytes: 1000,
		hash: "sha256:abc",
		alt: "A workbench",
		description: "wide, dark, room top-left",
		origin: { type: "uploaded" },
		addedAt: "2026-08-02T00:00:00Z",
	}
	const index: AssetIndex = { version: 1, assets: [entry] }

	it("replaces the reference with details the agent can place from", () => {
		const result = expandReferences("Put @hero-shot behind the headline", index)

		result.text.should.not.match(/@hero-shot/)
		result.text.should.match(/\/caret-assets\/hero-shot\.png/)
		result.text.should.match(/2400x1350/)
		result.text.should.match(/room top-left/)
		result.resolved.should.have.length(1)
	})

	it("leaves an unknown reference in place and reports it", () => {
		const result = expandReferences("Use @hero-shoot please", index)

		result.text.should.match(/@hero-shoot/)
		result.unknown.should.deepEqual(["hero-shoot"])
		result.resolved.should.have.length(0)
	})

	it("summarises for the always-on rules block", () => {
		summariseForRules(entry).should.equal(
			"@hero-shot (image 2400x1350) /caret-assets/hero-shot.png — wide, dark, room top-left",
		)
	})
})

describe("fit warnings", () => {
	const small: AssetEntry = {
		tag: "logo",
		file: "logo.png",
		kind: "image",
		mime: "image/png",
		width: 400,
		height: 400,
		bytes: 1,
		hash: "sha256:x",
		alt: "",
		description: "",
		origin: { type: "uploaded" },
		addedAt: "2026-08-02T00:00:00Z",
	}

	it("warns when an asset would be visibly upscaled", () => {
		fitWarning(small, { width: 2400, height: 2400 })!.should.match(/upscaled 6\.0x/)
	})

	it("warns when the aspect ratios are incompatible", () => {
		const wide = { ...small, width: 2400, height: 400 }
		fitWarning(wide, { width: 400, height: 600 })!.should.match(/Cropping to fit/)
	})

	it("stays quiet when the asset comfortably fits", () => {
		;(fitWarning(small, { width: 380, height: 380 }) === null).should.be.true()
	})

	it("stays quiet when the size is unknown rather than inventing a verdict", () => {
		;(fitWarning({ ...small, width: null, height: null }, { width: 2400, height: 2400 }) === null).should.be.true()
	})
})

/**
 * The fit judgment only earns its place if it reaches the model. `fitWarning`
 * being correct in isolation was already true before the box travelled with the
 * instruction, and nothing downstream read it.
 */
describe("fit judgment in the edit prompt", () => {
	let dir = ""

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "caret-fit-"))
		await fs.mkdir(path.join(dir, ".caret", "assets"), { recursive: true })
		await fs.writeFile(path.join(dir, ".caret", "assets", "brand-mark.png"), pngHeader(400, 400))
		await reindexAssets(dir)
	})

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	const request = (box?: { width: number; height: number }) => ({
		instruction: "Put @brand-mark in here",
		filePath: "",
		lineNumber: 0,
		columnNumber: 0,
		componentName: "",
		caretId: "",
		componentStack: "",
		box,
	})

	it("tells the agent the measured size and that refusing is allowed", async () => {
		const prompt = await buildVisualEditPrompt(request({ width: 2400, height: 900 }), dir)

		prompt.should.match(/2400x900 CSS pixels/)
		prompt.should.match(/upscaled/)
		prompt.should.match(/refuse and say why/)
	})

	it("says nothing about fit when the asset suits the space", async () => {
		const prompt = await buildVisualEditPrompt(request({ width: 380, height: 380 }), dir)

		prompt.should.match(/380x380 CSS pixels/)
		prompt.should.not.match(/Caret measured a poor fit/)
	})

	it("ignores a nonsense box rather than quoting it to the model as fact", async () => {
		const prompt = await buildVisualEditPrompt(request({ width: 0, height: Number.NaN }), dir)

		prompt.should.not.match(/CSS pixels/)
		prompt.should.match(/\/caret-assets\/brand-mark\.png/)
	})

	it("still expands the reference when no box was measured", async () => {
		const prompt = await buildVisualEditPrompt(request(), dir)

		prompt.should.match(/\/caret-assets\/brand-mark\.png/)
		prompt.should.not.match(/CSS pixels/)
	})
})
