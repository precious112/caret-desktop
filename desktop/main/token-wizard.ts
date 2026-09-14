/**
 * The AI-run token wizard — host half.
 *
 * The model runs the interview (`conductor.ts` in the design core); this is
 * where it meets a project: which backend, whose preferences, where scratch
 * lives, and what the renderer is shown. The host never invents interview
 * content — it forwards validated turns and records answers.
 *
 * State is in memory *and* on disk after every change, disk winning on load:
 * memory is what makes Back free, disk is what survives the window. Both are
 * cheap; losing a five-question interview to a crash is not.
 */
import { BrowserWindow } from "electron"

import {
	COVERAGE_AREAS,
	type CodingBackend,
	clearWizardScratch,
	coveredAreas,
	type FoundationProposal,
	finalizeProposal,
	getBackend,
	nextWizardTurn,
	questionCapFor,
	readWizardScratch,
	type StoredQA,
	type WizardAnswer,
	type WizardMode,
	type WizardQuestion,
	writeFoundationTokens,
	writeWizardScratch,
} from "../../src/core/design"
import { recordEdit } from "../../src/core/design/provenance"
import { Logger } from "../../src/shared/services/Logger"
import type { WizardStateWire } from "../shared/ipc"
import { getPrefs } from "./prefs"
import { regenerateRulesFiles } from "./rules/generate"

interface WizardSession {
	description: string
	mode: WizardMode
	history: StoredQA[]
	pending?: WizardQuestion
	proposal?: FoundationProposal
}

const sessions = new Map<string, WizardSession>()

/** The configured backend, only if it is actually ready. */
async function resolveBackend(): Promise<{ backend: CodingBackend; detail: null } | { backend: null; detail: string }> {
	const id = getPrefs().backendId
	if (!id) return { backend: null, detail: "No coding backend is set up. Open Settings → Backend to choose one." }
	try {
		const backend = getBackend(id)
		const report = await backend.availability()
		if (report.ready) return { backend, detail: null }
		return { backend: null, detail: report.remedy?.label ?? report.detail ?? `${backend.displayName} is not ready.` }
	} catch (err) {
		Logger.warn(`[wizard] backend check failed: ${err}`)
		return { backend: null, detail: "The coding backend could not be reached." }
	}
}

async function persist(projectPath: string, session: WizardSession): Promise<void> {
	sessions.set(projectPath, session)
	await writeWizardScratch(projectPath, {
		description: session.description,
		mode: session.mode,
		history: session.history,
		pending: session.pending,
		proposal: session.proposal,
	})
}

function stateFor(session: WizardSession): WizardStateWire {
	if (session.proposal) {
		const finalized = finalizeProposal(session.proposal, session.description)
		return {
			phase: "finish",
			mode: session.mode,
			description: session.description,
			proposal: session.proposal,
			name: finalized.name,
			rule: finalized.rule,
			summary: finalized.summary,
			history: session.history,
		}
	}
	if (session.pending) {
		const covered = new Set(coveredAreas(session.history))
		return {
			phase: "question",
			mode: session.mode,
			description: session.description,
			current: session.pending,
			asked: session.history.length,
			cap: questionCapFor(session.mode),
			history: session.history,
			coverage:
				session.mode === "collaborative"
					? {
							done: COVERAGE_AREAS.filter((area) => covered.has(area.id)),
							missing: COVERAGE_AREAS.filter((area) => !covered.has(area.id)),
						}
					: undefined,
		}
	}
	return { phase: "describe", description: session.description }
}

/**
 * Retries are invisible until spent: every window showing this project keeps
 * its loading state, and past the early attempts the renderer swaps in an
 * honest "taking longer than usual". Broadcast to every window (each filters
 * by projectPath) rather than a [0]-style pick — see the BrowserWindow race
 * note in the certification lessons.
 */
function notifyProgress(projectPath: string, attempt: number, max: number): void {
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) window.webContents.send("wizard:progress", { projectPath, attempt, max })
	}
}

/** Runs one model turn and stores whatever it decided. */
async function advance(projectPath: string, session: WizardSession, force?: "finish"): Promise<WizardStateWire> {
	const { backend, detail } = await resolveBackend()
	if (!backend) return { phase: "needs-backend", detail: detail ?? "No coding backend is available." }

	try {
		const turn = await nextWizardTurn({
			backend,
			workingDirectory: projectPath,
			model: getPrefs().backendModel || undefined,
			effort: getPrefs().backendEffort || undefined,
			description: session.description,
			history: session.history,
			force,
			mode: session.mode,
			onAttempt: (attempt, max) => notifyProgress(projectPath, attempt, max),
		})

		if (turn.action === "ask") session.pending = turn.question
		else {
			session.pending = undefined
			session.proposal = turn.foundation
		}
		await persist(projectPath, session)
		return stateFor(session)
	} catch (err) {
		Logger.error("[wizard] turn failed:", err)
		return {
			phase: "error",
			description: session.description,
			message: err instanceof Error ? err.message : String(err),
			canFinish: session.history.length > 0,
		}
	}
}

/** Whatever was in flight, or null. Never calls the model. */
export async function resumeWizard(projectPath: string): Promise<WizardStateWire | null> {
	const held = sessions.get(projectPath)
	if (held) return stateFor(held)

	const scratch = await readWizardScratch(projectPath)
	if (!scratch) return null

	const session: WizardSession = {
		description: scratch.description,
		mode: scratch.mode ?? "ai-led",
		history: scratch.history,
		pending: scratch.pending,
		proposal: scratch.proposal,
	}
	sessions.set(projectPath, session)
	return stateFor(session)
}

export async function startWizard(
	projectPath: string,
	description: string,
	mode: WizardMode = "collaborative",
): Promise<WizardStateWire> {
	const session: WizardSession = { description: description.trim(), mode, history: [] }
	await persist(projectPath, session)
	return advance(projectPath, session)
}

export async function answerWizard(projectPath: string, answer: WizardAnswer): Promise<WizardStateWire> {
	const session = sessions.get(projectPath)
	if (!session?.pending) throw new Error("There is no question waiting for an answer.")
	if (session.pending.id !== answer.questionId) {
		// A stale answer — the user double-clicked, or answered across a Back.
		return stateFor(session)
	}

	session.history = [...session.history, { question: session.pending, answer }]
	session.pending = undefined
	await persist(projectPath, session)
	return advance(projectPath, session)
}

/** Re-runs the turn that just failed, without recording anything new. */
export async function retryWizard(projectPath: string): Promise<WizardStateWire> {
	const session = sessions.get(projectPath)
	if (!session) throw new Error("There is no interview in progress.")
	return advance(projectPath, session)
}

/** "Just finish" — construct from whatever is known. */
export async function finishWizard(projectPath: string): Promise<WizardStateWire> {
	const session = sessions.get(projectPath)
	if (!session) throw new Error("There is no interview in progress.")
	session.pending = undefined
	return advance(projectPath, session, "finish")
}

/**
 * Back re-opens the previous question — for free.
 *
 * The stored question is re-rendered as-is rather than re-asked: the model's
 * question was already paid for, and it does not change because the user wants
 * to reconsider their answer. History after the revisited question is
 * discarded, since later questions may have been premised on the old answer.
 */
export async function wizardBack(projectPath: string): Promise<WizardStateWire> {
	const session = sessions.get(projectPath)
	if (!session) throw new Error("There is no interview in progress.")

	if (session.proposal) {
		session.proposal = undefined
		const last = session.history[session.history.length - 1]
		if (last) {
			session.pending = last.question
			session.history = session.history.slice(0, -1)
		}
	} else {
		const last = session.history[session.history.length - 1]
		if (!last) return stateFor(session)
		session.pending = last.question
		session.history = session.history.slice(0, -1)
	}

	await persist(projectPath, session)
	return stateFor(session)
}

/** Caret writes the file; the model's involvement ended at parameters. */
export async function commitWizard(projectPath: string): Promise<{ name: string; rule: string }> {
	const session = sessions.get(projectPath)
	if (!session?.proposal) throw new Error("There is no finished foundation to commit.")

	const finalized = finalizeProposal(session.proposal, session.description)
	// The rationale used to be shown once on the finish screen and destroyed
	// with the scratch; `meta` is where it survives — and it doubles as the
	// "a person actually committed this" marker the entry flow keys on.
	finalized.tokens.meta = {
		committed: true,
		committedAt: new Date().toISOString(),
		source: session.mode === "collaborative" ? "wizard-collaborative" : "wizard",
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
		note: `token wizard → ${finalized.name}`,
	})

	await clearWizardScratch(projectPath)
	sessions.delete(projectPath)
	return { name: finalized.name, rule: finalized.rule }
}

export async function abandonWizard(projectPath: string): Promise<void> {
	sessions.delete(projectPath)
	await clearWizardScratch(projectPath)
}
