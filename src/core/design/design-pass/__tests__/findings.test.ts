import type { FoundationTokens } from "../../types"
import { parseHex } from "../colour"
import { applyLevels, approvedFrom, type Finding, NOTHING_APPROVED, quoteIn, valueFindings, verifyMatches } from "../findings"
import type { DesignPlan, PlanSection } from "../plan"

const hero: PlanSection = {
	id: "hero",
	purpose: "Say what Smolder is",
	layout: "two columns, text left, product shot right",
	components: [
		{ term: "eyebrow", looks: "12px uppercase, tracked 0.2em, #B4532A", content: "SMALL-BATCH · BRISTOL" },
		{ term: "headline", looks: "56px Fraunces, #1C1917", content: "Hot sauce, slow-smoked over oak" },
		{ term: "pill button", looks: "fully rounded, 9999px corners, #B4532A", content: "Shop the sauces" },
		{ term: "card", looks: "background #F4F1EA, 12px corners", content: "Free UK delivery over £30" },
	],
	copy: { headline: "Hot sauce, slow-smoked over oak", cta: "Shop the sauces" },
}

const plan = (...sections: PlanSection[]): DesignPlan => ({ sections })
const section = (id: string, content: string): PlanSection => ({
	id,
	purpose: "",
	layout: "",
	components: [{ term: "other", looks: "", content }],
	copy: {},
})

describe("design pass · quotes must be in the plan", () => {
	it("accepts a word-for-word quote, whatever its case, spacing or curly quotes", () => {
		quoteIn("small-batch · bristol", hero).should.be.true()
		quoteIn("Hot  sauce, slow-smoked", hero).should.be.true()
		quoteIn("“Shop the sauces”", { ...hero, copy: { cta: '"Shop the sauces"' } }).should.be.true()
	})

	it("accepts a quote stitched from adjacent fields when 85% of its words are there", () => {
		quoteIn("eyebrow 12px uppercase tracked", hero).should.be.true()
	})

	it("rejects a made-up quote that only shares a few words", () => {
		quoteIn("purple gradient hero with glowing orbs", hero).should.be.false()
		quoteIn("", hero).should.be.false()
	})
})

describe("design pass · verifying checker claims", () => {
	it("throws out unknown habits, habits under the floor, few-option habits and quotes not in the plan", () => {
		const { findings, rejected } = verifyMatches(
			hero,
			[
				{ id: "eyebrow-labels", quote: "12px uppercase, tracked 0.2em" },
				{ id: "made-up-habit", quote: "12px uppercase" },
				{ id: "middle-dot-metadata", quote: "SMALL-BATCH · BRISTOL" },
				{ id: "centered-hero", quote: "two columns" },
				{ id: "eyebrow-labels", quote: "a kicker in neon above the fold" },
			],
			NOTHING_APPROVED,
		)
		findings.map((f) => f.habit).should.eql(["eyebrow-labels"])
		rejected
			.map((r) => r.why)
			.should.eql(["unknown habit id", "unknown habit id", "unknown habit id", "quote not in the plan"])
	})

	it("treats a radius habit as the user's choice when the foundation defines that radius", () => {
		const pill = { ...NOTHING_APPROVED, radii: [4, 8, 9999], radiusCharacter: "pill" as const }
		verifyMatches(
			hero,
			[{ id: "pill-buttons", quote: "fully rounded, 9999px corners" }],
			pill,
		).findings[0].userChose.should.be.true()
		verifyMatches(hero, [{ id: "pill-buttons", quote: "fully rounded, 9999px corners" }], {
			...NOTHING_APPROVED,
			radii: [4, 8],
		}).findings[0].userChose.should.be.false()
		const soft = { ...NOTHING_APPROVED, radii: [4, 12] }
		verifyMatches(hero, [{ id: "over-rounded-surfaces", quote: "12px corners" }], soft).findings[0].userChose.should.be.true()
		verifyMatches(hero, [{ id: "over-rounded-surfaces", quote: "12px corners" }], {
			...NOTHING_APPROVED,
			radii: [2, 4],
		}).findings[0].userChose.should.be.false()
	})

	it("treats a font habit described in words as the user's choice when the font is the approved one", () => {
		const approved = { ...NOTHING_APPROVED, fonts: ["fraunces"] }
		verifyMatches(
			hero,
			[{ id: "serif-display-hero", quote: "56px Fraunces" }],
			approved,
		).findings[0].userChose.should.be.true()
		verifyMatches(
			hero,
			[{ id: "serif-display-hero", quote: "56px Fraunces" }],
			NOTHING_APPROVED,
		).findings[0].userChose.should.be.false()
	})
})

describe("design pass · exact values, checked by code", () => {
	it("flags a reported cream and a reported font, and nothing for near-black", () => {
		const found = valueFindings(plan(hero), NOTHING_APPROVED, "a hot sauce shop")
		const habits = found.map((f) => `${f.habit}:${f.quote}`)
		habits.should.containEql("warm-cream-background:#F4F1EA")
		habits.should.containEql("serif-display-hero:Fraunces")
		found.some((f) => f.quote === "#1C1917").should.be.false()
		found.every((f) => f.by === "code").should.be.true()
	})

	it("exempts colours and fonts in the approved foundation", () => {
		const approved = { ...NOTHING_APPROVED, colours: [parseHex("#F4F1EA")!], fonts: ["fraunces"] }
		valueFindings(plan(hero), approved, "")
			.every((f) => f.userChose)
			.should.be.true()
	})

	it("exempts colours and fonts the user named in their own words", () => {
		const found = valueFindings(plan(hero), NOTHING_APPROVED, "Use Fraunces and a #F4F1EA background, like our packaging")
		found.every((f) => f.userChose).should.be.true()
	})

	it("matches font names as whole words only", () => {
		valueFindings(plan(section("s", "An interface for interns")), NOTHING_APPROVED, "").should.eql([])
		valueFindings(plan(section("s", "set in Inter at 16px")), NOTHING_APPROVED, "")
			.map((f) => f.habit)
			.should.containEql("default-sans-font")
	})

	it("reports one finding per section, habit and value", () => {
		const twice = section("s", "#F4F1EA here and #F4F1EA there")
		valueFindings(plan(twice), NOTHING_APPROVED, "")
			.filter((f) => f.habit === "warm-cream-background")
			.length.should.equal(1)
	})
})

describe("design pass · levels", () => {
	const finding = (sectionId: string, habit: string, quote: string, userChose = false): Finding => ({
		section: sectionId,
		habit,
		quote,
		by: "checker",
		userChose,
	})

	it("groups habits matched by one quote into one item, at the strongest habit's level", () => {
		const items = applyLevels([
			finding("hero", "hero-badge", "SMALL-BATCH"),
			finding("hero", "eyebrow-labels", "small-batch"),
		])
		items.length.should.equal(1)
		items[0].habits[0].should.equal("eyebrow-labels")
		items[0].level.should.equal(1)
	})

	it("bans a 7–9 source habit only when it appears in two sections", () => {
		applyLevels([finding("a", "glassmorphism", "frosted panel")])[0].level.should.equal(3)
		const twice = applyLevels([finding("a", "glassmorphism", "frosted panel"), finding("b", "glassmorphism", "glassy nav")])
		twice.map((i) => i.level).should.eql([2, 2])
	})

	it("puts what the user chose at level 0 and does not count it toward repetition", () => {
		const items = applyLevels([
			finding("a", "glassmorphism", "frosted panel", true),
			finding("b", "glassmorphism", "glassy nav"),
		])
		items.find((i) => i.section === "a")!.level.should.equal(0)
		items.find((i) => i.section === "b")!.level.should.equal(3)
	})
})

describe("design pass · approved foundation values", () => {
	it("collects every hex in the colour tokens, both font families and the radius scale", () => {
		const tokens = {
			color: {
				brand: { seed: "#B4532A", scale: { 500: "#B4532A", 50: "#FBF3EE" } },
				neutral: { character: "warm", scale: { 50: "#FAFAF9" } },
				semantic: { success: "#16A34A", warning: "x", error: "#DC2626", info: "#2563EB" },
			},
			typography: { fontFamily: "Inter", displayFamily: "Fraunces" },
			radius: { character: "soft", scale: [2, 6, 12] },
		} as unknown as FoundationTokens
		const approved = approvedFrom(tokens)
		approved.colours.length.should.equal(7)
		approved.fonts.should.eql(["inter", "fraunces"])
		approved.radii.should.eql([2, 6, 12])
		approved.radiusCharacter!.should.equal("soft")
		approvedFrom(null).should.equal(NOTHING_APPROVED)
	})
})
