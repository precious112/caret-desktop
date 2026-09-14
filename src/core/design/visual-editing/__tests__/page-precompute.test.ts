import { describe, it } from "mocha"
import "should"

import type { DynamicRange } from "../page-precompute"
import { precomputePage } from "../page-precompute"

function hasRange(ranges: DynamicRange[], diagnostic: string): boolean {
	return ranges.some((r) => r.diagnostics.includes(diagnostic as any))
}

function rangeAt(ranges: DynamicRange[], line: number): DynamicRange | undefined {
	return ranges.find((r) => r.startLine === line)
}

describe("precomputePage — caret-id injection", () => {
	it("should add data-caret-id to visible elements missing it", () => {
		const source = `export default function Page() {
  return (
    <div>
      <h1 className="text-white">Hello</h1>
      <p>World</p>
    </div>
  )
}`
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.true()
		result.correctedSource!.should.containEql("data-caret-id=")
		result.correctedSource!.should.containEql('data-caret-id="h1-1"')
		result.correctedSource!.should.containEql('data-caret-id="p-1"')
	})

	it("should not add data-caret-id to elements that already have it", () => {
		const source = `export default function Page() {
  return <h1 data-caret-id="title">Hello</h1>
}`
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.false()
		const count = (source.match(/data-caret-id/g) || []).length
		count.should.equal(1)
	})

	it("should not add data-caret-id to custom (capitalized) components", () => {
		const source = `export default function Page() {
  return <MyComponent>Hello</MyComponent>
}`
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.false()
	})

	it("should not add data-caret-id to non-visible native elements like div", () => {
		const source = `export default function Page() {
  return <div className="flex">Content</div>
}`
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.false()
	})

	it("should derive descriptive ID from alt attribute", () => {
		const source = `export default function Page() {
  return <img src="photo.jpg" alt="Hero Banner" />
}`
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.true()
		result.correctedSource!.should.containEql("hero-banner")
	})

	it("should derive descriptive ID from placeholder attribute", () => {
		const source = `export default function Page() {
  return <input placeholder="Search products" />
}`
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.true()
		result.correctedSource!.should.containEql("search-products")
	})
})

describe("precomputePage — inline style conversion", () => {
	it("should convert inline style to Tailwind arbitrary classes", () => {
		const source = `export default function Page() {
  return <div style={{ backgroundColor: "#ff0000", padding: "16px" }}>Box</div>
}`
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.true()
		result.correctedSource!.should.containEql("bg-[#ff0000]")
		result.correctedSource!.should.containEql("p-[16px]")
		result.correctedSource!.should.not.containEql("style=")
	})

	it("should merge converted classes into existing className", () => {
		const source = `export default function Page() {
  return <div className="flex" style={{ margin: "8px" }}>Box</div>
}`
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.true()
		result.correctedSource!.should.containEql("flex m-[8px]")
	})

	it("should keep style attribute if some properties can't be converted", () => {
		const source = `export default function Page() {
  return <div style={{ backgroundColor: "#ff0000", transform: "rotate(45deg)" }}>Box</div>
}`
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.true()
		result.correctedSource!.should.containEql("bg-[#ff0000]")
		result.correctedSource!.should.containEql("style=")
	})

	it("removes CONVERTED properties from a kept style attribute — a partial conversion must be idempotent", () => {
		// The healer write-loop this pins: converted properties left inside the
		// style object were re-converted on every pass, appending the same
		// classes forever (`w-[320px] h-[200px] w-[320px] …`) and turning any
		// page with a half-convertible style into an endless heal→write cycle.
		const source = `export default function Page() {
  return <div style={{ width: 320, backdropFilter: "blur(4px)" }}>Box</div>
}`
		const first = precomputePage(source, "test.tsx")
		first.modified.should.be.true()
		first.correctedSource!.should.containEql("w-[320px]")
		first.correctedSource!.should.containEql("backdropFilter")
		first.correctedSource!.should.not.containEql("width: 320")

		const second = precomputePage(first.correctedSource!, "test.tsx")
		second.modified.should.be.false()
	})

	it("writes px for numeric lengths and converts the background shorthand only for plain colours", () => {
		const source = `export default function Page() {
  return (
    <div>
      <div style={{ width: 320, height: 200, background: "#d4d4d4" }}>A</div>
      <div style={{ background: "linear-gradient(#000, #fff)" }}>B</div>
    </div>
  )
}`
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.true()
		result.correctedSource!.should.containEql("w-[320px]")
		result.correctedSource!.should.containEql("h-[200px]")
		result.correctedSource!.should.containEql("bg-[#d4d4d4]")
		// The gradient is not a colour class's job — it stays inline.
		result.correctedSource!.should.containEql("linear-gradient")
		result.correctedSource!.should.not.containEql("bg-[linear")
	})

	it("should convert numeric values", () => {
		const source = `export default function Page() {
  return <div style={{ zIndex: 10, opacity: 0.5 }}>Box</div>
}`
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.true()
		result.correctedSource!.should.containEql("z-[10]")
		result.correctedSource!.should.containEql("opacity-[0.5]")
	})

	it("should still convert inline styles inside .map()", () => {
		const source = `export default function Page() {
  return (
    <div>
      {items.map(item => (
        <p style={{ color: "red" }}>{item.name}</p>
      ))}
    </div>
  )
}`
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.true()
		result.correctedSource!.should.containEql("text-[red]")
	})
})

describe("precomputePage — .map() iterator handling", () => {
	it("seeds a TEMPLATE caret-id inside .map() — one id, N rendered rows (8.6)", () => {
		const source = `export default function Page() {
  return (
    <div>
      {items.map(item => (
        <h3>{item.name}</h3>
      ))}
    </div>
  )
}`
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.true()
		result.correctedSource!.should.containEql('<h3 data-caret-id="h3-1">')
	})

	it("should mark all elements inside .map() as dynamic", () => {
		const source = `export default function Page() {
  return (
    <div>
      {items.map(item => (
        <h3>{item.name}</h3>
      ))}
    </div>
  )
}`
		const result = precomputePage(source, "test.tsx")
		result.dynamicRanges.length.should.be.greaterThan(0)
	})

	it("should mark static text inside .map() as dynamic too", () => {
		const source = `export default function Page() {
  return (
    <div>
      {items.map(item => (
        <div>
          <p>View details</p>
          <img src={item.img} />
        </div>
      ))}
    </div>
  )
}`
		const result = precomputePage(source, "test.tsx")
		result.dynamicRanges.length.should.be.greaterThan(0)
	})

	it("should handle .forEach() the same as .map()", () => {
		const source = `export default function Page() {
  const els = []
  items.forEach(item => {
    els.push(<span>{item.label}</span>)
  })
  return <div>{els}</div>
}`
		const result = precomputePage(source, "test.tsx")
		result.dynamicRanges.length.should.be.greaterThan(0)
	})

	it("should handle .flatMap() the same as .map()", () => {
		const source = `export default function Page() {
  return (
    <div>
      {items.flatMap(item => (
        <p>{item.text}</p>
      ))}
    </div>
  )
}`
		const result = precomputePage(source, "test.tsx")
		result.dynamicRanges.length.should.be.greaterThan(0)
	})

	it("should still add data-caret-id to static elements outside .map()", () => {
		const source = `export default function Page() {
  return (
    <div>
      <h1>Static Title</h1>
      {items.map(item => (
        <p>{item.text}</p>
      ))}
    </div>
  )
}`
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.true()
		result.correctedSource!.should.containEql('data-caret-id="h1-1"')
	})
})

describe("precomputePage — dynamic content detection (outside iterators)", () => {
	it("should detect dynamic text children", () => {
		const source = `export default function Page() {
  return <h1 data-caret-id="title">{title}</h1>
}`
		const result = precomputePage(source, "test.tsx")
		hasRange(result.dynamicRanges, "dynamic-text").should.be.true()
	})

	it("should detect dynamic image src", () => {
		const source = `export default function Page() {
  return <img data-caret-id="hero" src={imageUrl} alt="Hero" />
}`
		const result = precomputePage(source, "test.tsx")
		hasRange(result.dynamicRanges, "dynamic-image-src").should.be.true()
	})

	it("should detect dynamic Tailwind class names", () => {
		const source = "export default function Page() {\n  return <div className={`bg-${color}-500 p-4`}>Box</div>\n}"
		const result = precomputePage(source, "test.tsx")
		hasRange(result.dynamicRanges, "dynamic-tailwind-class").should.be.true()
	})

	it("flags prop-driven text in a component file — the shape a mapped list resolves to", () => {
		// A click on "Monolith Trainer" in a product grid resolves to the
		// component, not the page: the page holds `products.map(p => <ProductCard
		// product={p}/>)`, the component holds `{product.name}`. Detection always
		// caught this shape — but the ranges were only ever computed for the
		// focused page file and stored under a mismatched key, so the "Edit text"
		// gate never fired and the user discovered the limit as a failure after
		// typing. `handlePageFocused` now analyzes components/ and layouts/
		// read-only and keys everything by resolved absolute path.
		const source = `export function ProductCard({ product }: { product: Product }) {
  return (
    <div data-caret-id="product-card">
      <p data-caret-id="p-1" className="text-brand-950">{product.name}</p>
    </div>
  )
}`
		const result = precomputePage(source, "components/ProductCard.tsx")
		hasRange(result.dynamicRanges, "dynamic-text").should.be.true()
		// Analysis of a component must be observation, not surgery.
		result.modified.should.be.false()
	})

	it("should NOT flag static text as dynamic", () => {
		const source = `export default function Page() {
  return <h1 data-caret-id="title">Static Title</h1>
}`
		const result = precomputePage(source, "test.tsx")
		result.dynamicRanges.length.should.equal(0)
	})

	it("should NOT flag static image src as dynamic", () => {
		const source = `export default function Page() {
  return <img data-caret-id="hero" src="photo.jpg" alt="Hero" />
}`
		const result = precomputePage(source, "test.tsx")
		hasRange(result.dynamicRanges, "dynamic-image-src").should.be.false()
	})

	it("should detect string expression container as non-dynamic", () => {
		const source = `export default function Page() {
  return <h1 data-caret-id="title">{"Static"}</h1>
}`
		const result = precomputePage(source, "test.tsx")
		result.dynamicRanges.length.should.equal(0)
	})
})

describe("precomputePage — combined scenarios", () => {
	it("should handle element with both inline style AND dynamic text", () => {
		const source = `export default function Page() {
  return <h1 style={{ color: "red" }}>{title}</h1>
}`
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.true()
		result.correctedSource!.should.containEql("text-[red]")
		hasRange(result.dynamicRanges, "dynamic-text").should.be.true()
	})

	it("should handle multiple visible elements with different issues", () => {
		const source = `export default function Page() {
  return (
    <div>
      <h1>Static Title</h1>
      <p>{dynamicText}</p>
      <img src={imgUrl} alt="Photo" />
      <span style={{ color: "blue" }}>Styled</span>
    </div>
  )
}`
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.true()
		result.correctedSource!.should.containEql('data-caret-id="h1-1"')
		result.correctedSource!.should.containEql("text-[blue]")
		hasRange(result.dynamicRanges, "dynamic-text").should.be.true()
		hasRange(result.dynamicRanges, "dynamic-image-src").should.be.true()
	})

	it("should be idempotent — second pass produces no changes", () => {
		const source = `export default function Page() {
  return (
    <div>
      <h1>Title</h1>
      <p>{dynamic}</p>
    </div>
  )
}`
		const first = precomputePage(source, "test.tsx")
		first.modified.should.be.true()

		const second = precomputePage(first.correctedSource!, "test.tsx")
		second.modified.should.be.false()
	})

	it("should return correct result for parse failure", () => {
		const source = `<<<<this is not valid JSX>>>>`
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.false()
		result.dynamicRanges.length.should.equal(0)
		result.caretIdViolations.should.eql({ dynamic: 0, duplicate: 0, inIterator: 0 })
	})
})

describe("precomputePage — caret-id normalization (unique + static)", () => {
	it("should rewrite a dynamic (interpolated) caret-id to a unique static literal", () => {
		const source = "export default function Page() {\n  return <h1 data-caret-id={`title-${id}`}>Hello</h1>\n}"
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.true()
		result.correctedSource!.should.containEql('data-caret-id="h1-1"')
		result.correctedSource!.should.not.containEql("${id}")
		result.caretIdViolations.dynamic.should.equal(1)
	})

	it("should rewrite a ternary caret-id expression to a static literal", () => {
		const source = `export default function Page() {
  return <p data-caret-id={cond ? "a" : undefined}>Hello</p>
}`
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.true()
		result.correctedSource!.should.containEql('data-caret-id="p-1"')
		result.correctedSource!.should.not.containEql("cond ?")
		result.caretIdViolations.dynamic.should.equal(1)
	})

	it("should rename duplicate static caret-ids so each is unique", () => {
		const source = `export default function Page() {
  return (
    <div>
      <h2 data-caret-id="heading">Loved by developers</h2>
      <h2 data-caret-id="heading">Trusted widely</h2>
    </div>
  )
}`
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.true()
		result.caretIdViolations.duplicate.should.equal(1)
		// First keeps the author id, second is renamed to something else.
		const ids = [...result.correctedSource!.matchAll(/data-caret-id="([^"]+)"/g)].map((m) => m[1])
		ids.length.should.equal(2)
		new Set(ids).size.should.equal(2)
		ids.should.containEql("heading")
	})

	it("keeps a static caret-id on a template element inside .map() (8.6: it addresses the template)", () => {
		const source = `export default function Page() {
  return (
    <div>
      {items.map(item => (
        <a data-caret-id="link" href="#">{item.name}</a>
      ))}
    </div>
  )
}`
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.false()
		result.caretIdViolations.inIterator.should.equal(0)
	})

	it("normalizes a dynamic caret-id inside .map() to a static template id", () => {
		const source =
			"export default function Page() {\n  return (\n    <div>\n      {items.map((item, i) => (\n        <span data-caret-id={`item-${i}`}>{item.label}</span>\n      ))}\n    </div>\n  )\n}"
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.true()
		result.correctedSource!.should.containEql('data-caret-id="span-1"')
		result.caretIdViolations.dynamic.should.equal(1)
	})

	it("should normalize a dynamic caret-id on a framer-motion element", () => {
		const source = `export default function Page() {
  return <motion.h2 data-caret-id={dataCaretId ? "x-title" : undefined}>Hello</motion.h2>
}`
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.true()
		result.correctedSource!.should.containEql('data-caret-id="h2-1"')
		result.caretIdViolations.dynamic.should.equal(1)
	})

	it("should add a caret-id to a framer-motion visible element missing one", () => {
		const source = `export default function Page() {
  return <motion.p>Animated text</motion.p>
}`
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.true()
		result.correctedSource!.should.containEql('data-caret-id="p-1"')
		result.caretIdViolations.should.eql({ dynamic: 0, duplicate: 0, inIterator: 0 })
	})

	it("should NOT touch motion.div (not a visible tag)", () => {
		const source = `export default function Page() {
  return <motion.div className="flex">Content</motion.div>
}`
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.false()
	})

	it("should leave an already-clean page unchanged (no churn, no violations)", () => {
		const source = `export default function Page() {
  return (
    <div>
      <h1 data-caret-id="hero-title">Hello</h1>
      <p data-caret-id="hero-sub">World</p>
    </div>
  )
}`
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.false()
		result.caretIdViolations.should.eql({ dynamic: 0, duplicate: 0, inIterator: 0 })
	})

	it("should generate ids that don't collide with author ids appearing later", () => {
		const source = `export default function Page() {
  return (
    <div>
      <h1>First</h1>
      <h1 data-caret-id="h1-1">Second</h1>
    </div>
  )
}`
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.true()
		const ids = [...result.correctedSource!.matchAll(/data-caret-id="([^"]+)"/g)].map((m) => m[1])
		ids.length.should.equal(2)
		new Set(ids).size.should.equal(2)
		ids.should.containEql("h1-1")
	})
})

describe("precomputePage — splice-backed writes", () => {
	it("preserves every byte outside the edited spans (no reprint, no re-indent)", () => {
		// Deliberately odd formatting recast.print would have normalized.
		const source = `export default function Page() {
  return (
      <div>
            <h1   className="text-3xl"
        >Oddly formatted</h1>
      </div>
  )
}`
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.true()
		const corrected = result.correctedSource!
		corrected.should.containEql('<h1 data-caret-id="h1-1"   className="text-3xl"')
		// The odd continuation-line formatting survives untouched.
		corrected.should.containEql("\n        >Oddly formatted</h1>")
		corrected.should.containEql("\n            <h1")
	})

	it("autofixes the single-ternary dynamic className into full class strings", () => {
		const source = 'export default function Page() {\n  return <p className={`p-4 bg-${dark ? "black" : "white"}`}>Box</p>\n}'
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.true()
		result.correctedSource!.should.containEql('className={dark ? "p-4 bg-black" : "p-4 bg-white"}')
		// Fixed, so not reported — and a second pass plans nothing for it.
		result.dynamicRanges.some((r) => r.diagnostics.includes("dynamic-tailwind-class")).should.be.false()
		const second = precomputePage(result.correctedSource!, "test.tsx")
		second.dynamicRanges.some((r) => r.diagnostics.includes("dynamic-tailwind-class")).should.be.false()
	})

	it("leaves the unfixable dynamic className as a diagnostic without editing it", () => {
		const source = "export default function Page() {\n  return <p className={`bg-${color}-500`}>Box</p>\n}"
		const result = precomputePage(source, "test.tsx")
		result.dynamicRanges.some((r) => r.diagnostics.includes("dynamic-tailwind-class")).should.be.true()
		;(result.correctedSource ?? source).should.containEql("`bg-${color}-500`")
	})

	it("drops extra data-caret-id attributes, keeping the first", () => {
		const source = 'export default function Page() {\n  return <h1 data-caret-id="keep" data-caret-id="drop">Hi</h1>\n}'
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.true()
		result.correctedSource!.should.containEql('data-caret-id="keep"')
		result.correctedSource!.should.not.containEql('data-caret-id="drop"')
	})

	it("combines a fresh caret-id with an inline-style conversion on the same element", () => {
		const source = 'export default function Page() {\n  return <h1 style={{ width: 320 }} className="font-bold">Hi</h1>\n}'
		const result = precomputePage(source, "test.tsx")
		result.modified.should.be.true()
		const corrected = result.correctedSource!
		corrected.should.containEql('data-caret-id="h1-1"')
		corrected.should.containEql('className="font-bold w-[320px]"')
		corrected.should.not.containEql("style=")
		// And the whole thing settles: a second pass changes nothing.
		precomputePage(corrected, "test.tsx").modified.should.be.false()
	})
})

describe("precomputePage — conditional rendering is not dynamic text", () => {
	it("a && card of static markup produces NO dynamic range — the field false positive", () => {
		// The exact shape that poisoned a whole page: a filterable grid wraps
		// each literal card in a visibility conditional, one range covered the
		// grid, and every static chip inside refused "Edit text".
		const source = `export default function Page() {
  const show = true
  return (
    <ul data-caret-id="grid">
      {show && (
        <li>
          <span data-caret-id="chip">Easy</span>
        </li>
      )}
    </ul>
  )
}`
		const result = precomputePage(source, "test.tsx")
		result.dynamicRanges.filter((r) => r.diagnostics.includes("dynamic-text")).should.be.empty()
	})

	it("a ternary whose branches are both markup stays clean; a string branch still flags", () => {
		const markupOnly = `export default function Page() {
  const on = true
  return <div data-caret-id="wrap">{on ? <b data-caret-id="a">Yes</b> : <i data-caret-id="b">No</i>}</div>
}`
		precomputePage(markupOnly, "test.tsx")
			.dynamicRanges.filter((r) => r.diagnostics.includes("dynamic-text"))
			.should.be.empty()

		// `{cond ? "Easy" : "Hard"}` paints text from an expression position —
		// the inline splice cannot edit it, so it must keep flagging.
		const stringBranch = `export default function Page() {
  const on = true
  return <span data-caret-id="chip">{on ? "Easy" : "Hard"}</span>
}`
		precomputePage(stringBranch, "test.tsx")
			.dynamicRanges.filter((r) => r.diagnostics.includes("dynamic-text"))
			.should.not.be.empty()
	})

	it("genuinely dynamic text keeps flagging — identifiers, members, calls", () => {
		const source = `export default function Page({ plant }) {
  return <p data-caret-id="name">{plant.name}</p>
}`
		precomputePage(source, "test.tsx")
			.dynamicRanges.filter((r) => r.diagnostics.includes("dynamic-text"))
			.should.not.be.empty()
	})
})
