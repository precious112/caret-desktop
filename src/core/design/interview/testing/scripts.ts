/**
 * Scripted interviews: what a person does on each screen, written down once.
 *
 * The same scripts drive the live recording runs (scripts/record-interview.ts),
 * the logic tests that replay those recordings, and the real-app tests, so all
 * three exercise exactly the same paths.
 */
import { type AreaQuestion, type OwnRaw, optionAnswer, ownAnswer, skipAnswer } from "../answers"
import type { AreaId } from "../areas"
import type { InterviewSession, SessionView } from "../session"
import type { AreaAnswer, InterviewMode, Verdict } from "../state"

/** What to do on one question. With no step, the recommended option is kept and Continue pressed. */
export type ScriptStep = { option: number } | { skip: true } | { own: OwnRaw } | { none: true }

export interface InterviewScript {
	name: string
	mode: InterviewMode
	description: string
	/** Lines to correct on the opening screen ("Not quite"), with what is true instead. */
	correct?: Partial<Record<AreaId, string>>
	steps?: Partial<Record<AreaId, ScriptStep>>
	/** After answering this topic, press Back once and answer it again with `backStep`. */
	backAfter?: AreaId
	backStep?: ScriptStep
	/** Press "Just finish it" when this topic's question is on screen. */
	finishAt?: AreaId
}

export const ARGUS =
	"Argus is an open-source monitoring tool for servers and applications, with an AI investigator built in. " +
	"You run it on your own infrastructure with one Docker command, then add its SDK to your apps. It watches " +
	"metrics, containers and processes, and when something looks wrong it investigates: it correlates metrics, " +
	"logs and events and explains the likely root cause in plain language. Free and MIT licensed; your data " +
	"never leaves your servers. The landing page should send people to the GitHub repo and the docs."

export const BRAND = "#28a4f0"

export const SCRIPTS: Record<string, InterviewScript> = {
	straight: {
		name: "straight",
		mode: "collaborative",
		description: ARGUS,
		steps: { "brand-color": { own: { kind: "hex", hex: BRAND } } },
	},
	escapes: {
		name: "escapes",
		mode: "collaborative",
		description: ARGUS,
		correct: { radius: "Corners are square, not rounded." },
		steps: {
			"brand-color": { skip: true },
			"body-type": { own: { kind: "font", family: "Libre Baskerville" } },
			"type-scale": { own: { kind: "size", px: "18", ratio: "1.2" } },
			"secondary-color": { none: true },
			"accent-color": { option: 0 },
		},
		backAfter: "accent-color",
		backStep: { skip: true },
	},
	"finish-early": {
		name: "finish-early",
		mode: "collaborative",
		description: ARGUS,
		steps: { "brand-color": { own: { kind: "hex", hex: BRAND } } },
		finishAt: "secondary-color",
	},
}

/** The answer a script step gives to a question, built exactly as the screen builds it. */
export function answerFor(question: AreaQuestion, step: ScriptStep | undefined): AreaAnswer {
	if (!step) {
		const answer = optionAnswer(question, question.recommendedId)
		if (!answer) throw new Error(`${question.id} has no recommended option`)
		return answer
	}
	if ("skip" in step) return skipAnswer(question)
	if ("none" in step) {
		const none = question.options.find((o) => "none" in (o.value as object))
		if (!none) throw new Error(`${question.id} offers no None option`)
		return optionAnswer(question, none.id) as AreaAnswer
	}
	if ("option" in step) {
		const options = question.options.filter((o) => !("none" in (o.value as object)))
		const chosen = options[Math.min(step.option, options.length - 1)]
		return optionAnswer(question, chosen.id) as AreaAnswer
	}
	const result = ownAnswer(question, step.own)
	if (result.kind !== "answer") throw new Error(`typing ${JSON.stringify(step.own)} on ${question.id} was ${result.kind}`)
	return result.answer
}

/** The opening screen's verdicts for a script. */
export function verdictsFor(script: InterviewScript, view: Extract<SessionView, { phase: "opening" }>): Verdict[] {
	return view.statements.map((statement) => {
		const note = script.correct?.[statement.area]
		return note
			? { statementId: statement.id, verdict: "corrected", note }
			: { statementId: statement.id, verdict: "confirmed" }
	})
}

/**
 * Runs a script on a session, the way a person clicking through would, and
 * returns the last screen (the finish, or an error). `onScreen` sees every
 * screen on the way, for checks.
 */
export async function runScript(
	session: InterviewSession,
	script: InterviewScript,
	onScreen?: (view: SessionView) => void,
): Promise<SessionView> {
	let backDone = false
	let backPending = false
	let finished = false
	for (let turns = 0; turns < 60; turns++) {
		const view = session.view()
		if (!view) throw new Error("the session has nothing on screen")
		onScreen?.(view)
		if (view.phase === "finish" || view.phase === "error") return view
		if (view.phase === "opening") {
			await session.answerOpening(verdictsFor(script, view))
			continue
		}
		const area = view.question.area
		if (script.finishAt === area && !finished) {
			finished = true
			await session.finishNow()
			continue
		}
		const step = backPending ? script.backStep : script.steps?.[area]
		backPending = false
		await session.answer(answerFor(view.question, step))
		if (script.backAfter === area && !backDone) {
			backDone = true
			backPending = true
			await session.back()
		}
	}
	throw new Error(`the script "${script.name}" did not reach the finish`)
}
