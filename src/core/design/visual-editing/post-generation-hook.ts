import * as fs from "fs/promises"

import { runExclusive, writeFileAtomic } from "../file-mutation-queue"
import type { PrecomputeResult } from "./page-precompute"
import { precomputePage } from "./page-precompute"

export async function precomputeAndApply(filePath: string): Promise<PrecomputeResult> {
	// Serialized per file: precompute fires on page-focused and HMR updates and
	// writes the same page files inline edits do — racing them corrupts files.
	return runExclusive(filePath, async () => {
		const source = await fs.readFile(filePath, "utf-8")
		const result = precomputePage(source, filePath)

		if (result.modified && result.correctedSource) {
			await writeFileAtomic(filePath, result.correctedSource)
			console.log(`[design] precompute: corrected ${filePath} (added caret-ids / converted styles)`)
		}

		return result
	})
}
