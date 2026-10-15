/**
 * One whole interview, run by the engine against a scripted stand-in for the
 * model: the paths a real model only produces by accident (garbled replies,
 * refusals, overused defaults, a supporting colour too close to the brand),
 * plus Back, reopening and "Just finish it".
 *
 * After every screen the record is checked against the rules in paths.ts.
 */
import { strict as assert } from "assert"

import type { CodingBackend, StructuredRequest } from "../../agent/backend"
import { ProviderRefusalError } from "../../agent/backend"
import { AREA_ORDER, type AreaId } from "../areas"
import { InterviewSession, type SessionDeps, type SessionScratch, type SessionView, viewOf } from "../session"
import { deriveState } from "../state"
import { ARGUS, BRAND, runScript, SCRIPTS } from "../testing/scripts"
import { checkRules, SAMPLE_OPTIONS } from "./paths"

type Reply = unknown | Error
/** How the stand-in answers one request; undefined means "a good reply". */
type Behaviour = (request: StructuredRequest, attempt: number) => Reply | undefined

/** A good reply for any interview request. */
function goodReply(request: StructuredRequest): unknown {
	const tag = request.trace?.tag
	const area = request.trace?.area as AreaId | undefined
	if (tag === "interview:opening") {
		return {
			question: "Before the questions, here's what I took from your description.",
			statements: [
				{ area: "surface", value: { surface: "dark" }, text: "The page is dark." },
				{ area: "radius", value: { radiusCharacter: "soft" }, text: "Corners are slightly rounded." },
			],
		}
	}
	if (tag === "interview:area" && area) {
		const values = SAMPLE_OPTIONS[area].filter((v) => !("none" in (v as object)))
		return {
			question: `About ${area}?`,
			options: values.slice(0, 3).map((value, i) => ({ value, label: `Option ${i + 1}`, reason: `Fits, ${i + 1}.` })),
			recommended: 0,
		}
	}
	if (tag === "interview:fill") {
		const schema = request.schema as { properties: { values: { required: AreaId[] } } }
		const values: Record<string, unknown> = {}
		for (const a of schema.properties.values.required) values[a] = SAMPLE_OPTIONS[a][0]
		return { values }
	}
	if (tag === "interview:prose") {
		return {
			summary: "Argus reads like a serious tool.",
			rule: "The brand colour is only on actions.",
			reasons: Object.fromEntries(AREA_ORDER.map((a) => [a, `Because of ${a}.`])),
		}
	}
	throw new Error(`unexpected request ${tag}`)
}

function standIn(behaviour: Behaviour = () => undefined) {
	const requests: StructuredRequest[] = []
	const attempts = new Map<string, number>()
	const backend = {
		id: "opencode",
		async structured(request: StructuredRequest) {
			requests.push(request)
			const key = `${request.trace?.tag}/${request.trace?.area ?? ""}`
			const attempt = (attempts.get(key) ?? 0) + 1
			attempts.set(key, attempt)
			const reply = behaviour(request, attempt) ?? goodReply(request)
			if (reply instanceof Error) throw reply
			return { value: reply, emulated: true }
		},
	} as unknown as CodingBackend
	return { backend, requests }
}

function deps(backend: CodingBackend, saved: SessionScratch[] = []): SessionDeps {
	return {
		backend,
		workingDirectory: "/tmp/project",
		persist: async (scratch) => {
			saved.push(structuredClone(scratch))
		},
	}
}

/** Checks the rules on every screen's record. */
const ruled = (view: SessionView) => checkRules(viewRecord(view))
let lastSession: InterviewSession | null = null
function viewRecord(_view: SessionView) {
	assert.ok(lastSession)
	return lastSession.saved.record
}

async function run(scriptName: string, behaviour?: Behaviour) {
	const model = standIn(behaviour)
	const saved: SessionScratch[] = []
	const script = SCRIPTS[scriptName]
	const session = await InterviewSession.start(script.mode, script.description, deps(model.backend, saved))
	lastSession = session
	const end = await runScript(session, script, ruled)
	return { session, end, ...model, saved }
}

describe("an interview, end to end, with a stand-in model", () => {
	it("a straight run asks each open topic once, in order, and finishes with the answers unchanged", async () => {
		const { end, requests, session } = await run("straight")
		assert.equal(end.phase, "finish")
		const asked = requests.filter((r) => r.trace?.tag === "interview:area").map((r) => r.trace?.area)
		assert.deepEqual(
			asked,
			AREA_ORDER.filter((a) => a !== "surface" && a !== "radius"),
			"the topics were not asked once each, in order (light/dark and corners were agreed on the opening screen)",
		)
		if (end.phase !== "finish") return
		assert.equal(end.proposal.brand, BRAND, "the typed brand colour did not reach the foundation")
		assert.equal(end.proposal.surface, "dark")
		assert.equal(end.proposal.radiusCharacter, "soft")
		assert.deepEqual(
			end.proposal.decisions?.map((d) => d.area),
			[...AREA_ORDER],
		)
		assert.equal(deriveState(session.saved.record).stage, "ready")
	})

	it("reopening shows the same screen without asking the model anything, at every point", async () => {
		const { saved, requests } = await run("escapes")
		const calls = requests.length
		for (const scratch of saved) {
			const reopened = new InterviewSession(structuredClone(scratch), deps(standIn(() => new Error("asked")).backend))
			assert.deepEqual(reopened.view(), viewOf(scratch))
		}
		assert.equal(requests.length, calls)
	})

	it("Back shows the earlier question again without asking the model, with the earlier answer selected", async () => {
		const { requests, session, end } = await run("escapes")
		assert.equal(end.phase, "finish")
		// The script answered the accent colour, pressed Back, and skipped it instead.
		const accentAsks = requests.filter((r) => r.trace?.area === "accent-color").length
		assert.equal(accentAsks, 1, "Back asked the model to rewrite a question it had already written")
		// Changing the accent answer changed what the greys question is written from, so it was asked again.
		assert.equal(requests.filter((r) => r.trace?.area === "neutral").length, 2)
		const accent = session.saved.record.answers.find((a) => a.area === "accent-color")
		assert.equal(accent?.via, "skip")
	})

	it("a correction on the opening screen reopens that topic and reaches the model's request", async () => {
		const { requests, end } = await run("escapes")
		const radius = requests.find((r) => r.trace?.area === "radius")
		assert.ok(radius, "corners were not asked after the correction")
		assert.match(radius.prompt, /Corners are square, not rounded/)
		if (end.phase === "finish") assert.notEqual(end.state.areas.radius.via, "opening")
	})

	it("a garbled reply is sent back with the reason, and the question still appears", async () => {
		const { end, requests } = await run("straight", (r, attempt) =>
			r.trace?.area === "brand-color" && attempt === 1 ? { nonsense: true } : undefined,
		)
		assert.equal(end.phase, "finish")
		const brand = requests.filter((r) => r.trace?.area === "brand-color")
		assert.equal(brand.length, 2)
		assert.match(brand[1].prompt, /Your previous reply was rejected[\s\S]*question text is empty/)
	})

	it("overused defaults are dropped; if too few options remain, the model is told which and asked again", async () => {
		const { end, requests } = await run("straight", (r, attempt) => {
			if (r.trace?.area !== "display-type" || attempt > 1) return undefined
			return {
				question: "Headings?",
				options: [
					{ value: { family: "Inter" }, label: "Inter", reason: "r" },
					{ value: { family: "Space Grotesk" }, label: "Space Grotesk", reason: "r" },
					{ value: { family: "Archivo" }, label: "Archivo", reason: "r" },
				],
				recommended: 0,
			}
		})
		assert.equal(end.phase, "finish")
		const asks = requests.filter((r) => r.trace?.area === "display-type")
		assert.equal(asks.length, 2)
		assert.match(asks[1].prompt, /Inter is an overused AI default/)
		assert.match(asks[0].prompt, /Avoid \(overused AI defaults they did not ask for\):[^\n]*Inter/)
	})

	it("a supporting colour too close to the brand is never shown", async () => {
		const { end } = await run("straight", (r) =>
			r.trace?.area === "secondary-color"
				? {
						question: "Supporting?",
						options: [
							{ value: { hex: "#29a5f1" }, label: "Almost the brand", reason: "r" },
							{ value: { hex: "#3e4c6b" }, label: "Slate", reason: "r" },
							{ value: { hex: "#8a6d3b" }, label: "Brass", reason: "r" },
						],
						recommended: 0,
					}
				: undefined,
		)
		assert.equal(end.phase, "finish")
		if (end.phase !== "finish") return
		assert.notEqual(end.proposal.secondary, "#29a5f1")
	})

	it("a provider refusal stops at once on the error screen, is saved, and Try again carries on", async () => {
		let refuse = true
		const model = standIn((r) =>
			refuse && r.trace?.area === "brand-color" ? new ProviderRefusalError("usage limit reached") : undefined,
		)
		const saved: SessionScratch[] = []
		const script = SCRIPTS.straight
		const session = await InterviewSession.start(script.mode, script.description, deps(model.backend, saved))
		lastSession = session
		const stopped = await runScript(session, script, ruled)
		assert.equal(stopped.phase, "error")
		if (stopped.phase !== "error") return
		assert.equal(stopped.stage, "brand-color")
		assert.match(stopped.message, /usage limit reached/)
		assert.equal(model.requests.filter((r) => r.trace?.area === "brand-color").length, 1, "a refusal was asked again")
		// Saved: reopening shows the same error screen with the answers kept.
		const reopened = viewOf(saved.at(-1) as SessionScratch)
		assert.equal(reopened?.phase, "error")
		refuse = false
		await session.retry()
		const end = await runScript(session, script, ruled)
		assert.equal(end.phase, "finish")
	})

	it("a model that never gives a usable reply ends on the error screen after 3 tries, never in a loop", async () => {
		const { end, requests } = await run("straight", (r) => (r.trace?.area === "body-type" ? { garbage: 1 } : undefined))
		assert.equal(end.phase, "error")
		if (end.phase === "error") assert.match(end.message, /couldn't write a usable question/)
		assert.equal(requests.filter((r) => r.trace?.area === "body-type").length, 3)
	})

	it("Just finish it makes one call for every remaining topic, and Back returns to where it was pressed", async () => {
		const { end, requests, session } = await run("finish-early")
		assert.equal(end.phase, "finish")
		assert.equal(requests.filter((r) => r.trace?.tag === "interview:fill").length, 1)
		assert.equal(requests.filter((r) => r.trace?.area === "accent-color").length, 0, "a topic after Just finish it was asked")
		if (end.phase === "finish") assert.equal(end.finishedEarly, true)
		const back = await session.back()
		assert.equal(back?.phase, "question")
		if (back?.phase === "question") assert.equal(back.question.area, "secondary-color")
		assert.equal(session.saved.record.answers.filter((a) => a.via === "finish-now").length, 0)
	})

	it("the finish's words fall back to Caret's own when the model can't write them, but a refusal still stops", async () => {
		const strange = await run("straight", (r) =>
			r.trace?.tag === "interview:prose"
				? { summary: "Use #ff00ff.", rule: "r", reasons: Object.fromEntries(AREA_ORDER.map((a) => [a, "x"])) }
				: undefined,
		)
		assert.equal(strange.end.phase, "finish", "unusable words blocked the finish")
		if (strange.end.phase === "finish") assert.doesNotMatch(strange.end.proposal.summary, /#ff00ff/)
		const refused = await run("straight", (r) =>
			r.trace?.tag === "interview:prose" ? new ProviderRefusalError("quota") : undefined,
		)
		assert.equal(refused.end.phase, "error")
	})

	it("an opening screen with nothing to confirm is skipped", async () => {
		const { end, requests } = await run("straight", (r) =>
			r.trace?.tag === "interview:opening" ? { question: "Here's what I took.", statements: [] } : undefined,
		)
		assert.equal(end.phase, "finish")
		assert.equal(requests.filter((r) => r.trace?.tag === "interview:area").length, 12)
	})

	it("reading an app, a finding whose file doesn't exist is dropped", async () => {
		const model = standIn((r) =>
			r.trace?.tag === "interview:opening"
				? {
						question: "Here's what I found in your code.",
						statements: [
							{
								area: "brand-color",
								value: { hex: "#4f46e5" },
								text: "Brand is indigo.",
								source: "tailwind.config.ts",
							},
							{
								area: "display-type",
								value: { family: "Inter" },
								text: "Headings use Inter.",
								source: "src/made-up.css",
							},
						],
					}
				: undefined,
		)
		const session = await InterviewSession.start("from-app", "Next.js with Tailwind.", {
			...deps(model.backend),
			sourceExists: async (file) => file === "tailwind.config.ts",
		})
		const view = session.view()
		assert.equal(view?.phase, "opening")
		if (view?.phase === "opening")
			assert.deepEqual(
				view.statements.map((s) => s.area),
				["brand-color"],
			)
		assert.equal(model.requests[0].reads, true, "reading an app did not let the model read the project")
	})

	it("the description and typed values reach the model; nothing else from the test machine does", async () => {
		const { requests } = await run("straight")
		const body = requests.find((r) => r.trace?.area === "body-type")
		assert.ok(body)
		assert.match(body.prompt, new RegExp(ARGUS.slice(0, 40)))
		assert.doesNotMatch(body.prompt + (body.systemPrompt ?? ""), /\/tmp\/project/)
	})
})
