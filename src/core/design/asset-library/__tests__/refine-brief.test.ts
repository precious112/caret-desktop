/**
 * The rebuild stage, tested from what it promises the user.
 *
 * The promise: an amateur's request comes back as the brief a professional
 * would have written, per kind, with their own decisions intact — and any
 * failure means "generate with the words we have", never a blocked user.
 */
import { strict as assert } from "assert"
import { refineBrief } from "../refine-brief"

/** A backend whose structured call records the prompt and returns a canned value. */
function backendReturning(value: unknown) {
	const seen: { prompt?: string } = {}
	return {
		seen,
		backend: {
			structured: async (input: { prompt: string }) => {
				seen.prompt = input.prompt
				return { value, emulated: false } as { value: never; emulated: boolean }
			},
		},
	}
}

describe("refineBrief", () => {
	it("carries the user's words and answers into the rewrite request", async () => {
		const { seen, backend } = backendReturning({ prompt: "a rebuilt brief" })
		const result = await refineBrief({
			backend,
			workingDirectory: "/tmp/p",
			request: {
				kind: "image",
				text: "a cozy coffee photo",
				answers: { q1: "beans spilling from a bag", q2: "for the hero section" },
			},
			tokens: null,
		})
		assert.equal(result?.prompt, "a rebuilt brief")
		assert.ok(seen.prompt?.includes("a cozy coffee photo"), "the user's own words must reach the rewriter")
		assert.ok(seen.prompt?.includes("beans spilling from a bag"), "clarify answers must reach the rewriter")
		assert.ok(seen.prompt?.includes("for the hero section"), "every answer travels, not just the first")
	})

	it("briefs each kind with its own craft, not one generic playbook", async () => {
		const kinds = [
			{ kind: "mark" as const, expects: /LOGO MARK/ },
			{ kind: "image" as const, expects: /PHOTOGRAPH/ },
			{ kind: "object3d" as const, expects: /3D MODEL/ },
			{ kind: "shader" as const, expects: /SHADER/ },
		]
		for (const { kind, expects } of kinds) {
			const { seen, backend } = backendReturning({ prompt: "x" })
			await refineBrief({
				backend,
				workingDirectory: "/tmp/p",
				request: { kind, text: "an ember" },
				tokens: null,
			})
			assert.match(seen.prompt ?? "", expects, `the ${kind} playbook never reached the rewriter`)
		}
	})

	it("orders the preservation contract above the craft", async () => {
		// The field failure this pins: an earlier prompt asked for an improved
		// rewrite under a word cap, and the model obeyed by deleting the user's
		// constraints. The contract must demand that every piece of information
		// survives, and must treat exclusions as decisions.
		const { seen, backend } = backendReturning({ prompt: "x" })
		await refineBrief({ backend, workingDirectory: "/tmp/p", request: { kind: "image", text: "a mug" }, tokens: null })
		assert.match(seen.prompt ?? "", /Preserve every piece of information/i)
		assert.match(seen.prompt ?? "", /An exclusion is a decision/i)
		assert.match(seen.prompt ?? "", /dropped never/i)
		const contractAt = (seen.prompt ?? "").indexOf("THE CONTRACT")
		const craftAt = (seen.prompt ?? "").indexOf("CRAFT FOR THIS KIND")
		assert.ok(contractAt >= 0 && craftAt > contractAt, "the contract must come before the craft")
	})

	it("translates page facts into composition, never into picture content", async () => {
		// Two projects painted literal headlines into photographs because
		// placement answers were treated as scene content.
		const { seen, backend } = backendReturning({ prompt: "x" })
		await refineBrief({ backend, workingDirectory: "/tmp/p", request: { kind: "image", text: "a mug" }, tokens: null })
		assert.match(seen.prompt ?? "", /Facts about the page shape the frame, never the picture/i)
		assert.match(seen.prompt ?? "", /added later in HTML/i)
	})

	it("carries each answer with its question, and imposes no word cap", async () => {
		const { seen, backend } = backendReturning({ prompt: "x" })
		await refineBrief({
			backend,
			workingDirectory: "/tmp/p",
			request: {
				kind: "image",
				text: "a mug",
				answers: { "Where will this image sit?": "Full-bleed hero" },
			},
			tokens: null,
		})
		assert.match(seen.prompt ?? "", /Q: Where will this image sit\?/)
		assert.match(seen.prompt ?? "", /A: Full-bleed hero/)
		// An answer alone reads as a fact about the picture; the question is what
		// lets the contract classify it as a fact about the page.
		assert.ok(!/90 words|at most \d+ words/i.test(seen.prompt ?? ""), "a word cap forces deletion")
	})

	it("returns null on an empty rewrite, a malformed value, or a thrown backend", async () => {
		for (const value of [{ prompt: "" }, {}, null]) {
			const { backend } = backendReturning(value)
			const result = await refineBrief({
				backend,
				workingDirectory: "/tmp/p",
				request: { kind: "image", text: "a mug" },
				tokens: null,
			})
			assert.equal(result, null, `a rewrite of ${JSON.stringify(value)} must be a skipped step, not a crash`)
		}
		const throwing = {
			structured: async () => {
				throw new Error("backend down")
			},
		}
		const result = await refineBrief({
			backend: throwing,
			workingDirectory: "/tmp/p",
			request: { kind: "image", text: "a mug" },
			tokens: null,
		})
		assert.equal(result, null, "a dead backend must mean generate-as-typed, never a blocked user")
	})
})

describe("the swappable phrases in a brief", () => {
	const brief = "A walnut keyboard seen in a three-quarter view on a dark oak desk, lit by low warm window light from the left."
	it("keeps only phrases that appear word for word, never the person's own words, never overlapping", async () => {
		const { usablePhrases } = await import("../refine-brief")
		const phrases = usablePhrases(brief, "a walnut keyboard", [
			{ text: "three-quarter view", alternatives: ["top-down view", "straight-on view", "three-quarter view"] },
			{ text: "low warm window light", alternatives: ["soft overcast light"] },
			{ text: "warm window", alternatives: ["cool window"] },
			{ text: "walnut keyboard", alternatives: ["oak keyboard"] },
			{ text: "a sunny beach", alternatives: ["a forest"] },
			{ text: "dark oak desk", alternatives: [] },
		])
		assert.deepEqual(
			phrases.map((phrase) => phrase.text),
			["three-quarter view", "low warm window light"],
		)
		assert.deepEqual(
			phrases[0].alternatives,
			["top-down view", "straight-on view"],
			"the phrase itself is not an alternative",
		)
	})
	it("comes back from the rewriter with the brief, and is dropped when malformed", async () => {
		const { backend } = backendReturning({
			prompt: brief,
			phrases: [{ text: "dark oak desk", alternatives: ["slate counter", "linen cloth"] }],
		})
		const result = await refineBrief({
			backend,
			workingDirectory: "/tmp/p",
			request: { kind: "image", text: "keyboard" },
			tokens: null,
		})
		assert.deepEqual(result?.phrases, [{ text: "dark oak desk", alternatives: ["slate counter", "linen cloth"] }])
		const { backend: odd } = backendReturning({ prompt: brief, phrases: "nonsense" })
		const plain = await refineBrief({
			backend: odd,
			workingDirectory: "/tmp/p",
			request: { kind: "image", text: "keyboard" },
			tokens: null,
		})
		assert.equal(plain?.phrases, undefined)
	})
})
