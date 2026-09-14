/**
 * The design↔app mapping manifest — Phase 9's foundation.
 *
 * `SyncState` is one field (the bookmark), so before this file existed there
 * was no record of WHAT maps to WHAT: every sync re-derived the whole
 * correspondence, and app-side drift was structurally invisible
 * (`hasDesignChangesSince` only watches `.caret/`).
 *
 * The mapping is RECORDED AT TRANSLATION TIME, never inferred. The agent
 * performing a sync already knows the correspondence — it read
 * `.caret/pages/checkout/index.tsx` and wrote `src/routes/checkout/page.tsx` —
 * so it reports the pair while the knowledge exists (the `report_sync_mapping`
 * tool). This turns an intractable content-matching inference problem into
 * bookkeeping, and bookkeeping is reliable. Drift then falls out as a hash
 * comparison in both directions, with no inference anywhere:
 *
 *   design hash moved → forward sync;  app hash moved → drift;
 *   both moved → conflict, surfaced and never auto-merged.
 *
 * The manifest lives at `.caret/sync-manifest.json`, versioned with the design
 * so collaborators share one idea of the correspondence.
 */
import * as crypto from "crypto"
import * as fs from "fs/promises"
import * as path from "path"

import { Logger } from "@/shared/services/Logger"

import { runExclusive, writeFileAtomic } from "../file-mutation-queue"

export interface MappingEntry {
	/** Repo-relative design file, e.g. ".caret/pages/checkout/index.tsx". */
	designPath: string
	/** Repo-relative app files this design file translated into. */
	appPaths: string[]
	/** The workspace HEAD when the mapping was recorded (null: no repo/commits). */
	syncedAt: string | null
	/** Content hash of the design file at record time (null: file missing). */
	designHash: string | null
	/** Content hash per app file at record time (null: file missing). */
	appHashes: Record<string, string | null>
	recordedAt: string
}

export interface SyncManifest {
	version: 1
	entries: MappingEntry[]
}

const EMPTY: SyncManifest = { version: 1, entries: [] }

export function manifestPath(workspacePath: string): string {
	return path.join(workspacePath, ".caret", "sync-manifest.json")
}

/** sha1 of the file's bytes, or null when it does not exist. */
export async function hashFileContent(absolutePath: string): Promise<string | null> {
	try {
		const bytes = await fs.readFile(absolutePath)
		return crypto.createHash("sha1").update(bytes).digest("hex")
	} catch {
		return null
	}
}

/**
 * Reads the manifest. Missing or corrupt degrades to empty — a torn manifest
 * must never crash a sync; it only means drift detection starts over as
 * mappings are re-recorded on the next sync.
 */
export async function readManifest(workspacePath: string): Promise<SyncManifest> {
	let raw: string
	try {
		raw = await fs.readFile(manifestPath(workspacePath), "utf-8")
	} catch {
		return { version: 1, entries: [] }
	}
	try {
		const parsed = JSON.parse(raw) as Partial<SyncManifest>
		if (parsed.version === 1 && Array.isArray(parsed.entries)) {
			return {
				version: 1,
				entries: parsed.entries.filter(
					(entry): entry is MappingEntry => typeof entry?.designPath === "string" && Array.isArray(entry?.appPaths),
				),
			}
		}
	} catch (err) {
		Logger.warn(`[sync] sync-manifest.json is not valid JSON; starting over: ${err}`)
	}
	return { ...EMPTY, entries: [] }
}

export async function writeManifest(workspacePath: string, manifest: SyncManifest): Promise<void> {
	const filePath = manifestPath(workspacePath)
	await runExclusive(filePath, async () => {
		await writeFileAtomic(filePath, JSON.stringify(manifest, null, 2))
	})
}

export interface MappingReport {
	designPath: string
	appPaths: string[]
}

/**
 * Records mappings as reported by the translating agent, hashing the CURRENT
 * content of both sides — call it when the app files are written, while the
 * agent's claim and the bytes on disk agree. Upserts by designPath: a re-sync
 * of a page replaces its mapping wholesale (files the new translation no
 * longer touches drop out with it).
 *
 * Paths are normalized to repo-relative POSIX form; absolute paths outside the
 * workspace are refused rather than recorded wrongly.
 */
export async function recordMappings(
	workspacePath: string,
	reports: MappingReport[],
	syncedAt: string | null,
): Promise<{ recorded: number; refused: string[] }> {
	const refused: string[] = []

	const normalize = (p: string): string | null => {
		const absolute = path.isAbsolute(p) ? p : path.join(workspacePath, p)
		const relative = path.relative(workspacePath, absolute)
		if (relative.startsWith("..") || path.isAbsolute(relative)) return null
		return relative.split(path.sep).join("/")
	}

	const manifest = await readManifest(workspacePath)
	let recorded = 0

	for (const report of reports) {
		const designPath = normalize(report.designPath)
		if (!designPath || !designPath.startsWith(".caret/")) {
			refused.push(`${report.designPath}: not a design-layer file`)
			continue
		}
		const appPaths: string[] = []
		let bad = false
		for (const rawAppPath of report.appPaths) {
			const appPath = normalize(rawAppPath)
			if (!appPath || appPath.startsWith(".caret/")) {
				refused.push(`${rawAppPath}: not an app file inside the workspace`)
				bad = true
				break
			}
			appPaths.push(appPath)
		}
		if (bad || appPaths.length === 0) {
			if (appPaths.length === 0 && !bad) refused.push(`${report.designPath}: no app files reported`)
			continue
		}

		const designHash = await hashFileContent(path.join(workspacePath, designPath))
		const appHashes: Record<string, string | null> = {}
		for (const appPath of appPaths) {
			appHashes[appPath] = await hashFileContent(path.join(workspacePath, appPath))
		}

		const entry: MappingEntry = {
			designPath,
			appPaths,
			syncedAt,
			designHash,
			appHashes,
			recordedAt: new Date().toISOString(),
		}
		const existing = manifest.entries.findIndex((e) => e.designPath === designPath)
		if (existing >= 0) manifest.entries[existing] = entry
		else manifest.entries.push(entry)
		recorded++
	}

	if (recorded > 0) await writeManifest(workspacePath, manifest)
	return { recorded, refused }
}

/** Drops entries whose design file no longer exists (page deleted). */
export async function pruneManifest(workspacePath: string): Promise<number> {
	const manifest = await readManifest(workspacePath)
	const kept: MappingEntry[] = []
	for (const entry of manifest.entries) {
		const exists = await fs
			.access(path.join(workspacePath, entry.designPath))
			.then(() => true)
			.catch(() => false)
		if (exists) kept.push(entry)
	}
	const dropped = manifest.entries.length - kept.length
	if (dropped > 0) await writeManifest(workspacePath, { version: 1, entries: kept })
	return dropped
}
