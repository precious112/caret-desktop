/**
 * One page of a list that grows with the project. What an agent loads stays
 * the same size whether the project has ten assets or a thousand: it asks for
 * the next page, or searches, when it needs more.
 */
export interface Page<T> {
	items: T[]
	total: number
	page: number
	pages: number
	/** Said in words, so an agent knows there is more without doing arithmetic. */
	more: string | null
}

export function pageOf<T>(all: T[], page: number | undefined, perPage: number, noun: string): Page<T> {
	const size = Math.max(1, Math.floor(perPage))
	const pages = Math.max(1, Math.ceil(all.length / size))
	const current = Math.min(Math.max(1, Math.floor(page ?? 1)), pages)
	const items = all.slice((current - 1) * size, current * size)
	return {
		items,
		total: all.length,
		page: current,
		pages,
		more: current < pages ? `${all.length - current * size} more ${noun}: ask for page ${current + 1}` : null,
	}
}

/** Case-insensitive match of every search word against an item's text. */
export function matchesSearch(text: string, search: string | undefined): boolean {
	if (!search?.trim()) return true
	const haystack = text.toLowerCase()
	return search
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.every((word) => haystack.includes(word))
}
