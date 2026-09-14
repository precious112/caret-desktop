/**
 * Pre-sync snapshots on plain git.
 *
 * V1 captured the rollback point with a checkpoint shadow-git, which dies
 * with the task loop. "Undo sync" is not optional — a sync rewrites app code
 * from a plan the user may only half-agree with — so the capability is
 * re-implemented here on git primitives that touch neither the user's index nor
 * their worktree.
 *
 * The snapshot is a real commit object written with a throwaway index:
 *
 *     GIT_INDEX_FILE=<tmp> git add -A     # stage everything, incl. untracked
 *     GIT_INDEX_FILE=<tmp> git write-tree # -> tree
 *     git commit-tree <tree> -p HEAD      # -> commit
 *     git update-ref refs/caret/pre-sync  # keep it alive against gc
 *
 * Restore is deliberately *scoped to what actually changed*, computed by diffing
 * the snapshot against a fresh snapshot taken at rollback time. Anything the sync
 * did not touch is never written to, so unrelated work in progress survives.
 *
 * `.caret/` is excluded throughout. The design change is the thing being synced
 * and must survive a rollback so the next sync re-offers it; the bookmark is
 * reverted explicitly by the caller rather than by restoring a file.
 */
import { execFile } from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { promisify } from "util"

import { Logger } from "@/shared/services/Logger"

const exec = promisify(execFile)

/** Where the snapshot commit is anchored so git's gc cannot collect it. */
const SNAPSHOT_REF = "refs/caret/pre-sync"

/**
 * Restricts every snapshot operation to app code. `:(exclude)` is a git pathspec
 * magic prefix, supported since 1.9.
 */
const EXCLUDE_CARET = ":(exclude).caret/"

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
	const { stdout } = await exec("git", args, {
		cwd,
		env: env ? { ...process.env, ...env } : process.env,
		maxBuffer: 1024 * 1024 * 50,
	})
	return stdout
}

/**
 * Records the current state of the app as a commit object, without staging
 * anything or moving HEAD.
 *
 * @returns the snapshot commit hash, or null when the repo has no HEAD yet (a
 *   project with no commits has nothing to roll back to, and sync's preflight
 *   already refuses to run in that state).
 */
export async function captureSyncSnapshot(cwd: string): Promise<string | null> {
	const tmpIndex = path.join(os.tmpdir(), `caret-sync-index-${process.pid}-${Date.now()}`)
	try {
		const head = (await git(cwd, ["rev-parse", "HEAD"])).trim()

		// A throwaway index means `add -A` never touches what the user has staged.
		const env = { GIT_INDEX_FILE: tmpIndex }
		await git(cwd, ["add", "-A", "--", ".", EXCLUDE_CARET], env)
		const tree = (await git(cwd, ["write-tree"], env)).trim()

		const commit = (await git(cwd, ["commit-tree", tree, "-p", head, "-m", "caret: pre-sync snapshot"])).trim()
		await git(cwd, ["update-ref", SNAPSHOT_REF, commit])

		Logger.info(`[sync] pre-sync snapshot captured at ${commit.slice(0, 8)}`)
		return commit
	} catch (err) {
		Logger.warn(`[sync] could not capture pre-sync snapshot (rollback will be unavailable): ${err}`)
		return null
	} finally {
		await fs.rm(tmpIndex, { force: true }).catch(() => {})
	}
}

export interface SnapshotRestoreResult {
	restored: boolean
	/** Repo-relative paths written back to their pre-sync content. */
	reverted: string[]
	/** Repo-relative paths the sync created, now removed. */
	removed: string[]
	error?: string
}

/**
 * Undoes everything the sync did to app files, and nothing else.
 *
 * Works by diffing the pre-sync snapshot against the current state and acting
 * only on the paths that differ: files the sync created are deleted, files it
 * changed or deleted are written back from the snapshot.
 */
export async function restoreSyncSnapshot(cwd: string, snapshot: string): Promise<SnapshotRestoreResult> {
	const result: SnapshotRestoreResult = { restored: false, reverted: [], removed: [] }

	const now = await captureCurrentTree(cwd)
	if (now === null) {
		result.error = "Could not read the current working tree."
		return result
	}

	let raw: string
	try {
		raw = await git(cwd, ["--no-pager", "diff", "--name-status", "-z", snapshot, now, "--", ".", EXCLUDE_CARET])
	} catch (err) {
		result.error = `Could not compare against the pre-sync snapshot: ${err}`
		return result
	}

	for (const change of parseNameStatusZ(raw)) {
		try {
			if (change.status === "A") {
				// Created by the sync — remove it.
				await fs.rm(path.join(cwd, change.path), { force: true })
				result.removed.push(change.path)
			} else if (change.status === "R" && change.oldPath) {
				// Renamed by the sync — drop the new name, restore the old one.
				await fs.rm(path.join(cwd, change.path), { force: true })
				result.removed.push(change.path)
				await git(cwd, ["checkout", snapshot, "--", change.oldPath])
				result.reverted.push(change.oldPath)
			} else {
				// Modified or deleted by the sync — write the pre-sync content back.
				await git(cwd, ["checkout", snapshot, "--", change.path])
				result.reverted.push(change.path)
			}
		} catch (err) {
			Logger.error(`[sync] rollback: could not restore ${change.path}:`, err)
		}
	}

	result.restored = true
	Logger.info(`[sync] rollback restored ${result.reverted.length} file(s), removed ${result.removed.length}`)
	return result
}

/**
 * How many app files differ from the snapshot. Used as the coarse "did the agent
 * do anything" signal before Phase 9's mapping manifest makes it exact.
 */
export async function diffCountAgainstSnapshot(cwd: string, snapshot: string): Promise<number> {
	const now = await captureCurrentTree(cwd)
	if (now === null) return 0
	try {
		const raw = await git(cwd, ["--no-pager", "diff", "--name-status", "-z", snapshot, now, "--", ".", EXCLUDE_CARET])
		return parseNameStatusZ(raw).length
	} catch (err) {
		Logger.error("[sync] could not diff against the pre-sync snapshot:", err)
		return 0
	}
}

/** Drops the snapshot ref. The snapshot commit becomes collectable. */
export async function clearSyncSnapshot(cwd: string): Promise<void> {
	await git(cwd, ["update-ref", "-d", SNAPSHOT_REF]).catch(() => {})
}

/** A tree-ish for the current worktree, captured the same way as a snapshot. */
async function captureCurrentTree(cwd: string): Promise<string | null> {
	const tmpIndex = path.join(os.tmpdir(), `caret-sync-now-${process.pid}-${Date.now()}`)
	try {
		const env = { GIT_INDEX_FILE: tmpIndex }
		await git(cwd, ["add", "-A", "--", ".", EXCLUDE_CARET], env)
		return (await git(cwd, ["write-tree"], env)).trim()
	} catch (err) {
		Logger.error("[sync] could not snapshot the current tree:", err)
		return null
	} finally {
		await fs.rm(tmpIndex, { force: true }).catch(() => {})
	}
}

interface NameStatusChange {
	status: string
	path: string
	/** Set for renames/copies: the path as it was in the snapshot. */
	oldPath?: string
}

/**
 * Parses `git diff --name-status -z`. NUL separation is used rather than newline
 * because paths can legally contain newlines, and a mis-split path here would
 * mean deleting the wrong file.
 *
 * Record shape: `STATUS\0path\0` — except renames and copies, which are
 * `STATUS\0oldPath\0newPath\0`.
 */
export function parseNameStatusZ(raw: string): NameStatusChange[] {
	const fields = raw.split("\0").filter((f) => f.length > 0)
	const out: NameStatusChange[] = []
	for (let i = 0; i < fields.length; ) {
		const status = fields[i][0]
		if (status === "R" || status === "C") {
			const oldPath = fields[i + 1]
			const newPath = fields[i + 2]
			if (oldPath === undefined || newPath === undefined) break
			out.push({ status, path: newPath, oldPath })
			i += 3
		} else {
			const filePath = fields[i + 1]
			if (filePath === undefined) break
			out.push({ status, path: filePath })
			i += 2
		}
	}
	return out
}
