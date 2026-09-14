import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import "should"

import type { FoundationTokens } from "../../types"
import { spliceColorEdit, spliceParamEdit, spliceTextEdit } from "../edit"

const TOKENS: FoundationTokens = {
	vibe: { description: "", tags: [] },
	color: {
		brand: { seed: "#0b7aff", scale: { "500": "#0b7aff" } },
		neutral: { character: "cool", scale: {} },
		semantic: { success: "#16a34a", warning: "#f59e0b", error: "#dc2626", info: "#0ea5e9" },
	},
	typography: { fontFamily: "Inter", fallback: "sans-serif", scaleRatio: 1.25, baseSize: 16, scale: {} },
	spacing: { baseUnit: 4, scale: [] },
	radius: { character: "soft", scale: [0, 2, 4, 8, 12, 9999] },
}

describe("splice-backed editors", () => {
	let dir: string
	let file: string

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-edit-"))
		file = path.join(dir, "index.tsx")
	})
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("text: edits the span and PRESERVES all indentation across repeated edits", async () => {
		const original = `export default function P() {
  return (
    <div>
      <h1 data-caret-id="t" className="text-4xl">Welcome home</h1>
    </div>
  )
}
`
		await fs.writeFile(file, original)
		for (const next of ["First", "Second", "Third"]) {
			const outcome = await spliceTextEdit(file, "t", next, undefined)
			outcome.handled.should.be.true()
			outcome.ok.should.be.true()
		}
		;(await fs.readFile(file, "utf-8")).should.equal(original.replace("Welcome home", "Third"))
	})

	it("text: redelivery of the same edit is success without a write", async () => {
		await fs.writeFile(file, `<h1 data-caret-id="t">Done</h1>`)
		const outcome = await spliceTextEdit(file, "t", "Done", "Old")
		outcome.handled.should.be.true()
		outcome.ok.should.be.true()
		;(await fs.readFile(file, "utf-8")).should.equal(`<h1 data-caret-id="t">Done</h1>`)
	})

	it("text: falls through when there is no caret-id or the text is ambiguous", async () => {
		await fs.writeFile(file, `<h1 data-caret-id="t">One <b>x</b> Two</h1>`)
		const noId = await spliceTextEdit(file, undefined, "New")
		noId.handled.should.be.false()
		const ambiguous = await spliceTextEdit(file, "t", "New")
		ambiguous.handled.should.be.false()
	})

	it("colour: replaces the first colour family in place, keeping family and variant prefixes", async () => {
		await fs.writeFile(file, `<div data-caret-id="c" className="p-4 md:bg-brand-500 text-white">x</div>`)
		const outcome = await spliceColorEdit(file, "c", "#123456")
		outcome.handled.should.be.true()
		outcome.replacedClass?.should.equal("bg-brand-500")
		;(await fs.readFile(file, "utf-8")).should.containEql("md:bg-[#123456]")
		;(await fs.readFile(file, "utf-8")).should.containEql("text-white")
	})

	it("colour: writes the token class when binding", async () => {
		await fs.writeFile(file, `<div data-caret-id="c" className="bg-[#000000]">x</div>`)
		await spliceColorEdit(file, "c", "#0b7aff", "brand-500")
		;(await fs.readFile(file, "utf-8")).should.containEql(`className="bg-brand-500"`)
	})

	it("colour: appends or creates className when no colour class exists", async () => {
		await fs.writeFile(file, `<p data-caret-id="a" className="mt-2">x</p>\n`)
		await spliceColorEdit(file, "a", "#dc2626")
		;(await fs.readFile(file, "utf-8")).should.containEql(`className="mt-2 text-[#dc2626]"`)

		await fs.writeFile(file, `<p data-caret-id="b">x</p>`)
		await spliceColorEdit(file, "b", "#dc2626")
		;(await fs.readFile(file, "utf-8")).should.containEql(`<p data-caret-id="b" className="text-[#dc2626]">x</p>`)
	})

	it("colour: leaves dynamic classNames to the fallback", async () => {
		await fs.writeFile(file, `<div data-caret-id="d" className={cls}>x</div>`)
		const outcome = await spliceColorEdit(file, "d", "#fff")
		outcome.handled.should.be.false()
	})

	it("colour: edits the property the gesture targeted, not the first colour-ish class — the marquee shape", async () => {
		// The exact field failure: a background edit on an element whose
		// className leads with a border width and a border colour. The old
		// matcher replaced `border-y-2` (misclassified as a colour), the
		// background never changed, and the user watched their pick revert.
		await fs.writeFile(file, `<div data-caret-id="m" className="border-y-2 border-brand-950 bg-brand-500 py-3.5">x</div>`)
		const outcome = await spliceColorEdit(file, "m", "#d38809", "brand-600", "background")
		outcome.ok.should.be.true()
		outcome.replacedClass?.should.equal("bg-brand-500")
		const after = await fs.readFile(file, "utf-8")
		after.should.containEql("border-y-2")
		after.should.containEql("border-brand-950")
		after.should.containEql("bg-brand-600")
		after.should.not.containEql("bg-brand-500")
	})

	it("colour: a text-targeted edit skips an earlier background class", async () => {
		await fs.writeFile(file, `<a data-caret-id="cta" className="bg-brand-600 text-neutral-950">x</a>`)
		const outcome = await spliceColorEdit(file, "cta", "#ffffff", undefined, "text")
		outcome.replacedClass?.should.equal("text-neutral-950")
		const after = await fs.readFile(file, "utf-8")
		after.should.containEql("bg-brand-600")
		after.should.containEql("text-[#ffffff]")
	})

	it("colour: prefers the unvarianted class of the target family over a hover variant", async () => {
		await fs.writeFile(file, `<a data-caret-id="h" className="hover:bg-brand-500 bg-brand-600">x</a>`)
		const outcome = await spliceColorEdit(file, "h", "#123456", undefined, "background")
		outcome.replacedClass?.should.equal("bg-brand-600")
		const after = await fs.readFile(file, "utf-8")
		after.should.containEql("hover:bg-brand-500")
		after.should.containEql("bg-[#123456]")
	})

	it("colour: appends the targeted family when no colour class exists", async () => {
		await fs.writeFile(file, `<div data-caret-id="bgless" className="p-4">x</div>`)
		await spliceColorEdit(file, "bgless", "#101010", undefined, "background")
		;(await fs.readFile(file, "utf-8")).should.containEql(`className="p-4 bg-[#101010]"`)
	})

	it("colour: without a target, keeps the historical first-colour behaviour", async () => {
		await fs.writeFile(file, `<div data-caret-id="c2" className="p-4 md:bg-brand-500 text-white">x</div>`)
		const outcome = await spliceColorEdit(file, "c2", "#123456")
		outcome.replacedClass?.should.equal("bg-brand-500")
	})

	it("text: refuses dynamic text with a typed reason instead of falling through", async () => {
		await fs.writeFile(file, `<p data-caret-id="d">{user.name}</p>`)
		const outcome = await spliceTextEdit(file, "d", "New")
		outcome.handled.should.be.true()
		outcome.ok.should.be.false()
		outcome.reason?.should.containEql("comes from data")
		;(await fs.readFile(file, "utf-8")).should.equal(`<p data-caret-id="d">{user.name}</p>`)
	})

	it("text: mixed static + dynamic children still edit the static span by oldText", async () => {
		await fs.writeFile(file, `<p data-caret-id="m">Hello {user.name} friend</p>`)
		const outcome = await spliceTextEdit(file, "m", "Howdy", "Hello")
		outcome.handled.should.be.true()
		outcome.ok.should.be.true()
		;(await fs.readFile(file, "utf-8")).should.containEql("Howdy {user.name} friend")
	})

	it("param: sets a property through the generalized path and refuses with reasons", async () => {
		await fs.writeFile(file, `<div data-caret-id="p" className="p-4">x</div>`)
		const ok = await spliceParamEdit(file, "p", "padding", { raw: "24px" }, 1440, TOKENS)
		ok.ok.should.be.true()
		;(await fs.readFile(file, "utf-8")).should.containEql(`className="p-[24px]"`)

		const missing = await spliceParamEdit(file, "nope", "padding", { raw: "1px" }, 1440, TOKENS)
		missing.ok.should.be.false()
		missing.refused?.should.containEql("caret-id")
	})
})
