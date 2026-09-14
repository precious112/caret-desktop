/**
 * Every change to `.caret/`, with who made it.
 *
 * This exists for Phase 7. "Make corrections stick" means noticing that the user
 * has overridden the same thing by hand three times and offering to promote it
 * into a token or a rule — and that is only possible with a history to notice it
 * in. The history cannot be reconstructed later: git records that a file
 * changed, not that *the user* changed a colour from `brand-500` to `#e8e8e8`
 * for the fourth time after an agent kept reverting it.
 *
 * So it is written now, while it is nearly free, and read later.
 *
 * Append-only JSONL under `.caret/.provenance.jsonl`, gitignored. Not under
 * version control on purpose: it is local observation, it would produce a merge
 * conflict on every branch, and it says things about how someone works that they
 * did not choose to publish.
 */
import * as fs from "fs/promises"
import * as path from "path"

import { Logger } from "@/shared/services/Logger"

/**
 * Who made the change. The distinction that matters is `inline` (the user, by
 * hand, in the canvas) versus everything else — a correction the user made
 * themselves is evidence of taste; a change an agent made is not.
 */
export type EditActor = "inline" | "agent" | "external" | "caret"

export type EditAction = "create" | "write" | "delete" | "heal"

/**
 * Structured detail for the records correction-mining reads. Free-text notes
 * are for humans; a miner parsing prose out of `note` would be the drift bug
 * waiting to happen.
 */
export type EditDetail =
	| { kind: "color-detach"; token: string; hex: string }
	| { kind: "color-bind"; token: string }
	| { kind: "color"; hex: string }
	| { kind: "instruction"; text: string }

export interface EditRecord {
	actor: EditActor
	action: EditAction
	/** Path relative to the project root where possible. */
	file: string
	/** Param path, once the Phase 8 parameter model can name one. */
	param?: string
	oldValue?: string
	newValue?: string
	sizeBefore?: number
	sizeAfter?: number
	/** Free-form note, e.g. which healing rule fired. */
	note?: string
	/** Machine-readable detail for correction mining. */
	detail?: EditDetail
}

interface StoredRecord extends EditRecord {
	at: string
}

const LOG_FILE = ".provenance.jsonl"
/** Above this, the log is trimmed to the most recent half on next append. */
const MAX_BYTES = 4 * 1024 * 1024

function logPath(projectPath: string): string {
	return path.join(projectPath, ".caret", LOG_FILE)
}

/**
 * Appends one record. Never throws — provenance is observation, and losing a
 * line must never fail the edit that produced it.
 */
export async function recordEdit(projectPath: string, record: EditRecord): Promise<void> {
	const target = logPath(projectPath)
	const stored: StoredRecord = { at: new Date().toISOString(), ...record, file: relativise(projectPath, record.file) }

	try {
		await fs.mkdir(path.dirname(target), { recursive: true })
		await fs.appendFile(target, `${JSON.stringify(stored)}\n`, "utf-8")
		await trimIfLarge(target)
	} catch (err) {
		Logger.warn(`[provenance] could not record edit: ${err}`)
	}
}

/** Reads the log, newest last. Malformed lines are skipped rather than fatal. */
export async function readProvenance(projectPath: string, limit?: number): Promise<StoredRecord[]> {
	try {
		const raw = await fs.readFile(logPath(projectPath), "utf-8")
		const records: StoredRecord[] = []
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue
			try {
				records.push(JSON.parse(line) as StoredRecord)
			} catch {
				// A torn write at the tail, or a line from a future format. Skip it.
			}
		}
		return limit ? records.slice(-limit) : records
	} catch {
		return []
	}
}

function relativise(projectPath: string, file: string): string {
	return path.isAbsolute(file) ? path.relative(projectPath, file) : file
}

/**
 * Keeps the log bounded by dropping the oldest half. Correction capture cares
 * about recent, repeated overrides; a year of history is not worth unbounded
 * growth in the user's repo directory.
 */
async function trimIfLarge(target: string): Promise<void> {
	try {
		const { size } = await fs.stat(target)
		if (size <= MAX_BYTES) return
		const lines = (await fs.readFile(target, "utf-8")).split("\n").filter(Boolean)
		await fs.writeFile(target, `${lines.slice(Math.floor(lines.length / 2)).join("\n")}\n`, "utf-8")
		Logger.info("[provenance] trimmed the edit log to its most recent half")
	} catch {
		// Trimming is opportunistic.
	}
}
