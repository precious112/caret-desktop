/**
 * Saving a foundation: Caret turns the interview's values into
 * foundation.json itself, deriving every scale, so the file is always in the
 * shape the token editor expects.
 */
import { strict as assert } from "assert"

import { finalizeProposal, ProposalError } from "../finalize"
import { type FoundationProposal, normalizeHex } from "../widgets"

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
