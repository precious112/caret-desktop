/**
 * The splice primitive — every Phase 8 source write is a span replacement.
 *
 * Not recast: `print()` cannot know which subtrees changed without diffing the
 * whole tree against the original, so it costs O(nodes) per write (~35ms vs
 * ~4ms on a 600-line file) and — worse — it *reformats*. The compounding-
 * indentation bug was exactly that: recast re-indented the reprinted subtree,
 * the next edit read the inflated whitespace back, and indentation grew one
 * level per edit. A splice writes the bytes it was asked to write and no other
 * byte moves; the bug class cannot exist.
 *
 * Rules (settled 2026-07-27):
 * - Offsets are absolute character indices in UTF-16 code units — what Babel
 *   reports and what `String.slice` consumes. (If SWC ever replaces Babel its
 *   spans are UTF-8 BYTE offsets; that is a conversion, not a drop-in.)
 * - Apply back-to-front so earlier offsets stay valid.
 * - Recompute spans from disk every time; never cache across edits.
 * - One splice pass per batch, one atomic serialized write.
 */
import * as fs from "fs/promises"

import { runExclusive, writeFileAtomic } from "../file-mutation-queue"

export interface SpliceEdit {
	/** Inclusive start, absolute UTF-16 offset into the source. */
	start: number
	/** Exclusive end. `start === end` inserts. */
	end: number
	/** Replacement text. */
	text: string
}

/**
 * Applies span replacements to a string. Pure. Throws on overlapping or
 * out-of-range spans — an overlap means two edits disagree about the same
 * bytes, and silently applying either order would corrupt the file.
 */
export function applyEdits(source: string, edits: SpliceEdit[]): string {
	const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end)

	for (const edit of ordered) {
		if (edit.start < 0 || edit.end > source.length || edit.start > edit.end) {
			throw new Error(`splice out of range: [${edit.start}, ${edit.end}) in ${source.length} chars`)
		}
	}
	for (let i = 1; i < ordered.length; i++) {
		// Descending by start: the previous entry starts at or after this one.
		if (ordered[i].end > ordered[i - 1].start) {
			throw new Error(
				`overlapping splices: [${ordered[i].start}, ${ordered[i].end}) and [${ordered[i - 1].start}, ${ordered[i - 1].end})`,
			)
		}
	}

	let out = source
	for (const edit of ordered) {
		out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
	}
	return out
}

/**
 * Reads the file, applies the batch, writes atomically — serialized per file
 * with every other design-layer write. The read happens INSIDE the exclusive
 * section: spans computed against a file another write got to first would
 * splice into the wrong offsets silently.
 *
 * `compute` receives the current source and returns the edits (or null to
 * decline) — the caller derives spans from the same bytes that get spliced.
 */
export async function spliceFile(
	filePath: string,
	compute: (source: string) => SpliceEdit[] | null | Promise<SpliceEdit[] | null>,
): Promise<boolean> {
	return runExclusive(filePath, async () => {
		const source = await fs.readFile(filePath, "utf-8")
		const edits = await compute(source)
		if (!edits || edits.length === 0) return false
		const next = applyEdits(source, edits)
		if (next === source) return false
		await writeFileAtomic(filePath, next)
		return true
	})
}
