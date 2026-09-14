import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import should from "should"

import { getIndex, hashSource, indexSource } from "../source-index"
import { applyEdits, spliceFile } from "../splice"

describe("applyEdits", () => {
	it("applies multiple spans back-to-front so earlier offsets stay valid", () => {
		const source = "abc def ghi"
		applyEdits(source, [
			{ start: 0, end: 3, text: "AAAA" },
			{ start: 8, end: 11, text: "G" },
		]).should.equal("AAAA def G")
	})

	it("inserts at a zero-width span", () => {
		applyEdits("ab", [{ start: 1, end: 1, text: "-" }]).should.equal("a-b")
	})

	it("refuses overlapping spans — two edits disagreeing about the same bytes", () => {
		should(() =>
			applyEdits("abcdef", [
				{ start: 0, end: 4, text: "x" },
				{ start: 2, end: 6, text: "y" },
			]),
		).throw(/overlapping/)
	})

	it("refuses out-of-range spans", () => {
		should(() => applyEdits("abc", [{ start: 1, end: 9, text: "x" }])).throw(/out of range/)
	})

	it("never moves bytes outside the spans — the whole point versus reprinting", () => {
		const source = `<div>\n\t\t\t<h1>Title</h1>\n</div>`
		const out = applyEdits(source, [{ start: source.indexOf("Title"), end: source.indexOf("Title") + 5, text: "Hello" }])
		out.should.equal(`<div>\n\t\t\t<h1>Hello</h1>\n</div>`)
	})
})

describe("spliceFile", () => {
	let dir: string

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-"))
	})
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("computes spans against the same bytes it splices, and writes once", async () => {
		const file = path.join(dir, "a.tsx")
		await fs.writeFile(file, "hello world")
		const wrote = await spliceFile(file, (source) => [
			{ start: source.indexOf("world"), end: source.indexOf("world") + 5, text: "there" },
		])
		wrote.should.be.true()
		;(await fs.readFile(file, "utf-8")).should.equal("hello there")
	})

	it("declines cleanly when compute returns null or the result is identical", async () => {
		const file = path.join(dir, "a.tsx")
		await fs.writeFile(file, "same")
		should(await spliceFile(file, () => null)).be.false()
		should(await spliceFile(file, () => [{ start: 0, end: 4, text: "same" }])).be.false()
		;(await fs.readFile(file, "utf-8")).should.equal("same")
	})

	it("repeated text edits never inflate indentation — the bug class splice retires", async () => {
		// The recast path read leading/trailing whitespace off the JSXText node,
		// reprinted, re-indented, and grew one level per edit. Splicing the
		// trimmed content span cannot touch the whitespace at all.
		const file = path.join(dir, "page.tsx")
		const original = `export default function P() {
  return (
    <div>
      <h1 data-caret-id="t">One</h1>
    </div>
  )
}
`
		await fs.writeFile(file, original)

		for (const next of ["Two", "Three", "Four"]) {
			await spliceFile(file, (source) => {
				const index = indexSource(source)
				const span = index.elements.get("t")?.textSpans[0]
				if (!span) return null
				return [{ start: span.start, end: span.end, text: next }]
			})
		}

		const final = await fs.readFile(file, "utf-8")
		final.should.equal(original.replace("One", "Four"))
	})
})

describe("source index", () => {
	const SOURCE = `export default function Page() {
  return (
    <section data-caret-id="hero" className="p-8 bg-brand-500">
      <h1 data-caret-id="title" className="text-4xl">Welcome home</h1>
      <img data-caret-id="pic" src="/x.png" />
      <ul>
        {items.map((item) => (
          <li data-caret-id="row" className="p-2">{item.name}</li>
        ))}
      </ul>
    </section>
  )
}
`

	it("indexes elements with attribute and trimmed-text spans", () => {
		const index = indexSource(SOURCE)
		should(index.parseError).be.undefined()

		const title = index.elements.get("title")
		should(title).not.be.undefined()
		title?.tagName.should.equal("h1")
		const cls = title?.attributes.get("className")
		cls?.value?.should.equal("text-4xl")
		SOURCE.slice(cls?.valueStart ?? 0, cls?.valueEnd ?? 0).should.equal("text-4xl")

		const text = title?.textSpans[0]
		SOURCE.slice(text?.start ?? 0, text?.end ?? 0).should.equal("Welcome home")
	})

	it("marks elements inside iterators and leaves the rest unmarked", () => {
		const index = indexSource(SOURCE)
		index.elements.get("row")?.inIterator.should.be.true()
		index.elements.get("title")?.inIterator.should.be.false()
	})

	it("computes the attribute insertion point inside the opening tag", () => {
		const index = indexSource(SOURCE)
		const pic = index.elements.get("pic")
		// Inserting ` alt=""` at openingInsertAt must land before `/>`.
		const out = applyEdits(SOURCE, [{ start: pic?.openingInsertAt ?? 0, end: pic?.openingInsertAt ?? 0, text: ' alt=""' }])
		out.should.containEql(`<img data-caret-id="pic" src="/x.png" alt="" />`)
	})

	it("reports a parse error instead of an empty success", () => {
		const index = indexSource("<<<<not jsx")
		should(index.parseError).not.be.undefined()
		index.elements.size.should.equal(0)
	})

	it("caches by content hash and rebuilds when the source changes", () => {
		const first = getIndex("/virtual/a.tsx", SOURCE)
		const again = getIndex("/virtual/a.tsx", SOURCE)
		should(again).equal(first) // same object — cache hit

		const changed = SOURCE.replace("Welcome home", "Changed")
		const rebuilt = getIndex("/virtual/a.tsx", changed)
		should(rebuilt).not.equal(first)
		hashSource(changed).should.equal(rebuilt.hash)
	})
})
