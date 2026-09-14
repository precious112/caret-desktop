/**
 * Turning four answers into `foundation.json`.
 *
 * Caret builds the file, in this function, from library pieces the user pointed
 * at plus the same `generateTokenScale` the hand editor uses. **The model is
 * never asked to write it**, and not only for safety: a foundation assembled
 * from curated parts is one the user can keep editing afterwards in the token
 * editor, because it has the same shape as one built by hand. A file a model
 * emitted would be a one-off.
 *
 * Nothing here reaches the filesystem — the host does that, so the design core
 * stays testable without one.
 */
import { buildTokens, findPairing, findPreset, findRecipe } from "../foundation-library"
import type { FoundationTokens } from "../types"
import type { Decisions } from "./steps"
import { tagsFromDescription } from "./steps"

export interface CommittedFoundation {
	tokens: FoundationTokens
	/** For the provenance note and the confirmation line. */
	name: string
	typefaceName: string
	paletteName: string
	/** The restraint rule, which has to survive into every page generated later. */
	rule: string
}

export class IncompleteInterviewError extends Error {
	constructor(missing: string) {
		super(`The interview is missing its ${missing}, so there is nothing to write.`)
		this.name = "IncompleteInterviewError"
	}
}

/**
 * Builds the foundation the user assembled.
 *
 * Every id is re-resolved against the library rather than trusted: these values
 * have been to disk and back through scratch state, and an id the library no
 * longer has (a pairing removed between versions) must fail loudly here rather
 * than write a foundation referencing a typeface that cannot be loaded.
 */
export function buildFoundation(description: string, decisions: Decisions): CommittedFoundation {
	const typeface = decisions.typeface ? findPairing(decisions.typeface) : undefined
	if (!typeface) throw new IncompleteInterviewError("typeface")

	const palette = decisions.palette ? findRecipe(decisions.palette) : undefined
	if (!palette) throw new IncompleteInterviewError("colour direction")

	const shape = decisions.shape ? findPreset(decisions.shape) : undefined
	if (!shape) throw new IncompleteInterviewError("spacing and corners")

	// The user's own words are what the tags come from, so the vibe recorded in
	// the file is grounded in what they said rather than in what they clicked.
	const tags = tagsFromDescription(description)

	return {
		tokens: buildTokens({ typeface, palette, shape, tags, seed: decisions.brand }),
		name: `${typeface.name} · ${palette.name}`,
		typefaceName: typeface.name,
		paletteName: palette.name,
		rule: palette.rule,
	}
}
