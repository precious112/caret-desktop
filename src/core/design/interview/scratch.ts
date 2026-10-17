/**
 * An interview in progress, on disk (`.caret/.interview.json`).
 *
 * Every answer cost a real model call, and the answers are the user's own
 * decisions, so the whole interview is written after every change: the record
 * of answers, the question on screen, an error if the last step failed, and
 * the finish's words. Reopening Caret shows exactly the same screen without
 * asking the model anything.
 *
 * Gitignored: a half-finished interview is not a design decision anyone should
 * review. Deleted when the foundation is saved, when the user leaves for "Set
 * it by hand", and when a foundation saved some other way is newer than it.
 */
import * as fs from "fs/promises"
import * as path from "path"

import { Logger } from "@/shared/services/Logger"
import type { SessionScratch } from "./session"

export type SavedInterview = SessionScratch & { updatedAt: number }

function scratchPath(projectPath: string): string {
	return path.join(projectPath, ".caret", ".interview.json")
}

/** The saved interview, or null when there is none (or it was saved by an older Caret, which is discarded once). */
export async function readInterviewScratch(projectPath: string): Promise<SavedInterview | null> {
	let raw: string
	try {
		raw = await fs.readFile(scratchPath(projectPath), "utf8")
	} catch {
		return null
	}
	try {
		const parsed = JSON.parse(raw) as Partial<SavedInterview>
		if (parsed.version !== 2 || !parsed.record || !Array.isArray(parsed.record.answers)) {
			Logger.warn("[interview] discarded an interview saved by an older Caret; it can't be resumed")
			await clearInterviewScratch(projectPath)
			return null
		}
		return { questions: {}, pending: null, updatedAt: 0, ...parsed } as SavedInterview
	} catch {
		Logger.warn("[interview] discarded an unreadable saved interview")
		await clearInterviewScratch(projectPath)
		return null
	}
}

export async function writeInterviewScratch(projectPath: string, scratch: SessionScratch): Promise<void> {
	const file = scratchPath(projectPath)
	await fs.mkdir(path.dirname(file), { recursive: true })
	await fs.writeFile(file, `${JSON.stringify({ ...scratch, updatedAt: Date.now() }, null, 2)}\n`)
}

export async function clearInterviewScratch(projectPath: string): Promise<void> {
	await fs.rm(scratchPath(projectPath), { force: true }).catch(() => {})
}
