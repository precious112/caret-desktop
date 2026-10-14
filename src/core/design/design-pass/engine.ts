/**
 * The Design pass: plan → check every section → remove the most reported
 * habits → defend or drop the rest → ask the user what only the AI defended →
 * polish with a seasoned designer → hand the build turn a finished plan.
 *
 * No step is ever skipped or cut short, and nothing here has a time limit: a
 * limit would make the result depend on how fast a provider happened to be that
 * day, and leave a system nobody tested. A step that keeps failing fails the
 * pass with its name on it, and the user decides what to do next.
 *
 * Every model call goes through {@link PassModels}, so the whole loop can be run
 * against scripted answers in tests.
 */
import type { ToolCallRecord } from "../agent/backend"
import {
	applyVerdicts,
	type Defence,
	forJudge,
	judgeOrder,
	type Screened,
	screenDefences,
	selectQuestions,
	type Verdict,
} from "./defence"
import {
	type Approved,
	applyLevels,
	type CheckerMatch,
	type Finding,
	type Item,
	isBanned,
	normalize,
	valueFindings,
	verifyMatches,
} from "./findings"
import { kindOfLibraryTool, libraryOfTool } from "./libraries"
import {
	type DesignPlan,
	mergeSections,
	normalizePlan,
	normalizeSection,
	PLAN_SCHEMA,
	type PlanSection,
	sectionKey,
} from "./plan"
import {
	CHECK_SCHEMA,
	COMPONENT_JUDGE_SCHEMA,
	checkPrompt,
	componentJudgePrompt,
	JUDGE_SCHEMA,
	JUSTIFY_SCHEMA,
	judgePrompt,
	justifyPrompt,
	type PassContext,
	planPrompt,
	REVISE_SCHEMA,
	type RemovedPart,
	revisePrompt,
	TASTE_SCHEMA,
	type TasteTools,
	tastePrompt,
} from "./prompts"

export interface PassModels {
	/** The user's main model: plans, defends, rewrites. */
	main<T>(prompt: string, schema: Record<string, unknown>): Promise<T>
	/** The helper model: checks and judges. */
	helper<T>(prompt: string, schema: Record<string, unknown>): Promise<T>
	/** The main model with the libraries' tools switched on. */
	designer<T>(prompt: string, schema: Record<string, unknown>): Promise<{ value: T; toolCalls: ToolCallRecord[] }>
}

export type PassStep = "plan" | "check" | "questions" | "polish"

export interface PassProgress {
	step: PassStep
	state: "active" | "done"
	/** Short detail for the step's row: "removed 7", "looked at 4 reference pages". */
	detail?: string
}

/** One question for the user: a part only the AI's own argument supports. */
export interface DesignQuestion {
	section: string
	/** The part, in the plan's own words. */
	quote: string
	habit: string
	/** The AI's one-line reason for keeping it. */
	reason: string
}

export type QuestionAnswer = "keep" | "remove"

export interface ComponentPick {
	/** "@registry/name" or "21st:<id>". */
	component: string
	section: string
	job: string
	whyNotPlain: string
	/** The judge's one sentence. */
	verdict?: string
}

export interface DesignPassDeps {
	models: PassModels
	context: PassContext
	approved: Approved
	/** The libraries usable right now. Asked at the polish step, so a library that rested meanwhile is left out. */
	tasteTools(): TasteTools
	/** Shows the questions card and waits — no default, no timer. One answer per question, in order. */
	ask(questions: DesignQuestion[]): Promise<QuestionAnswer[]>
	progress(update: PassProgress): void
	/** Every tool call the designer made, for library health. */
	onToolCalls?(calls: ToolCallRecord[]): void
	signal?: AbortSignal
}

export interface DesignPassResult {
	plan: DesignPlan
	/** The plan as first written, before any check. */
	original: DesignPlan
	removed: RemovedPart[]
	/** Level-3 parts that stayed, and why. */
	kept: Array<{ item: Item; by: "your-words" | "you" }>
	questions: Array<{ question: DesignQuestion; answer: QuestionAnswer }>
	/** Components the designer chose and the judge agreed with. */
	components: ComponentPick[]
	/** Components the judge turned down. */
	declined: ComponentPick[]
	references: Array<{ what: string; learned: string }>
	refinements: Array<{ section: string; what: string; why: string }>
	stats: PassStats
}

export interface PassStats {
	/** Ban rounds before the questions, after the first check. */
	rounds: number
	/** Habit ids that were banned (level 1 or 2) at any point. */
	bannedHabits: string[]
	/** Habit ids that reached the defence step. */
	defendedHabits: string[]
	/** Checker claims thrown out (unknown habit, quote not in the plan). */
	rejectedClaims: number
	/** Milliseconds per step. */
	timings: Partial<Record<PassStep, number>>
}

export class DesignPassError extends Error {
	constructor(
		readonly step: PassStep,
		message: string,
	) {
		super(message)
		this.name = "DesignPassError"
	}
}

/** How many times an AI call is tried before its step fails. */
export const ATTEMPTS = 3
/** Ban rounds: the first check's rewrite plus this many more. */
export const MAX_BAN_ROUNDS = 2

class Cancelled extends Error {
	constructor() {
		super("The Design pass was cancelled.")
		this.name = "AbortError"
	}
}

export async function runDesignPass(deps: DesignPassDeps): Promise<DesignPassResult> {
	return new DesignPass(deps).run()
}

class DesignPass {
	private readonly checked = new Map<string, CheckerMatch[]>()
	private readonly removed: RemovedPart[] = []
	private readonly banned = new Set<string>()
	private rejectedClaims = 0
	private readonly timings: Partial<Record<PassStep, number>> = {}

	constructor(private readonly deps: DesignPassDeps) {}

	async run(): Promise<DesignPassResult> {
		const { deps } = this

		// 1. Plan, section by section.
		let plan = await this.step("plan", async () => {
			const raw = await this.retry("plan", () => deps.models.main<unknown>(planPrompt(deps.context), PLAN_SCHEMA))
			try {
				return normalizePlan(raw)
			} catch (error) {
				throw new DesignPassError("plan", `The plan came back unusable: ${messageOf(error)}`)
			}
		})
		const original = plan

		// 2–4. Check, remove the banned, defend the rest.
		let questions: Array<{ question: DesignQuestion; answer: QuestionAnswer }> = []
		let kept: DesignPassResult["kept"] = []
		let rounds = 0
		const defended = new Set<string>()
		const checkStarted = Date.now()
		deps.progress({ step: "check", state: "active" })
		let items: Item[]
		;({ plan, items, rounds } = await this.removeBanned(plan, MAX_BAN_ROUNDS))

		const level3 = items.filter((item) => item.level === 3)
		for (const item of level3) for (const habit of item.habits) defended.add(habit)
		let rework: Item[] = []
		let ask: Screened[] = []
		if (level3.length) {
			const screened = await this.defend(plan, level3)
			const selected = selectQuestions(screened)
			ask = selected.ask
			rework = selected.rework.map((s) => s.item)
			kept = selected.kept.map((s) => ({ item: s.item, by: "your-words" as const }))
		}
		this.timings.check = Date.now() - checkStarted
		deps.progress({ step: "check", state: "done", detail: this.removedDetail(rework.length) })

		// 5. The user decides what only the AI could defend.
		if (ask.length) {
			const started = Date.now()
			const asked = ask.map((s) => ({
				section: s.item.section,
				quote: s.item.quote,
				habit: s.item.names[0] ?? s.item.habits[0],
				reason: s.defence?.reason?.trim() || "No reason given.",
			}))
			deps.progress({
				step: "questions",
				state: "active",
				detail: `${asked.length} design question${asked.length === 1 ? "" : "s"}`,
			})
			const answers = await deps.ask(asked)
			this.throwIfCancelled()
			questions = asked.map((question, index) => ({ question, answer: answers[index] === "keep" ? "keep" : "remove" }))
			ask.forEach((s, index) => {
				if (questions[index].answer === "keep") kept.push({ item: s.item, by: "you" })
				else rework.push(s.item)
			})
			this.timings.questions = Date.now() - started
			const removedCount = questions.filter((q) => q.answer === "remove").length
			deps.progress({ step: "questions", state: "done", detail: removedCount ? `removed ${removedCount}` : "kept all" })
		}

		// Everything dropped, over the cap, or removed by the user goes back once,
		// and the rework is re-checked for bans.
		if (rework.length) {
			const reworked = await this.revise(plan, rework)
			if (reworked) {
				;({ plan } = await this.removeBanned(reworked, MAX_BAN_ROUNDS))
			} else {
				throw new DesignPassError("check", "The AI could not rework the parts that had to go.")
			}
		}

		// 6. Taste: a seasoned designer refines every section.
		const taste = await this.step("polish", () => this.polish(plan))

		return {
			plan: taste.plan,
			original,
			removed: this.removed,
			kept,
			questions,
			components: taste.components,
			declined: taste.declined,
			references: taste.references,
			refinements: taste.refinements,
			stats: {
				rounds,
				bannedHabits: [...this.banned],
				defendedHabits: [...defended],
				rejectedClaims: this.rejectedClaims,
				timings: this.timings,
			},
		}
	}

	/** Checks, then rewrites banned parts until none are left or the rounds run out. */
	private async removeBanned(
		plan: DesignPlan,
		maxRounds: number,
	): Promise<{ plan: DesignPlan; items: Item[]; rounds: number }> {
		let current = plan
		let rounds = 0
		for (;;) {
			const items = await this.check(current)
			const banned = items.filter(isBanned)
			for (const item of banned) for (const habit of item.habits) this.banned.add(habit)
			if (!banned.length || rounds >= maxRounds) return { plan: current, items, rounds }
			const next = await this.revise(current, banned)
			if (!next) throw new DesignPassError("check", "The AI could not rewrite the parts that had to go.")
			current = next
			rounds += 1
		}
	}

	/** One isolated checker per section, all at once; unchanged sections reuse their result. */
	private async check(plan: DesignPlan): Promise<Item[]> {
		const result = await checkPlan(
			(section) =>
				this.retry(
					"check",
					() => this.deps.models.helper<{ matches?: CheckerMatch[] }>(checkPrompt(section), CHECK_SCHEMA),
					`checking section "${section.id}"`,
				),
			plan,
			this.deps.approved,
			this.deps.context.brief,
			this.checked,
		)
		this.rejectedClaims += result.rejected
		return result.items
	}

	/** Rewrites the flagged parts. Null when the answer changed nothing usable. */
	private async revise(plan: DesignPlan, flagged: Item[]): Promise<DesignPlan | null> {
		const answer = await this.retry("check", () =>
			this.deps.models.main<{ sections?: unknown[]; changes?: Array<Record<string, unknown>> }>(
				revisePrompt(this.deps.context, plan, flagged),
				REVISE_SCHEMA,
			),
		)
		const ids = new Set(plan.sections.map((s) => s.id))
		const changed: PlanSection[] = (Array.isArray(answer?.sections) ? answer.sections : [])
			.map((raw, index) => normalizeSection(raw, index))
			.filter((section) => ids.has(section.id))
		if (!changed.length) return null
		const changes = Array.isArray(answer?.changes) ? answer.changes : []
		flagged.forEach((item, index) => {
			const change = changes.find((c) => Number(c.n) === index + 1)
			// A part flagged again in a later round is still one part: the latest
			// rewrite of it is what the user's record shows.
			const key = `${item.section}|${normalize(item.quote)}`
			const earlier = this.removed.findIndex((r) => `${r.section}|${normalize(r.was)}` === key)
			if (earlier >= 0) this.removed.splice(earlier, 1)
			this.removed.push({
				section: item.section,
				was: item.quote,
				habit: item.names[0] ?? item.habits[0],
				action: change?.action === "replaced" ? "replaced" : "removed",
				...(typeof change?.now === "string" && change.now ? { now: change.now } : {}),
			})
		})
		return mergeSections(plan, changed)
	}

	/** One defence call for every level-3 part, then one isolated judge call. */
	private async defend(plan: DesignPlan, items: Item[]): Promise<Screened[]> {
		const read = (answer: { answers?: Array<Record<string, unknown>> } | null) => {
			const map = new Map<number, Defence>()
			for (const a of Array.isArray(answer?.answers) ? answer.answers : []) {
				const n = Number(a.n)
				if (!Number.isInteger(n) || n < 1 || n > items.length) continue
				map.set(n, {
					decision: a.decision === "remove" ? "remove" : "keep",
					reason: typeof a.reason === "string" ? a.reason : "",
					briefQuote: typeof a.brief_quote === "string" ? a.brief_quote : "",
				})
			}
			return map
		}
		const prompt = justifyPrompt(this.deps.context, plan, items)
		let defences = read(await this.retry("check", () => this.deps.models.main(prompt, JUSTIFY_SCHEMA)))
		// A defence call that answered nothing usable is asked once more before
		// anything is decided on it: silence is not a defence, nor a removal.
		if (defences.size === 0) defences = read(await this.retry("check", () => this.deps.models.main(prompt, JUSTIFY_SCHEMA)))

		const screened = screenDefences(items, defences, this.deps.context.brief)
		const toJudge = judgeOrder(forJudge(screened))
		const verdicts = new Map<Screened, Verdict>()
		if (toJudge.length) {
			const answer = await this.retry("check", () =>
				this.deps.models.helper<{ verdicts?: Array<Record<string, unknown>> }>(
					judgePrompt(
						this.deps.context.brief,
						toJudge.map((s) => ({
							quote: s.item.quote,
							habit: s.item.names[0] ?? s.item.habits[0],
							reason: s.defence?.reason ?? "",
							briefQuote: s.defence?.briefQuote ?? "",
						})),
					),
					JUDGE_SCHEMA,
				),
			)
			for (const v of Array.isArray(answer?.verdicts) ? answer.verdicts : []) {
				const target = toJudge[Number(v.n) - 1]
				if (target) verdicts.set(target, { anchored: v.anchored === true, why: typeof v.why === "string" ? v.why : "" })
			}
		}
		return applyVerdicts(screened, verdicts)
	}

	private async polish(plan: DesignPlan): Promise<{
		plan: DesignPlan
		components: ComponentPick[]
		declined: ComponentPick[]
		references: DesignPassResult["references"]
		refinements: DesignPassResult["refinements"]
	}> {
		const tools = this.deps.tasteTools()
		const { value, toolCalls } = await this.retry("polish", () =>
			this.deps.models.designer<Record<string, unknown>>(
				tastePrompt(this.deps.context, plan, this.removed, tools),
				TASTE_SCHEMA,
			),
		)
		this.deps.onToolCalls?.(toolCalls)

		// The designer returns the whole plan; a section it dropped or garbled
		// keeps its checked version rather than vanishing from the page.
		const ids = new Set(plan.sections.map((s) => s.id))
		const refined = (Array.isArray(value?.sections) ? value.sections : [])
			.map((raw, index) => normalizeSection(raw, index))
			.filter((section) => ids.has(section.id))
		const polished = mergeSections(plan, refined)

		const list = <T>(raw: unknown): T[] => (Array.isArray(raw) ? (raw as T[]) : [])
		const picks: ComponentPick[] = list<Record<string, unknown>>(value?.components)
			.map((c) => ({
				component: String(c.component ?? "").trim(),
				section: String(c.section ?? ""),
				job: String(c.job ?? ""),
				whyNotPlain: String(c.why_not_plain ?? ""),
			}))
			.filter((c) => isInstallableRef(c.component) && ids.has(c.section))
			// A pick counts only from a library the designer actually searched:
			// a model can name a plausible component id it never saw.
			.filter((c) => searched(c.component, toolCalls))

		let components: ComponentPick[] = []
		let declined: ComponentPick[] = []
		if (picks.length) {
			const answer = await this.retry("polish", () =>
				this.deps.models.helper<{ verdicts?: Array<Record<string, unknown>> }>(
					componentJudgePrompt(this.deps.context.brief, picks),
					COMPONENT_JUDGE_SCHEMA,
				),
			)
			const verdicts = new Map<number, { keep: boolean; why: string }>()
			for (const v of Array.isArray(answer?.verdicts) ? answer.verdicts : []) {
				verdicts.set(Number(v.n), { keep: v.keep === true, why: typeof v.why === "string" ? v.why : "" })
			}
			picks.forEach((pick, index) => {
				const verdict = verdicts.get(index + 1)
				// No verdict is no approval: an unjudged component is not installed.
				if (verdict?.keep) components.push({ ...pick, verdict: verdict.why })
				else declined.push({ ...pick, verdict: verdict?.why || "Not judged." })
			})
		}
		components = dedupe(components)
		declined = dedupe(declined)

		// A reference counts only if the designer actually opened an inspiration
		// library: a model can describe pages it never looked at.
		const browsed = toolCalls.some((call) => call.ok && kindOfLibraryTool(call.tool) === "inspiration")
		const references = browsed
			? list<Record<string, unknown>>(value?.references).map((r) => ({
					what: String(r.what ?? ""),
					learned: String(r.learned ?? ""),
				}))
			: []
		this.deps.progress({
			step: "polish",
			state: "done",
			detail: references.length
				? `looked at ${references.length} reference page${references.length === 1 ? "" : "s"}`
				: undefined,
		})
		return {
			plan: polished,
			components,
			declined,
			references,
			refinements: list<Record<string, unknown>>(value?.refinements).map((r) => ({
				section: String(r.section ?? ""),
				what: String(r.what ?? ""),
				why: String(r.why ?? ""),
			})),
		}
	}

	private removedDetail(pendingRework: number): string | undefined {
		const count = this.removed.length + pendingRework
		return count ? `removed ${count}` : undefined
	}

	private async step<T>(step: PassStep, run: () => Promise<T>): Promise<T> {
		const started = Date.now()
		this.deps.progress({ step, state: "active" })
		const value = await run()
		this.timings[step] = Date.now() - started
		// The polish step reports its own "done", with what it looked at.
		if (step !== "polish") this.deps.progress({ step, state: "done" })
		return value
	}

	/** Tries an AI call {@link ATTEMPTS} times; then the step fails, named. */
	private async retry<T>(step: PassStep, call: () => Promise<T>, what?: string): Promise<T> {
		let last: unknown
		for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
			this.throwIfCancelled()
			try {
				return await call()
			} catch (error) {
				if (this.deps.signal?.aborted) throw new Cancelled()
				last = error
			}
		}
		throw new DesignPassError(step, `${what ? `Failed while ${what}: ` : ""}${messageOf(last)}`)
	}

	private throwIfCancelled(): void {
		if (this.deps.signal?.aborted) throw new Cancelled()
	}
}

/**
 * Steps 2 and 3 on one plan: every section checked in its own call, all at
 * once, claims verified, exact values measured, levels applied. Exported for
 * the development regression test, which runs exactly this on planted plans.
 */
export async function checkPlan(
	askSection: (section: PlanSection) => Promise<{ matches?: CheckerMatch[] } | null>,
	plan: DesignPlan,
	approved: Approved,
	brief: string,
	cache: Map<string, CheckerMatch[]> = new Map(),
): Promise<{ items: Item[]; rejected: number }> {
	const reports = await Promise.all(
		plan.sections.map(async (section) => {
			const key = sectionKey(section)
			const cached = cache.get(key)
			if (cached) return cached
			const answer = await askSection(section)
			const matches = Array.isArray(answer?.matches) ? answer.matches : []
			cache.set(key, matches)
			return matches
		}),
	)
	const findings: Finding[] = []
	let rejected = 0
	plan.sections.forEach((section, index) => {
		const verified = verifyMatches(section, reports[index], approved)
		findings.push(...verified.findings)
		rejected += verified.rejected.length
	})
	findings.push(...valueFindings(plan, approved, brief))
	return { items: applyLevels(findings), rejected }
}

/** "@registry/name" or "21st:<id>": the two forms the installer can fetch. */
export function isInstallableRef(ref: string): boolean {
	return /^@[a-z0-9][\w-]*\/[a-z0-9][\w./-]*$/i.test(ref) || /^21st:\d+$/.test(ref)
}

/** Did the designer search the library a pick comes from? */
export function searched(ref: string, toolCalls: ToolCallRecord[]): boolean {
	const libraries = new Set(toolCalls.filter((call) => call.ok).map((call) => libraryOfTool(call.tool)))
	if (ref.startsWith("21st:")) return libraries.has("twentyfirst")
	// shadcn's MCP searches every registry Caret installs from; Aceternity has its own too.
	if (ref.startsWith("@aceternity/")) return libraries.has("aceternity") || libraries.has("shadcn")
	return libraries.has("shadcn")
}

function dedupe(picks: ComponentPick[]): ComponentPick[] {
	const seen = new Set<string>()
	return picks.filter((p) => {
		const key = `${p.component}|${p.section}`
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
