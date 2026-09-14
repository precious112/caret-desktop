/**
 * Advancing the sync bookmark, and undoing a sync.
 *
 * The bookmark in `.caret/sync-state.json` is advanced by OUR code, never by
 * instructing a model to write the file. That rule survives the move to an
 * external agent, but the *signal* had to change: there is no local task
 * lifecycle to hook any more, so completion arrives one of three ways, in
 * descending order of confidence:
 *
 *   1. the agent calls the `complete_sync` MCP tool (honor-system, but explicit)
 *   2. Caret detects the app tree moved since the pre-sync snapshot, and offers
 *      to mark it synced (never advances on this alone — it is a heuristic)
 *   3. the user marks it synced by hand
 *
 * All three matter. V1 shipped with only an implicit signal and the bookmark got
 * stuck at "never synced", which made every subsequent sync re-report the entire
 * design layer. That bug must not return.
 */
import * as fs from "fs/promises"
import * as path from "path"

import { Logger } from "@/shared/services/Logger"
import { runExclusive, writeFileAtomic } from "../file-mutation-queue"
import { ensureCaretGitignore } from "../scaffold"
import { clearSyncSnapshot, diffCountAgainstSnapshot, restoreSyncSnapshot, type SnapshotRestoreResult } from "./sync-snapshot"
import { advanceSyncState, writeSyncState } from "./sync-state"

/**
 * Durable record of the single in-flight sync.
 *
 * Persisted to a gitignored `.caret/.sync-pending.json` rather than held in
 * memory because a sync spans a long human-in-the-loop flow — the agent
 * proposes, the user reads, the user accepts — during which Caret may be
 * restarted. Only one sync runs at a time, so a single record suffices.
 */
export interface PendingSync {
	/** Caret-generated id for this sync. Echoed back by the agent's `complete_sync` call. */
	syncId: string
	/** The design HEAD this sync is reconciling the app up to. */
	commit: string
	/** The bookmark BEFORE this sync started — restored if the sync is rolled back. */
	previousBookmark: string | null
	/** Pre-sync git snapshot commit — the rollback target. Absent if capture failed. */
	preSyncSnapshot?: string
	/** ISO timestamp the sync was handed to the agent. */
	startedAt: string
	/** True once the bookmark has been advanced. Makes completion idempotent. */
	applied?: boolean
}

function pendingPath(cwd: string): string {
	return path.join(cwd, ".caret", ".sync-pending.json")
}

/** Reads the durable pending-sync record, or null when there is none / it's unreadable. */
export async function readPendingSync(cwd: string): Promise<PendingSync | null> {
	try {
		const parsed = JSON.parse(await fs.readFile(pendingPath(cwd), "utf-8")) as PendingSync
		return parsed && typeof parsed.syncId === "string" ? parsed : null
	} catch {
		return null
	}
}

async function writePendingSync(cwd: string, entry: PendingSync): Promise<void> {
	const filePath = pendingPath(cwd)
	await runExclusive(filePath, async () => {
		await writeFileAtomic(filePath, JSON.stringify(entry, null, 2))
	})
}

/** Records that `syncId` is syncing the design layer up to `commit` (durable). */
export async function registerPendingSync(
	cwd: string,
	entry: Omit<PendingSync, "applied" | "startedAt"> & { startedAt?: string },
): Promise<void> {
	// Guarantee `.sync-pending.json` is ignored before creating it, so it can't be
	// swept into the design auto-commit or trip the dirty check (handles existing
	// projects whose .gitignore predates this file).
	await ensureCaretGitignore(cwd).catch(() => {})
	await writePendingSync(cwd, { ...entry, startedAt: entry.startedAt ?? new Date().toISOString(), applied: false })
}

/** Drops the pending sync without advancing (caller-side cleanup). */
export async function clearPendingSync(cwd: string): Promise<void> {
	await fs.rm(pendingPath(cwd), { force: true }).catch(() => {})
	await clearSyncSnapshot(cwd)
}

export type CompleteSyncOutcome = "advanced" | "already-applied" | "no-pending-sync" | "wrong-sync" | "failed"

/**
 * Advances the bookmark for `syncId`. Idempotent — repeated calls after the
 * first are reported as `already-applied` rather than double-advancing.
 *
 * @param syncId omit to complete whichever sync is pending (the manual
 *   "mark synced" control, where the user is the authority rather than an agent).
 */
export async function completeSync(cwd: string, syncId?: string): Promise<CompleteSyncOutcome> {
	const entry = await readPendingSync(cwd)
	if (!entry) {
		return "no-pending-sync"
	}
	if (syncId !== undefined && entry.syncId !== syncId) {
		Logger.warn(`[sync] complete_sync for ${syncId} ignored — pending sync is ${entry.syncId}`)
		return "wrong-sync"
	}
	if (entry.applied) {
		return "already-applied"
	}

	try {
		await advanceSyncState(cwd, entry.commit)
	} catch (err) {
		Logger.error(`[sync] failed to advance bookmark for sync ${entry.syncId}:`, err)
		return "failed"
	}

	entry.applied = true
	await writePendingSync(cwd, entry)
	Logger.info(`[sync] bookmark advanced to ${entry.commit.slice(0, 8)} (sync ${entry.syncId})`)
	return "advanced"
}

/**
 * Whether the app appears to have been changed since the sync started.
 *
 * Deliberately coarse: it compares the current app tree against the pre-sync
 * snapshot, so it answers "did anything happen" and not "was the worklist
 * addressed". Phase 9's mapping manifest makes this exact. Until then it is only
 * ever used to *offer* marking the sync complete — never to advance the bookmark
 * on its own, because a wrong advance silently drops design changes from every
 * future sync.
 */
export async function detectSyncAddressed(cwd: string): Promise<boolean> {
	const entry = await readPendingSync(cwd)
	if (!entry?.preSyncSnapshot || entry.applied) {
		return false
	}
	return (await diffCountAgainstSnapshot(cwd, entry.preSyncSnapshot)) > 0
}

export interface RollbackResult {
	status: "rolledback" | "nothing"
	message: string
	restore?: SnapshotRestoreResult
}

/**
 * Undoes the most recent (possibly half-applied) sync: app files go back to the
 * pre-sync snapshot and the bookmark reverts to its previous value.
 *
 * The design change is deliberately preserved — it is committed in `.caret/` and
 * is the thing the user wanted synced — so the next sync re-offers it. Unlike
 * V1, this no longer requires the sync to still be the active task; there are no
 * tasks, and the snapshot is a git object that outlives any session.
 */
export async function rollbackSync(cwd: string): Promise<RollbackResult> {
	const record = await readPendingSync(cwd)
	if (!record) {
		return { status: "nothing", message: "No recent sync to roll back." }
	}

	let restore: SnapshotRestoreResult | undefined
	if (record.preSyncSnapshot) {
		restore = await restoreSyncSnapshot(cwd, record.preSyncSnapshot)
	}

	try {
		await writeSyncState(cwd, { lastSyncedCommit: record.previousBookmark })
	} catch (err) {
		Logger.error("[sync] rollback: failed to revert bookmark:", err)
	}

	await clearPendingSync(cwd)

	if (!restore?.restored) {
		return {
			status: "rolledback",
			message:
				"Reverted the sync bookmark. App file edits could not be undone automatically — no pre-sync snapshot was available.",
			restore,
		}
	}

	const changed = restore.reverted.length + restore.removed.length
	return {
		status: "rolledback",
		message:
			changed === 0
				? "Rolled back the last sync — the app had not been changed yet."
				: `Rolled back the last sync — ${restore.reverted.length} file(s) reverted, ${restore.removed.length} removed. Your design changes are untouched.`,
		restore,
	}
}
