import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import should from "should"

import { markSignal, mineCorrections, normalizeInstruction, pendingSignals, signalKey } from "../corrections"
import { addPromotedRule, readPromotedRules, removePromotedRule } from "../promoted-rules"
import type { EditRecord } from "../provenance"

function detach(file: string, caretId: string, token: string, hex: string): EditRecord {
	return {
		actor: "inline",
		action: "write",
		file,
		param: caretId,
		detail: { kind: "color-detach", token, hex },
	}
}

function instruction(text: string): EditRecord {
	return { actor: "inline", action: "write", file: ".caret/pages/home/index.tsx", detail: { kind: "instruction", text } }
}

describe("mineCorrections", () => {
	it("raises a token signal when the same token goes to the same colour twice", () => {
		const signals = mineCorrections([
			detach("a.tsx", "hero", "brand-500", "#111111"),
			detach("b.tsx", "cta", "brand-500", "#111111"),
		])
		signals.should.have.length(1)
		const signal = signals[0]
		if (signal.kind !== "token") throw new Error("expected a token signal")
		signal.token.should.equal("brand-500")
		signal.hex.should.equal("#111111")
		signal.count.should.equal(2)
		signal.places.should.have.length(2)
	})

	it("counts repeated corrections to the same element — the agent-keeps-reverting case", () => {
		const signals = mineCorrections([
			detach("a.tsx", "hero", "brand-500", "#111111"),
			detach("a.tsx", "hero", "brand-500", "#111111"),
		])
		signals.should.have.length(1)
		if (signals[0].kind !== "token") throw new Error("expected a token signal")
		signals[0].places.should.have.length(1)
	})

	it("does not conflate different target colours or different tokens", () => {
		mineCorrections([
			detach("a.tsx", "hero", "brand-500", "#111111"),
			detach("b.tsx", "cta", "brand-500", "#222222"),
			detach("c.tsx", "nav", "brand-600", "#111111"),
		]).should.have.length(0)
	})

	it("ignores non-inline actors entirely", () => {
		const record = detach("a.tsx", "hero", "brand-500", "#111111")
		mineCorrections([record, { ...record, actor: "agent" }]).should.have.length(0)
	})

	it("raises a rule signal on the third identical instruction, matching loosely but quoting verbatim", () => {
		const signals = mineCorrections([
			instruction("Remove the border around the cards"),
			instruction("remove the border around the cards!"),
			instruction("  Remove the border around the cards. "),
		])
		signals.should.have.length(1)
		const signal = signals[0]
		if (signal.kind !== "rule") throw new Error("expected a rule signal")
		signal.instruction.should.equal("Remove the border around the cards")
		signal.count.should.equal(3)
	})

	it("never promotes trivially short instructions", () => {
		mineCorrections([instruction("fix"), instruction("fix"), instruction("fix")]).should.have.length(0)
	})
})

describe("normalizeInstruction", () => {
	it("strips case, punctuation and whitespace but keeps letters and digits", () => {
		normalizeInstruction("  Use 8px  grid, please! ").should.equal("use 8px grid please")
	})
})

describe("correction offer bookkeeping", () => {
	let workspace: string

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), "corrections-"))
		await fs.mkdir(path.join(workspace, ".caret"), { recursive: true })
	})

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true })
	})

	it("raises a signal once, and never again after offered or dismissed", async () => {
		const records = [detach("a.tsx", "hero", "brand-500", "#111111"), detach("b.tsx", "cta", "brand-500", "#111111")]

		const first = await pendingSignals(workspace, records)
		first.should.have.length(1)

		await markSignal(workspace, signalKey(first[0]), "offered")
		;(await pendingSignals(workspace, records)).should.have.length(0)
	})

	it("treats a new target colour for the same token as a new signal", async () => {
		const old = [detach("a.tsx", "hero", "brand-500", "#111111"), detach("b.tsx", "cta", "brand-500", "#111111")]
		await markSignal(workspace, signalKey(mineCorrections(old)[0]), "dismissed")

		const next = [detach("a.tsx", "hero", "brand-500", "#333333"), detach("b.tsx", "cta", "brand-500", "#333333")]
		;(await pendingSignals(workspace, [...old, ...next])).should.have.length(1)
	})
})

describe("promoted rules store", () => {
	let workspace: string

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), "promoted-rules-"))
		await fs.mkdir(path.join(workspace, ".caret"), { recursive: true })
	})

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true })
	})

	it("adds, deduplicates, lists and removes rules", async () => {
		const rule = await addPromotedRule(workspace, "Never use pure black for text", "correction")
		const duplicate = await addPromotedRule(workspace, "Never use pure black for text", "manual")
		duplicate.id.should.equal(rule.id)

		const stored = await readPromotedRules(workspace)
		stored.rules.should.have.length(1)
		stored.rules[0].source.should.equal("correction")

		should(await removePromotedRule(workspace, rule.id)).be.true()
		;(await readPromotedRules(workspace)).rules.should.have.length(0)
		should(await removePromotedRule(workspace, rule.id)).be.false()
	})

	it("survives a corrupt rules file by starting empty", async () => {
		await fs.writeFile(path.join(workspace, ".caret", "rules.json"), "{not json")
		;(await readPromotedRules(workspace)).rules.should.have.length(0)
	})
})
