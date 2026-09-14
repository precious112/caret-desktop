import * as fs from "fs/promises"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as os from "os"
import * as path from "path"
import should from "should"

import {
	editJSXColor,
	editJSXImageSrc,
	editJSXText,
	findJSXElementAtLine,
	findJSXElementAtPosition,
	findJSXElementByCaretId,
	parseSource,
} from "../ast-editor"

describe("findJSXElementByCaretId", () => {
	it("should find an element by data-caret-id", () => {
		const source = `<div><h1 data-caret-id="title" className="text-white">Hello</h1></div>`
		const ast = parseSource(source)
		const result = findJSXElementByCaretId(ast, "title")
		should(result).not.be.null()
		result!.openingElement.name.type.should.equal("JSXIdentifier")
		// biome-ignore lint/suspicious/noExplicitAny: recast AST node types
		;(result!.openingElement.name as any).name.should.equal("h1")
	})

	it("should find a nested element, not the parent", () => {
		const source = `<div data-caret-id="wrapper">
  <h1 data-caret-id="title">
    Text <span data-caret-id="subtitle">Sub</span>
  </h1>
</div>`
		const ast = parseSource(source)
		const result = findJSXElementByCaretId(ast, "subtitle")
		should(result).not.be.null()
		// biome-ignore lint/suspicious/noExplicitAny: recast AST node types
		;(result!.openingElement.name as any).name.should.equal("span")
	})

	it("should find h1 when queried by h1 caret id (same-line siblings)", () => {
		const source = `<h1 data-caret-id="title" className="text-white">Text <span data-caret-id="accent" className="text-zinc-500">Sub</span></h1>`
		const ast = parseSource(source)

		const h1 = findJSXElementByCaretId(ast, "title")
		should(h1).not.be.null()
		// biome-ignore lint/suspicious/noExplicitAny: recast AST node types
		;(h1!.openingElement.name as any).name.should.equal("h1")

		const span = findJSXElementByCaretId(ast, "accent")
		should(span).not.be.null()
		// biome-ignore lint/suspicious/noExplicitAny: recast AST node types
		;(span!.openingElement.name as any).name.should.equal("span")
	})

	it("should return null when no match exists", () => {
		const source = `<div data-caret-id="wrapper"><p>Hello</p></div>`
		const ast = parseSource(source)
		const result = findJSXElementByCaretId(ast, "nonexistent")
		should(result).be.null()
	})

	it("should find a deeply nested element", () => {
		const source = `<div>
  <section>
    <div>
      <p data-caret-id="deep-text">Found me</p>
    </div>
  </section>
</div>`
		const ast = parseSource(source)
		const result = findJSXElementByCaretId(ast, "deep-text")
		should(result).not.be.null()
		// biome-ignore lint/suspicious/noExplicitAny: recast AST node types
		;(result!.openingElement.name as any).name.should.equal("p")
	})
})

describe("findJSXElementAtLine", () => {
	it("should find an element at the exact line", () => {
		const source = `<div>
  <h1 className="text-white">Hello</h1>
</div>`
		const ast = parseSource(source)
		const result = findJSXElementAtLine(ast, 2)
		should(result).not.be.null()
		// biome-ignore lint/suspicious/noExplicitAny: recast AST node types
		;(result!.openingElement.name as any).name.should.equal("h1")
	})

	it("should find nearest element with matching tagName when no exact line match", () => {
		const source = `<div>
  <h1>Title</h1>
  <p>Paragraph</p>
  <span>Text</span>
</div>`
		const ast = parseSource(source)
		const result = findJSXElementAtLine(ast, 5, "span")
		should(result).not.be.null()
		// biome-ignore lint/suspicious/noExplicitAny: recast AST node types
		;(result!.openingElement.name as any).name.should.equal("span")
	})

	it("should return null when no match exists", () => {
		const source = `<div><p>Hello</p></div>`
		const ast = parseSource(source)
		const result = findJSXElementAtLine(ast, 99)
		should(result).be.null()
	})
})

describe("editJSXText with caretId", () => {
	let tmpDir: string
	let tmpFile: string

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-editor-test-"))
		tmpFile = path.join(tmpDir, "test.tsx")
	})

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	it("should edit text of the element matched by caretId", async () => {
		const source = `<div>
  <h1 data-caret-id="title">Old Title</h1>
  <span data-caret-id="sub">Old Sub</span>
</div>`
		await fs.writeFile(tmpFile, source)

		const result = await editJSXText(tmpFile, 1, "span", "New Sub", "Old Sub", "sub")
		result.should.be.true()

		const output = await fs.readFile(tmpFile, "utf-8")
		output.should.containEql("New Sub")
		output.should.containEql("Old Title")
	})

	it("applying the same edit twice writes it once — the FIND YOUR LANE bug, replayed", async () => {
		// The transport delivered every inline edit twice (the canvas relay
		// re-posted into its own window at top level). Apply #1 wrote the file;
		// apply #2's stale guard rejected the AST path, and the raw fallback then
		// found "Find your lane" INSIDE "Find your lanes" — the old text is a
		// prefix of the new — and produced "Find your laness". The editor must be
		// idempotent whatever the transport does.
		const source = `<div>
  <h2 data-caret-id="category-title">Find your lane</h2>
</div>`
		await fs.writeFile(tmpFile, source)

		const first = await editJSXText(tmpFile, 2, "h2", "Find your lanes", "Find your lane", "category-title")
		first.should.be.true()

		const second = await editJSXText(tmpFile, 2, "h2", "Find your lanes", "Find your lane", "category-title")
		second.should.be.true(
			"the duplicate must report success — a failure toast on an applied edit reads as 'editing is broken'",
		)

		const output = await fs.readFile(tmpFile, "utf-8")
		output.should.containEql("Find your lanes")
		output.should.not.containEql("laness")
		output.match(/Find your lanes/g)!.length.should.equal(1)
	})

	it("a duplicate whose old text is NOT a prefix of the new is also a silent success", async () => {
		// The prefix shape is the corrupting one; the disjoint shape used to fail
		// loudly instead ("can't be edited inline") — which is what "text edits
		// stopped working on that node" looked like. Both duplicates must land as
		// success with a single write.
		const source = `<div>
  <h2 data-caret-id="hero">Old headline</h2>
</div>`
		await fs.writeFile(tmpFile, source)
		;(await editJSXText(tmpFile, 2, "h2", "Fresh copy", "Old headline", "hero")).should.be.true()
		;(await editJSXText(tmpFile, 2, "h2", "Fresh copy", "Old headline", "hero")).should.be.true()

		const output = await fs.readFile(tmpFile, "utf-8")
		output.should.containEql("Fresh copy")
		output.should.not.containEql("Old headline")
	})

	it("the raw fallback refuses the prefix trap even with no element to anchor on", async () => {
		// Element lookup misses entirely (wrong line, no caretId), so only the
		// unique-occurrence fallback runs. The file already carries the applied
		// edit; the stale oldText matches only as a substring of it. Writing
		// there is the corruption; the right answer is success-without-write.
		const source = `<div>
  <p>Find your lanes</p>
</div>`
		await fs.writeFile(tmpFile, source)

		const result = await editJSXText(tmpFile, 99, "h2", "Find your lanes", "Find your lane")
		result.should.be.true()

		const output = await fs.readFile(tmpFile, "utf-8")
		output.should.equal(source)
	})

	it("should fall back to line-based lookup when caretId is not provided", async () => {
		const source = `<div>
  <h1>Editable</h1>
</div>`
		await fs.writeFile(tmpFile, source)

		const result = await editJSXText(tmpFile, 2, "h1", "Changed")
		result.should.be.true()

		const output = await fs.readFile(tmpFile, "utf-8")
		output.should.containEql("Changed")
	})
})

describe("editJSXColor with caretId", () => {
	let tmpDir: string
	let tmpFile: string

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-editor-test-"))
		tmpFile = path.join(tmpDir, "test.tsx")
	})

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	it("should change color on the span, not the h1, when targeting span caretId", async () => {
		const source = `<h1 data-caret-id="title" className="text-white">Text <span data-caret-id="accent" className="text-zinc-500">Sub</span></h1>`
		await fs.writeFile(tmpFile, source)

		const result = await editJSXColor(tmpFile, 1, "#00ff00", "accent")
		result.ok.should.be.true()

		const output = await fs.readFile(tmpFile, "utf-8")
		output.should.containEql("text-[#00ff00]")
		output.should.containEql('className="text-white"')
	})

	it("should change color on h1 when targeting h1 caretId", async () => {
		const source = `<h1 data-caret-id="title" className="text-red-500">Hello</h1>`
		await fs.writeFile(tmpFile, source)

		const result = await editJSXColor(tmpFile, 1, "#0000ff", "title")
		result.ok.should.be.true()

		const output = await fs.readFile(tmpFile, "utf-8")
		output.should.containEql("text-[#0000ff]")
	})

	it("should replace an arbitrary hex color class like text-[#b9b1b1]", async () => {
		const source = `<span data-caret-id="accent" className="text-[#b9b1b1]">Bag</span>`
		await fs.writeFile(tmpFile, source)

		const result = await editJSXColor(tmpFile, 1, "#ff0000", "accent")
		result.ok.should.be.true()

		const output = await fs.readFile(tmpFile, "utf-8")
		output.should.containEql("text-[#ff0000]")
		output.should.not.containEql("#b9b1b1")
	})

	it("should replace a named Tailwind color class (regression check)", async () => {
		const source = `<span data-caret-id="label" className="text-zinc-500">Text</span>`
		await fs.writeFile(tmpFile, source)

		const result = await editJSXColor(tmpFile, 1, "#00ff00", "label")
		result.ok.should.be.true()

		const output = await fs.readFile(tmpFile, "utf-8")
		output.should.containEql("text-[#00ff00]")
		output.should.not.containEql("text-zinc-500")
	})

	it("edits a foundation-generated theme colour like text-brand-950", async () => {
		// The exact element this shipped broken on. The foundation writes its own
		// scale into the generated theme and the design rules tell every agent to
		// use it — so `text-brand-950` is what the colour editor meets MOST, and
		// recognising only the stock palette refused it with "use AI Edit".
		const source = `<h2 data-caret-id="featured-title" className="mt-2 text-xl font-black uppercase leading-none tracking-tight text-brand-950 sm:text-2xl">This week's drops</h2>`
		await fs.writeFile(tmpFile, source)

		const result = await editJSXColor(tmpFile, 1, "#e11d48", "featured-title")
		result.ok.should.be.true()

		const output = await fs.readFile(tmpFile, "utf-8")
		output.should.containEql("text-[#e11d48]")
		output.should.not.containEql("text-brand-950")
		// The sized utilities around it are untouched.
		output.should.containEql("text-xl")
		output.should.containEql("tracking-tight")
	})

	it("writes a token class instead of an arbitrary value when tokenClass is given", async () => {
		// Bind-on-match: the picked colour exactly equals brand-500, so the edit
		// binds to the token rather than freezing today's value as a magic number.
		const source = `<h1 data-caret-id="title" className="text-zinc-800 font-bold">Hello</h1>`
		await fs.writeFile(tmpFile, source)

		const result = await editJSXColor(tmpFile, 1, "#0b7aff", "title", "brand-500")
		result.ok.should.be.true()
		should(result.replacedClass).equal("text-zinc-800")

		const output = await fs.readFile(tmpFile, "utf-8")
		output.should.containEql("text-brand-500")
		output.should.not.containEql("text-[#0b7aff]")
	})

	it("reports the class it replaced so a detach from a token is detectable", async () => {
		const source = `<h1 data-caret-id="title" className="bg-brand-500 p-4">Hello</h1>`
		await fs.writeFile(tmpFile, source)

		const result = await editJSXColor(tmpFile, 1, "#123456", "title")
		result.ok.should.be.true()
		should(result.replacedClass).equal("bg-brand-500")

		const output = await fs.readFile(tmpFile, "utf-8")
		output.should.containEql("bg-[#123456]")
	})

	it("does not mistake width utilities like border-2 or ring-2 for colours", async () => {
		// The custom-colour rule is "name…-number with two or more segments":
		// `brand-950` qualifies, a bare width number must not.
		const source = `<div data-caret-id="card" className="border-2 ring-2 ring-offset-2 border-brand-200">Card</div>`
		await fs.writeFile(tmpFile, source)

		const result = await editJSXColor(tmpFile, 1, "#0000ff", "card")
		result.ok.should.be.true()

		const output = await fs.readFile(tmpFile, "utf-8")
		output.should.containEql("border-2")
		output.should.containEql("ring-2")
		output.should.containEql("ring-offset-2")
		output.should.containEql("border-[#0000ff]")
		output.should.not.containEql("border-brand-200")
	})

	it("adds a colour class when the element has none, rather than refusing", async () => {
		// An element that inherits its colour is the most ordinary target the
		// picker gets; "can't be edited inline — use AI Edit" turned a one-token
		// change into a model call.
		const source = `<p data-caret-id="plain" className="mt-4 leading-relaxed">Inherited colour</p>`
		await fs.writeFile(tmpFile, source)

		const result = await editJSXColor(tmpFile, 1, "#dc2626", "plain")
		result.ok.should.be.true()

		const output = await fs.readFile(tmpFile, "utf-8")
		output.should.containEql("mt-4 leading-relaxed text-[#dc2626]")
	})

	it("creates className outright when the element has no attributes to lean on", async () => {
		const source = `<p data-caret-id="bare">Bare</p>`
		await fs.writeFile(tmpFile, source)

		const result = await editJSXColor(tmpFile, 1, "#16a34a", "bare")
		result.ok.should.be.true()

		const output = await fs.readFile(tmpFile, "utf-8")
		output.should.containEql(`className="text-[#16a34a]"`)
	})

	it("refuses a dynamic className rather than stacking a second one", async () => {
		const source = `<p data-caret-id="dyn" className={active ? "text-red-500" : "text-blue-500"}>Dyn</p>`
		await fs.writeFile(tmpFile, source)

		const result = await editJSXColor(tmpFile, 1, "#000000", "dyn")
		result.ok.should.be.false()

		const output = await fs.readFile(tmpFile, "utf-8")
		output.should.equal(source)
		// Exactly one className — a second one would be the worse bug.
		output.match(/className/g)!.length.should.equal(1)
	})

	it("should NOT replace text-4xl or other non-color text- classes", async () => {
		const source = `<h1 data-caret-id="title" className="text-4xl font-bold text-white">Hello</h1>`
		await fs.writeFile(tmpFile, source)

		const result = await editJSXColor(tmpFile, 1, "#ff0000", "title")
		result.ok.should.be.true()

		const output = await fs.readFile(tmpFile, "utf-8")
		output.should.containEql("text-4xl")
		output.should.containEql("font-bold")
		output.should.containEql("text-[#ff0000]")
	})

	it("should NOT replace text-lg, text-sm, or text-center", async () => {
		const source = `<p data-caret-id="desc" className="text-lg text-center text-slate-600">Desc</p>`
		await fs.writeFile(tmpFile, source)

		const result = await editJSXColor(tmpFile, 1, "#123456", "desc")
		result.ok.should.be.true()

		const output = await fs.readFile(tmpFile, "utf-8")
		output.should.containEql("text-lg")
		output.should.containEql("text-center")
		output.should.containEql("text-[#123456]")
		output.should.not.containEql("text-slate-600")
	})
})

describe("editJSXImageSrc with caretId", () => {
	let tmpDir: string
	let tmpFile: string

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-editor-test-"))
		tmpFile = path.join(tmpDir, "test.tsx")
	})

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	it("should update the src of an img matched by caretId", async () => {
		const source = `<div>
  <img data-caret-id="hero-img" src="old.jpg" alt="Hero" />
  <img data-caret-id="thumb-img" src="thumb.jpg" alt="Thumb" />
</div>`
		await fs.writeFile(tmpFile, source)

		const result = await editJSXImageSrc(tmpFile, 1, "new.jpg", "hero-img")
		result.should.be.true()

		const output = await fs.readFile(tmpFile, "utf-8")
		output.should.containEql('src="new.jpg"')
		output.should.containEql('src="thumb.jpg"')
	})
})

describe("findJSXElementAtPosition", () => {
	it("should find the deepest element at a position", () => {
		const source = `<div><h1>Title <span>Accent</span></h1></div>`
		const ast = parseSource(source)
		const result = findJSXElementAtPosition(ast, 1, 16)
		should(result).not.be.null()
		// biome-ignore lint/suspicious/noExplicitAny: recast AST node types
		;(result!.openingElement.name as any).name.should.equal("span")
	})

	it("should find the outer element when position is on opening tag", () => {
		const source = `<div><h1>Title</h1></div>`
		const ast = parseSource(source)
		const result = findJSXElementAtPosition(ast, 1, 5)
		should(result).not.be.null()
		// biome-ignore lint/suspicious/noExplicitAny: recast AST node types
		;(result!.openingElement.name as any).name.should.equal("h1")
	})

	it("should return null for position outside any element", () => {
		const source = `const x = 1`
		const ast = parseSource(source)
		const result = findJSXElementAtPosition(ast, 1, 0)
		should(result).be.null()
	})
})

describe("AST editor hardening", () => {
	let tmpDir: string
	let tmpFile: string

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-editor-test-"))
		tmpFile = path.join(tmpDir, "test.tsx")
	})

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	it("editJSXText should return false for malformed JSX", async () => {
		await fs.writeFile(tmpFile, "<<<<not valid JSX>>>>")
		const result = await editJSXText(tmpFile, 1, "h1", "New")
		result.should.be.false()
	})

	it("editJSXColor should return false for malformed JSX", async () => {
		await fs.writeFile(tmpFile, "<<<<not valid JSX>>>>")
		const result = await editJSXColor(tmpFile, 1, "#ff0000")
		result.ok.should.be.false()
	})

	it("fallbackTextReplace should refuse ambiguous replacements", async () => {
		const source = `<div>
  <span>{items.map(x => <i>Hello</i>)}</span>
  <span>{items.map(x => <i>Hello</i>)}</span>
</div>`
		await fs.writeFile(tmpFile, source)
		const result = await editJSXText(tmpFile, 99, "b", "World", "Hello")
		result.should.be.false()
		const output = await fs.readFile(tmpFile, "utf-8")
		output.should.equal(source)
	})

	it("editJSXText should not edit an element whose text no longer matches oldText (stale target)", async () => {
		// Client captured "Sign up" at line 2, but the file shifted: line 2 is
		// now a different h1. Unique-occurrence fallback should still find the
		// real text elsewhere and fix it there.
		const source = `<div>
  <h1>Welcome back</h1>
  <h2>Sign up</h2>
</div>`
		await fs.writeFile(tmpFile, source)
		const result = await editJSXText(tmpFile, 2, "h1", "Create account", "Sign up")
		result.should.be.true()
		const output = await fs.readFile(tmpFile, "utf-8")
		output.should.containEql("<h1>Welcome back</h1>")
		output.should.containEql("Create account")
		output.should.not.containEql("Sign up")
	})

	it("editJSXText should return false when oldText matches nothing (fully stale)", async () => {
		const source = `<div>
  <h1>Welcome back</h1>
</div>`
		await fs.writeFile(tmpFile, source)
		const result = await editJSXText(tmpFile, 2, "h1", "New", "Text that was deleted")
		result.should.be.false()
		const output = await fs.readFile(tmpFile, "utf-8")
		output.should.equal(source)
	})

	it("editJSXText should tolerate whitespace differences between DOM and source text", async () => {
		const source = `<div>
  <h1>
    Hello
    World
  </h1>
</div>`
		await fs.writeFile(tmpFile, source)
		// DOM textContent collapses the newlines to single spaces
		const result = await editJSXText(tmpFile, 2, "h1", "Greetings", "Hello World")
		result.should.be.true()
		const output = await fs.readFile(tmpFile, "utf-8")
		output.should.containEql("Greetings")
	})

	it("editJSXText without oldText keeps editing the first text child (back-compat)", async () => {
		const source = `<div>
  <h1>Anything</h1>
</div>`
		await fs.writeFile(tmpFile, source)
		const result = await editJSXText(tmpFile, 2, "h1", "Replaced")
		result.should.be.true()
		const output = await fs.readFile(tmpFile, "utf-8")
		output.should.containEql("Replaced")
	})
})
