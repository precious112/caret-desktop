/**
 * The AI interview that sets up a project's design foundation.
 *
 * Caret runs the interview: the topics, their order and how each is shown
 * (`areas.ts`). The model only writes the opening screen, one question per
 * topic, the "Just finish it" values and the finish's words (`model-calls.ts`).
 * Every answer is an exact value in one record (`state.ts`), checked the same
 * way by the screen and the engine (`answers.ts`). `session.ts` runs one
 * interview and saves it after every change (`scratch.ts`); `finalize.ts`
 * turns the finished values into foundation.json.
 */
export { type AreaOption, type AreaQuestion, acceptAnswer, type OwnRaw, optionAnswer, ownAnswer, skipAnswer } from "./answers"
export { AREA_ORDER, AREAS, type AreaId, type AreaValue, describeValue, isAreaValue, RANGES } from "./areas"
export { type FinalizedFoundation, finalizeProposal, ProposalError } from "./finalize"
export { InterviewTurnError } from "./model-calls"
export { clearInterviewScratch, readInterviewScratch, writeInterviewScratch } from "./scratch"
export { buildProposal, InterviewSession, type SessionScratch, type SessionView, viewOf } from "./session"
export {
	type AreaAnswer,
	deriveState,
	type InterviewMode,
	type InterviewRecord,
	type InterviewState,
	type OpeningStatement,
	type Verdict,
} from "./state"
export { type FoundationProposal, normalizeHex, type SpecimenParams } from "./widgets"
