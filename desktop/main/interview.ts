/**
 * The foundation interview's request/response plumbing.
 *
 * An agent calls `present_question` or `present_options` and waits; the chrome
 * renders it, the user points at something, and the answer travels back to the
 * still-open tool call. That is unusual for MCP — most tools return immediately
 * — but it is the right shape here: the agent is running a conversation whose
 * other participant is a human looking at rendered specimens, not text.
 *
 * A pending prompt is deliberately *not* given a short timeout. Someone
 * comparing typefaces may take minutes, and timing out would hand the agent an
 * error it would most likely respond to by inventing an answer — which is the
 * one thing the curated library exists to prevent.
 */
import { randomUUID } from "crypto"

import { Logger } from "../../src/shared/services/Logger"

export interface InterviewPromptBase {
	id: string
	/**
	 * Where the prompt renders. Absent means the Foundation interview surface,
	 * which force-switches the user to it and holds them there until answered —
	 * right for the interview, wrong for a question that belongs to a chat
	 * conversation. `"chat"` docks it in the sidebar instead: no surface switch,
	 * no navigation veto. (`asset-options` prompts are chat-docked by kind.)
	 */
	place?: "chat"
	/** Progress, so the user can see how much is left. */
	step?: number
	total?: number
}

export interface QuestionPrompt extends InterviewPromptBase {
	kind: "question"
	question: string
	hint?: string
	choices: string[]
}

export interface OptionsPrompt extends InterviewPromptBase {
	kind: "options"
	title: string
	subtitle?: string
	candidates: PresentedCandidate[]
}

/** A candidate rendered as something to look at, never as a list of values. */
export interface PresentedCandidate {
	id: string
	name: string
	summary: string
	/** Google Fonts CSS URL, so the specimen renders in the real typeface. */
	fontUrl: string
	displayFamily: string
	/** The pairing's own fallback stack. Hardcoding one misrepresents the face. */
	displayFallback: string
	bodyFamily: string
	bodyFallback: string
	/** Light or dark, per the palette recipe. */
	surface: "light" | "dark"
	brandColor: string
	neutralCharacter: string
	radius: number[]
	baseSize: number
}

/**
 * Takes to point at, for an asset the agent proposed in conversation.
 *
 * Its own kind rather than an `options` prompt: those carry typefaces and
 * palettes because they present foundations. These are pictures, and the whole
 * interaction is looking at three of them.
 */
export interface TakesPrompt extends InterviewPromptBase {
	kind: "takes"
	title: string
	subtitle?: string
	/** Data URLs. Nothing is on disk until one is picked. */
	takes: Array<{ index: number; preview: string; error?: string }>
	surface: string
}

/**
 * Existing assets offered as answers to a question.
 *
 * Unlike every other kind, this one renders docked in the chat rather than on
 * the interview surface: the choice belongs to a conversation already happening
 * in the sidebar, and pulling the user to Foundation for it would remove the
 * canvas they are planning against.
 */
export interface AssetOptionsPrompt extends InterviewPromptBase {
	kind: "asset-options"
	question: string
	why?: string
	options: AssetOption[]
}

/** One asset as a pickable option. URLs are Vite-relative, absolutised by the renderer. */
export interface AssetOption {
	tag: string
	url: string
	kind: string
	posterUrl: string | null
}

export type InterviewPrompt = QuestionPrompt | OptionsPrompt | TakesPrompt | AssetOptionsPrompt

interface Pending {
	prompt: InterviewPrompt
	resolve(answer: string | null): void
}

const pending = new Map<string, Pending>()

/** Sends a prompt to the chrome and resolves with whatever the user picks. */
export function askUser(
	send: (prompt: InterviewPrompt) => void,
	prompt: Omit<QuestionPrompt, "id"> | Omit<OptionsPrompt, "id"> | Omit<TakesPrompt, "id"> | Omit<AssetOptionsPrompt, "id">,
): Promise<string | null> {
	const id = randomUUID()
	const full = { ...prompt, id } as InterviewPrompt

	return new Promise<string | null>((resolve) => {
		pending.set(id, { prompt: full, resolve })
		send(full)
	})
}

/** Delivers the user's answer. Called from the IPC layer. */
export function answerInterviewPrompt(id: string, answer: string | null): boolean {
	const entry = pending.get(id)
	if (!entry) return false
	pending.delete(id)
	entry.resolve(answer)
	return true
}

/**
 * Cancels every waiting prompt, resolving them null.
 *
 * Called when the project closes. Without this, an agent's tool call would hang
 * forever against a window that no longer exists.
 */
export function cancelInterviewPrompts(): void {
	for (const [id, entry] of pending) {
		pending.delete(id)
		entry.resolve(null)
	}
	Logger.info("[interview] cancelled all pending prompts")
}

export function hasPendingPrompt(): boolean {
	return pending.size > 0
}

/**
 * The prompt currently waiting on the user, if any.
 *
 * `interview:prompt` is fire-and-forget, so a prompt sent while the user is
 * looking at the canvas — or before the renderer has mounted the interview —
 * would simply vanish, leaving the agent blocked forever on a question nobody
 * ever saw. The renderer asks for this on mount to recover.
 */
export function currentPrompt(): InterviewPrompt | null {
	for (const entry of pending.values()) return entry.prompt
	return null
}
