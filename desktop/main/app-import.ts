/**
 * App import (code → design), host half.
 *
 * The design core finds the screens and runs the import; this is where it meets
 * a window: which backend, which lane, where progress goes, and the one rule
 * that matters most here — only one import per project at a time, because two
 * would race on the same page ids.
 *
 * Progress is pushed to the chrome after every change and also kept, so a
 * surface that mounts mid-import (the user wandered off to Assets and came
 * back) asks for it instead of waiting for the next event.
 */
import {
	ExploreCancelledError,
	ImportCancelledError,
	type ImportProgress,
	type ImportScreen,
	type ImportSurvey,
	runAppImport,
	surveyAppScreens,
	surveyScreensWithModel,
} from "../../src/core/design"
import { Logger } from "../../src/shared/services/Logger"
import { getLatestGitCommitHash } from "../../src/utils/git"
import type { AgentService } from "./agent-service"
import { capture } from "./analytics"
import { getPrefs } from "./prefs"

export interface ImportSurveyResult {
	ok: boolean
	/** Why there is nothing to offer, in words the card can show. */
	reason?: string
	survey?: ImportSurvey
}

export class AppImportService {
	private progress: ImportProgress | null = null
	/** The last survey, so `start` imports exactly the screens the user was shown. */
	private lastSurvey: ImportSurvey | null = null

	constructor(
		private readonly options: {
			projectPath: string
			agent: AgentService
			onProgress(progress: ImportProgress): void
		},
	) {}

	status(): ImportProgress | null {
		return this.progress
	}

	running(): boolean {
		return this.progress?.state === "running"
	}

	/**
	 * The screens worth offering. File-routed apps are listed for free; an app
	 * that routes in code costs one read-only model turn, so that only happens
	 * when a backend is ready — otherwise the card says what is needed.
	 */
	async survey(): Promise<ImportSurveyResult> {
		try {
			let survey = await surveyAppScreens(this.options.projectPath)
			if (survey.found === "none") {
				const backend = await this.options.agent.readyBackend()
				if (!backend) {
					return {
						ok: false,
						reason: "This app declares its screens in code, so finding them needs a model. Connect one in Backend.",
					}
				}
				survey = await surveyScreensWithModel({
					projectPath: this.options.projectPath,
					backend,
					model: getPrefs().backendModel || undefined,
					effort: getPrefs().backendEffort || undefined,
				})
			}
			this.lastSurvey = survey
			return { ok: true, survey }
		} catch (err) {
			Logger.warn(`[import] survey failed: ${err}`)
			return { ok: false, reason: err instanceof Error ? err.message : String(err) }
		}
	}

	/** Starts importing the chosen screens. Returns at once; progress arrives as events. */
	async start(screenIds: string[]): Promise<{ ok: boolean; reason?: string }> {
		if (this.running()) return { ok: false, reason: "An import is already running." }
		const survey = this.lastSurvey ?? (await this.survey()).survey
		if (!survey) return { ok: false, reason: "There is nothing to import." }
		const chosen = new Set(screenIds)
		const screens: ImportScreen[] = survey.screens.filter((screen) => chosen.has(screen.id))
		if (screens.length === 0) return { ok: false, reason: "Choose at least one screen." }
		if (!this.options.agent.importLane.connected()) {
			return { ok: false, reason: "Importing screens needs a model. Connect one in Backend." }
		}

		const lane = this.options.agent.importLane
		const head = await getLatestGitCommitHash(this.options.projectPath).catch(() => null)
		this.lastSurvey = null
		const startedAt = Date.now()
		capture("app_import_started", { screens: screens.length, shell: survey.shell.length > 0 })

		void runAppImport({
			projectPath: this.options.projectPath,
			screens,
			shell: survey.shell,
			head,
			onProgress: (progress) => {
				this.progress = progress
				this.options.onProgress(progress)
			},
			run: async (id, prompt, displayPrompt, files) => {
				try {
					await lane.run(id, {
						kind: "visual-edit",
						prompt,
						displayPrompt,
						context: { filePath: files[0] },
						unattended: true,
					})
				} catch (err) {
					if (err instanceof ExploreCancelledError) throw new ImportCancelledError()
					throw err
				}
			},
		})
			.then((result) => {
				const done = result.screens.filter((screen) => screen.status === "done").length
				capture("app_import_finished", {
					done,
					failed: result.screens.filter((screen) => screen.status === "failed").length,
					cancelled: result.screens.filter((screen) => screen.status === "cancelled").length,
					duration_s: Math.round((Date.now() - startedAt) / 1000),
				})
			})
			.catch((err) => Logger.error("[import] run failed:", err))

		return { ok: true }
	}

	async cancel(): Promise<void> {
		await this.options.agent.importLane.cancelAll()
	}
}
