/**
 * Bidirectional drift detection — a hash comparison over the manifest, with no
 * inference anywhere.
 *
 * Each mapping entry recorded both sides' content hashes at translation time.
 * Comparing them against the bytes on disk NOW classifies every mapped design
 * file:
 *
 *   design moved, app still     → "forward"   (an ordinary design→app sync)
 *   app moved, design still     → "app-drift" (the app walked away from the
 *                                  design — invisible before the manifest)
 *   both moved                  → "conflict"  (surfaced, never auto-merged)
 *   neither                     → "clean"
 *
 * A deleted app file counts as app movement (drift is drift, whether by edit
 * or by removal). A deleted design file is forward movement — the design
 * layer's deletions sync forward like its edits do.
 */
import * as path from "path"

import { hashFileContent, type MappingEntry, readManifest } from "./mapping-manifest"

export type DriftClass = "clean" | "forward" | "app-drift" | "conflict"

export interface DriftEntry {
	designPath: string
	appPaths: string[]
	classification: DriftClass
	designChanged: boolean
	/** App files whose content moved (or vanished) since the mapping was recorded. */
	changedAppPaths: string[]
}

export interface DriftReport {
	entries: DriftEntry[]
	forward: number
	appDrift: number
	conflicts: number
	clean: number
}

async function classifyEntry(workspacePath: string, entry: MappingEntry): Promise<DriftEntry> {
	const designNow = await hashFileContent(path.join(workspacePath, entry.designPath))
	const designChanged = designNow !== entry.designHash

	const changedAppPaths: string[] = []
	for (const appPath of entry.appPaths) {
		const recorded = entry.appHashes[appPath] ?? null
		const now = await hashFileContent(path.join(workspacePath, appPath))
		if (now !== recorded) changedAppPaths.push(appPath)
	}

	const classification: DriftClass =
		designChanged && changedAppPaths.length > 0
			? "conflict"
			: designChanged
				? "forward"
				: changedAppPaths.length > 0
					? "app-drift"
					: "clean"

	return { designPath: entry.designPath, appPaths: entry.appPaths, classification, designChanged, changedAppPaths }
}

export interface WorklistPartition {
	/** Genuinely needing a forward sync: unmapped, or design-hash moved with the app still. */
	toSync: string[]
	/** Mapped and verified already translated — the bookkeeping beats the bookmark. */
	alreadyTranslated: string[]
	/** Both sides moved since the mapping was recorded — a human chooses, never a merge. */
	conflicts: string[]
	/** The app moved and the design did not — reverse-sync material, not forward work. */
	appDrifted: string[]
}

/**
 * Filters a git-derived changed-file list through the manifest, making the
 * worklist EXACT instead of bookmark-coarse. The honor-system failure this
 * closes: an external agent that syncs but forgets `complete_sync` leaves the
 * bookmark stale, and the next sync re-reports everything it just did. The
 * manifest knows better — an entry whose hashes are unmoved on both sides is
 * already translated, whatever the bookmark thinks.
 *
 * Unmapped files pass through: a page that has never been synced has no entry,
 * and the git list is the only signal for it.
 */
export async function partitionWorklist(workspacePath: string, changedPaths: string[]): Promise<WorklistPartition> {
	const manifest = await readManifest(workspacePath)
	const byDesignPath = new Map(manifest.entries.map((entry) => [entry.designPath, entry]))

	const partition: WorklistPartition = { toSync: [], alreadyTranslated: [], conflicts: [], appDrifted: [] }

	for (const changedPath of changedPaths) {
		const entry = byDesignPath.get(changedPath)
		if (!entry) {
			partition.toSync.push(changedPath)
			continue
		}
		const classified = await classifyEntry(workspacePath, entry)
		switch (classified.classification) {
			case "clean":
				partition.alreadyTranslated.push(changedPath)
				break
			case "forward":
				partition.toSync.push(changedPath)
				break
			case "conflict":
				partition.conflicts.push(changedPath)
				break
			case "app-drift":
				// The git list says the design moved since the bookmark, but the
				// hash says it is back to (or still at) its recorded content — the
				// only live movement is the app's. Not forward work.
				partition.appDrifted.push(changedPath)
				break
		}
	}

	return partition
}

/** The full drift picture for every mapped design file. */
export async function computeDrift(workspacePath: string): Promise<DriftReport> {
	const manifest = await readManifest(workspacePath)
	const entries: DriftEntry[] = []
	for (const entry of manifest.entries) {
		entries.push(await classifyEntry(workspacePath, entry))
	}
	return {
		entries,
		forward: entries.filter((e) => e.classification === "forward").length,
		appDrift: entries.filter((e) => e.classification === "app-drift").length,
		conflicts: entries.filter((e) => e.classification === "conflict").length,
		clean: entries.filter((e) => e.classification === "clean").length,
	}
}
