import should from "should"

import type { ToolCallRecord } from "../../agent/backend"
import {
	ATTEMPTS,
	type DesignPassDeps,
	DesignPassError,
	type DesignQuestion,
	type PassModels,
	type PassProgress,
	runDesignPass,
} from "../engine"
import { NOTHING_APPROVED } from "../findings"
import type { PlanSection } from "../plan"

const BRIEF = "A landing page for Smolder, small-batch hot sauce from Bristol."

const HERO: PlanSection = {
	id: "hero",
	purpose: "Say what Smolder is",
	layout: "two columns",
	components: [
		{ term: "eyebrow", looks: "12px uppercase, tracked 0.2em", content: "SMALL-BATCH SAUCES" },
		{ term: "headline", looks: "56px, #7C2D12", content: "Slow-smoked over oak" },
	],
	copy: { headline: "Slow-smoked over oak" },
}
const DELIVERY: PlanSection = {
	id: "delivery",
	purpose: "Explain delivery",
	layout: "one column",
	components: [{ term: "glass panel", looks: "frosted glass over the smoker photo", content: "Free UK delivery over £30" }],
	copy: { body: "Free UK delivery over £30" },
}

interface Script {
	plan?: () => unknown
	check?: (section: PlanSection) => unknown
	revise?: (prompt: string) => unknown
	justify?: () => unknown
	judge?: () => unknown
	designer?: () => unknown
	designerCalls?: ToolCallRecord[]
	componentJudge?: () => unknown
}

/** Fake models that answer by recognising which step's prompt they were sent. */
function fakeModels(script: Script) {
	const calls: string[] = []
	const checked: string[] = []
	const models: PassModels = {
		async main<T>(prompt: string): Promise<T> {
			if (prompt.startsWith("Plan this page"))
				return (calls.push("plan"), script.plan?.() ?? { sections: [HERO, DELIVERY] }) as T
			if (prompt.includes("For EACH flagged part")) return (calls.push("revise"), script.revise?.(prompt)) as T
			if (prompt.includes("These parts were flagged as common AI design habits"))
				return (calls.push("justify"), script.justify?.()) as T
			throw new Error(`unexpected main prompt: ${prompt.slice(0, 60)}`)
		},
		async helper<T>(prompt: string): Promise<T> {
			if (prompt.startsWith("You are checking ONE section")) {
				const section = JSON.parse(
					prompt.slice(prompt.indexOf("The section:\n") + 13, prompt.lastIndexOf("\n\nReply with JSON")),
				) as PlanSection
				calls.push("check")
				checked.push(section.id)
				return (script.check?.(section) ?? defaultCheck(section)) as T
			}
			if (prompt.startsWith("A product request")) return (calls.push("judge"), script.judge?.() ?? { verdicts: [] }) as T
			if (prompt.startsWith("A designer picked"))
				return (calls.push("component-judge"), script.componentJudge?.() ?? { verdicts: [] }) as T
			throw new Error(`unexpected helper prompt: ${prompt.slice(0, 60)}`)
		},
		async designer<T>(): Promise<{ value: T; toolCalls: ToolCallRecord[] }> {
			calls.push("designer")
			return { value: (script.designer?.() ?? { sections: [] }) as T, toolCalls: script.designerCalls ?? [] }
		},
	}
	return { models, calls, checked }
}

/** Reports what each section really contains: an eyebrow is level 1, a glass panel level 3. */
function defaultCheck(section: PlanSection) {
	const matches = []
	for (const c of section.components) {
		if (c.term === "eyebrow") matches.push({ id: "eyebrow-labels", quote: c.looks })
		if (c.term === "glass panel") matches.push({ id: "glassmorphism", quote: c.looks })
	}
	return { matches }
}

const noEyebrow = { ...HERO, components: HERO.components.filter((c) => c.term !== "eyebrow") }
const noGlass = {
	...DELIVERY,
	components: [{ term: "card", looks: "solid #FFFFFF, 1px border", content: "Free UK delivery over £30" }],
}

function deps(
	models: PassModels,
	overrides: Partial<DesignPassDeps> = {},
): DesignPassDeps & { progress: (u: PassProgress) => void; seen: PassProgress[]; asked: DesignQuestion[][] } {
	const seen: PassProgress[] = []
	const asked: DesignQuestion[][] = []
	return {
		models,
		context: { brief: BRIEF, foundation: null, existingPages: [] },
		approved: NOTHING_APPROVED,
		tasteTools: () => ({ libraries: [], viewTool: "caret_view_reference" }),
		ask: async (questions) => {
			asked.push(questions)
			return questions.map(() => "remove" as const)
		},
		progress: (update) => seen.push(update),
		seen,
		asked,
		...overrides,
	}
}

describe("design pass · the whole loop", () => {
	it("bans the eyebrow, asks about the glass panel, reworks it, then polishes", async () => {
		const { models, calls, checked } = fakeModels({
			revise: (prompt) =>
				prompt.includes('"12px uppercase, tracked 0.2em"')
					? { changes: [{ n: 1, action: "removed" }], sections: [noEyebrow] }
					: { changes: [{ n: 1, action: "replaced", now: "a plain card" }], sections: [noGlass] },
			justify: () => ({
				answers: [{ n: 1, decision: "keep", reason: "Keeps the note readable over the photo.", brief_quote: "" }],
			}),
			designer: () => ({
				sections: [noEyebrow, noGlass],
				references: [{ what: "a sauce shop", learned: "big product photos" }],
				components: [
					{ component: "@magicui/marquee", section: "hero", job: "scroll the flavours", why_not_plain: "motion" },
					{ component: "@aceternity/sparkles", section: "hero", job: "sparkle", why_not_plain: "looks alive" },
					{ component: "not-a-ref", section: "hero", job: "x", why_not_plain: "y" },
				],
			}),
			designerCalls: [
				{ tool: "lazyweb_lazyweb_execute", ok: true },
				{ tool: "shadcn_search_items_in_registries", ok: true },
			],
			componentJudge: () => ({ verdicts: [{ n: 1, keep: true, why: "Shows every flavour." }] }),
		})
		const d = deps(models)
		const result = await runDesignPass(d)

		// The banned eyebrow was rewritten before anyone was asked anything.
		calls.slice(0, 4).should.eql(["plan", "check", "check", "revise"])
		// Only the changed hero is re-checked; the delivery section's result is reused.
		checked.slice(0, 3).should.eql(["hero", "delivery", "hero"])
		// The glass panel had only the AI's argument: the user was asked, with that argument.
		d.asked.length.should.equal(1)
		d.asked[0].should.eql([
			{
				section: "delivery",
				quote: "frosted glass over the smoker photo",
				habit: "Glassmorphism",
				reason: "Keeps the note readable over the photo.",
			},
		])
		result.questions[0].answer.should.equal("remove")
		// The user's "remove" went back for rework, and the result was re-checked.
		result.removed.map((r) => r.habit).should.eql(["Eyebrow labels", "Glassmorphism"])
		result.removed[1].should.containDeep({ action: "replaced", now: "a plain card" })
		result.plan.sections.should.eql([noEyebrow, noGlass])
		result.stats.bannedHabits.should.eql(["eyebrow-labels"])
		result.stats.defendedHabits.should.eql(["glassmorphism"])
		// Only the judged-and-approved, installable component survives.
		result.components.map((c) => c.component).should.eql(["@magicui/marquee"])
		result.declined.map((c) => c.component).should.eql(["@aceternity/sparkles"])
		result.references.length.should.equal(1)

		d.seen
			.map((p) => `${p.step}:${p.state}`)
			.should.eql([
				"plan:active",
				"plan:done",
				"check:active",
				"check:done",
				"questions:active",
				"questions:done",
				"polish:active",
				"polish:done",
			])
		d.seen.find((p) => p.step === "polish" && p.state === "done")!.detail!.should.equal("looked at 1 reference page")
	})

	it("drops a component from a library the designer never searched", async () => {
		let judged = 0
		const { models } = fakeModels({
			plan: () => ({ sections: [noEyebrow] }),
			designer: () => ({
				sections: [noEyebrow],
				components: [{ component: "21st:35051", section: "hero", job: "x", why_not_plain: "y" }],
			}),
			designerCalls: [{ tool: "shadcn_search_items_in_registries", ok: true }],
			componentJudge: () => {
				judged += 1
				return { verdicts: [{ n: 1, keep: true }] }
			},
		})
		const result = await runDesignPass(deps(models))
		result.components.should.eql([])
		judged.should.equal(0)
	})

	it("drops references the designer reports without having opened an inspiration library", async () => {
		const { models } = fakeModels({
			plan: () => ({ sections: [noEyebrow] }),
			designer: () => ({ sections: [noEyebrow], references: [{ what: "a page it never saw", learned: "nothing" }] }),
			designerCalls: [{ tool: "shadcn_search_items_in_registries", ok: true }],
		})
		const d = deps(models)
		const result = await runDesignPass(d)
		result.references.should.eql([])
		should(d.seen.find((p) => p.step === "polish" && p.state === "done")!.detail).be.undefined()
	})

	it("keeps a part without asking when the user's own words call for it and the judge agrees", async () => {
		const { models, calls } = fakeModels({
			plan: () => ({ sections: [DELIVERY] }),
			justify: () => ({
				answers: [
					{
						n: 1,
						decision: "keep",
						reason: "The brief names Bristol.",
						brief_quote: "small-batch hot sauce from Bristol",
					},
				],
			}),
			judge: () => ({ verdicts: [{ n: 1, anchored: true, why: "Specific." }] }),
		})
		const d = deps(models)
		const result = await runDesignPass(d)
		d.asked.length.should.equal(0)
		result.kept.map((k) => k.by).should.eql(["your-words"])
		calls.should.not.containEql("revise")
	})

	it("asks the defence again once when it answers nothing, before deciding anything", async () => {
		let justifies = 0
		const { models } = fakeModels({
			plan: () => ({ sections: [DELIVERY] }),
			justify: () => (++justifies === 1 ? { answers: [] } : { answers: [{ n: 1, decision: "remove", reason: "" }] }),
			revise: () => ({ changes: [{ n: 1, action: "removed" }], sections: [noGlass] }),
		})
		const result = await runDesignPass(deps(models))
		justifies.should.equal(2)
		result.removed.map((r) => r.habit).should.eql(["Glassmorphism"])
	})

	it("stops banning after the last round instead of looping forever", async () => {
		const { models, calls } = fakeModels({
			plan: () => ({ sections: [HERO] }),
			// A planner that never really removes the habit.
			revise: () => ({ changes: [{ n: 1, action: "replaced" }], sections: [HERO] }),
		})
		const result = await runDesignPass(deps(models))
		calls.filter((c) => c === "revise").length.should.equal(2)
		// The same part flagged in both rounds is one removed part, not two.
		result.removed.length.should.equal(1)
	})
})

describe("design pass · failures and cancelling", () => {
	it(`fails the step by name after ${ATTEMPTS} tries, without skipping it`, async () => {
		let tries = 0
		const { models } = fakeModels({
			check: () => {
				tries += 1
				throw new Error("provider is down")
			},
		})
		const error = await runDesignPass(deps(models)).then(
			() => null,
			(e) => e,
		)
		should(error).be.instanceOf(DesignPassError)
		error.step.should.equal("check")
		error.message.should.match(/checking section "(hero|delivery)": provider is down/)
		tries.should.be.aboveOrEqual(ATTEMPTS)
	})

	it("recovers when a call fails once and then answers", async () => {
		let first = true
		const { models } = fakeModels({
			plan: () => {
				if (first) {
					first = false
					throw new Error("blip")
				}
				return { sections: [noEyebrow] }
			},
		})
		const result = await runDesignPass(deps(models))
		result.plan.sections.should.eql([noEyebrow])
	})

	it("refuses an unusable plan with a clear message", async () => {
		const { models } = fakeModels({ plan: () => ({ sections: [] }) })
		const error = await runDesignPass(deps(models)).then(
			() => null,
			(e) => e,
		)
		error.should.be.instanceOf(DesignPassError)
		error.message.should.match(/plan came back unusable/)
	})

	it("stops when cancelled, even while waiting for the user", async () => {
		const controller = new AbortController()
		const { models } = fakeModels({
			plan: () => ({ sections: [DELIVERY] }),
			justify: () => ({ answers: [{ n: 1, decision: "keep", reason: "Readable.", brief_quote: "" }] }),
		})
		const d = deps(models, {
			signal: controller.signal,
			ask: async () => {
				controller.abort()
				return ["keep"]
			},
		})
		const error = await runDesignPass(d).then(
			() => null,
			(e) => e,
		)
		should(error).not.be.null()
		error.name.should.equal("AbortError")
	})

	it("installs nothing the judge did not approve", async () => {
		const { models } = fakeModels({
			plan: () => ({ sections: [noEyebrow] }),
			designer: () => ({
				sections: [noEyebrow],
				components: [{ component: "21st:10635", section: "hero", job: "logs", why_not_plain: "interactive" }],
			}),
			designerCalls: [{ tool: "twentyfirst_search", ok: true }],
			componentJudge: () => {
				throw new Error("judge down")
			},
		})
		const error = await runDesignPass(deps(models)).then(
			() => null,
			(e) => e,
		)
		error.should.be.instanceOf(DesignPassError)
		error.step.should.equal("polish")
	})
})
