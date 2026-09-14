/**
 * Filling in the asset index's measured-pixel metadata after a reindex.
 *
 * `opaqueBox` — where an image's visible pixels actually sit — exists so that
 * geometry handed to a model can point at the *object* in a cutout PNG rather
 * than the transparent margins around it. The arithmetic lives in
 * `src/core/design` where it is pure and unit-tested; this wrapper is only the
 * Electron dance: decode with `nativeImage`, measure, and hand the results to
 * the store for one locked index write.
 *
 * Fire-and-forget by design: enrichment is a courtesy on top of the index, and
 * a decode failure on one file must never block or fail the reindex that
 * triggered it. Absence of the field is a valid state everywhere it is read.
 */

import { nativeImage } from "electron"
import * as path from "path"

import { alphaBounds, worthIndexing } from "../../src/core/design/asset-library/raster/alpha-bounds"
import { assetsDirectory, readAssetIndex, setOpaqueBoxes } from "../../src/core/design/assets/store"
import { Logger } from "../../src/shared/services/Logger"

/**
 * Measures opaque-pixel bounds for indexed PNGs that lack one.
 *
 * PNG only in v1: `nativeImage` decodes it reliably and the cutout lane —
 * where transparent margins actually occur — emits PNG. Entries whose bytes
 * changed had their stale bound dropped by the reindex, so "missing" is the
 * only state to fill.
 */
export async function enrichOpaqueBoxes(projectPath: string, beforeWrite?: () => void): Promise<void> {
	const index = await readAssetIndex(projectPath)
	const directory = assetsDirectory(projectPath)

	const boxes = new Map<string, { x: number; y: number; width: number; height: number } | null>()
	for (const entry of index.assets) {
		if (entry.mime !== "image/png" || entry.opaqueBox !== undefined) continue

		const image = nativeImage.createFromPath(path.join(directory, entry.file))
		const { width, height } = image.getSize()
		if (!width || !height) continue

		const bounds = alphaBounds({ data: image.toBitmap(), width, height, order: "bgra" })
		// An edge-to-edge opaque image records nothing — reindex already dropped
		// any stale bound when the bytes changed, and recording nulls here would
		// rewrite the index on every pass for every plain PNG.
		if (bounds && worthIndexing(bounds, width, height)) boxes.set(entry.file, bounds)
	}

	if (boxes.size === 0) return
	// Every measured entry lacked a bound, so this call will write. The caller
	// marks the index write as its own BEFORE it lands, never speculatively — a
	// mark with no following write would swallow the next real external edit.
	beforeWrite?.()
	await setOpaqueBoxes(projectPath, boxes)
}

/** The watcher seam calls this without awaiting; failures are logged, never thrown. */
export function enrichOpaqueBoxesSoon(projectPath: string, beforeWrite?: () => void): void {
	enrichOpaqueBoxes(projectPath, beforeWrite).catch((err) => {
		Logger.warn(`[assets] opaque-box enrichment failed: ${err instanceof Error ? err.message : String(err)}`)
	})
}
