/**
 * One interview, from the opening screen to the finish.
 *
 * Holds the record of answers plus what is on screen (the current question,
 * an error, the finish's words), saves it all after every change through
 * `persist`, and decides what happens next. What the screen shows is worked
 * out from the saved progress alone (`view`), so reopening Caret shows exactly
 * the same screen without asking the model anything.
 *
 * Errors are saved too: a failed turn shows the error screen, and it is still
 * there after quitting and reopening, with every answer kept.
 */
import type { AreaQuestion } from "./answers"
import { acceptAnswer } from "./answers"
import { AREA_ORDER, type AreaId, describeValue } from "./areas"
import {
	askArea,
	askFill,
	askOpening,
	askProse,
	type CallContext,
	contextKeyFor,
	InterviewTurnError,
	type Prose,
	type Stage,
} from "./model-calls"
import {
	type AreaAnswer,
	applyAnswer,
	applyOpening,
	deriveState,
	type InterviewMode,
	type InterviewRecord,
	type InterviewState,
	newRecord,
	type OpeningStatement,
	stepBack,
	type Verdict,
} from "./state"
import type { FoundationProposal } from "./widgets"

/** Everything saved about an interview in progress (`.caret/.interview.json`). */
export interface SessionScratch {
	version: 2
	record: InterviewRecord
	/** The opening screen's one-line introduction. */
	openingQuestion?: string
	/** The latest question written for each topic; Back shows it again without asking the model. */
	questions: Partial<Record<AreaId, AreaQuestion>>
	/** What is on screen: the opening, a topic's question, or the finish. */
	pending: "opening" | AreaId | "finish" | null
	/** The answer to preselect after Back. */
	previous?: AreaAnswer
	error?: { stage: Stage; message: string; refusal?: boolean }
	prose?: Prose
	/** "Just finish it" was pressed; Back from the finish returns to where it was pressed. */
	finishedEarly?: boolean
}

export type SessionView =
	| { phase: "opening"; question: string; statements: OpeningStatement[]; state: InterviewState }
	| { phase: "question"; question: AreaQuestion; previous?: AreaAnswer; state: InterviewState; canBack: boolean }
	| { phase: "finish"; proposal: FoundationProposal; state: InterviewState; finishedEarly: boolean }
	| { phase: "error"; stage: Stage; message: string; canFinish: boolean; state: InterviewState }

export interface SessionDeps extends Omit<CallContext, "onAttempt"> {
	/** Saves the progress. Called after every change, before the new screen is shown. */
	persist(scratch: SessionScratch): Promise<void>
	onAttempt?: (attempt: number, max: number) => void
	/** Whether a file named on the opening screen exists in the project ("Use what my app already has"). */
	sourceExists?: (relativePath: string) => Promise<boolean>
}

/** The foundation the finish screen shows and saving writes: values from the answers, words from the model. */
export function buildProposal(state: InterviewState, prose: Prose): FoundationProposal {
	if (!state.values) throw new Error("The interview isn't finished: some topics have no answer.")
	return {
		...state.values,
		rule: prose.rule,
		summary: prose.summary,
		decisions: AREA_ORDER.map((area) => ({
			area,
			choice: describeValue(area, state.areas[area].value as NonNullable<InterviewState["areas"][AreaId]["value"]>),
			reason: prose.reasons[area],
		})),
	}
}

/** What the screen shows for saved progress. Pure: never calls the model. */
export function viewOf(scratch: SessionScratch): SessionView | null {
	const state = deriveState(scratch.record)
	if (scratch.error) {
		return {
			phase: "error",
			stage: scratch.error.stage,
			message: scratch.error.message,
			canFinish: scratch.record.answers.length > 0,
			state,
		}
	}
	if (scratch.pending === "opening" && scratch.record.opening) {
		return {
			phase: "opening",
			question: scratch.openingQuestion ?? "",
			statements: scratch.record.opening.statements,
			state,
		}
	}
	if (scratch.pending === "finish" && scratch.prose && state.values) {
		return {
			phase: "finish",
			proposal: buildProposal(state, scratch.prose),
			state,
			finishedEarly: scratch.finishedEarly === true,
		}
	}
	if (scratch.pending && scratch.pending !== "opening" && scratch.pending !== "finish") {
		const question = scratch.questions[scratch.pending]
		if (question && state.next === scratch.pending) {
			return {
				phase: "question",
				question,
				previous: scratch.previous?.area === scratch.pending ? scratch.previous : undefined,
				state,
				canBack: scratch.record.answers.length > 0 || (scratch.record.opening?.statements.length ?? 0) > 0,
			}
		}
	}
	return null
}

export class InterviewSession {
	constructor(
		private scratch: SessionScratch,
		private readonly deps: SessionDeps,
	) {}

	/** Starts a new interview and runs until the first screen is ready. */
	static async start(mode: InterviewMode, description: string, deps: SessionDeps): Promise<InterviewSession> {
		const session = new InterviewSession(
			{ version: 2, record: newRecord(mode, description), questions: {}, pending: null },
			deps,
		)
		await session.save()
		await session.advance()
		return session
	}

	get saved(): SessionScratch {
		return this.scratch
	}

	view(): SessionView | null {
		return viewOf(this.scratch)
	}

	/** The answers on the opening screen ("Not quite" lines, with what is true instead). */
	async answerOpening(verdicts: Verdict[]): Promise<SessionView | null> {
		if (this.scratch.pending !== "opening") throw new Error("The opening screen is not on screen.")
		this.scratch = { ...this.scratch, record: applyOpening(this.scratch.record, verdicts), previous: undefined }
		await this.save()
		return this.advance()
	}

	/** An answer to the question on screen, as the screen built it. Checked again here. */
	async answer(answer: AreaAnswer): Promise<SessionView | null> {
		const area = this.scratch.pending
		const question = area && area !== "opening" && area !== "finish" ? this.scratch.questions[area] : undefined
		if (!question) throw new Error("There is no question on screen to answer.")
		this.scratch = { ...this.scratch, record: acceptAnswer(this.scratch.record, question, answer), previous: undefined }
		await this.save()
		return this.advance()
	}

	/** Back: the previous screen, with the answer given there selected. Never asks the model. */
	async back(): Promise<SessionView | null> {
		let record = this.scratch.record
		let previous: AreaAnswer | undefined
		if (this.scratch.finishedEarly) {
			record = { ...record, answers: record.answers.filter((a) => a.via !== "finish-now") }
		} else {
			previous = record.answers.at(-1)
			record = stepBack(record)
		}
		const state = deriveState(record)
		const pending: SessionScratch["pending"] = state.stage === "opening" ? "opening" : state.next
		this.scratch = {
			...this.scratch,
			record,
			pending,
			previous,
			error: undefined,
			prose: undefined,
			finishedEarly: false,
		}
		await this.save()
		// The question shown before is reused if what it was written from still holds.
		return this.advance()
	}

	/** "Try again" on the error screen. */
	async retry(): Promise<SessionView | null> {
		const stage = this.scratch.error?.stage
		this.scratch = { ...this.scratch, error: undefined }
		await this.save()
		return stage === "fill" ? this.finishNow() : this.advance()
	}

	/** "Just finish it": one model call fills every remaining topic, then the finish. */
	async finishNow(): Promise<SessionView | null> {
		let record = this.scratch.record
		if (record.opening && !record.opening.verdicts) record = applyOpening(record, [])
		const state = deriveState(record)
		if (state.next) {
			try {
				const values = await askFill(record, this.context())
				for (const area of AREA_ORDER) {
					const value = values.get(area)
					if (!value || deriveState(record).next !== area) continue
					record = applyAnswer(record, {
						area,
						questionId: "finish-now",
						via: "finish-now",
						value,
						reason: "Filled in when you pressed Just finish it.",
					})
				}
			} catch (err) {
				return this.fail(err, "fill")
			}
		}
		this.scratch = { ...this.scratch, record, finishedEarly: true, previous: undefined, error: undefined }
		await this.save()
		return this.advance()
	}

	/** Runs the next model call the interview needs, until a screen is ready for the user. */
	private async advance(): Promise<SessionView | null> {
		const ctx = this.context()
		try {
			let record = this.scratch.record
			if (!record.opening) {
				const opening = await askOpening(record, ctx, this.deps.sourceExists)
				record = { ...record, opening: { questionId: "opening", statements: opening.statements } }
				// Nothing to confirm: the screen is skipped.
				if (opening.statements.length === 0) record = applyOpening(record, [])
				this.scratch = { ...this.scratch, record, openingQuestion: opening.question }
				await this.save()
			}
			const state = deriveState(record)
			if (state.stage === "opening") {
				this.scratch = { ...this.scratch, pending: "opening" }
				await this.save()
				return this.view()
			}
			if (state.next) {
				const cached = this.scratch.questions[state.next]
				const question =
					cached && cached.contextKey === contextKeyFor(record, state.next)
						? cached
						: await askArea(record, state.next, ctx)
				this.scratch = {
					...this.scratch,
					questions: { ...this.scratch.questions, [state.next]: question },
					pending: state.next,
				}
				await this.save()
				return this.view()
			}
			const prose = this.scratch.prose ?? (await askProse(record, ctx))
			this.scratch = { ...this.scratch, prose, pending: "finish" }
			await this.save()
			return this.view()
		} catch (err) {
			return this.fail(err)
		}
	}

	private async fail(err: unknown, stage?: Stage): Promise<SessionView | null> {
		if (this.deps.signal?.aborted) throw err
		const state = deriveState(this.scratch.record)
		const error =
			err instanceof InterviewTurnError
				? { stage: err.stage, message: err.message, refusal: err.refusal }
				: { stage: stage ?? state.next ?? "prose", message: err instanceof Error ? err.message : String(err) }
		this.deps.log?.(`[interview] turn failed at ${error.stage}: ${error.message}`)
		this.scratch = { ...this.scratch, error }
		await this.save()
		return this.view()
	}

	private context(): CallContext {
		return { ...this.deps }
	}

	private save(): Promise<void> {
		return this.deps.persist(this.scratch)
	}
}
