/**
 * Correction capture — the direct fix for "next session it makes them again".
 *
 * The provenance log records what the user changed by hand; this module notices
 * when they have made the SAME correction more than once and turns it into an
 * offer to promote — into a token (the colour cases) or into the always-on
 * rules (the repeated-instruction case). Mining is deterministic: exact
 * groupings over structured `detail` records, never a judgment call about what
 * "similar" means. A fuzzy miner would offer wrong promotions with confidence,
 * and a wrong promotion silently restyles the whole project.
 *
 * State (what was offered, what was dismissed) lives in
 * `.caret/.corrections-state.json` — local observation like the provenance log
 * itself, gitignored. The PROMOTED rules are the durable half and live in
 * `.caret/rules.json`, under version control (see promoted-rules.ts).
 */
import * as fs from "fs/promises"
import * as path from "path"

import { runExclusive, writeFileAtomic } from "./file-mutation-queue"
import type { EditRecord } from "./provenance"

export type CorrectionSignal =
	| {
			kind: "token"
			/** The token the user keeps overriding (`brand-500`). */
			token: string
			/** The value they keep overriding it to. */
			hex: string
			/** How many times they made this exact correction. */
			count: number
			/** Distinct places (file + element) it was made in. */
			places: string[]
	  }
	| {
			kind: "rule"
			/** The instruction the user keeps giving, verbatim from its first use. */
			instruction: string
			count: number
	  }

/** How many identical corrections before Caret says something. */
export const TOKEN_SIGNAL_THRESHOLD = 2
export const RULE_SIGNAL_THRESHOLD = 3

/** A stable identity for a signal, for offered/dismissed bookkeeping. */
export function signalKey(signal: CorrectionSignal): string {
	return signal.kind === "token"
		? `token:${signal.token}→${signal.hex.toLowerCase()}`
		: `rule:${normalizeInstruction(signal.instruction)}`
}

/**
 * Instructions are grouped by a normalized form — case, punctuation and
 * whitespace are not intent — but the OFFER quotes the user's own wording.
 */
export function normalizeInstruction(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, "")
		.replace(/\s+/g, " ")
		.trim()
}

/**
 * Finds repeated corrections in the record stream. Only `inline` records count
 * — a correction the user made by hand is evidence of taste; an agent's change
 * is not, and promoting it would launder machine output into a rule.
 */
export function mineCorrections(records: EditRecord[]): CorrectionSignal[] {
	const detaches = new Map<string, { token: string; hex: string; count: number; places: Set<string> }>()
	const instructions = new Map<string, { first: string; count: number }>()

	for (const record of records) {
		if (record.actor !== "inline" || !record.detail) continue

		if (record.detail.kind === "color-detach") {
			const { token, hex } = record.detail
			const key = `${token}→${hex.toLowerCase()}`
			const entry = detaches.get(key) ?? { token, hex: hex.toLowerCase(), count: 0, places: new Set<string>() }
			entry.count += 1
			entry.places.add(`${record.file}#${record.param ?? ""}`)
			detaches.set(key, entry)
		}

		if (record.detail.kind === "instruction") {
			const normal = normalizeInstruction(record.detail.text)
			if (normal.length < 8) continue // "fix", "undo" — too short to be a standing rule
			const entry = instructions.get(normal) ?? { first: record.detail.text, count: 0 }
			entry.count += 1
			instructions.set(normal, entry)
		}
	}

	const signals: CorrectionSignal[] = []
	for (const entry of detaches.values()) {
		if (entry.count >= TOKEN_SIGNAL_THRESHOLD) {
			signals.push({ kind: "token", token: entry.token, hex: entry.hex, count: entry.count, places: [...entry.places] })
		}
	}
	for (const entry of instructions.values()) {
		if (entry.count >= RULE_SIGNAL_THRESHOLD) {
			signals.push({ kind: "rule", instruction: entry.first, count: entry.count })
		}
	}
	return signals
}

// ---------------------------------------------------------------------------
// Offer bookkeeping — so a signal is raised once, not on every edit after the
// threshold. Dismissal is permanent for that exact signal; a NEW value for the
// same token is a new signal.
// ---------------------------------------------------------------------------

const STATE_FILE = ".corrections-state.json"

interface CorrectionsState {
	version: 1
	/** signalKey → ISO timestamp the offer was shown. */
	offered: Record<string, string>
	/** signalKey → ISO timestamp the user said no. */
	dismissed: Record<string, string>
}

function statePath(workspacePath: string): string {
	return path.join(workspacePath, ".caret", STATE_FILE)
}

export async function readCorrectionsState(workspacePath: string): Promise<CorrectionsState> {
	try {
		const raw = JSON.parse(await fs.readFile(statePath(workspacePath), "utf-8"))
		return { version: 1, offered: raw.offered ?? {}, dismissed: raw.dismissed ?? {} }
	} catch {
		return { version: 1, offered: {}, dismissed: {} }
	}
}

export async function markSignal(workspacePath: string, key: string, outcome: "offered" | "dismissed"): Promise<void> {
	const target = statePath(workspacePath)
	await runExclusive(target, async () => {
		const state = await readCorrectionsState(workspacePath)
		state[outcome][key] = new Date().toISOString()
		await writeFileAtomic(target, JSON.stringify(state, null, 2))
	})
}

/** The signals worth raising now: past threshold, never offered, never dismissed. */
export async function pendingSignals(workspacePath: string, records: EditRecord[]): Promise<CorrectionSignal[]> {
	const state = await readCorrectionsState(workspacePath)
	return mineCorrections(records).filter((signal) => {
		const key = signalKey(signal)
		return !state.offered[key] && !state.dismissed[key]
	})
}
