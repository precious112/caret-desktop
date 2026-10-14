import should from "should"

import { compile } from "../../../../../scripts/slop-list/build"
import { closeMatch, hexesIn, isUninformative, parseHex } from "../colour"
import {
	activeHabits,
	BAN,
	bannedHabitLines,
	bannedHabitNames,
	FLOOR,
	HABITS,
	habitById,
	habitsText,
	levelOf,
} from "../slop-list"

describe("design pass · colour", () => {
	it("parses 3, 4, 6 and 8 digit hex and refuses anything else", () => {
		should(parseHex("#fff")).eql({ r: 255, g: 255, b: 255 })
		should(parseHex("#F4F1EA")).eql({ r: 244, g: 241, b: 234 })
		should(parseHex("#f4f1eaff")).eql({ r: 244, g: 241, b: 234 })
		should(parseHex("#ffff")).eql({ r: 255, g: 255, b: 255 })
		should(parseHex("#12345")).be.null()
		should(parseHex("rgb(1,2,3)")).be.null()
		should(parseHex("")).be.null()
	})

	it("matches a near shade of a reported cream, but not a cool off-white of the same lightness", () => {
		const cream = parseHex("#F4F1EA")!
		should(closeMatch(parseHex("#F5F0E6")!, cream)).not.be.null()
		// Neutrals are crowded: the same lightness with a cool tint is a different colour.
		should(closeMatch(parseHex("#EEF2F7")!, cream)).be.null()
		// A plain grey is close by distance, but never counts at all (see below).
		isUninformative(parseHex("#F2F2F2")!).should.be.true()
	})

	it("matches a near shade of a saturated colour within ΔE 8, and nothing further", () => {
		const terracotta = parseHex("#D97757")!
		should(closeMatch(parseHex("#D57553")!, terracotta)).not.be.null()
		should(closeMatch(parseHex("#3B82F6")!, terracotta)).be.null()
	})

	it("never counts near-black, grey or plain white", () => {
		isUninformative(parseHex("#000")!).should.be.true()
		isUninformative(parseHex("#0B0B0B")!).should.be.true()
		isUninformative(parseHex("#808080")!).should.be.true()
		isUninformative(parseHex("#ffffff")!).should.be.true()
		isUninformative(parseHex("#F4F1EA")!).should.be.false()
	})

	it("finds 3- and 6-digit hexes in text without splitting longer ones", () => {
		hexesIn("bg #F4F1EA, text #111 and id #abcdef12").should.eql(["#F4F1EA", "#111"])
	})
})

describe("design pass · slop list levels", () => {
	it("bans at 10 sources, bans 7–9 only when repeated, and asks for a defence below", () => {
		levelOf(BAN, 1).should.equal(1)
		levelOf(26, 1).should.equal(1)
		levelOf(9, 1).should.equal(3)
		levelOf(9, 2).should.equal(2)
		levelOf(7, 2).should.equal(2)
		levelOf(7, 1).should.equal(3)
		levelOf(6, 5).should.equal(3)
	})

	it("ships the 13 level-1 habits the plan names", () => {
		const banned = bannedHabitNames()
		banned.length.should.equal(13)
		banned.should.containEql("Eyebrow labels")
		banned.should.containEql("Purple-indigo gradients")
		banned.should.containEql("Centered hero with three cards")
	})

	it("names the reported values beside a banned value habit, so a rewrite cannot swap one for another", () => {
		const line = bannedHabitLines().find((l) => l.startsWith("Default sans font"))!
		line.should.containEql("Inter")
		line.should.containEql("Space Grotesk")
		bannedHabitLines()
			.find((l) => l.startsWith("Eyebrow labels"))!
			.should.equal("Eyebrow labels")
	})

	it("ignores habits under the floor and few-option patterns", () => {
		const active = new Set(activeHabits().map((h) => h.id))
		for (const habit of HABITS) {
			if (habit.sources < FLOOR) active.has(habit.id).should.be.false(habit.id)
		}
		should(habitById("centered-hero")?.fewOptions).be.true()
		active.has("centered-hero").should.be.false()
		habitsText().should.not.containEql("[centered-hero]")
		habitsText().should.not.containEql("[middle-dot-metadata]")
	})

	it("leaves value-only habits out of the checker's list (code checks those)", () => {
		const text = habitsText()
		text.should.not.containEql("[default-sans-font]")
		text.should.containEql("[eyebrow-labels]")
	})
})

describe("design pass · slop list compile", () => {
	const evidence = (...urls: string[]) => urls.map((url) => ({ url }))

	it("counts distinct source links, ignoring anchors, queries and trailing slashes", () => {
		const out = compile(
			[
				{
					id: "a",
					kind: "element",
					name: "Eyebrow A",
					evidence: evidence("https://x.com/p#one", "https://x.com/p/", "https://y.com/q?s=1"),
				},
				{ id: "b", kind: "element", name: "Eyebrow B", evidence: evidence("https://z.com/r") },
			],
			[{ name: "Eyebrow labels", ids: ["a", "b"] }],
		)
		out.habits[0].sources.should.equal(3)
	})

	it("takes the research's own count when it lists fewer links than it counted", () => {
		const out = compile(
			[{ id: "a", kind: "element", name: "A", evidence: evidence("https://x.com/1"), independent_sources: 5 }],
			[{ name: "Habit", ids: ["a"] }],
		)
		out.habits[0].sources.should.equal(5)
	})

	it("drops entries older than seven months and keeps value members out of the checker's terms", () => {
		const out = compile(
			[
				{ id: "old", kind: "element", name: "Old", evidence: evidence("https://x.com/1"), older_than_7_months: true },
				{
					id: "cream",
					kind: "foundation",
					name: "Cream bg",
					detect: { values: ["#F4F1EA"] },
					evidence: evidence("https://x.com/2"),
				},
				{
					id: "words",
					kind: "treatment",
					name: "Warm beige surface",
					description: "First. Second.",
					evidence: evidence("https://x.com/3"),
				},
			],
			[
				{ name: "Old habit", ids: ["old"] },
				{ name: "Warm cream", ids: ["cream", "words"] },
			],
		)
		out.entries.should.equal(2)
		out.habits.map((h) => h.id).should.eql(["warm-cream"])
		out.habits[0].terms.should.eql(["Warm beige surface"])
		out.habits[0].colours.should.eql(["#F4F1EA"])
		out.habits[0].description.should.equal("First.")
	})
})
