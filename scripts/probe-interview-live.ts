/**
 * Runs FULL live collaborative interviews against the real backend, with a
 * scripted inbetweener answering the way the widgets would: exact hexes typed
 * into the colour picker, families picked in the font search, own numbers for
 * spacing and type scale, one deliberate Skip — then asserts the finished
 * proposal echoes every one of those values verbatim.
 *
 * This is the reliability contract under test, end to end, on the
 * probabilistic surface: the model may word questions differently every run,
 * ask in any order, or try to drop a value — the harness must land the same
 * committed values every time. Run it more than once.
 *
 *   CARET_VERIFY_MODEL=… npx tsx scripts/probe-interview-live.ts [runs]
 */
import { disposeBackends, nextWizardTurn, settledValues } from "../src/core/design"
import type { StoredQA, WizardAnswer, WizardQuestion } from "../src/core/design/interview/widgets"
import { resolveVerifyModel } from "./verify-support"

const DESCRIPTION = `Frond — a houseplant care companion. I keep track of every plant I own:
when to water, mist and fertilize each one, which room it lives in, and how
it's doing over time. Desktop app, just for me.`

/** The inbetweener's intended values — what MUST land in the finish. */
const WANT = {
	brand: "#2f6b4a",
	secondary: "#b25a3c",
	accent: "#e9a13b",
	displayFamily: "Young Serif",
	bodyFamily: "Instrument Sans",
	spacingUnit: 4,
	baseSize: 16,
	scaleRatio: 1.25,
}

/** Answer a validated question the way the real widgets would. */
function scriptedAnswer(question: WizardQuestion, gave: Set<string>): WizardAnswer {
	const base = { questionId: question.id, question: question.question, kind: question.kind }
	const area = question.covers?.length === 1 ? question.covers[0] : undefined
	const options = question.options ?? []
	const recommended = options.find((option) => option.id === question.recommendedId) ?? options[0]

	// The assumptions screen: confirm everything, exactly as the widget does.
	if (question.kind === "assumptions") {
		const lines = options.map((option) => `${option.label} → yes`)
		return { ...base, value: lines.join("\n"), label: "all confirmed" }
	}

	if (question.kind === "color" && area && ["brand-color", "secondary-color", "accent-color"].includes(area)) {
		const hex = area === "brand-color" ? WANT.brand : area === "secondary-color" ? WANT.secondary : WANT.accent
		gave.add(area)
		return { ...base, value: hex, label: "your own colour", wasOther: true, data: { hex } }
	}

	if (question.kind === "font" && (area === "display-type" || area === "body-type")) {
		const family = area === "display-type" ? WANT.displayFamily : WANT.bodyFamily
		gave.add(area)
		return { ...base, value: family, label: family, wasOther: true, data: { family } }
	}

	if (area === "spacing" && (question.kind === "options" || question.kind === "scale")) {
		gave.add(area)
		return {
			...base,
			value: `base unit ${WANT.spacingUnit}px`,
			label: `base unit ${WANT.spacingUnit}px`,
			wasOther: true,
			data: { px: WANT.spacingUnit },
		}
	}

	if (area === "type-scale" && (question.kind === "options" || question.kind === "scale")) {
		gave.add(area)
		return {
			...base,
			value: `${WANT.baseSize}px · ×${WANT.scaleRatio}`,
			label: `${WANT.baseSize}px · ×${WANT.scaleRatio}`,
			wasOther: true,
			data: { px: WANT.baseSize, ratio: WANT.scaleRatio },
		}
	}

	// One deliberate Skip: depth is delegated — the recommendation stands.
	if (area === "depth") return { ...base, value: "", skipped: true }

	// Everything else (neutral, surface, semantics, radius, boolean forks,
	// chips): take the recommendation, the way pressing straight through would.
	if (question.kind === "scale") {
		const step = question.steps?.[question.defaultStep ?? 0]
		return { ...base, value: step?.label ?? "", label: step?.label }
	}
	if (question.kind === "chips") {
		return { ...base, value: recommended?.label ?? "", label: recommended?.label }
	}
	if (question.kind === "text") {
		return { ...base, value: "Frond, a quiet plant journal" }
	}
	if (question.kind === "color") {
		// A colour question outside the scripted areas (semantics): recommended swatch.
		return {
			...base,
			value: recommended?.hex ?? recommended?.label ?? "",
			label: recommended?.label,
			data: recommended?.hex ? { hex: recommended.hex } : { none: true },
		}
	}
	// options / boolean / font without a scripted area: for a value-ish boolean
	// ("do you want an accent?") avoid the "no" side so the follow-up comes.
	const yes = options.find((option) => !/\bno\b|\bnone\b|skip|without/i.test(option.label)) ?? recommended
	return { ...base, value: yes?.id ?? "", label: yes?.label }
}

async function runOnce(run: number, backend: any, model?: string, effort?: string): Promise<string[]> {
	const problems: string[] = []
	const history: StoredQA[] = []
	const gave = new Set<string>()
	const askedAreas: string[] = []

	for (let turnIndex = 0; turnIndex < 24; turnIndex++) {
		const turn = await nextWizardTurn({
			workingDirectory: process.cwd(),
			description: DESCRIPTION,
			history,
			mode: "collaborative",
			backend,
			model,
			effort: effort as never,
		})

		if (turn.action === "ask") {
			const q = turn.question
			askedAreas.push(q.covers?.join("+") ?? "(untagged)")
			// Structural assertions on every question that reached "the screen".
			if (q.kind !== "assumptions" && (q.covers?.length ?? 0) > 1)
				problems.push(`bundled question survived validation: ${q.id}`)
			if (
				["brand-color", "secondary-color", "accent-color"].some((a) => q.covers?.includes(a)) &&
				!["color", "boolean"].includes(q.kind)
			) {
				problems.push(`colour area rendered as kind "${q.kind}": ${q.id}`)
			}
			const answer = scriptedAnswer(q, gave)
			history.push({ question: q, answer })
			console.log(
				`  [run ${run}] Q${history.length} (${q.kind}, covers ${q.covers?.join(",") ?? "-"}): ${q.question.slice(0, 70)}…`,
			)
			continue
		}

		// Finish: the echo contract, value by value.
		const f = turn.foundation
		console.log(`  [run ${run}] FINISH after ${history.length} questions`)
		const expectEqual = (name: string, got: unknown, want: unknown, when = true) => {
			if (!when) return
			if (
				typeof want === "number"
					? Math.abs(Number(got) - want) > 0.001
					: String(got ?? "").toLowerCase() !== String(want).toLowerCase()
			) {
				problems.push(`${name}: wanted ${want}, got ${got ?? "(nothing)"}`)
			}
		}
		expectEqual("brand", f.brand, WANT.brand, gave.has("brand-color"))
		expectEqual("secondary", f.secondary, WANT.secondary, gave.has("secondary-color"))
		expectEqual("accent", f.accent, WANT.accent, gave.has("accent-color"))
		expectEqual("displayFamily", f.displayFamily, WANT.displayFamily, gave.has("display-type"))
		expectEqual("bodyFamily", f.bodyFamily, WANT.bodyFamily, gave.has("body-type"))
		expectEqual("spacingUnit", f.spacingUnit, WANT.spacingUnit, gave.has("spacing"))
		expectEqual("baseSize", f.baseSize, WANT.baseSize, gave.has("type-scale"))
		expectEqual("scaleRatio", f.scaleRatio, WANT.scaleRatio, gave.has("type-scale"))
		for (const area of [
			"brand-color",
			"secondary-color",
			"accent-color",
			"display-type",
			"body-type",
			"spacing",
			"type-scale",
		]) {
			if (!gave.has(area))
				problems.push(
					`the interview never gave the scripted user a usable ${area} question (asked: ${askedAreas.join(" | ")})`,
				)
		}
		if (!f.decisions?.length) problems.push("finish carries no decisions log")
		const ledger = settledValues(history)
		console.log(`  [run ${run}] ledger entries: ${ledger.length}, decisions: ${f.decisions?.length ?? 0}`)
		return problems
	}
	problems.push("the interview never finished within 24 turns")
	return problems
}

async function main(): Promise<void> {
	const runs = Number(process.argv[2] ?? 2)
	const resolved = await resolveVerifyModel()
	if (!resolved) {
		console.log("SKIP: no verify model available (set CARET_VERIFY_MODEL / connect the backend)")
		return
	}
	console.log(`model: ${resolved.id} (effort ${resolved.effort ?? "default"}), ${runs} run(s)`)
	let failed = false
	try {
		for (let run = 1; run <= runs; run++) {
			const problems = await runOnce(run, resolved.backend, resolved.id, resolved.effort)
			if (problems.length) {
				failed = true
				console.log(`✗ run ${run}: ${problems.length} problem(s)`)
				for (const problem of problems) console.log(`   - ${problem}`)
			} else {
				console.log(`✓ run ${run}: every scripted value echoed into the finish`)
			}
		}
	} finally {
		await disposeBackends().catch(() => {})
	}
	if (failed) process.exitCode = 1
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})
