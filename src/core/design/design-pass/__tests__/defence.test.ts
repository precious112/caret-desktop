import should from "should"

import {
	applyVerdicts,
	type Defence,
	forJudge,
	judgeOrder,
	QUESTION_CAP,
	type Screened,
	screenDefences,
	selectQuestions,
} from "../defence"
import type { Item } from "../findings"
import { mergeSections, normalizePlan } from "../plan"

const item = (quote: string, sources = 5): Item => ({
	section: "hero",
	quote,
	habits: ["h"],
	names: ["Habit"],
	sources,
	spread: 1,
	level: 3,
	by: ["checker"],
})
const keep = (reason: string, briefQuote = ""): Defence => ({ decision: "keep", reason, briefQuote })
const BRIEF = "A landing page for Smolder. Our customers order for the weekend barbecue."

describe("design pass · screening defences", () => {
	it("sends a part the AI dropped to rework", () => {
		const [s] = screenDefences([item("a")], new Map([[1, { decision: "remove", reason: "", briefQuote: "" }]]), BRIEF)
		s.outcome.should.equal("removed")
	})

	it("asks the user when the AI gave no answer or no reason", () => {
		const screened = screenDefences([item("a"), item("b")], new Map([[2, keep("  ")]]), BRIEF)
		screened.map((s) => s.outcome).should.eql(["ask", "ask"])
	})

	it("treats the same reason pasted under several parts as no defence", () => {
		const reason = "It adds warmth and makes the page feel premium."
		const screened = screenDefences(
			[item("a"), item("b")],
			new Map([
				[1, keep(reason, "weekend barbecue")],
				[2, keep(reason.toUpperCase(), "weekend barbecue")],
			]),
			BRIEF,
		)
		screened.map((s) => s.outcome).should.eql(["ask", "ask"])
		screened[0].note.should.match(/same reason/)
	})

	it("only lets a defence reach the judge when its quote is really in the brief", () => {
		const screened = screenDefences(
			[item("a"), item("b")],
			new Map([
				[1, keep("For the weekend crowd", "weekend barbecue")],
				[2, keep("Feels premium", "premium artisan feel")],
			]),
			BRIEF,
		)
		screened.map((s) => s.outcome).should.eql(["judge", "ask"])
		forJudge(screened)
			.map((s) => s.item.quote)
			.should.eql(["a"])
	})
})

describe("design pass · the judge and the questions", () => {
	const screened = (outcome: Screened["outcome"], sources = 5): Screened => ({
		item: item(`q${sources}-${outcome}`, sources),
		defence: keep("r"),
		outcome,
		note: "",
	})

	it("keeps a judged part only on an anchored verdict; a missing verdict is not an acquittal", () => {
		const a = screened("judge")
		const b = screened("judge")
		const out = applyVerdicts([a, b], new Map([[a, { anchored: true, why: "" }]]))
		out.map((s) => s.outcome).should.eql(["kept", "ask"])
	})

	it(`asks at most ${QUESTION_CAP}, the most reported first, and reworks the rest`, () => {
		const all = [3, 9, 4, 6, 8, 5, 7].map((sources) => screened("ask", sources))
		const { ask, rework } = selectQuestions([...all, screened("removed"), screened("kept")])
		ask.map((s) => s.item.sources).should.eql([9, 8, 7, 6, 5])
		rework.map((s) => s.outcome).should.eql(["removed", "ask", "ask"])
		rework
			.slice(1)
			.map((s) => s.item.sources)
			.should.eql([4, 3])
	})

	it("shuffles the judge's list the same way every time, never in the planner's order", () => {
		const list = [1, 2, 3, 4, 5, 6]
		const once = judgeOrder(list)
		once.should.eql(judgeOrder(list))
		once.should.not.eql(list)
		once.slice().sort().should.eql(list)
	})
})

describe("design pass · plan format", () => {
	it("gives every section a unique id, so a rewrite can never drop one", () => {
		const plan = normalizePlan({ sections: [{ id: "Hero" }, { id: "hero" }, {}] })
		plan.sections.map((s) => s.id).should.eql(["hero", "hero-2", "section-3"])
		plan.sections[0].components.should.eql([])
	})

	it("refuses a plan with no sections", () => {
		should.throws(() => normalizePlan({ sections: [] }))
		should.throws(() => normalizePlan(null))
	})

	it("replaces sections by id, ignores unknown ids, and leaves the rest untouched", () => {
		const plan = normalizePlan({
			sections: [
				{ id: "a", purpose: "one" },
				{ id: "b", purpose: "two" },
			],
		})
		const merged = mergeSections(plan, [
			{ ...plan.sections[1], purpose: "changed" },
			{ id: "z", purpose: "new", layout: "", components: [], copy: {} },
		])
		merged.sections.map((s) => s.purpose).should.eql(["one", "changed"])
		merged.sections[0].should.equal(plan.sections[0])
	})
})
