/**
 * The foundation interview.
 *
 * **The wizard** is the feature: the model runs the interview — minimal in
 * ai-led mode, exhaustive in collaborative mode — composing every question
 * from the widget vocabulary (`widgets.ts`), one validated turn at a time
 * (`conductor.ts`), finishing in a parameter proposal that Caret alone turns
 * into `foundation.json` (`finalize.ts`). Progress survives a crash
 * (`scratch.ts`).
 *
 * **The external-agent path** commits through `commit.ts` (`buildFoundation`),
 * assembling curated library pieces the agent's user pointed at.
 */
export { buildFoundation, type CommittedFoundation, IncompleteInterviewError } from "./commit"
export {
	bindSettledValues,
	COLLABORATIVE_QUESTION_CAP,
	COVERAGE_AREAS,
	type ConductorInput,
	checkValueEcho,
	coveredAreas,
	nextWizardTurn,
	QUESTION_CAP,
	questionCapFor,
	type SettledValue,
	settledValues,
	validateQuestion,
	type WizardMode,
	WizardTurnError,
} from "./conductor"
export { type FinalizedFoundation, finalizeProposal, ProposalError } from "./finalize"
export { clearWizardScratch, readWizardScratch, type WizardScratch, writeWizardScratch } from "./scratch"
export { type Decisions, type StepId, tagsFromDescription } from "./steps"
export {
	type FoundationProposal,
	normalizeHex,
	type ScaleStep,
	type SpecimenParams,
	type StoredQA,
	WIZARD_TURN_SCHEMA,
	type WidgetKind,
	type WizardAnswer,
	type WizardOption,
	type WizardQuestion,
	type WizardTurn,
} from "./widgets"
