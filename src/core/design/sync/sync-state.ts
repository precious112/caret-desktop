import * as fs from "fs/promises"
import * as path from "path"

import { Logger } from "@/shared/services/Logger"
import { runExclusive, writeFileAtomic } from "../file-mutation-queue"
import type { SyncState } from "../types"

const DEFAULT_SYNC_STATE: SyncState = { lastSyncedCommit: null }

function syncStatePath(workspacePath: string): string {
	return path.join(workspacePath, ".caret", "sync-state.json")
}

/**
 * Reads `.caret/sync-state.json`. Returns the default (lastSyncedCommit: null,
 * i.e. "never synced") when the file is missing or corrupt — a torn/invalid
 * state file should degrade to a full first-sync, never crash the sync flow.
 */
export async function readSyncState(workspacePath: string): Promise<SyncState> {
	let content: string
	try {
		content = await fs.readFile(syncStatePath(workspacePath), "utf-8")
	} catch {
		return { ...DEFAULT_SYNC_STATE }
	}
	try {
		const parsed = JSON.parse(content) as Partial<SyncState>
		return { lastSyncedCommit: typeof parsed.lastSyncedCommit === "string" ? parsed.lastSyncedCommit : null }
	} catch (err) {
		Logger.warn(`[sync] sync-state.json is not valid JSON; treating as never-synced: ${err}`)
		return { ...DEFAULT_SYNC_STATE }
	}
}

/**
 * Atomically writes `.caret/sync-state.json`, serialized against concurrent
 * writers (same temp+rename guarantee the rest of the design layer relies on).
 */
export async function writeSyncState(workspacePath: string, state: SyncState): Promise<void> {
	const filePath = syncStatePath(workspacePath)
	await runExclusive(filePath, async () => {
		await writeFileAtomic(filePath, JSON.stringify(state, null, 2))
	})
}

/**
 * Advances the sync bookmark to `commit` after a successful sync.
 */
export async function advanceSyncState(workspacePath: string, commit: string): Promise<void> {
	await writeSyncState(workspacePath, { lastSyncedCommit: commit })
}
