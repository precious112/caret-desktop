/**
 * Watches git HEAD and offers a sync when unsynced design commits land.
 *
 * `.git/logs/HEAD` is appended to on every commit, checkout and reset, so
 * watching that one file fires exactly when HEAD moves and never otherwise.
 * This is a soft signal — it prompts, it never blocks and never syncs on its own.
 */

import chokidar, { type FSWatcher } from "chokidar"
import * as path from "path"

import { Logger } from "@/shared/services/Logger"
import { getLatestGitCommitHash, hasDesignChangesSince } from "@/utils/git"
import { caretDirectoryExists } from "../scaffold"
import { conversationFor, hostFor } from "../services"
import { computeDrift } from "./drift"
import { startReverseSyncProposal } from "./reverse-sync"
import { readPendingSync } from "./sync-completion"
import { runSync, type SyncResult } from "./sync-orchestrator"
import { readSyncState } from "./sync-state"

const DEBOUNCE_MS = 1500
const SYNC_NOW = "Sync now"

/**
 * Runs a sync, surfacing the preflight's fixable states as a confirm prompt.
 *
 * Shared by the canvas toolbar button, the menu command and the watcher, so
 * "sync" means the same thing however it was triggered.
 */
export async function runSyncInteractive(cwd: string): Promise<SyncResult> {
	let result = await runSync(cwd)

	if ((result.status === "needs-git-setup" || result.status === "needs-design-commit") && result.fixLabel) {
		const choice = await hostFor(cwd).notify("warn", result.message, [result.fixLabel])
		if (choice !== result.fixLabel) {
			return result // user declined the fix
		}
		result = await runSync(cwd, { autoFix: true })
	}

	const level = result.status === "git-not-installed" || result.status === "no-agent" ? "error" : "info"
	await hostFor(cwd).notify(level, result.message)

	// The reverse half (Phase 9): app drift and conflicts get a REVIEW, never a
	// merge. The compare surface doubles as the conflict choice — "Original" is
	// the design's version (keep it; the next forward sync carries it), "App's
	// version" is the drifted truth translated back (accept it; the mapping
	// refreshes and the design tells the truth again). One page at a time: the
	// variant scratch is exclusive by design.
	const conflicted = result.conflicts ?? []
	const drifted = result.appDrifted ?? []
	if (conflicted.length + drifted.length > 0) {
		const first = conflicted[0] ?? drifted[0]
		const kind = conflicted.length > 0 ? "conflict" : "drift"
		const label = "Review side by side"
		const message =
			kind === "conflict"
				? `"${first}" changed in BOTH the design and the app since they were last synced. Review the two versions and choose — Caret never merges for you.`
				: `The app walked away from "${first}" after it was translated. Review the app's version against the design and choose which is the truth.`
		const choice = await hostFor(cwd).notify("warn", message, [label])
		if (choice === label) {
			const start = await startReverseSyncProposal(cwd, first)
			if (!start.ok) {
				await hostFor(cwd).notify("error", start.reason ?? "Could not start the review.")
			}
		}
	}
	return result
}

export interface SyncWatcher {
	dispose(): Promise<void>
}

export function createSyncWatcher(cwd: string): SyncWatcher {
	const watcher: FSWatcher = chokidar.watch(path.join(cwd, ".git", "logs", "HEAD"), {
		ignoreInitial: true,
		// The file is appended to by git in one shot; a short stability window is
		// enough and keeps the first prompt from lagging behind the commit.
		awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
	})

	let timer: NodeJS.Timeout | undefined
	// Don't re-prompt for a HEAD we've already offered (or that's mid-sync).
	let lastHandledCommit: string | null = null

	const onHeadMoved = () => {
		if (timer) clearTimeout(timer)
		timer = setTimeout(async () => {
			try {
				if (!(await caretDirectoryExists(cwd))) return

				const head = await getLatestGitCommitHash(cwd)
				if (!head || head === lastHandledCommit) return

				const { lastSyncedCommit } = await readSyncState(cwd)
				if (lastSyncedCommit === head) return // already in sync

				// A sync in flight moves HEAD itself — the preflight commits `.caret/`
				// before planning — so without this the watcher offers a second sync
				// on top of the one the user is already reading, and the offer sits
				// there unanswerable until they dismiss it.
				if (await readPendingSync(cwd)) return
				if (conversationFor(cwd)?.getState().streaming) return

				if (!(await hasDesignChangesSince(cwd, lastSyncedCommit))) {
					// HEAD moved but the design didn't — before the manifest this was
					// the invisible case: an APP commit may have walked mapped files
					// away from their design. Check by hash, not by guess (Phase 9).
					const drift = await computeDrift(cwd)
					const touched = drift.entries.filter(
						(entry) => entry.classification === "app-drift" || entry.classification === "conflict",
					)
					if (touched.length === 0) return
					lastHandledCommit = head
					const first = touched[0]
					const label = "Review side by side"
					const choice = await hostFor(cwd).notify(
						"warn",
						touched.length === 1
							? `This commit changed app files that were translated from "${first.designPath}" — the design no longer tells the truth about them.`
							: `This commit drifted ${touched.length} mapped design files' app code — the design layer no longer tells the truth about them.`,
						[label],
					)
					if (choice === label) {
						const start = await startReverseSyncProposal(cwd, first.designPath)
						if (!start.ok) await hostFor(cwd).notify("error", start.reason ?? "Could not start the review.")
					}
					return
				}

				lastHandledCommit = head
				const choice = await hostFor(cwd).notify("info", "Design changes detected — sync them into the app?", [SYNC_NOW])
				if (choice === SYNC_NOW) {
					await runSyncInteractive(cwd)
				}
			} catch (error) {
				Logger.error("[sync] watcher check failed:", error)
			}
		}, DEBOUNCE_MS)
	}

	watcher.on("add", onHeadMoved)
	watcher.on("change", onHeadMoved)

	return {
		async dispose() {
			if (timer) clearTimeout(timer)
			await watcher.close()
		},
	}
}
