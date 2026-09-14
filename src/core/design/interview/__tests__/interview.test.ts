/**
 * The wizard's guarantees, pinned.
 *
 * The model owns the interview — what to ask, how to word it, when to finish.
 * What it does not own is the screen or the file, and these tests are the
 * boundary of that ownership:
 *
 * 1. **Every turn must render.** A question that names no options, repeats an
 *    id, or claims a kind its payload cannot support is bounced back to the
 *    model with a sentence it can act on — never dropped silently, never shown
 *    broken.
 * 2. **The file is Caret's.** A finish carries parameters; `finalizeProposal`
 *    derives every scale with the same generator the token editor uses, and a
 *    proposal that cannot survive that derivation is refused with a reason.
 * 3. **The Presets tab is deterministic.** Same description, same screens, on
 *    every machine, with no model in the room.
 */
import { strict as assert } from "assert"

import type { CodingBackend } from "../../agent/backend"
import { TYPEFACE_PAIRINGS } from "../../foundation-library"
import { buildFoundation, IncompleteInterviewError } from "../commit"
import {
	bindSettledValues,
	COVERAGE_AREAS,
	checkValueEcho,
	nextWizardTurn,
	settledValues,
	validateQuestion,
	WizardTurnError,
} from "../conductor"
import { finalizeProposal, ProposalError } from "../finalize"
import { tagsFromDescription } from "../steps"
import type { FoundationProposal, StoredQA, WizardQuestion } from "../widgets"
import { normalizeHex } from "../widgets"

const DESCRIPTION = "A dashboard for technical teams who watch it all day"

const PROPOSAL: FoundationProposal = {
	displayFamily: "Space Grotesk",
	bodyFamily: "Inter",
	scaleRatio: 1.2,
	baseSize: 15,
	brand: "#2563eb",
	neutral: "cool",
	surface: "dark",
	spacingUnit: 4,
	radiusCharacter: "sharp",
	rule: "Brand colour on the primary action only.",
	vibeTags: ["technical", "dense"],
	summary: "Built for long sessions: quiet, dense, readable.",
}

function question(overrides: Partial<WizardQuestion>): WizardQuestion {
	return { id: "q1", kind: "options", question: "Which of these?", ...overrides } as WizardQuestion
}

describe("validateQuestion", () => {
	it("passes a well-formed question through with its recommendation intact", () => {
		const valid = validateQuestion(
			question({
				options: [
					{ id: "a", label: "First" },
					{ id: "b", label: "Second" },
				],
				recommendedId: "b",
			}),
			[],
		)
		assert.equal(valid.recommendedId, "b")
		assert.equal(valid.options?.length, 2)
	})

	it("falls back to the first option when the recommendation names nothing", () => {
		const valid = validateQuestion(
			question({
				options: [
					{ id: "a", label: "First" },
					{ id: "b", label: "Second" },
				],
				recommendedId: "made-up",
			}),
			[],
		)
		assert.equal(valid.recommendedId, "a", "someone has to be preselected — pressing through must work")
	})

	it("rejects a pick question with fewer than two options", () => {
		assert.throws(() => validateQuestion(question({ options: [{ id: "a", label: "Only" }] }), []), WizardTurnError)
	})

	it("rejects a question whose kind is missing or unknown — the wire is not trusted", () => {
		// The schema requires a kind, but the backend does not enforce the
		// schema: a kind-less spacing question reached the renderer and drew an
		// empty screen with Continue disabled forever (test4).
		const options = [
			{ id: "a", label: "Snug" },
			{ id: "b", label: "Roomy" },
		]
		for (const kind of [undefined, "slider", "number"]) {
			assert.throws(
				() => validateQuestion(question({ kind: kind as never, options }), []),
				(err: unknown) => err instanceof WizardTurnError && /must be one of/.test(err.message),
			)
		}
	})

	it("refuses a question bundling several coverage areas — one decision per question", () => {
		// test4's pairing card asked heading AND body faces at once; the font
		// search picks one family, so only free text could answer it.
		assert.throws(
			() =>
				validateQuestion(
					question({
						kind: "font",
						covers: ["display-type", "body-type"],
						options: [
							{ id: "a", label: "Young Serif" },
							{ id: "b", label: "Fraunces" },
						],
					}),
					[],
				),
			(err: unknown) => err instanceof WizardTurnError && /one decision per question/.test(err.message),
		)
	})

	it("refuses an assumptions screen that claims to settle typefaces or palette colours", () => {
		// test4's opening assumptions claimed brand-color, so the dedicated
		// brand question never came and the exact hex was never the user's.
		assert.throws(
			() =>
				validateQuestion(
					question({
						kind: "assumptions",
						covers: ["surface", "brand-color"],
						options: [{ id: "a", label: "Screens sit on a light background" }],
					}),
					[],
				),
			(err: unknown) => err instanceof WizardTurnError && /may not settle/.test(err.message),
		)
	})

	it("lets an assumptions screen confirm several character areas at once", () => {
		const valid = validateQuestion(
			question({
				kind: "assumptions",
				covers: ["surface", "neutral", "semantics"],
				options: [
					{ id: "a", label: "Screens sit on a light background" },
					{ id: "b", label: "The greys lean warm" },
				],
			}),
			[],
		)
		assert.deepEqual(valid.covers, ["surface", "neutral", "semantics"])
	})

	it("requires the colour widget for a question that settles a colour", () => {
		// test4's accent question came as plain option cards, so the user typed
		// a hex into a text field while the picker sat unused.
		assert.throws(
			() =>
				validateQuestion(
					question({
						covers: ["accent-color"],
						options: [
							{ id: "a", label: "Warm amber" },
							{ id: "b", label: "No accent" },
						],
					}),
					[],
				),
			(err: unknown) => err instanceof WizardTurnError && /kind "color"/.test(err.message),
		)
	})

	it("lets a colour question carry one hex-less 'none' option, but not only those", () => {
		const valid = validateQuestion(
			question({
				kind: "color",
				covers: ["accent-color"],
				options: [
					{ id: "a", label: "Marigold", hex: "#e9a13b" },
					{ id: "b", label: "No accent colour" },
				],
			}),
			[],
		)
		assert.equal(valid.options?.[0].hex, "#e9a13b")
		assert.equal(valid.options?.[1].hex, undefined)

		assert.throws(
			() =>
				validateQuestion(
					question({
						kind: "color",
						options: [
							{ id: "a", label: "None" },
							{ id: "b", label: "Also none" },
						],
					}),
					[],
				),
			(err: unknown) => err instanceof WizardTurnError && /at least one option with a hex/.test(err.message),
		)
	})

	it("rejects a 'you decide' option — Skip and the recommendation carry delegation", () => {
		// Field-measured (test4): the delegate option was the only escape when
		// the user's value was not on offer, and clicking it sealed the area.
		for (const label of ["You decide", "Whatever you think works", "Up to you"]) {
			assert.throws(
				() =>
					validateQuestion(
						question({
							options: [
								{ id: "a", label: "Deep green #2d6a4f" },
								{ id: "b", label },
							],
						}),
						[],
					),
				(err: unknown) => err instanceof WizardTurnError && /concrete outcome/.test(err.message),
			)
		}
	})

	it("rejects a colour option without a usable hex, and normalises the rest", () => {
		assert.throws(
			() =>
				validateQuestion(
					question({
						kind: "color",
						options: [
							{ id: "a", label: "Blue", hex: "#2563eb" },
							{ id: "b", label: "Broken", hex: "blue" },
						],
					}),
					[],
				),
			WizardTurnError,
		)

		const valid = validateQuestion(
			question({
				kind: "color",
				options: [
					{ id: "a", label: "Blue", hex: "2563EB" },
					{ id: "b", label: "Short", hex: "#abc" },
				],
			}),
			[],
		)
		assert.equal(valid.options?.[0].hex, "#2563eb")
		assert.equal(valid.options?.[1].hex, "#aabbcc")
		// The picker/hex/eyedropper escape hatch is the user's by design, not the
		// model's to withhold.
		assert.equal(valid.other, "color")
	})

	it("de-duplicates option ids instead of rendering one card twice", () => {
		const valid = validateQuestion(
			question({
				options: [
					{ id: "same", label: "One" },
					{ id: "same", label: "Two" },
				],
			}),
			[],
		)
		const ids = valid.options?.map((option) => option.id) ?? []
		assert.equal(new Set(ids).size, ids.length, `duplicate ids survived: ${ids.join(", ")}`)
	})

	it("renames a question id the interview has already used", () => {
		const asked = {
			question: question({ id: "brand" }),
			answer: { questionId: "brand", question: "?", kind: "options" as const, value: "a" },
		}
		const valid = validateQuestion(
			question({
				id: "brand",
				options: [
					{ id: "a", label: "A" },
					{ id: "b", label: "B" },
				],
			}),
			[asked],
		)
		assert.notEqual(valid.id, "brand", "a repeated question id would make the answer ambiguous")
	})

	it("requires a scale question to have poles and at least three steps", () => {
		assert.throws(
			() => validateQuestion(question({ kind: "scale", steps: [{ label: "tight" }, { label: "airy" }] }), []),
			WizardTurnError,
		)

		const valid = validateQuestion(
			question({
				kind: "scale",
				leftLabel: "Compact",
				rightLabel: "Airy",
				steps: [{ label: "tight" }, { label: "normal" }, { label: "open" }],
				defaultStep: 99,
			}),
			[],
		)
		assert.equal(valid.defaultStep, 2, "an out-of-range default was not clamped")
	})
})

describe("nextWizardTurn", () => {
	function backendReturning(values: unknown[]): CodingBackend {
		let call = 0
		return {
			id: "opencode",
			async structured() {
				return { value: values[Math.min(call++, values.length - 1)], emulated: false }
			},
		} as unknown as CodingBackend
	}

	const base = { workingDirectory: "/tmp/x", description: DESCRIPTION, history: [] }

	it("returns a validated ask turn", async () => {
		const turn = await nextWizardTurn({
			...base,
			backend: backendReturning([
				{
					action: "ask",
					question: question({
						options: [
							{ id: "a", label: "A" },
							{ id: "b", label: "B" },
						],
					}),
				},
			]),
		})
		assert.equal(turn.action, "ask")
	})

	it("retries once with the validator's complaint, and succeeds on the corrected turn", async () => {
		const turn = await nextWizardTurn({
			...base,
			backend: backendReturning([
				{ action: "ask", question: question({ options: [] }) }, // rejected: no options
				{
					action: "ask",
					question: question({
						options: [
							{ id: "a", label: "A" },
							{ id: "b", label: "B" },
						],
					}),
				},
			]),
		})
		assert.equal(turn.action, "ask")
	})

	it("fails after the retry rather than looping", async () => {
		await assert.rejects(
			nextWizardTurn({ ...base, backend: backendReturning([{ action: "ask", question: question({ options: [] }) }]) }),
			WizardTurnError,
		)
	})

	it("refuses a finish whose foundation cannot be finalized", async () => {
		await assert.rejects(
			nextWizardTurn({
				...base,
				backend: backendReturning([{ action: "finish", foundation: { ...PROPOSAL, brand: "not-a-colour" } }]),
			}),
			ProposalError,
		)
	})

	it("forces a finish when asked to, even if the model wants to keep asking", async () => {
		const turn = await nextWizardTurn({
			...base,
			force: "finish",
			backend: backendReturning([
				// The model ignores the instruction and asks anyway — the payload has
				// no foundation, so the retry complaint tells it exactly what to send.
				{
					action: "ask",
					question: question({
						options: [
							{ id: "a", label: "A" },
							{ id: "b", label: "B" },
						],
					}),
				},
				{ action: "finish", foundation: PROPOSAL },
			]),
		})
		assert.equal(turn.action, "finish")
	})

	describe("collaborative mode", () => {
		it("covers the secondary and the accent as separate areas", () => {
			// As one "supporting-colors" area, a single delegated question
			// satisfied the checklist while the accent was never mentioned —
			// test4 committed with accent: null.
			const ids = COVERAGE_AREAS.map((area) => area.id)
			assert.ok(ids.includes("secondary-color"))
			assert.ok(ids.includes("accent-color"))
			assert.ok(!ids.includes("supporting-colors"))
		})

		/** One answered question per coverage area, each properly tagged. */
		function fullCoverage(): StoredQA[] {
			return COVERAGE_AREAS.map((area, index) => ({
				question: question({ id: `q-${area.id}`, covers: [area.id], options: undefined, kind: "text" }),
				answer: { questionId: `q-${area.id}`, question: `About ${area.label}?`, kind: "text", value: `answer ${index}` },
			}))
		}

		const fullDecisions = () => COVERAGE_AREAS.map((area) => ({ area: area.id, choice: "chosen", reason: "they said so" }))

		it("rejects a model-chosen finish while coverage areas are missing", async () => {
			await assert.rejects(
				nextWizardTurn({
					...base,
					mode: "collaborative",
					backend: backendReturning([{ action: "finish", foundation: { ...PROPOSAL, decisions: fullDecisions() } }]),
				}),
				(err: unknown) => err instanceof WizardTurnError && /have not asked about/.test(err.message),
			)
		})

		it("rejects a covered finish that skips its decisions record", async () => {
			await assert.rejects(
				nextWizardTurn({
					...base,
					history: fullCoverage(),
					mode: "collaborative",
					backend: backendReturning([{ action: "finish", foundation: PROPOSAL }]),
				}),
				(err: unknown) => err instanceof WizardTurnError && /decisions/.test(err.message),
			)
		})

		it("accepts a finish once every area is asked about and decided", async () => {
			const turn = await nextWizardTurn({
				...base,
				history: fullCoverage(),
				mode: "collaborative",
				backend: backendReturning([{ action: "finish", foundation: { ...PROPOSAL, decisions: fullDecisions() } }]),
			})
			assert.equal(turn.action, "finish")
		})

		it("lets 'Just finish it' bypass coverage — the user's escape always works", async () => {
			const turn = await nextWizardTurn({
				...base,
				mode: "collaborative",
				force: "finish",
				backend: backendReturning([{ action: "finish", foundation: PROPOSAL }]),
			})
			assert.equal(turn.action, "finish")
		})

		it("sanitizes unknown coverage tags instead of rejecting the question", () => {
			const valid = validateQuestion(
				question({
					covers: ["spacing", "made-up-area"],
					options: [
						{ id: "a", label: "A" },
						{ id: "b", label: "B" },
					],
				}),
				[],
			)
			assert.deepEqual(valid.covers, ["spacing"])
		})
	})
})

describe("the settled-values ledger", () => {
	/** A QA whose answer carries a typed payload, tagged with one area. */
	function qa(area: string, answer: Partial<StoredQA["answer"]>, kind: WizardQuestion["kind"] = "color"): StoredQA {
		return {
			question: question({ id: `q-${area}`, kind, covers: [area], options: undefined }),
			answer: { questionId: `q-${area}`, question: `About ${area}?`, kind, value: "", ...answer } as StoredQA["answer"],
		}
	}

	it("builds typed entries from data.* only — labels never parse", () => {
		const settled = settledValues([
			qa("brand-color", { value: "#2f6b4a", data: { hex: "#2f6b4a" }, wasOther: true }),
			// A colour NAMED like a negation must not become "none": no data.none,
			// no none entry — this is the regex-scavenging trap, closed.
			qa("secondary-color", { value: "Nordic Noir", label: "Nordic Noir" }),
			qa("accent-color", { value: "No accent", label: "No accent", data: { none: true } }),
			qa("display-type", { value: "Young Serif", data: { family: "Young Serif" }, wasOther: true }, "font"),
			qa("spacing", { value: "4px", data: { px: 4 }, wasOther: true }, "options"),
			qa("type-scale", { value: "16 · 1.25", data: { px: 16, ratio: 1.25 }, wasOther: true }, "options"),
			qa("depth", { value: "", skipped: true }, "options"),
		])
		const byKey = new Map(settled.map((entry) => [`${entry.area}:${"field" in entry ? entry.field : ""}`, entry]))
		assert.deepEqual(byKey.get("brand-color:"), { area: "brand-color", kind: "hex", value: "#2f6b4a", own: true })
		assert.deepEqual(byKey.get("secondary-color:"), {
			area: "secondary-color",
			kind: "choice",
			value: "Nordic Noir",
			own: false,
		})
		assert.deepEqual(byKey.get("accent-color:"), { area: "accent-color", kind: "none" })
		assert.deepEqual(byKey.get("display-type:"), { area: "display-type", kind: "family", value: "Young Serif", own: true })
		assert.deepEqual(byKey.get("spacing:spacingUnit"), {
			area: "spacing",
			kind: "number",
			field: "spacingUnit",
			value: 4,
			own: true,
		})
		assert.deepEqual(byKey.get("type-scale:baseSize"), {
			area: "type-scale",
			kind: "number",
			field: "baseSize",
			value: 16,
			own: true,
		})
		assert.deepEqual(byKey.get("type-scale:scaleRatio"), {
			area: "type-scale",
			kind: "number",
			field: "scaleRatio",
			value: 1.25,
			own: true,
		})
		assert.deepEqual(byKey.get("depth:"), { area: "depth", kind: "delegated" })
	})

	it("echo check refuses a finish that drops or rewrites a settled value, naming the field", () => {
		const settled = settledValues([
			qa("secondary-color", { value: "#b25a3c", data: { hex: "#b25a3c" }, wasOther: true }),
			qa("accent-color", { value: "No accent", data: { none: true } }),
			qa("spacing", { value: "4px", data: { px: 4 }, wasOther: true }, "options"),
		])
		assert.throws(
			() => checkValueEcho({ ...PROPOSAL, secondary: undefined, accent: "#f0b429", spacingUnit: 8 }, settled),
			(err: unknown) =>
				err instanceof WizardTurnError &&
				/`secondary` — the user answered #b25a3c but the proposal has nothing/.test(err.message) &&
				/`accent` — the user chose none/.test(err.message) &&
				/`spacingUnit` — the user answered 4/.test(err.message),
		)
		// The same proposal, echoing correctly, passes.
		checkValueEcho({ ...PROPOSAL, secondary: "#b25a3c", accent: undefined, spacingUnit: 4 }, settled)
	})

	it("bind writes the ledger into the proposal and rewrites the matching decision", async () => {
		const settled = settledValues([
			qa("secondary-color", { value: "#b25a3c", data: { hex: "#b25a3c" }, wasOther: true }),
			qa("accent-color", { value: "No accent", data: { none: true } }),
		])
		const foundation = {
			...PROPOSAL,
			accent: "#f0b429",
			decisions: [{ area: "secondary-color", choice: "a warm clay", reason: "fits" }],
		}
		await bindSettledValues(foundation, settled)
		assert.equal(foundation.secondary, "#b25a3c")
		assert.equal(foundation.accent, undefined)
		assert.equal(foundation.decisions?.[0].choice, "#b25a3c")
	})

	it("the retry carries the rejected payload — a stateless attempt cannot correct what it never saw", async () => {
		const prompts: string[] = []
		const bad = { action: "ask", question: question({ kind: "slider" as never, options: [{ id: "a", label: "A" }] }) }
		const good = {
			action: "ask",
			question: question({
				options: [
					{ id: "a", label: "A" },
					{ id: "b", label: "B" },
				],
			}),
		}
		let call = 0
		const backend = {
			id: "opencode",
			async structured(request: { prompt: string }) {
				prompts.push(request.prompt)
				return { value: [bad, good][Math.min(call++, 1)], emulated: false }
			},
		} as unknown as CodingBackend
		const turn = await nextWizardTurn({ workingDirectory: "/tmp/x", description: "d", history: [], backend })
		assert.equal(turn.action, "ask")
		assert.ok(prompts[1].includes('"slider"'), "retry prompt must echo the rejected payload")
		assert.ok(prompts[1].includes("Why it was rejected:"))
	})

	it("a hallucinated 'you decide' card is sanitized, not retried — the recommendation re-points", () => {
		const valid = validateQuestion(
			question({
				options: [
					{ id: "a", label: "Deep green #2d6a4f" },
					{ id: "b", label: "Warm clay #b45309" },
					{ id: "c", label: "You decide" },
				],
				recommendedId: "c",
			}),
			[],
		)
		assert.deepEqual(
			valid.options?.map((option) => option.id),
			["a", "b"],
		)
		assert.equal(valid.recommendedId, "a")
	})
})

describe("finalizeProposal", () => {
	it("derives every scale itself, in the token editor's shape", () => {
		const { tokens } = finalizeProposal(PROPOSAL, DESCRIPTION)

		assert.equal(tokens.typography.fontFamily, "Inter")
		assert.equal(tokens.typography.displayFamily, "Space Grotesk")
		assert.ok(Object.keys(tokens.typography.scale).length > 0, "no type scale was derived")
		assert.ok(Object.keys(tokens.color.brand.scale).length > 0, "no colour scale was derived")
		assert.ok(tokens.spacing.scale.length > 0, "no spacing scale")
		assert.equal(tokens.radius.character, "sharp")
		assert.ok(tokens.radius.scale.includes(9999), "the radius scale lost its pill stop")
	})

	it("clamps parameters into the ranges the derivations behave in", () => {
		const { tokens } = finalizeProposal({ ...PROPOSAL, scaleRatio: 3, baseSize: 60, spacingUnit: 5 }, DESCRIPTION)
		assert.equal(tokens.typography.scaleRatio, 1.5)
		assert.equal(tokens.typography.baseSize, 20)
		assert.equal(tokens.spacing.baseUnit, 4)
	})

	it("fills semantic colours the proposal left out, and keeps valid ones it set", () => {
		const { tokens } = finalizeProposal({ ...PROPOSAL, semantic: { error: "#b91c1c" } }, DESCRIPTION)
		assert.equal(tokens.color.semantic.error, "#b91c1c")
		assert.ok(normalizeHex(tokens.color.semantic.success), "a default semantic is missing")
	})

	it("refuses a brand that is not a colour, naming the fix", () => {
		assert.throws(() => finalizeProposal({ ...PROPOSAL, brand: "cornflower" }, DESCRIPTION), ProposalError)
	})

	it("refuses a proposal with no restraint rule", () => {
		assert.throws(() => finalizeProposal({ ...PROPOSAL, rule: "  " }, DESCRIPTION), ProposalError)
	})

	it("derives ramps for secondary and accent when the palette names them", () => {
		const { tokens } = finalizeProposal({ ...PROPOSAL, secondary: "#0ea5e9", accent: "f59e0b" }, DESCRIPTION)
		assert.equal(tokens.color.secondary?.seed, "#0ea5e9")
		assert.equal(tokens.color.accent?.seed, "#f59e0b")
		assert.ok(Object.keys(tokens.color.secondary?.scale ?? {}).length > 0, "no secondary ramp")
		assert.ok(Object.keys(tokens.color.accent?.scale ?? {}).length > 0, "no accent ramp")
	})

	it("refuses a secondary that is not a colour, naming the role", () => {
		assert.throws(
			() => finalizeProposal({ ...PROPOSAL, secondary: "sea foam" }, DESCRIPTION),
			(err: unknown) => err instanceof ProposalError && /secondary/.test(err.message),
		)
	})

	it("ships a real neutral ramp — never the empty scale that fell through to stock grey", () => {
		const { tokens } = finalizeProposal(PROPOSAL, DESCRIPTION)
		assert.ok(Object.keys(tokens.color.neutral.scale).length > 0, "neutral.scale is empty")
		assert.ok(tokens.color.on?.brand, "no on-brand foreground was derived")
		assert.ok(tokens.elevation?.scale.floating, "no elevation was derived")
		assert.ok(tokens.motion?.durations.base, "no motion was derived")
		assert.ok(tokens.typography.leadings?.base, "no leadings were derived")
	})

	it("carries collaborative decisions through for the commit to persist", () => {
		const decisions = [{ area: "brand-color", choice: "#2563eb", reason: "asked for a trustworthy blue" }]
		const finalized = finalizeProposal({ ...PROPOSAL, decisions }, DESCRIPTION)
		assert.deepEqual(finalized.decisions, decisions)
		assert.equal(finalizeProposal(PROPOSAL, DESCRIPTION).decisions, undefined)
	})
})

describe("the library reading and shared validation", () => {
	it("refuses a blanket confirmation among assumptions", () => {
		// The screen ticks every statement already, so "Yes, all of these" says
		// nothing — and sitting beside real statements it gets confirmed with them,
		// reporting that the user agreed to a direction and to two departures from
		// it at the same time. Observed in a real run.
		assert.throws(
			() =>
				validateQuestion(
					{
						id: "q1",
						kind: "assumptions",
						question: "Confirm these.",
						options: [
							{ id: "a", label: "Yes, all of these" },
							{ id: "b", label: "Give type more character" },
						],
					} as never,
					[],
				),
			/blanket confirmation/,
		)
	})

	it("recommends nothing on assumptions, and something on every other kind", () => {
		// A recommendation is meaningless when everything is agreed already, and
		// asking for one is what pushes a pick-one shape into a format that is not
		// a picker.
		const assumptions = validateQuestion(
			{
				id: "q1",
				kind: "assumptions",
				question: "Confirm these.",
				options: [{ id: "a", label: "Pages sit on a light background" }],
			} as never,
			[],
		)
		assert.equal(assumptions.recommendedId, undefined)

		const options = validateQuestion(
			{
				id: "q2",
				kind: "options",
				question: "Which one?",
				options: [
					{ id: "a", label: "Calm" },
					{ id: "b", label: "Loud" },
				],
			} as never,
			[],
		)
		assert.ok(options.recommendedId, "a pick-one question lost its recommendation")
	})

	it("finds the library's vocabulary in prose without matching inside words", () => {
		assert.ok(tagsFromDescription(DESCRIPTION).includes("dashboard"))
		assert.deepEqual(tagsFromDescription("we condense reports"), [])
	})

	it("never reads a quality the user ruled out as one they asked for", () => {
		// Matching is on the word, not the meaning, so a negated quality used to
		// seed its own tag — the opposite of what was said, which is worse than
		// reading nothing. The product's own placeholder demonstrated it.
		assert.deepEqual(tagsFromDescription("Dark, calm, nothing playful."), ["calm", "dark"])
		assert.ok(!tagsFromDescription("clean and modern, never playful").includes("playful"))
		assert.ok(!tagsFromDescription("a serious tool, not a consumer toy").includes("consumer"))
		assert.ok(!tagsFromDescription("warm and human, without the retro styling").includes("retro"))
	})

	it("keeps the qualities named before a negation later in the same sentence", () => {
		// Clause-scoped, not whole-string: a late negation must not discard what
		// came before it, or one careless phrase empties the whole narrowing.
		assert.deepEqual(tagsFromDescription("Editorial and minimal, calm and considered rather than loud."), [
			"calm",
			"considered",
			"editorial",
			"minimal",
		])
	})

	it("builds a complete foundation from chosen ids and refuses incomplete ones", () => {
		const typeface = TYPEFACE_PAIRINGS[0]
		const foundation = buildFoundation(DESCRIPTION, {
			typeface: typeface.id,
			palette: typeface.pairsWith.palettes[0],
			shape: typeface.pairsWith.shapes[0],
		})
		assert.equal(foundation.tokens.typography.fontFamily, typeface.body.family)
		assert.ok(foundation.rule)

		assert.throws(() => buildFoundation(DESCRIPTION, { typeface: typeface.id }), IncompleteInterviewError)
	})
})
