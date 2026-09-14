import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import should from "should"

import type { FoundationTokens } from "../../types"
import {
	countTokenUses,
	foundationTokenForClass,
	normalizeHex,
	setFoundationTokenValue,
	tokenClassForHex,
	tokenValue,
} from "../token-colors"

const TOKENS: FoundationTokens = {
	vibe: { description: "test", tags: [] },
	color: {
		brand: { seed: "#0b7aff", scale: { 50: "#e6f1ff", 500: "#0b7aff", 950: "#02142b" } },
		neutral: { character: "cool", scale: { 100: "#f1f3f6", 600: "#5b6472" } },
		semantic: { success: "#16a34a", warning: "#f59e0b", error: "#dc2626", info: "#0ea5e9" },
	},
	typography: { fontFamily: "Inter", fallback: "sans-serif", scaleRatio: 1.25, baseSize: 16, scale: { base: 16 } },
	spacing: { baseUnit: 4, scale: [0, 4, 8] },
	radius: { character: "soft", scale: [0, 2, 4, 8, 12, 9999] },
}

describe("normalizeHex", () => {
	it("expands shorthand and lowercases", () => {
		should(normalizeHex("#ABC")).equal("#aabbcc")
		should(normalizeHex("#0B7AFF")).equal("#0b7aff")
	})

	it("refuses non-hex values", () => {
		should(normalizeHex("rgb(1,2,3)")).be.null()
		should(normalizeHex("#12345")).be.null()
		should(normalizeHex("blue")).be.null()
	})
})

describe("tokenValue", () => {
	it("resolves every token shape and refuses unknowns", () => {
		should(tokenValue(TOKENS, "brand")).equal("#0b7aff")
		should(tokenValue(TOKENS, "brand-950")).equal("#02142b")
		should(tokenValue(TOKENS, "neutral-100")).equal("#f1f3f6")
		should(tokenValue(TOKENS, "warning")).equal("#f59e0b")
		should(tokenValue(TOKENS, "brand-475")).be.null()
	})
})

describe("foundationTokenForClass", () => {
	it("recognises brand scale, neutral scale, semantic and bare brand", () => {
		should(foundationTokenForClass("bg-brand-500", TOKENS)).equal("brand-500")
		should(foundationTokenForClass("text-neutral-600", TOKENS)).equal("neutral-600")
		should(foundationTokenForClass("border-success", TOKENS)).equal("success")
		should(foundationTokenForClass("bg-brand", TOKENS)).equal("brand")
	})

	it("refuses steps the foundation does not define, stock palette and non-colour classes", () => {
		// brand-475 is a typo, not a token — promoting it would invent a foundation entry.
		should(foundationTokenForClass("bg-brand-475", TOKENS)).be.null()
		should(foundationTokenForClass("text-blue-500", TOKENS)).be.null()
		should(foundationTokenForClass("text-4xl", TOKENS)).be.null()
		should(foundationTokenForClass("p-4", TOKENS)).be.null()
		should(foundationTokenForClass("bg-brand-500", null)).be.null()
	})
})

describe("tokenClassForHex", () => {
	it("matches exactly, case-insensitively, preferring the scale step over the bare seed", () => {
		// #0b7aff is both the seed and brand-500 — the step says more.
		should(tokenClassForHex("#0B7AFF", TOKENS)).equal("brand-500")
		should(tokenClassForHex("#16a34a", TOKENS)).equal("success")
		should(tokenClassForHex("#5b6472", TOKENS)).equal("neutral-600")
	})

	it("never near-matches", () => {
		should(tokenClassForHex("#0b7afe", TOKENS)).be.null()
		should(tokenClassForHex("#000000", TOKENS)).be.null()
	})
})

describe("setFoundationTokenValue", () => {
	it("repoints a scale step, a semantic colour and the seed", () => {
		const tokens = structuredClone(TOKENS)
		should(setFoundationTokenValue(tokens, "brand-500", "#111111")).be.true()
		should(tokens.color.brand.scale[500]).equal("#111111")
		should(setFoundationTokenValue(tokens, "error", "#222222")).be.true()
		should(tokens.color.semantic.error).equal("#222222")
		should(setFoundationTokenValue(tokens, "brand", "#333333")).be.true()
		should(tokens.color.brand.seed).equal("#333333")
	})

	it("refuses unknown tokens, missing steps, and bad hex", () => {
		const tokens = structuredClone(TOKENS)
		should(setFoundationTokenValue(tokens, "brand-475", "#111111")).be.false()
		should(setFoundationTokenValue(tokens, "accent", "#111111")).be.false()
		should(setFoundationTokenValue(tokens, "brand-500", "not-a-hex")).be.false()
		should(JSON.stringify(tokens)).equal(JSON.stringify(TOKENS))
	})
})

describe("countTokenUses", () => {
	let caretDir: string

	beforeEach(async () => {
		caretDir = await fs.mkdtemp(path.join(os.tmpdir(), "token-uses-"))
		await fs.mkdir(path.join(caretDir, "pages", "home"), { recursive: true })
		await fs.mkdir(path.join(caretDir, "components"), { recursive: true })
	})

	afterEach(async () => {
		await fs.rm(caretDir, { recursive: true, force: true })
	})

	it("counts colour-utility uses across pages and components, including variants", async () => {
		await fs.writeFile(
			path.join(caretDir, "pages", "home", "index.tsx"),
			`<div className="bg-brand-500 hover:text-brand-500 md:border-brand-500">x</div>`,
		)
		await fs.writeFile(path.join(caretDir, "components", "Button.tsx"), `<button className="bg-brand-500">y</button>`)

		const result = await countTokenUses(caretDir, "brand-500")
		should(result.occurrences).equal(4)
		should(result.files).equal(2)
	})

	it("does not count different tokens or non-colour families, but does count opacity-modified uses", async () => {
		await fs.writeFile(
			path.join(caretDir, "pages", "home", "index.tsx"),
			`<div className="bg-brand-50 text-brand-500/50 w-brand-500">x</div>`,
		)
		// bg-brand-50 is a different token and w- is not a colour family — but
		// text-brand-500/50 genuinely uses the token and a token edit reaches it.
		const result = await countTokenUses(caretDir, "brand-500")
		should(result.occurrences).equal(1)
	})

	it("returns zero on an empty or missing layer", async () => {
		const result = await countTokenUses(path.join(caretDir, "nope"), "brand-500")
		should(result.occurrences).equal(0)
		should(result.files).equal(0)
	})
})
