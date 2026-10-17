import { strict as assert } from "assert"

import { matchesSearch, pageOf } from "../mcp/paging"

describe("growing lists come a page at a time", () => {
	const items = Array.from({ length: 1000 }, (_, i) => i)

	it("returns the same page size for a thousand items as for a few", () => {
		assert.equal(pageOf(items, 1, 30, "assets").items.length, 30)
		assert.equal(pageOf(items.slice(0, 5), 1, 30, "assets").items.length, 5)
	})

	it("says how much is left and which page to ask for", () => {
		const first = pageOf(items, 1, 30, "assets")
		assert.equal(first.pages, 34)
		assert.equal(first.more, "970 more assets: ask for page 2")
		assert.equal(pageOf(items, 34, 30, "assets").more, null)
	})

	it("clamps a page past the end, or below one, into range", () => {
		assert.equal(pageOf(items, 99, 30, "assets").page, 34)
		assert.equal(pageOf(items, 0, 30, "assets").page, 1)
		assert.deepEqual(pageOf([], 3, 30, "assets"), { items: [], total: 0, page: 1, pages: 1, more: null })
	})

	it("matches every search word, in any order and case", () => {
		assert.ok(matchesSearch("hero-shot photo of the smoker", "Smoker HERO"))
		assert.ok(!matchesSearch("hero-shot photo of the smoker", "smoker logo"))
		assert.ok(matchesSearch("anything", "  "))
	})
})
