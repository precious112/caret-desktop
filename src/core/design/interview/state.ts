/**
 * The interview's record of what you answered, and the one function that
 * works out everything from it: which topics are done, which comes next, what
 * the Covering list and So far show, the preview, and the final values.
 *
 * The engine and the screen both call `deriveState` on the same record, so
 * they cannot disagree. (They used to: the screen worked out So far on its
 * own and showed the wrong colour.) Every answer is stored as an exact value,
 * never as text that has to be read back.
 *
 * Shared with the screen: no Node, no `@/` aliases.
 */
import { closeMatch, parseHex } from "../defaults/colour"
import {
	AREA_ORDER,
	AREAS,
	type AreaId,
	type AreaValue,
	type AreaValues,
	describeValue,
	isAreaId,
	isAreaValue,
	specOf,
	swatchesOf,
} from "./areas"
import type { FoundationProposal, SpecimenParams } from "./widgets"

/** "Design a new look with the AI" starts from a description; "Use what my app already has" from your code. */
export type InterviewMode = "collaborative" | "from-app"

/** One line on the opening screen: a conclusion about one topic, with its exact value. */
export interface OpeningStatement<A extends AreaId = AreaId> {
	id: string
	area: A
	value: AreaValue<A>
	text: string
	/** Where in the app's code it was read from ("Use what my app already has" only). */
	source?: string
}

export type Verdict = { statementId: string; verdict: "confirmed" } | { statementId: string; verdict: "corrected"; note: string }

/** How an answer was given. "finish-now" is a topic filled in when "Just finish it" was pressed. */
export type AnswerVia = "option" | "own" | "skip" | "finish-now"

export interface AreaAnswer<A extends AreaId = AreaId> {
	area: A
	questionId: string
	via: AnswerVia
	optionId?: string
	value: AreaValue<A>
	/** The reason shown with the chosen option, kept for the finish's decisions. */
	reason?: string
}

/** Everything the interview has been told. Saved after every change. */
export interface InterviewRecord {
	version: 2
	mode: InterviewMode
	description: string
	opening?: { questionId: string; statements: OpeningStatement[]; verdicts?: Verdict[] }
	answers: AreaAnswer[]
}

export type AreaStatusKind = "open" | "confirmed" | "answered" | "skipped"

export interface AreaStatus {
	area: AreaId
	label: string
	status: AreaStatusKind
	value?: AreaValue
	via?: AnswerVia | "opening"
	/** Where an opening statement was read from. */
	source?: string
	/** What the user typed when they pressed "Not quite" on this topic's opening line. */
	correction?: string
	/** Why Caret reopened a colour agreed on the opening screen: it matched another colour. */
	clash?: string
}

export interface SoFarRow {
	area: AreaId
	term: string
	text: string
	swatches: string[]
}

/** The final foundation's values: everything except the summary, the rule and the reasons, which the model writes. */
export type ProposalValues = Omit<FoundationProposal, "rule" | "summary" | "decisions" | "vibeTags">

export interface InterviewState {
	stage: "opening" | "asking" | "ready"
	areas: Record<AreaId, AreaStatus>
	/** The topic to ask next, or null when every topic is settled. */
	next: AreaId | null
	/** "Question 3 of 9": `index` is the next question's number, `total` the questions this interview asks. */
	position: { index: number; total: number }
	coverage: Array<{ area: AreaId; label: string; status: AreaStatusKind; done: boolean }>
	soFar: SoFarRow[]
	/** The live preview built from every settled topic. */
	spec: SpecimenParams
	/** The final values, once every topic is settled; otherwise null. */
	values: ProposalValues | null
}

export class InterviewRuleError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "InterviewRuleError"
	}
}

export function newRecord(mode: InterviewMode, description: string): InterviewRecord {
	return { version: 2, mode, description, answers: [] }
}

/** Whether a confirmed opening line may settle its topic in this mode. */
export function openingMaySettle(mode: InterviewMode, area: AreaId): boolean {
	return mode === "from-app" || (AREAS[area].confirmable && !AREAS[area].mustAsk)
}

function openingStatus(
	record: InterviewRecord,
	area: AreaId,
): Pick<AreaStatus, "status" | "value" | "source" | "correction"> | null {
	const opening = record.opening
	if (!opening?.verdicts) return null
	const statement = opening.statements.find((s) => s.area === area)
	if (!statement) return null
	const verdict = opening.verdicts.find((v) => v.statementId === statement.id)
	if (verdict?.verdict === "corrected") return { status: "open", correction: verdict.note }
	if (!openingMaySettle(record.mode, area)) return null
	return { status: "confirmed", value: statement.value, source: statement.source }
}

export function deriveState(record: InterviewRecord): InterviewState {
	const areas = {} as Record<AreaId, AreaStatus>
	for (const area of AREA_ORDER) {
		const answer = record.answers.find((a) => a.area === area)
		const fromOpening = openingStatus(record, area)
		if (answer) {
			areas[area] = {
				area,
				label: AREAS[area].label,
				status: answer.via === "option" || answer.via === "own" ? "answered" : "skipped",
				value: answer.value,
				via: answer.via,
				correction: fromOpening?.correction,
			}
		} else if (fromOpening?.status === "confirmed") {
			areas[area] = {
				area,
				label: AREAS[area].label,
				status: "confirmed",
				value: fromOpening.value,
				via: "opening",
				source: fromOpening.source,
			}
		} else {
			areas[area] = { area, label: AREAS[area].label, status: "open", correction: fromOpening?.correction }
		}
	}

	reopenTwins(areas)

	const openingDone = record.opening?.verdicts !== undefined
	const next = openingDone ? (AREA_ORDER.find((area) => areas[area].status === "open") ?? null) : null
	const stage = !openingDone ? "opening" : next ? "asking" : "ready"
	const asked = AREA_ORDER.filter((area) => areas[area].status !== "confirmed").length

	const settled = AREA_ORDER.filter((area) => areas[area].value !== undefined)
	const spec: SpecimenParams = {}
	for (const area of settled) {
		// The preview's one colour is the brand: supporting and accent answers preview on their own cards only.
		if (area === "secondary-color" || area === "accent-color") continue
		Object.assign(spec, specOf(area, areas[area].value as AreaValue))
	}

	return {
		stage,
		areas,
		next,
		position: { index: Math.min(record.answers.length + 1, asked), total: asked },
		coverage: AREA_ORDER.map((area) => ({
			area,
			label: AREAS[area].label,
			status: areas[area].status,
			done: areas[area].status !== "open",
		})),
		soFar: settled.map((area) => ({
			area,
			term: AREAS[area].term,
			text: describeValue(area, areas[area].value as AreaValue),
			swatches: swatchesOf(area, areas[area].value as AreaValue),
		})),
		spec,
		values: next === null && openingDone ? assembleValues(areas) : null,
	}
}

/**
 * A supporting or accent colour agreed on the opening screen that turns out
 * to be the brand colour's twin (or, for the accent, the supporting colour's)
 * is reopened, so it gets its own question. Field run: the app's supporting
 * colour was #3730a3, the user then typed #3730a3 as the brand, and the
 * foundation would have had the same colour twice.
 */
function reopenTwins(areas: Record<AreaId, AreaStatus>): void {
	const hexOf = (area: AreaId) => (areas[area].value as { hex?: string } | undefined)?.hex
	const near = (a?: string, b?: string) => {
		const x = a ? parseHex(a) : null
		const y = b ? parseHex(b) : null
		return !!x && !!y && closeMatch(x, y) !== null
	}
	const bare = (area: AreaId) => AREAS[area].label.replace(/^(a|an|the) /, "")
	const reopen = (area: AreaId, twin: AreaId) => {
		const hex = hexOf(twin) as string
		areas[area] = {
			area,
			label: AREAS[area].label,
			status: "open",
			clash: `The app's ${bare(area)} is the same as the ${bare(twin)}, ${hex}. Offer colours that look clearly different from it.`,
		}
	}
	if (areas["secondary-color"].status === "confirmed" && near(hexOf("secondary-color"), hexOf("brand-color"))) {
		reopen("secondary-color", "brand-color")
	}
	if (areas["accent-color"].status === "confirmed") {
		if (near(hexOf("accent-color"), hexOf("brand-color"))) reopen("accent-color", "brand-color")
		else if (near(hexOf("accent-color"), hexOf("secondary-color"))) reopen("accent-color", "secondary-color")
	}
}

/** Every topic's value, placed in the foundation's fields. Nothing is guessed or parsed. */
function assembleValues(areas: Record<AreaId, AreaStatus>): ProposalValues {
	const value = <A extends AreaId>(area: A) => areas[area].value as AreaValues[A]
	const secondary = value("secondary-color")
	const accent = value("accent-color")
	const semantics = value("semantics")
	return {
		surface: value("surface").surface,
		displayFamily: value("display-type").family,
		bodyFamily: value("body-type").family,
		baseSize: value("type-scale").baseSize,
		scaleRatio: value("type-scale").scaleRatio,
		brand: value("brand-color").hex,
		...("hex" in secondary ? { secondary: secondary.hex } : {}),
		...("hex" in accent ? { accent: accent.hex } : {}),
		neutral: value("neutral").neutral,
		semantic: { success: semantics.success, warning: semantics.warning, error: semantics.error, info: semantics.info },
		spacingUnit: value("spacing").spacingUnit,
		radiusCharacter: value("radius").radiusCharacter,
		elevationCharacter: value("depth").elevation,
	}
}

/** Records the opening screen's verdicts. Every statement gets one; unknown ids are refused. */
export function applyOpening(record: InterviewRecord, verdicts: Verdict[]): InterviewRecord {
	if (!record.opening) throw new InterviewRuleError("There is no opening screen to answer.")
	if (record.opening.verdicts) throw new InterviewRuleError("The opening screen was already answered.")
	const ids = new Set(record.opening.statements.map((s) => s.id))
	const seen = new Set<string>()
	for (const verdict of verdicts) {
		if (!ids.has(verdict.statementId)) throw new InterviewRuleError(`Unknown statement "${verdict.statementId}".`)
		if (seen.has(verdict.statementId)) throw new InterviewRuleError(`Statement "${verdict.statementId}" answered twice.`)
		if (verdict.verdict === "corrected" && !verdict.note.trim()) {
			throw new InterviewRuleError("A correction needs the words of what is true instead.")
		}
		seen.add(verdict.statementId)
	}
	// A statement left out is agreed: everything on that screen starts agreed.
	const complete: Verdict[] = record.opening.statements.map(
		(s) => verdicts.find((v) => v.statementId === s.id) ?? { statementId: s.id, verdict: "confirmed" },
	)
	return { ...record, opening: { ...record.opening, verdicts: complete } }
}

/** Records one answer. It must be for the topic that comes next, with a valid value. */
export function applyAnswer(record: InterviewRecord, answer: AreaAnswer): InterviewRecord {
	const state = deriveState(record)
	if (state.stage === "opening") throw new InterviewRuleError("The opening screen has not been answered yet.")
	if (!isAreaId(answer.area)) throw new InterviewRuleError(`"${String(answer.area)}" is not an interview topic.`)
	if (answer.area !== state.next) {
		throw new InterviewRuleError(
			state.next
				? `This answer is for "${answer.area}", but the question on screen is about "${state.next}".`
				: "Every topic is already settled.",
		)
	}
	if (!isAreaValue(answer.area, answer.value)) {
		throw new InterviewRuleError(`${JSON.stringify(answer.value)} is not a valid answer about ${AREAS[answer.area].label}.`)
	}
	return { ...record, answers: [...record.answers, answer] }
}

/** Back: undoes the last answer, or reopens the opening screen when nothing has been answered since. */
export function stepBack(record: InterviewRecord): InterviewRecord {
	if (record.answers.length) return { ...record, answers: record.answers.slice(0, -1) }
	if (record.opening?.verdicts) return { ...record, opening: { ...record.opening, verdicts: undefined } }
	return record
}
