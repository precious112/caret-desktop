/**
 * Matching `@tag` as it is typed.
 *
 * Pure and dependency-free so main, the renderer and the tests all use one
 * definition of what a mention is. The canvas keeps its own copy — generated
 * code shipped into the user's project cannot import from Caret — and this
 * module is the one to change first if the grammar ever moves.
 */

export interface MentionCandidate {
	tag: string
	description: string
}

/** The partial tag immediately before the caret, or null. */
export function mentionQueryAt(value: string, caret: number): { query: string; start: number } | null {
	const before = value.slice(0, caret)
	// Anchored to a boundary so an email address or a path never opens a picker.
	const match = before.match(/(^|[\s([{>])@([a-z0-9-]*)$/i)
	if (!match) return null
	return { query: match[2].toLowerCase(), start: caret - match[2].length - 1 }
}

/**
 * Assets worth offering for a partial tag, best first.
 *
 * Prefix matches lead, then anything whose tag or description contains the
 * text — the description is searchable because a user who added a photograph
 * months ago remembers "the dark wide one", not what they named it.
 */
export function rankMentions<T extends MentionCandidate>(assets: T[], query: string, limit = 8): T[] {
	if (!query) return assets.slice(0, limit)
	const starts = assets.filter((asset) => asset.tag.startsWith(query))
	const contains = assets.filter(
		(asset) =>
			!asset.tag.startsWith(query) &&
			(asset.tag.includes(query) || (asset.description ?? "").toLowerCase().includes(query)),
	)
	return [...starts, ...contains].slice(0, limit)
}

/** Replaces the partial tag under the caret with a full one, plus a space. */
export function applyMention(value: string, caret: number, start: number, tag: string): { value: string; caret: number } {
	const next = `${value.slice(0, start)}@${tag} ${value.slice(caret)}`
	return { value: next, caret: start + tag.length + 2 }
}
