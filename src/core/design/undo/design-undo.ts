/**
 * Unified undo for the design layer — Phase 8.7, cursor model.
 *
 * One history for every actor that writes `.caret/`: an inline splice, a panel
 * param edit, a bulk edit, an agent edit-lane turn. Each undoable boundary
 * captures the design layer as a REAL COMMIT OBJECT (the sync-snapshot
 * technique with the inverse pathspec: only `.caret/`, never app code), so a
 * step survives process restarts and git gc, and restore is scoped to exactly
 * the paths the step changed — the same restraint "Undo sync" has.
 *
 * Undo/redo is a CURSOR over that history, not pop-and-push. The first model
 * shipped as "redo is an undo of the undo": undoing pushed the pre-undo state
 * back on top, so a second ⌘Z restored what the first had just removed — undo
 * ping-ponged between the last two states forever and everything older was
 * buried (found in the field the first time someone actually leaned on it).
 * Now each undo walks the cursor one step back, redo walks it forward, and a
 * new edit while the cursor is set truncates the future — the model every
 * editor uses.
 */
import { execFile } from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { promisify } from "util"

import { Logger } from "@/shared/services/Logger"

import { runExclusive } from "../file-mutation-queue"
import { parseNameStatusZ } from "../sync/sync-snapshot"

const exec = promisify(execFile)

/** Undo history depth. Beyond this, the oldest step's ref is dropped. */
const MAX_STEPS = 50

/** Journal beside the design layer, never inside a snapshot of it. */
const JOURNAL_FILE = ".undo-journal.json"

const ONLY_CARET = ".caret/"
const EXCLUDE_JOURNAL = `:(exclude).caret/${JOURNAL_FILE}`

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
	const { stdout } = await exec("git", args, {
		cwd,
		env: env ? { ...process.env, ...env } : process.env,
		maxBuffer: 1024 * 1024 * 50,
	})
	return stdout
}

export interface UndoStep {
	/** Monotonic sequence, also the ref suffix (refs/caret/undo/<seq>). */
	seq: number
	/** Human label: "text edit on hero-subtitle", "agent turn: make it warmer". */
	label: string
	/** The actor that made the change this step precedes. `undo` marks the
	 * redo anchor — the live state captured when an undo walk began. */
	actor: "inline" | "agent" | "undo"
	commit: string
	at: string
}

interface Journal {
	steps: UndoStep[]
	nextSeq: number
	/**
	 * Where the workspace currently sits in the history: the index of the step
	 * whose snapshot it matches. Absent means live — no undo walk in progress.
	 * Steps above the cursor are the redo future; a new edit discards them.
	 */
	cursor?: number
}

function journalPath(cwd: string): string {
	return path.join(cwd, ".caret", JOURNAL_FILE)
}

async function readJournal(cwd: string): Promise<Journal> {
	try {
		const parsed = JSON.parse(await fs.readFile(journalPath(cwd), "utf-8"))
		if (Array.isArray(parsed.steps) && typeof parsed.nextSeq === "number") {
			const journal: Journal = { steps: parsed.steps, nextSeq: parsed.nextSeq }
			// Journals written before the cursor existed simply have none.
			if (typeof parsed.cursor === "number" && parsed.cursor >= 0 && parsed.cursor < parsed.steps.length) {
				journal.cursor = parsed.cursor
			}
			return journal
		}
	} catch {
		// Missing or corrupt journal: start clean. The refs of any orphaned
		// steps are unreachable from here and will simply age out.
	}
	return { steps: [], nextSeq: 1 }
}

async function writeJournal(cwd: string, journal: Journal): Promise<void> {
	await fs.writeFile(journalPath(cwd), JSON.stringify(journal, null, 2))
}

/** The last capture failure, verbatim — surfaced in undo results so a broken
 * environment names itself instead of hiding behind a generic message. */
let lastCaptureError = ""

/** The design layer as a tree-ish, via a throwaway index. */
async function captureCaretTree(cwd: string): Promise<string | null> {
	const tmpIndex = path.join(os.tmpdir(), `caret-undo-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
	try {
		const env = { GIT_INDEX_FILE: tmpIndex }
		// The journal must NOT be named in the add pathspec, not even as an
		// exclude: a pathspec that names a gitignored file makes `git add`
		// refuse outright ("use -f"), which broke capture in every scaffolded
		// project (they gitignore the journal). Stage everything, then drop the
		// journal from the throwaway index — rm --cached has no such rule.
		await git(cwd, ["add", "-A", "--", ONLY_CARET], env)
		await git(cwd, ["rm", "--cached", "-q", "--ignore-unmatch", `.caret/${JOURNAL_FILE}`], env).catch(() => {})
		return (await git(cwd, ["write-tree"], env)).trim()
	} catch (err) {
		lastCaptureError = err instanceof Error ? err.message : String(err)
		Logger.warn(`[design-undo] could not capture the design layer: ${err}`)
		return null
	} finally {
		await fs.rm(tmpIndex, { force: true }).catch(() => {})
	}
}

async function dropStepRef(cwd: string, seq: number): Promise<void> {
	await git(cwd, ["update-ref", "-d", `refs/caret/undo/${seq}`]).catch(() => {})
}

/**
 * Captures the design layer BEFORE a change, as one undoable boundary.
 * Best-effort by design: a workspace that is not a git repo (or has no HEAD)
 * gets no undo, and the edit proceeds — undo is a convenience, never a gate.
 */
export async function captureUndoStep(cwd: string, label: string, actor: UndoStep["actor"] = "inline"): Promise<void> {
	await runExclusive(`undo-journal:${cwd}`, async () => {
		const tree = await captureCaretTree(cwd)
		if (!tree) return

		const journal = await readJournal(cwd)

		// A new edit while the cursor sits in the past discards the future —
		// the states above the cursor can no longer be reached coherently.
		if (journal.cursor !== undefined) {
			const dropped = journal.steps.splice(journal.cursor + 1)
			for (const step of dropped) await dropStepRef(cwd, step.seq)
			journal.cursor = undefined
		}

		// Coalesce no-op boundaries: if nothing changed since the last step's
		// snapshot, a new step would make undo a frustrating stutter.
		const last = journal.steps[journal.steps.length - 1]
		if (last) {
			try {
				const lastTree = (await git(cwd, ["rev-parse", `${last.commit}^{tree}`])).trim()
				if (lastTree === tree) {
					await writeJournal(cwd, journal)
					return
				}
			} catch {
				// The last step's commit is gone (gc, clone) — proceed.
			}
		}

		let commit: string
		try {
			commit = (await git(cwd, ["commit-tree", tree, "-m", `caret undo step: ${label}`])).trim()
			await git(cwd, ["update-ref", `refs/caret/undo/${journal.nextSeq}`, commit])
		} catch (err) {
			Logger.warn(`[design-undo] could not write the step commit: ${err}`)
			return
		}

		journal.steps.push({ seq: journal.nextSeq, label, actor, commit, at: new Date().toISOString() })
		journal.nextSeq++

		while (journal.steps.length > MAX_STEPS) {
			const dropped = journal.steps.shift()
			if (dropped) await dropStepRef(cwd, dropped.seq)
		}
		await writeJournal(cwd, journal)
	})
}

export interface UndoResult {
	undone: boolean
	label?: string
	/** Design-layer paths written back or removed. */
	changed: string[]
	error?: string
}

/** Diff a step's snapshot against a live tree, restore what differs. */
async function restoreSnapshot(cwd: string, stepCommit: string, nowTree: string): Promise<{ changed: string[]; error?: string }> {
	let raw: string
	try {
		raw = await git(cwd, [
			"--no-pager",
			"diff",
			"--name-status",
			"-z",
			stepCommit,
			nowTree,
			"--",
			ONLY_CARET,
			EXCLUDE_JOURNAL,
		])
	} catch (err) {
		return { changed: [], error: `Could not compare against the undo step: ${err}` }
	}

	const changed: string[] = []
	for (const change of parseNameStatusZ(raw)) {
		try {
			if (change.status === "A") {
				await fs.rm(path.join(cwd, change.path), { force: true })
				changed.push(change.path)
			} else if (change.status === "R" && change.oldPath) {
				await fs.rm(path.join(cwd, change.path), { force: true })
				changed.push(change.path)
				await git(cwd, ["checkout", stepCommit, "--", change.oldPath])
				changed.push(change.oldPath)
			} else {
				await git(cwd, ["checkout", stepCommit, "--", change.path])
				changed.push(change.path)
			}
		} catch (err) {
			Logger.error(`[design-undo] could not restore ${change.path}:`, err)
		}
	}
	return { changed }
}

/** Does this step's snapshot differ from the live tree at all? */
async function stepDiffers(cwd: string, stepCommit: string, nowTree: string): Promise<boolean> {
	try {
		const raw = await git(cwd, [
			"--no-pager",
			"diff",
			"--name-status",
			"-z",
			stepCommit,
			nowTree,
			"--",
			ONLY_CARET,
			EXCLUDE_JOURNAL,
		])
		return parseNameStatusZ(raw).length > 0
	} catch {
		return true
	}
}

/** Walks the cursor one step back and restores that snapshot. */
export async function undoLastStep(cwd: string): Promise<UndoResult> {
	return runExclusive(`undo-journal:${cwd}`, async () => {
		const result: UndoResult = { undone: false, changed: [] }

		const journal = await readJournal(cwd)
		const now = await captureCaretTree(cwd)
		if (!now) {
			result.error = `Could not read the design layer: ${lastCaptureError || "unknown"}`
			return result
		}

		if (journal.cursor === undefined) {
			// Live: dead steps on top (an edit that then failed) are popped so
			// they never count as an undo, then the top real step is the target.
			while (journal.steps.length > 0) {
				const top = journal.steps[journal.steps.length - 1]
				if (await stepDiffers(cwd, top.commit, now)) break
				journal.steps.pop()
				await dropStepRef(cwd, top.seq)
			}
			const targetIndex = journal.steps.length - 1
			if (targetIndex < 0) {
				await writeJournal(cwd, journal)
				result.error = "Nothing to undo."
				return result
			}
			const target = journal.steps[targetIndex]

			// The live state becomes the redo anchor BEFORE anything is written,
			// so redo can walk all the way back up to it.
			let anchor: string | null = null
			try {
				anchor = (await git(cwd, ["commit-tree", now, "-m", `caret undo step: before undo of "${target.label}"`])).trim()
			} catch {
				anchor = null
			}

			const restored = await restoreSnapshot(cwd, target.commit, now)
			if (restored.error) {
				result.error = restored.error
				return result
			}

			if (anchor) {
				await git(cwd, ["update-ref", `refs/caret/undo/${journal.nextSeq}`, anchor]).catch(() => {})
				journal.steps.push({
					seq: journal.nextSeq,
					label: `before undo of "${target.label}"`,
					actor: "undo",
					commit: anchor,
					at: new Date().toISOString(),
				})
				journal.nextSeq++
			}
			journal.cursor = targetIndex
			await writeJournal(cwd, journal)

			result.undone = true
			result.label = target.label
			result.changed = restored.changed
		} else {
			// Mid-walk: continue down, skipping snapshots identical to here.
			let index = journal.cursor - 1
			while (index >= 0 && !(await stepDiffers(cwd, journal.steps[index].commit, now))) index--
			if (index < 0) {
				result.error = "Nothing to undo."
				return result
			}
			const target = journal.steps[index]
			const restored = await restoreSnapshot(cwd, target.commit, now)
			if (restored.error) {
				result.error = restored.error
				return result
			}
			journal.cursor = index
			await writeJournal(cwd, journal)

			result.undone = true
			result.label = target.label
			result.changed = restored.changed
		}

		Logger.info(`[design-undo] restored ${result.changed.length} path(s) for "${result.label}"`)
		return result
	})
}

/** Walks the cursor one step forward. Reaching the redo anchor returns to live. */
export async function redoStep(cwd: string): Promise<UndoResult> {
	return runExclusive(`undo-journal:${cwd}`, async () => {
		const result: UndoResult = { undone: false, changed: [] }

		const journal = await readJournal(cwd)
		if (journal.cursor === undefined || journal.cursor + 1 >= journal.steps.length) {
			result.error = "Nothing to redo."
			return result
		}

		const now = await captureCaretTree(cwd)
		if (!now) {
			result.error = `Could not read the design layer: ${lastCaptureError || "unknown"}`
			return result
		}

		const target = journal.steps[journal.cursor + 1]
		// The label names the edit being re-applied: the one whose pre-state is
		// where the cursor currently sits.
		const label = journal.steps[journal.cursor].label

		const restored = await restoreSnapshot(cwd, target.commit, now)
		if (restored.error) {
			result.error = restored.error
			return result
		}

		if (journal.cursor + 1 === journal.steps.length - 1 && target.actor === "undo") {
			// Back at the live edge: the anchor's job is done.
			journal.steps.pop()
			await dropStepRef(cwd, target.seq)
			journal.cursor = undefined
		} else {
			journal.cursor = journal.cursor + 1
		}
		await writeJournal(cwd, journal)

		result.undone = true
		result.label = label
		result.changed = restored.changed
		Logger.info(`[design-undo] redid ${result.changed.length} path(s) for "${label}"`)
		return result
	})
}

/** The visible history, most recent last. */
export async function listUndoSteps(cwd: string): Promise<UndoStep[]> {
	return (await readJournal(cwd)).steps
}
