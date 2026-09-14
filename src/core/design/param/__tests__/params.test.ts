import should from "should"

import type { FoundationTokens } from "../../types"
import { activeUtilityFor, cssValueOf, parseClassName, propertyOf, resolveParam, writeParam } from "../params"
import { indexSource } from "../source-index"
import { applyEdits } from "../splice"

const TOKENS: FoundationTokens = {
	vibe: { description: "", tags: [] },
	color: {
		brand: { seed: "#0b7aff", scale: { "500": "#0b7aff", "950": "#02142b" } },
		neutral: { character: "cool", scale: { "600": "#5b6472" } },
		semantic: { success: "#16a34a", warning: "#f59e0b", error: "#dc2626", info: "#0ea5e9" },
	},
	typography: { fontFamily: "Inter", fallback: "sans-serif", scaleRatio: 1.25, baseSize: 16, scale: { base: 16, xl: 25 } },
	spacing: { baseUnit: 4, scale: [] },
	radius: { character: "soft", scale: [0, 2, 4, 8, 12, 9999] },
}

const CONTEXT = { viewportWidth: 1440, tokens: TOKENS }

function elementOf(source: string, caretId: string) {
	const element = indexSource(source).elements.get(caretId)
	should(element).not.be.undefined()
	if (!element) throw new Error("unreachable")
	return element
}

describe("parseClassName", () => {
	it("splits variants without breaking arbitrary values", () => {
		const utilities = parseClassName("p-4 md:hover:bg-[url(:x)] text-brand-500")
		utilities.map((u) => u.base).should.eql(["p-4", "bg-[url(:x)]", "text-brand-500"])
		utilities[1].variants.should.eql(["md", "hover"])
	})

	it("records exact offsets within the string", () => {
		const value = "p-4  md:p-8"
		const [a, b] = parseClassName(value)
		value.slice(a.start, a.end).should.equal("p-4")
		value.slice(b.start, b.end).should.equal("md:p-8")
	})
})

describe("propertyOf", () => {
	it("disambiguates the text- family", () => {
		propertyOf("text-xl")?.property.should.equal("font-size")
		propertyOf("text-brand-500")?.property.should.equal("color")
		propertyOf("text-[13px]")?.property.should.equal("font-size")
		propertyOf("text-[#fff]")?.property.should.equal("color")
		should(propertyOf("text-center")).be.null()
	})

	it("keeps border widths and styles out of border-color", () => {
		propertyOf("border-brand-500")?.property.should.equal("border-color")
		should(propertyOf("border-2")).be.null()
		should(propertyOf("border-dashed")).be.null()
	})

	it("maps spacing, size, radius, weight and opacity", () => {
		propertyOf("p-4")?.property.should.equal("padding")
		propertyOf("w-[320px]")?.property.should.equal("width")
		propertyOf("rounded-lg")?.property.should.equal("border-radius")
		propertyOf("font-bold")?.property.should.equal("font-weight")
		propertyOf("opacity-50")?.property.should.equal("opacity")
		should(propertyOf("flex")).be.null()
	})
})

describe("activeUtilityFor", () => {
	const utilities = parseClassName("p-4 md:p-8 hover:p-12 lg:p-2")

	it("resolves the active responsive variant for the viewport", () => {
		activeUtilityFor(utilities, "padding", 375)?.raw.should.equal("p-4")
		activeUtilityFor(utilities, "padding", 800)?.raw.should.equal("md:p-8")
		activeUtilityFor(utilities, "padding", 1440)?.raw.should.equal("lg:p-2")
	})

	it("never lets a state variant decide the resting value", () => {
		activeUtilityFor(utilities, "padding", 1440)?.raw.should.not.equal("hover:p-12")
	})

	it("last one wins among same-breakpoint duplicates", () => {
		const dupes = parseClassName("p-4 p-6")
		activeUtilityFor(dupes, "padding", 375)?.raw.should.equal("p-6")
	})
})

describe("cssValueOf", () => {
	it("computes scale steps, arbitrary values and foundation-backed values", () => {
		cssValueOf({ property: "padding", type: "length", suffix: "4" }, TOKENS)?.should.equal("16px")
		cssValueOf({ property: "padding", type: "length", suffix: "[13px]" }, TOKENS)?.should.equal("13px")
		cssValueOf({ property: "font-size", type: "length", suffix: "xl" }, TOKENS)?.should.equal("25px")
		cssValueOf({ property: "border-radius", type: "length", suffix: "lg" }, TOKENS)?.should.equal("8px")
		cssValueOf({ property: "font-weight", type: "number", suffix: "bold" }, TOKENS)?.should.equal("700")
	})
})

describe("resolveParam — the chain", () => {
	it("resolves a token-bound colour with its splice span", () => {
		const source = `<div data-caret-id="hero" className="p-8 bg-brand-500">x</div>`
		const param = resolveParam(elementOf(source, "hero"), "background-color", CONTEXT)
		param.origin.should.equal("token")
		param.token?.should.equal("brand-500")
		param.value?.should.equal("#0b7aff")
		source.slice(param.source?.start ?? 0, param.source?.end ?? 0).should.equal("bg-brand-500")
	})

	it("resolves the variant that is active at the current viewport", () => {
		const source = `<div data-caret-id="hero" className="p-4 md:p-8">x</div>`
		const at1440 = resolveParam(elementOf(source, "hero"), "padding", CONTEXT)
		at1440.utility?.should.equal("md:p-8")
		at1440.variant?.should.equal("md")
		const at375 = resolveParam(elementOf(source, "hero"), "padding", { ...CONTEXT, viewportWidth: 375 })
		at375.utility?.should.equal("p-4")
		should(at375.variant).be.null()
	})

	it("refuses dynamic classNames with a typed reason", () => {
		const dynamic = `<div data-caret-id="dyn" className={active ? "a" : "b"}>x</div>`
		const dynParam = resolveParam(elementOf(dynamic, "dyn"), "color", CONTEXT)
		dynParam.origin.should.equal("data")
		dynParam.writable.should.be.false()
	})

	it("resolves iterator rows as ordinary look params — the template is the span (8.6)", () => {
		const iterated = `<ul>{items.map((i) => (<li data-caret-id="row" className="p-2">{i}</li>))}</ul>`
		const rowParam = resolveParam(elementOf(iterated, "row"), "padding", CONTEXT)
		rowParam.origin.should.equal("literal")
		rowParam.writable.should.be.true()
		rowParam.utility?.should.equal("p-2")
	})

	it("absence is inherited for inheritable properties, computed otherwise — both writable", () => {
		const source = `<p data-caret-id="copy" className="mt-4">x</p>`
		resolveParam(elementOf(source, "copy"), "color", CONTEXT).origin.should.equal("inherited")
		resolveParam(elementOf(source, "copy"), "background-color", CONTEXT).origin.should.equal("computed")
		resolveParam(elementOf(source, "copy"), "color", CONTEXT).writable.should.be.true()
	})
})

describe("writeParam — splices only", () => {
	it("replaces the active utility in place, nothing else moving", () => {
		const source = `<div data-caret-id="hero" className="p-8 bg-brand-500 rounded-lg">x</div>`
		const edits = writeParam(elementOf(source, "hero"), "background-color", { raw: "#ff0000" }, CONTEXT)
		if ("refused" in edits) throw new Error(edits.refused)
		applyEdits(source, edits).should.equal(`<div data-caret-id="hero" className="p-8 bg-[#ff0000] rounded-lg">x</div>`)
	})

	it("writes a token class when given a token", () => {
		const source = `<div data-caret-id="hero" className="bg-[#123456]">x</div>`
		const edits = writeParam(elementOf(source, "hero"), "background-color", { token: "brand-500" }, CONTEXT)
		if ("refused" in edits) throw new Error(edits.refused)
		applyEdits(source, edits).should.containEql(`className="bg-brand-500"`)
	})

	it("keeps the responsive prefix when editing at that viewport", () => {
		const source = `<div data-caret-id="hero" className="p-4 md:p-8">x</div>`
		const edits = writeParam(elementOf(source, "hero"), "padding", { raw: "24px" }, CONTEXT)
		if ("refused" in edits) throw new Error(edits.refused)
		applyEdits(source, edits).should.equal(`<div data-caret-id="hero" className="p-4 md:p-[24px]">x</div>`)
	})

	it("appends to className when nothing declares the property", () => {
		const source = `<p data-caret-id="copy" className="mt-4">x</p>`
		const edits = writeParam(elementOf(source, "copy"), "color", { token: "neutral-600" }, CONTEXT)
		if ("refused" in edits) throw new Error(edits.refused)
		applyEdits(source, edits).should.containEql(`className="mt-4 text-neutral-600"`)
	})

	it("creates className when the element has none", () => {
		const source = `<p data-caret-id="bare">x</p>`
		const edits = writeParam(elementOf(source, "bare"), "color", { raw: "#dc2626" }, CONTEXT)
		if ("refused" in edits) throw new Error(edits.refused)
		applyEdits(source, edits).should.containEql(`<p data-caret-id="bare" className="text-[#dc2626]">x</p>`)
	})

	it("refuses what resolveParam refuses", () => {
		const source = `<div data-caret-id="dyn" className={cls}>x</div>`
		const edits = writeParam(elementOf(source, "dyn"), "color", { raw: "#fff" }, CONTEXT)
		;("refused" in edits).should.be.true()
	})
})
