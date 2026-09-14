/**
 * Asset tags — the `@` names.
 *
 * One name has to work in three places: typed by a person, autocompleted by the
 * editor, and read by an agent. That rules out anything needing quoting or
 * escaping, so the grammar is deliberately narrow.
 */

/** Lowercase alphanumerics and single hyphens, starting and ending on a word. */
const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const MAX_TAG_LENGTH = 48

/**
 * Words that would make `@tag` ambiguous or misleading.
 *
 * `@here` and `@everyone` read as broadcasts in every chat surface a user has
 * used, and a bare `@image` says nothing about *which* image while looking like
 * it does.
 */
const RESERVED = new Set(["here", "everyone", "all", "none", "image", "asset", "video", "icon", "logo"])

export function validateTag(tag: string): { ok: true } | { ok: false; reason: string } {
	if (!tag) return { ok: false, reason: "A tag cannot be empty." }
	if (tag.length > MAX_TAG_LENGTH) {
		return { ok: false, reason: `"${tag}" is longer than ${MAX_TAG_LENGTH} characters.` }
	}
	if (!TAG_PATTERN.test(tag)) {
		return {
			ok: false,
			reason: `"${tag}" is not a usable tag. Use lowercase letters, numbers and single hyphens — for example "hero-shot".`,
		}
	}
	if (RESERVED.has(tag)) {
		return { ok: false, reason: `"${tag}" is reserved because it reads as a category rather than a specific asset.` }
	}
	return { ok: true }
}

/** Best-effort tag from a filename, for assets that arrive without one. */
export function deriveTag(fileName: string): string {
	const base = fileName
		.replace(/\.[^.]+$/, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_TAG_LENGTH)
		.replace(/-+$/g, "")

	// Numeric-only names ("2024-04-11") and camera dumps ("IMG_4821") produce
	// tags nobody would type. A name is still better than a refusal here, since
	// this path exists for files that arrived without anyone naming them.
	if (!base || !TAG_PATTERN.test(base) || RESERVED.has(base)) return "asset"
	return base
}

/** Appends `-2`, `-3`, … until the tag is unique. */
export function uniqueTag(desired: string, taken: Iterable<string>): string {
	const used = new Set(taken)
	if (!used.has(desired)) return desired

	for (let suffix = 2; suffix < 1000; suffix++) {
		const candidate = `${desired}-${suffix}`.slice(0, MAX_TAG_LENGTH)
		if (!used.has(candidate)) return candidate
	}
	throw new Error(`Could not find a free tag based on "${desired}".`)
}

/**
 * Finds `@tag` references in free text.
 *
 * Deliberately not matched inside emails or paths: `a@b.com` and `user@host`
 * both contain something shaped like a reference, and expanding either into an
 * asset would be worse than missing a real one.
 */
export function findTagReferences(text: string): string[] {
	const found: string[] = []
	const pattern = /(^|[^\w@./-])@([a-z0-9]+(?:-[a-z0-9]+)*)/g

	for (const match of text.matchAll(pattern)) {
		if (!found.includes(match[2])) found.push(match[2])
	}
	return found
}
