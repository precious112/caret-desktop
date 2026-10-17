/**
 * The AI interview, where it meets a project: which model it uses, where its
 * progress is saved, and what the screen is shown.
 *
 * The interview itself runs in the design core (`interview/session.ts`); this
 * file only connects it. Everything the screen shows comes from the saved
 * progress, so reopening Caret puts the user back on the same screen, an
 * error included, without asking the model anything.
 */

import { app, BrowserWindow } from "electron"
import * as fs from "fs/promises"
import * as path from "path"

import {
	type CodingBackend,
	finalizeProposal,
	getBackend,
	readFoundationTokens,
	writeFoundationTokens,
} from "../../src/core/design"
import { describeApp } from "../../src/core/design/interview/describe-app"
import { clearInterviewScratch, readInterviewScratch, writeInterviewScratch } from "../../src/core/design/interview/scratch"
import { InterviewSession, type SessionScratch, viewOf } from "../../src/core/design/interview/session"
import type { AreaAnswer, Verdict } from "../../src/core/design/interview/state"
import { recordEdit } from "../../src/core/design/provenance"
import { Logger } from "../../src/shared/services/Logger"
import type { InterviewWire } from "../shared/ipc"
import { interviewBackendOverride, recordingBackend, replayBackend } from "./interview-backend"
import { getPrefs } from "./prefs"
import { regenerateRulesFiles } from "./rules/generate"

/**
 * One action at a time per project, in the order they were asked for. An
 * identical action asked again while it runs (a double click, React's
 * StrictMode mounting the screen twice in development) gets the same result
 * instead of running twice: two parallel starts once replaced the question the
 * user was reading.
 */
const queues = new Map<string, Promise<unknown>>()
const running = new Map<string, Promise<unknown>>()

export function oneAtATime<T>(projectPath: string, key: string, run: () => Promise<T>): Promise<T> {
	const id = `${projectPath}\n${key}`
	const same = running.get(id)
	if (same) return same as Promise<T>
	const before = queues.get(projectPath) ?? Promise.resolve()
	const task = before.catch(() => {}).then(run)
	const tracked = task.finally(() => {
		if (running.get(id) === tracked) running.delete(id)
		if (queues.get(projectPath) === tracked) queues.delete(projectPath)
	})
	running.set(id, tracked)
	queues.set(projectPath, tracked)
	return tracked
}

/** Cancels a model call in progress when the user abandons the interview. */
const inFlight = new Map<string, AbortController>()

/** The configured backend, only if it is actually ready. */
async function resolveBackend(): Promise<{ backend: CodingBackend; detail: null } | { backend: null; detail: string }> {
	// Development test switch: answers from a recording instead of a model.
	const override = interviewBackendOverride(process.env, app.isPackaged)
	if (override?.kind === "replay") return { backend: replayBackend(override), detail: null }
	const id = getPrefs().backendId
	if (!id) return { backend: null, detail: "No coding backend is set up. Open Settings → Backend to choose one." }
	try {
		const backend = getBackend(id)
		const report = await backend.availability()
		if (report.ready) {
			return { backend: override?.kind === "record" ? recordingBackend(backend, override.file) : backend, detail: null }
		}
		return { backend: null, detail: report.remedy?.label ?? report.detail ?? `${backend.displayName} is not ready.` }
	} catch (err) {
		Logger.warn(`[interview] backend check failed: ${err}`)
		return { backend: null, detail: "The coding backend could not be reached." }
	}
}

/**
 * Every window showing this project keeps its "thinking" screen while the
 * model works; past the first attempts it adds an honest "taking longer than
 * usual". Sent to every window (each checks the project).
 */
function notifyProgress(projectPath: string, attempt: number, max: number): void {
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) window.webContents.send("wizard:progress", { projectPath, attempt, max })
	}
}

/** A session on the saved progress, with a live backend; null with the reason when no model is ready. */
async function sessionFor(
	projectPath: string,
	scratch: SessionScratch | null,
): Promise<
	| { session: InterviewSession; start: (mode: "collaborative" | "from-app", description: string) => Promise<InterviewSession> }
	| { detail: string }
> {
	const { backend, detail } = await resolveBackend()
	if (!backend) return { detail: detail ?? "No coding backend is available." }
	const controller = new AbortController()
	inFlight.get(projectPath)?.abort()
	inFlight.set(projectPath, controller)
	const deps = {
		backend,
		workingDirectory: projectPath,
		model: getPrefs().backendModel || undefined,
		effort: getPrefs().backendEffort || undefined,
		signal: controller.signal,
		onAttempt: (attempt: number, max: number) => notifyProgress(projectPath, attempt, max),
		log: (line: string) => Logger.warn(line),
		persist: (next: SessionScratch) => writeInterviewScratch(projectPath, next),
		sourceExists: async (relative: string) => {
			const full = path.resolve(projectPath, relative)
			if (!full.startsWith(path.resolve(projectPath) + path.sep)) return false
			return fs
				.stat(full)
				.then((stat) => stat.isFile())
				.catch(() => false)
		},
	}
	return {
		session: new InterviewSession(scratch ?? ({} as SessionScratch), deps),
		start: (mode, description) => InterviewSession.start(mode, description, deps),
	}
}

function wireOf(scratch: SessionScratch): InterviewWire | null {
	const view = viewOf(scratch)
	if (!view) return null
	const mode = scratch.record.mode
	if (view.phase === "finish") {
		const finalized = finalizeProposal(view.proposal, vibeDescription(scratch))
		return { ...view, mode, name: finalized.name, rule: finalized.rule, summary: finalized.summary }
	}
	return { ...view, mode }
}

/** The words a saved foundation is filed under: the user's description, or for an app, the model's summary. */
function vibeDescription(scratch: SessionScratch): string {
	return scratch.record.mode === "from-app" ? "" : scratch.record.description
}

/**
 * A saved interview, unless a foundation was saved after it (by hand, or by an
 * agent): then it is out of date and thrown away, so it never reappears over
 * the newer foundation.
 */
async function savedInterview(projectPath: string): Promise<SessionScratch | null> {
	const saved = await readInterviewScratch(projectPath)
	if (!saved) return null
	const tokens = await readFoundationTokens(projectPath).catch(() => null)
	const committedAt = tokens?.meta?.committedAt ? Date.parse(tokens.meta.committedAt) : Number.NaN
	if (Number.isFinite(committedAt) && committedAt > saved.updatedAt) {
		Logger.info("[interview] a foundation was saved after this interview; the interview was discarded")
		await clearInterviewScratch(projectPath)
		return null
	}
	return saved
}

/** Runs one action on the saved interview and returns the screen it leads to. */
function act(projectPath: string, key: string, run: (session: InterviewSession) => Promise<unknown>): Promise<InterviewWire> {
	return oneAtATime(projectPath, key, async () => {
		const saved = await savedInterview(projectPath)
		if (!saved) throw new Error("There is no interview in progress.")
		const ready = await sessionFor(projectPath, saved)
		if ("detail" in ready) return { phase: "needs-backend", detail: ready.detail }
		await run(ready.session)
		return wireOf(ready.session.saved) ?? { phase: "needs-backend", detail: "The interview has nothing to show." }
	})
}

/** What was in progress, or null. Never asks the model. */
export function resumeWizard(projectPath: string): Promise<InterviewWire | null> {
	return oneAtATime(projectPath, "resume", async () => {
		const saved = await savedInterview(projectPath)
		return saved ? wireOf(saved) : null
	})
}

export function startWizard(
	projectPath: string,
	description: string,
	mode: "collaborative" | "from-app" = "collaborative",
): Promise<InterviewWire> {
	return oneAtATime(projectPath, `start:${mode}:${description}`, async () => {
		const ready = await sessionFor(projectPath, null)
		if ("detail" in ready) return { phase: "needs-backend", detail: ready.detail }
		const context = mode === "from-app" ? await describeApp(projectPath) : description.trim()
		const session = await ready.start(mode, context)
		return wireOf(session.saved) ?? { phase: "needs-backend", detail: "The interview has nothing to show." }
	})
}

export function answerOpening(projectPath: string, verdicts: Verdict[]): Promise<InterviewWire> {
	return act(projectPath, "opening", (session) => session.answerOpening(verdicts))
}

export function answerWizard(projectPath: string, answer: AreaAnswer): Promise<InterviewWire> {
	return act(projectPath, `answer:${answer.questionId}`, (session) => session.answer(answer))
}

export function retryWizard(projectPath: string): Promise<InterviewWire> {
	return act(projectPath, "retry", (session) => session.retry())
}

export function finishWizard(projectPath: string): Promise<InterviewWire> {
	return act(projectPath, "finish-now", (session) => session.finishNow())
}

export function wizardBack(projectPath: string): Promise<InterviewWire> {
	return act(projectPath, "back", (session) => session.back())
}

/** Saves the foundation: every value from the answers, the words from the model. */
export function commitWizard(projectPath: string): Promise<{ name: string; rule: string }> {
	return oneAtATime(projectPath, "commit", async () => {
		const saved = await readInterviewScratch(projectPath)
		const view = saved ? viewOf(saved) : null
		if (!saved || view?.phase !== "finish") throw new Error("There is no finished foundation to save.")
		const finalized = finalizeProposal(view.proposal, vibeDescription(saved))
		// The rationale outlives the interview here, and `committed` marks a
		// foundation a person actually chose.
		finalized.tokens.meta = {
			committed: true,
			committedAt: new Date().toISOString(),
			source: saved.record.mode === "from-app" ? "wizard-from-app" : "wizard-collaborative",
			rule: finalized.rule,
			summary: finalized.summary,
			decisions: finalized.decisions,
		}
		await writeFoundationTokens(projectPath, finalized.tokens)
		await regenerateRulesFiles(projectPath)
		await recordEdit(projectPath, {
			actor: "caret",
			action: "write",
			file: "tokens/foundation.json",
			note: `interview → ${finalized.name}`,
		})
		await clearInterviewScratch(projectPath)
		return { name: finalized.name, rule: finalized.rule }
	})
}

/** Throws the interview away (the user chose "Set it by hand", or started over), cancelling any model call. */
export async function abandonWizard(projectPath: string): Promise<void> {
	inFlight.get(projectPath)?.abort()
	inFlight.delete(projectPath)
	await oneAtATime(projectPath, "abandon", () => clearInterviewScratch(projectPath))
}
