/**
 * The Design pass, as one project's chat runs it.
 *
 * The engine (`src/core/design/design-pass`) is the steps; this is everything
 * around them that only the app can do: which models answer, which libraries
 * the designer may open, the questions card, consent and installs for chosen
 * components, the build turn's instructions, and the events that say how it
 * went (counts, habit and library names, timings — never the brief, the plan
 * or the page).
 */
import type { CodingBackend, StructuredRequest } from "../../../src/core/design/agent/backend"
import type { PrepareApi, PreparedTurn } from "../../../src/core/design/agent/conversation"
import type { InstallOutcome } from "../../../src/core/design/catalog/registry-install"
import { DesignPassError, type DesignQuestion, type PassStep, runDesignPass } from "../../../src/core/design/design-pass/engine"
import { approvedFrom } from "../../../src/core/design/design-pass/findings"
import { foundationSummary } from "../../../src/core/design/design-pass/foundation-summary"
import { pickHelperModel } from "../../../src/core/design/design-pass/helper-model"
import { LIBRARIES, REGISTRIES } from "../../../src/core/design/design-pass/libraries"
import {
	type BuildComponent,
	buildInstructions,
	PAGE_WORK_SCHEMA,
	type PassContext,
	pageWorkPrompt,
} from "../../../src/core/design/design-pass/prompts"
import { listPages } from "../../../src/core/design/page-meta"
import { readFoundationTokens } from "../../../src/core/design/tokens"
import { Logger } from "../../../src/shared/services/Logger"
import { capture } from "../analytics"
import { askUser, type InterviewPrompt } from "../interview"
import { getPrefs, setPref } from "../prefs"
import type { DesignLibraries } from "./libraries"

export interface DesignPassServiceOptions {
	projectPath: string
	backend(): Promise<CodingBackend | null>
	libraries: DesignLibraries
	sendPrompt(prompt: InterviewPrompt): void
	withdrawPrompt(id: string): void
	/** One native notification when the window is not focused. */
	notify(body: string): void
	installComponent(ref: string, why: string): Promise<InstallOutcome>
	/** The build is about to write this page: the canvas shows a placeholder until it lands. */
	onBuildStart?(pageId: string): void
}

/** What the chat's build turn checks afterwards: the components it was told to import. */
export interface PendingImportCheck {
	components: BuildComponent[]
}

export class DesignPassService {
	/** Components the last build turn was told to import; the free code check reads it once. */
	private importCheck: PendingImportCheck | null = null

	constructor(private readonly options: DesignPassServiceOptions) {}

	isOn(): boolean {
		return !getPrefs().designPassOff.includes(this.options.projectPath)
	}

	async setOn(on: boolean, where: "composer" | "settings"): Promise<void> {
		const off = new Set(getPrefs().designPassOff)
		if (on) off.delete(this.options.projectPath)
		else off.add(this.options.projectPath)
		await setPref("designPassOff", [...off])
		capture("design_pass_toggled", { on, where })
	}

	/** Takes the pending import check, once. */
	takeImportCheck(): PendingImportCheck | null {
		const check = this.importCheck
		this.importCheck = null
		return check
	}

	/**
	 * Runs the pass for one typed message. Null when the message is not page
	 * work: the chat then runs the turn exactly as it would with the pass off.
	 */
	async prepare(message: string, api: PrepareApi): Promise<PreparedTurn | null> {
		const backend = await this.options.backend()
		// No backend: the turn itself reports that, in the chat's usual words.
		if (!backend) return null
		const { projectPath } = this.options
		const prefs = getPrefs()
		const mainModel = prefs.backendModel || undefined
		const helper =
			pickHelperModel(
				await (backend.listModels?.() ?? Promise.resolve([])).catch(() => []),
				prefs.designPassHelperModel,
				mainModel,
			).model ?? mainModel

		// Every pass call answers a question; none may write pages. Caret's own
		// tools are off unless a step switches one back on.
		const ask = <T>(
			model: string | undefined,
			prompt: string,
			schema: Record<string, unknown>,
			extra: Partial<StructuredRequest> = {},
		) =>
			backend.structured<T>({
				workingDirectory: projectPath,
				prompt,
				schema,
				model,
				signal: api.signal,
				...extra,
				tools: { "caret_*": false, ...extra.tools },
			})

		const pages = (await listPages(projectPath).catch(() => [])).filter((p) => !p.variantOf)
		const pageIds = pages.map((p) => p.id)

		// Page work? Asked of the helper, and retried like any step: a failure here
		// fails the turn rather than quietly building without the pass.
		let pageWork: { pageWork?: boolean; page?: string } | null = null
		let lastError: unknown
		for (let attempt = 0; attempt < 3 && !pageWork; attempt++) {
			if (api.signal.aborted) throw new Error("Stopped.")
			try {
				pageWork = (
					await ask<{ pageWork?: boolean; page?: string }>(helper, pageWorkPrompt(message, pageIds), PAGE_WORK_SCHEMA)
				).value
			} catch (err) {
				lastError = err
			}
		}
		if (!pageWork)
			throw new Error(
				`The Design pass could not read the request: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
			)
		if (pageWork.pageWork !== true) return null

		// Libraries connect while the plan and checks run; the designer needs them last.
		const librariesReady = this.options.libraries.ensure(projectPath).catch(() => new Set<string>())
		const tokens = await readFoundationTokens(projectPath).catch(() => null)
		const context: PassContext = { brief: message, foundation: foundationSummary(tokens), existingPages: pageIds }
		const started = Date.now()
		const progress = (step: PassStep | "build", state: "active" | "done", detail?: string) =>
			api.progress(step, state, detail)

		try {
			let usableAtPolish: Set<string> = new Set()
			const result = await runDesignPass({
				models: {
					main: async (prompt, schema) =>
						(await ask(mainModel, prompt, schema, { effort: prefs.backendEffort || undefined })).value as never,
					helper: async (prompt, schema) => (await ask(helper, prompt, schema)).value as never,
					designer: async (prompt, schema) => {
						usableAtPolish = await librariesReady
						const answer = await ask(mainModel, prompt, schema, {
							effort: prefs.backendEffort || undefined,
							// Library tools come from the project's policy; Caret's own
							// reference viewer is the one extra tool the designer needs.
							tools: { caret_view_reference: true },
							allowTools: true,
						})
						return { value: answer.value as never, toolCalls: answer.toolCalls ?? [] }
					},
				},
				context,
				approved: approvedFrom(tokens),
				tasteTools: () => ({
					libraries: LIBRARIES.filter((l) => this.options.libraries.usable(projectPath).has(l.id)).map((l) => ({
						name: l.name,
						gives: l.gives,
						kind: l.kind,
					})),
					viewTool: "caret_view_reference",
				}),
				ask: (questions) => this.askQuestions(questions, api.signal),
				progress: (update) => progress(update.step, update.state, update.detail),
				onToolCalls: (calls) => this.options.libraries.noteToolCalls(calls),
				signal: api.signal,
			})

			// Install what the judge approved; a component that cannot be installed
			// is left out of the build rather than imported broken.
			const components: BuildComponent[] = []
			for (const pick of result.components) {
				const installed = await this.options.installComponent(pick.component, pick.job)
				capture("design_pass_component", { library: libraryProp(pick.component), installed: installed.ok })
				if (installed.ok)
					components.push({
						importPath: installed.importPath,
						namedExport: installed.namedExport,
						section: pick.section,
						job: pick.job,
					})
				else Logger.warn(`[design-pass] ${pick.component} not installed: ${installed.reason}`)
			}
			this.importCheck = components.length ? { components } : null

			capture("design_pass_completed", {
				ok: true,
				duration_s: Math.round((Date.now() - started) / 1000),
				plan_s: secondsOf(result.stats.timings.plan),
				check_s: secondsOf(result.stats.timings.check),
				questions_s: secondsOf(result.stats.timings.questions),
				polish_s: secondsOf(result.stats.timings.polish),
				sections: result.plan.sections.length,
				rounds: result.stats.rounds,
				main_model: mainModel ?? "default",
				helper_model: helper ?? "default",
				libraries: [...usableAtPolish].sort().join(","),
				references: result.references.length,
				components: components.length,
			})
			capture("design_pass_habits", {
				banned: result.stats.bannedHabits.sort().join(","),
				defended: result.stats.defendedHabits.sort().join(","),
				kept_by_user: result.questions
					.filter((q) => q.answer === "keep")
					.map((q) => q.question.habit)
					.join(","),
				removed: result.removed.length,
				rejected_claims: result.stats.rejectedClaims,
			})
			const pageId = slugOf(pageWork.page)
			if (pageId && !pageIds.includes(pageId)) this.options.onBuildStart?.(pageId)
			// The plan goes in this turn's system text; the user's words stay the prompt.
			return { system: buildInstructions(result.plan, result.removed, components) }
		} catch (err) {
			if (api.signal.aborted) throw err
			capture("design_pass_completed", {
				ok: false,
				step: err instanceof DesignPassError ? err.step : "unknown",
				duration_s: Math.round((Date.now() - started) / 1000),
			})
			const message = err instanceof Error ? err.message : String(err)
			throw new Error(
				`The Design pass stopped: ${message} Try again, choose another helper model in the backend tab, or turn the Design pass off for this project.`,
			)
		}
	}

	/** The questions card: one chat-docked card, waiting for an answer with no default and no timer. */
	private async askQuestions(questions: DesignQuestion[], signal: AbortSignal): Promise<Array<"keep" | "remove">> {
		const count = questions.length
		this.options.notify(`${count} design question${count === 1 ? "" : "s"}`)
		const answer = await askUser(
			this.options.sendPrompt,
			{
				kind: "design-questions",
				place: "chat",
				title: "Possible AI slop spotted",
				subtitle: "These are common in AI-made designs. Keep them anyway?",
				items: questions.map((q) => ({ section: q.section, quote: q.quote, habit: q.habit, reason: q.reason })),
			},
			{ signal, onWithdrawn: (id) => this.options.withdrawPrompt(id) },
		)
		if (signal.aborted) throw new Error("Stopped.")
		// No silent default: a card that closed unanswered (the project closed)
		// stops the pass rather than deciding for the user.
		if (answer === null) throw new Error("The design questions were closed before they were answered.")
		const parsed = parseAnswers(answer, count)
		capture("design_pass_questions_answered", {
			asked: count,
			kept: parsed.filter((a) => a === "keep").length,
			removed: parsed.filter((a) => a === "remove").length,
			habits: questions.map((q) => q.habit).join(","),
		})
		return parsed
	}
}

/**
 * The card's answer: a JSON array of "keep"/"remove", one per item. The card
 * only sends complete answers; an unreadable entry removes, because nobody
 * chose to keep it.
 */
export function parseAnswers(answer: string | null, count: number): Array<"keep" | "remove"> {
	let parsed: unknown = null
	try {
		parsed = answer ? JSON.parse(answer) : null
	} catch {}
	const list = Array.isArray(parsed) ? parsed : []
	return Array.from({ length: count }, (_, index) => (list[index] === "keep" ? "keep" : "remove"))
}

/** A component's library for telemetry: a known registry or 21st.dev, never free text from a model. */
export function libraryProp(ref: string): string {
	if (ref.startsWith("21st:")) return "21st"
	const registry = ref.split("/")[0]
	return REGISTRIES[registry] ? registry.replace(/^@/, "") : "other"
}

function slugOf(text: string | undefined): string | null {
	const slug = String(text ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
	return slug || null
}

function secondsOf(ms: number | undefined): number | undefined {
	return ms === undefined ? undefined : Math.round(ms / 1000)
}
