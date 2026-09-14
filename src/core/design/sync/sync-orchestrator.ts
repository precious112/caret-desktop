import { randomUUID } from "crypto"

import { Logger } from "@/shared/services/Logger"
import {
	assessSyncGitState,
	getDesignLayerChangedFiles,
	getDesignLayerLog,
	getLatestGitCommitHash,
	hasDesignChangesSince,
} from "@/utils/git"
import { NoBackendError } from "../agent/backend"
import { caretDirectoryExists } from "../scaffold"
import { bridgeFor, conversationFor } from "../services"
import { emitDesignEvent } from "../telemetry-hooks"
import { partitionWorklist } from "./drift"
import { runBackendSync } from "./sync-backend"
import { clearPendingSync, registerPendingSync } from "./sync-completion"
import { commitDesignLayer, ensureGitRepo } from "./sync-git"
import { buildSyncPrompt } from "./sync-prompt"
import { captureSyncSnapshot } from "./sync-snapshot"
import { readSyncState } from "./sync-state"

export type SyncStatus =
	| "started"
	| "up-to-date"
	| "no-caret-dir"
	| "no-agent"
	| "git-not-installed"
	| "needs-git-setup"
	| "needs-design-commit"

export interface SyncResult {
	status: SyncStatus
	message: string
	/** Label for the one-click fix, present on fixable statuses (re-run with { autoFix: true }). */
	fixLabel?: string
	/** Number of changed design files handed to the agent. Present when status === "started". */
	changedCount?: number
	/** Id of the sync just started, for `complete_sync`. Present when status === "started". */
	syncId?: string
	/** Mapped files where BOTH sides moved — excluded from the forward sync, a human chooses. */
	conflicts?: string[]
	/** Mapped files where only the APP moved — reverse-sync material, not forward work. */
	appDrifted?: string[]
	/**
	 * The full sync worklist prompt. Present ONLY for `audience: "mcp"` — the
	 * calling agent is the one doing the translation, so the prompt goes back to
	 * it instead of into the bundled backend's conversation.
	 */
	prompt?: string
}

export interface SyncOptions {
	/** When true, perform the git fix (init/commit) the preflight would otherwise prompt for. */
	autoFix?: boolean
	/**
	 * Who carries the sync out. `backend` (default) hands it to the bundled
	 * backend's conversation — the Sync button's path. `mcp` hands the worklist
	 * BACK to the caller: an external agent working over Caret's MCP server does
	 * the translation itself, reports mappings with `report_sync_mapping`, and
	 * records the sync with `complete_sync`. No backend needs to be connected.
	 */
	audience?: "backend" | "mcp"
}

/**
 * Runs a design→app sync: get the design layer into a committed state, compute
 * the net changed-files worklist since the last sync, capture a rollback point,
 * and start the plan.
 *
 * The preflight is unchanged from V1 — it was the reliable part. The far end is
 * back to the V1 contract too, now that Caret owns the loop: plan, review,
 * apply, and Caret advances the bookmark itself (`sync-backend.ts`).
 */
export async function runSync(cwd: string, opts: SyncOptions = {}): Promise<SyncResult> {
	// One wrapper reads the funnel off the result instead of ten emit sites
	// inside the preflight: every non-started status IS the drop-off name.
	emitDesignEvent("sync_started", { audience: opts.audience ?? "backend" })
	const result = await runSyncInner(cwd, opts)
	if (result.status === "up-to-date") emitDesignEvent("sync_noop")
	else if (result.status !== "started") emitDesignEvent("sync_blocked", { status: result.status })
	return result
}

async function runSyncInner(cwd: string, opts: SyncOptions = {}): Promise<SyncResult> {
	if (!(await caretDirectoryExists(cwd))) {
		return { status: "no-caret-dir", message: "No .caret/ design layer in this project — nothing to sync." }
	}

	// Fail before doing any git work if there is nobody to hand the sync to.
	// Not for the MCP audience: the CALLER is the agent, and requiring the
	// bundled backend would refuse exactly the user who runs Caret purely as a
	// design tool and syncs with their own agent.
	const audience = opts.audience ?? "backend"
	if (audience === "backend" && !bridgeFor(cwd).connected()) {
		return { status: "no-agent", message: new NoBackendError("sync").message }
	}

	// Preflight: get the design layer into a committed state (the bookmark is a
	// commit hash). Each gap is either auto-fixed (after a confirmed re-run with
	// autoFix) or surfaced as a fixable status. All Caret commits are .caret/-scoped.
	const gitState = await assessSyncGitState(cwd)
	switch (gitState) {
		case "not-installed":
			return {
				status: "git-not-installed",
				message: "Git isn't installed. Sync needs git to track the design layer — install git and try again.",
			}
		case "no-repo":
		case "no-commits":
			if (opts.autoFix) {
				await ensureGitRepo(cwd)
				await commitDesignLayer(cwd, "chore(caret): initialize design layer")
			} else {
				return {
					status: "needs-git-setup",
					message:
						"This project needs a git repo with the design layer committed before syncing. Initialize git and commit .caret/ now?",
					fixLabel: "Initialize & commit .caret/",
				}
			}
			break
		case "dirty-design":
			if (opts.autoFix) {
				await commitDesignLayer(cwd, "design: sync checkpoint")
			} else {
				return {
					status: "needs-design-commit",
					message: "You have uncommitted design changes. Commit them (only the .caret/ folder) before syncing?",
					fixLabel: "Commit .caret/ changes",
				}
			}
			break
		case "ready":
			break
	}

	const { lastSyncedCommit } = await readSyncState(cwd)

	// Up-to-date is gated on actual design changes, NOT commit-hash equality:
	// an unrelated app commit moves HEAD but doesn't change the design.
	if (!(await hasDesignChangesSince(cwd, lastSyncedCommit))) {
		return { status: "up-to-date", message: "Design layer is already in sync with the app." }
	}

	const targetCommit = await getLatestGitCommitHash(cwd)
	if (!targetCommit) {
		// Defensive: assessSyncGitState already guaranteed commits exist.
		return { status: "up-to-date", message: "Design layer is already in sync with the app." }
	}

	// Net cumulative changed-files worklist (no file content) — the agent reads the
	// current `.caret/` + app sources itself. See buildSyncPrompt.
	const gitChangedFiles = await getDesignLayerChangedFiles(cwd, lastSyncedCommit)

	// The manifest makes the worklist EXACT where the bookmark is coarse:
	// entries verified already-translated drop out (the forgot-complete_sync
	// case re-reports nothing), conflicts are excluded from the forward sync
	// and surfaced, and app-only drift is reported as reverse-sync material.
	const partition = await partitionWorklist(
		cwd,
		gitChangedFiles.map((f) => f.path),
	)
	const toSyncSet = new Set(partition.toSync)
	const changedFiles = gitChangedFiles.filter((f) => toSyncSet.has(f.path))

	if (changedFiles.length === 0) {
		const held =
			partition.conflicts.length > 0
				? ` ${partition.conflicts.length} file(s) are in conflict (both sides changed) and need your choice.`
				: ""
		const drifted =
			partition.appDrifted.length > 0
				? ` ${partition.appDrifted.length} app file group(s) drifted from the design — review them from the Sync panel.`
				: ""
		return {
			status: "up-to-date",
			message:
				partition.alreadyTranslated.length > 0
					? `Every changed design file is verified already translated (the mapping manifest checked content, not the bookmark).${held}${drifted}`
					: `Design layer is already in sync with the app.${held}${drifted}`,
			...(partition.conflicts.length > 0 ? { conflicts: partition.conflicts } : {}),
			...(partition.appDrifted.length > 0 ? { appDrifted: partition.appDrifted } : {}),
		}
	}

	const intentLog = await getDesignLayerLog(cwd, lastSyncedCommit)
	const isFirstSync = lastSyncedCommit === null

	const syncId = randomUUID()
	const prompt = await buildSyncPrompt(cwd, { changedFiles, isFirstSync, intentLog, syncId, audience })

	// Capture the rollback point BEFORE the agent touches anything. Ordered this
	// way deliberately: an agent that starts editing the instant it receives the
	// prompt must not race the snapshot.
	const preSyncSnapshot = (await captureSyncSnapshot(cwd)) ?? undefined

	await registerPendingSync(cwd, {
		syncId,
		commit: targetCommit,
		previousBookmark: lastSyncedCommit,
		preSyncSnapshot,
	})

	if (audience === "mcp") {
		// The caller does the work: hand the worklist back. `report_sync_mapping`
		// and `complete_sync` are its half of the contract — the prompt says so.
		Logger.info(
			`[sync] Handed to MCP caller: ${changedFiles.length} changed design file(s), target ${targetCommit.slice(0, 8)}`,
		)
		return {
			status: "started",
			syncId,
			changedCount: changedFiles.length,
			prompt,
			...(partition.conflicts.length > 0 ? { conflicts: partition.conflicts } : {}),
			...(partition.appDrifted.length > 0 ? { appDrifted: partition.appDrifted } : {}),
			message: `The sync worklist is in \`prompt\` — carry it out now, then record it with complete_sync (syncId "${syncId}").`,
		}
	}

	const conversation = conversationFor(cwd)
	if (!conversation) {
		// The backend went away between the connected() check and here. Drop the
		// pending record so a stale sync can't be completed later.
		await clearPendingSync(cwd)
		return { status: "no-agent", message: new NoBackendError("sync").message }
	}

	// Deliberately not awaited. A sync is a plan, a human decision and an apply —
	// minutes of wall clock — and it reports its own progress into the chat. The
	// caller is a button that has to come back.
	void runBackendSync(conversation, { cwd, syncId, prompt, changedCount: changedFiles.length })

	Logger.info(`[sync] Started: ${changedFiles.length} changed design file(s), target ${targetCommit.slice(0, 8)}`)

	return {
		status: "started",
		syncId,
		changedCount: changedFiles.length,
		...(partition.conflicts.length > 0 ? { conflicts: partition.conflicts } : {}),
		...(partition.appDrifted.length > 0 ? { appDrifted: partition.appDrifted } : {}),
		message:
			changedFiles.length === 0
				? "Syncing design → app (reconciling full design state)."
				: `Syncing design → app: ${changedFiles.length} changed design file(s)${
						partition.conflicts.length > 0
							? ` — ${partition.conflicts.length} conflicted file(s) held back for your choice`
							: ""
					}.`,
	}
}
