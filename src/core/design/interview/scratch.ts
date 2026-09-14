/**
 * A half-finished wizard, on disk.
 *
 * Every answered question cost a real model call, and the answers are the
 * user's own judgment — losing either to a crash or a closed window is how
 * someone abandons the flow and ships without foundations. So the whole state
 * (description, transcript, the question currently on screen, a finished
 * proposal awaiting confirmation) is written after every change, and reopening
 * resumes exactly where it stopped — with no model call, because the current
 * question is stored too.
 *
 * Gitignored: a half-finished interview is not a design decision anyone should
 * review. Deleted on commit: once `foundation.json` exists, the scratch is a
 * stale copy of a real file, and "resume" into it would re-propose decisions
 * the user already committed.
 */
import * as fs from "fs/promises"
import * as path from "path"

import { Logger } from "@/shared/services/Logger"
import type { WizardMode } from "./conductor"
import type { FoundationProposal, StoredQA, WizardQuestion } from "./widgets"

export interface WizardScratch {
	description: string
	/** Which interview this is; scratch written before modes existed is ai-led. */
	mode?: WizardMode
	/** Answered questions, in order. */
	history: StoredQA[]
	/** On screen but not yet answered, so resume re-renders it for free. */
	pending?: WizardQuestion
	/** Present once the model finished; the user is at the confirm screen. */
	proposal?: FoundationProposal
	updatedAt: number
}

function scratchPath(projectPath: string): string {
	return path.join(projectPath, ".caret", ".interview.json")
}

export async function readWizardScratch(projectPath: string): Promise<WizardScratch | null> {
	try {
		const raw = await fs.readFile(scratchPath(projectPath), "utf8")
		const parsed = JSON.parse(raw) as Partial<WizardScratch>
		// No description → nothing to ground a resume in. This also quietly
		// discards scratch from the pre-wizard flow, whose shape had no history.
		if (typeof parsed.description !== "string" || !parsed.description.trim()) return null
		if (!Array.isArray(parsed.history)) return null
		return {
			description: parsed.description,
			mode: parsed.mode === "collaborative" ? "collaborative" : "ai-led",
			history: parsed.history,
			pending: parsed.pending,
			proposal: parsed.proposal,
			updatedAt: parsed.updatedAt ?? 0,
		}
	} catch {
		return null
	}
}

export async function writeWizardScratch(projectPath: string, scratch: Omit<WizardScratch, "updatedAt">): Promise<void> {
	try {
		const file = scratchPath(projectPath)
		await fs.mkdir(path.dirname(file), { recursive: true })
		await fs.writeFile(file, `${JSON.stringify({ ...scratch, updatedAt: Date.now() }, null, 2)}\n`)
	} catch (err) {
		// Scratch is a convenience, never a precondition: an unwritable project
		// costs the resume point, not the interview.
		Logger.warn(`[wizard] could not save progress: ${err}`)
	}
}

export async function clearWizardScratch(projectPath: string): Promise<void> {
	await fs.rm(scratchPath(projectPath), { force: true }).catch(() => {})
}
