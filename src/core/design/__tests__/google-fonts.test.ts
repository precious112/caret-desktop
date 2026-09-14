import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import "should"

import { mockFetchForTesting } from "@/shared/net"
import { resetFontCatalogForTesting, searchGoogleFonts } from "../google-fonts"

/**
 * The field failure this file holds down: with no API key the search silently
 * covered 20 bundled fonts while the UI promised all of Google Fonts, so a
 * real family (Young Serif) looked nonexistent. Keyless search now loads the
 * full catalogue from the fonts.google.com metadata endpoint.
 */

const CATALOG_BODY = JSON.stringify({
	familyMetadataList: [
		{ family: "Roboto", category: "Sans Serif", fonts: { "400": {}, "700": {} }, popularity: 1 },
		{ family: "Young Serif", category: "Serif", fonts: { "400": {} }, popularity: 493 },
		{ family: "Archivo", category: "Sans Serif", fonts: { "400": {}, "400i": {}, "600": {}, "600i": {} }, popularity: 90 },
		{ family: "Broken Entry", category: "Serif", fonts: {} },
	],
})

const okResponse = (body: string) =>
	({ ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) }) as unknown as Response

describe("searchGoogleFonts without an API key", () => {
	let dir: string
	let cacheFile: string

	beforeEach(async () => {
		resetFontCatalogForTesting()
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "gf-test-"))
		cacheFile = path.join(dir, "catalog.json")
		delete process.env.GOOGLE_FONTS_API_KEY
	})
	afterEach(async () => {
		resetFontCatalogForTesting()
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("finds a family the bundled list does not carry, labelled google-fonts", async () => {
		const result = await mockFetchForTesting(
			async () => okResponse(CATALOG_BODY),
			() => searchGoogleFonts("young serif", { cacheFile }),
		)
		result.source.should.equal("google-fonts")
		result.fonts.map((f) => f.family).should.containEql("Young Serif")
	})

	it("maps weights (italics collapsed), categories, and drops weightless families", async () => {
		const result = await mockFetchForTesting(
			async () => okResponse(CATALOG_BODY),
			() => searchGoogleFonts("", { cacheFile }),
		)
		const archivo = result.fonts.find((f) => f.family === "Archivo")
		archivo?.variants.should.eql(["400", "600"])
		result.fonts.find((f) => f.family === "Young Serif")?.category.should.equal("serif")
		result.fonts.map((f) => f.family).should.not.containEql("Broken Entry")
		// Popularity ordering: Roboto (1) before Archivo (90) before Young Serif (493).
		result.fonts.map((f) => f.family).should.eql(["Roboto", "Archivo", "Young Serif"])
	})

	it("writes the disk cache and serves from it without the network", async () => {
		await mockFetchForTesting(
			async () => okResponse(CATALOG_BODY),
			() => searchGoogleFonts("", { cacheFile }),
		)
		;(await fs.readFile(cacheFile, "utf-8")).should.containEql("Young Serif")

		resetFontCatalogForTesting()
		const offline = await mockFetchForTesting(
			async () => {
				throw new Error("no network")
			},
			() => searchGoogleFonts("young", { cacheFile }),
		)
		offline.source.should.equal("google-fonts")
		offline.fonts[0]?.family.should.equal("Young Serif")
	})

	it("falls back to the bundled list, honestly labelled, when there is no network and no cache", async () => {
		const result = await mockFetchForTesting(
			async () => {
				throw new Error("no network")
			},
			() => searchGoogleFonts("inter", { cacheFile }),
		)
		result.source.should.equal("bundled")
		result.fonts[0]?.family.should.equal("Inter")

		const missing = await mockFetchForTesting(
			async () => {
				throw new Error("no network")
			},
			() => searchGoogleFonts("young serif", { cacheFile }),
		)
		missing.source.should.equal("bundled")
		missing.fonts.should.be.empty()
	})

	it("ranks prefix matches above substring matches", async () => {
		const body = JSON.stringify({
			familyMetadataList: [
				{ family: "Newsreader", category: "Serif", fonts: { "400": {} }, popularity: 1 },
				{ family: "Readex Pro", category: "Sans Serif", fonts: { "400": {} }, popularity: 2 },
			],
		})
		const result = await mockFetchForTesting(
			async () => okResponse(body),
			() => searchGoogleFonts("read", { cacheFile }),
		)
		result.fonts.map((f) => f.family).should.eql(["Readex Pro", "Newsreader"])
	})
})
