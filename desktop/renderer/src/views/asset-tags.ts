/**
 * Finding `@tag` references to real assets inside chat text.
 *
 * Deliberately a plain module with no React in it: the same tokenizer serves
 * the user bubbles (rendered as text) and the assistant markdown (rewritten at
 * the mdast level), and being pure is what lets a unit test hold the matching
 * rules down without a DOM.
 *
 * Only tags that exist in the index light up. An `@word` that matches nothing
 * stays plain text — underlining it would promise a click that resolves to
 * nothing, which is the exact failure `@tag` exists to avoid.
 */

/**
 * A token shaped like a tag: lowercase alphanumerics joined by single hyphens,
 * the grammar `validateTag` enforces. The trailing hyphen is excluded by the
 * grammar itself, so "@grain-" matches "grain" and the hyphen stays text.
 * The lookbehind keeps emails and handles-inside-words from matching.
 */
const TAG_TOKEN = /(?<![\w@])@([a-z0-9]+(?:-[a-z0-9]+)*)/g

export type TagSegment = { kind: "text"; text: string } | { kind: "tag"; tag: string }

/** Splits text into plain runs and known-tag references, in order. */
export function splitAssetTags(text: string, tags: ReadonlySet<string>): TagSegment[] {
	if (tags.size === 0 || !text.includes("@")) return text ? [{ kind: "text", text }] : []

	const segments: TagSegment[] = []
	let cursor = 0
	for (const match of text.matchAll(TAG_TOKEN)) {
		// The whole token has to be a tag. "@hero-imagery" when only "hero-image"
		// exists is a different word, not a tag with a suffix.
		if (!tags.has(match[1])) continue
		const start = match.index ?? 0
		if (start > cursor) segments.push({ kind: "text", text: text.slice(cursor, start) })
		segments.push({ kind: "tag", tag: match[1] })
		cursor = start + match[0].length
	}
	if (cursor === 0) return text ? [{ kind: "text", text }] : []
	if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) })
	return segments
}

/**
 * Tag references travel through markdown as links with this fragment scheme,
 * so the renderer's anchor component can tell them from real links and open
 * the viewer instead of the OS browser.
 */
const TAG_HREF_PREFIX = "#asset-tag:"

export function assetTagHref(tag: string): string {
	return `${TAG_HREF_PREFIX}${tag}`
}

export function assetTagFromHref(href: string | undefined): string | null {
	return href?.startsWith(TAG_HREF_PREFIX) ? href.slice(TAG_HREF_PREFIX.length) : null
}

/** The slice of mdast this transform touches. */
interface MdNode {
	type: string
	value?: string
	url?: string
	children?: MdNode[]
}

/**
 * A remark plugin that rewrites known `@tag` text into `#asset-tag:` links.
 *
 * Working on the tree rather than the source string is what keeps code spans
 * honest for free: their text lives in `code`/`inlineCode` values, not in text
 * nodes, so the walk never sees it. Existing links are left whole — a tag
 * inside someone's link text is that link's business.
 */
export function remarkAssetTags(tags: ReadonlySet<string>) {
	return (tree: MdNode): void => rewriteNode(tree, tags)
}

function rewriteNode(node: MdNode, tags: ReadonlySet<string>): void {
	if (!node.children || node.type === "link") return

	const next: MdNode[] = []
	for (const child of node.children) {
		if (child.type !== "text" || typeof child.value !== "string") {
			rewriteNode(child, tags)
			next.push(child)
			continue
		}

		const segments = splitAssetTags(child.value, tags)
		if (!segments.some((segment) => segment.kind === "tag")) {
			next.push(child)
			continue
		}
		for (const segment of segments) {
			next.push(
				segment.kind === "text"
					? { type: "text", value: segment.text }
					: { type: "link", url: assetTagHref(segment.tag), children: [{ type: "text", value: `@${segment.tag}` }] },
			)
		}
	}
	node.children = next
}
