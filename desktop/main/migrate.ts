/**
 * Brings a `.caret/` written by the VS Code extension up to date.
 *
 * Projects that predate the desktop app are the ones most worth not breaking —
 * they contain real design work. Migration is therefore additive and idempotent:
 * it adds what is missing and rewrites only what has genuinely changed shape,
 * and it never touches page sources, components, tokens or flows.
 */
import * as fs from "fs/promises"
import * as path from "path"

import { ensureCaretGitignore } from "../../src/core/design"
import { Logger } from "../../src/shared/services/Logger"

export interface MigrationReport {
	migrated: boolean
	notes: string[]
}

export async function migrateProject(projectPath: string): Promise<MigrationReport> {
	const notes: string[] = []

	// Adds any missing ignore lines, including `.mcp.json` (which holds the MCP
	// bearer token) and `.provenance.jsonl`. Both are new, so every pre-existing
	// project would otherwise commit them.
	await ensureCaretGitignore(projectPath).catch((err) => Logger.warn(`[migrate] gitignore: ${err}`))

	if (await migratePendingSync(projectPath)) {
		notes.push("Discarded an in-flight sync record from the extension — its rollback point no longer exists.")
	}

	if (await removeStaleShell(projectPath)) {
		notes.push("Removed the generated rendering shell so it regenerates from the current templates.")
	}

	if (notes.length > 0) {
		Logger.info(`[migrate] ${path.basename(projectPath)}: ${notes.join(" ")}`)
	}

	return { migrated: notes.length > 0, notes }
}

/**
 * The pending-sync record changed shape: `taskId` became `syncId`, and
 * `preSyncCheckpoint` (a shadow-git checkpoint hash) became `preSyncSnapshot` (a git
 * commit). An old record cannot be translated — the checkpoint shadow-git it
 * pointed at is gone with the task loop — so it is dropped rather than carried
 * forward as a rollback target that would silently do nothing.
 *
 * Dropping it is safe: the bookmark itself lives in `sync-state.json` and is
 * untouched, so at worst the next sync re-offers work that was already done.
 */
async function migratePendingSync(projectPath: string): Promise<boolean> {
	const target = path.join(projectPath, ".caret", ".sync-pending.json")
	try {
		const record = JSON.parse(await fs.readFile(target, "utf-8"))
		if (record?.syncId) return false // already the current shape
		await fs.rm(target, { force: true })
		return true
	} catch {
		return false
	}
}

/**
 * `.caret/lib/` is generated on every boot. Clearing it means a project opened
 * by an older Caret cannot end up running a stale canvas against a newer host —
 * a mismatch that shows up as messages silently going nowhere.
 */
async function removeStaleShell(projectPath: string): Promise<boolean> {
	const target = path.join(projectPath, ".caret", "lib")
	try {
		await fs.access(target)
	} catch {
		return false
	}
	try {
		await fs.rm(target, { recursive: true, force: true })
		return true
	} catch (err) {
		Logger.warn(`[migrate] could not clear the generated shell: ${err}`)
		return false
	}
}
