/**
 * The caret-id → node index, built once per parse.
 *
 * The property panel resolves ~50 properties per selection; re-walking the AST
 * from the root per lookup measured 115ms on a large page — a visible stutter
 * on click — against 3.1ms for one walk plus a map (22–37×, widening with file
 * size). So: parse once, index every caret-id'd element with the SPANS the
 * splice editors need, and answer lookups from the map.
 *
 * **The risk is staleness, not speed.** An index whose file changed underneath
 * (HMR, an agent edit, an external save) has every offset wrong and splices
 * into the wrong place silently. The index is keyed to the file's content
 * hash and discarded on mismatch — hashing is ~30× cheaper than parsing, so
 * it is affordable on every access. Same rule as "recompute spans from disk,
 * never cache across edits", one level up.
 *
 * Parse is offsets-only (`@babel/parser` directly): no recast wrapper, no
 * codegen, nothing that could reformat.
 */
import { parse } from "@babel/parser"
import * as crypto from "crypto"

export interface AttributeSpan {
	/** The whole attribute (`className="a b"`), for removal/replacement. */
	start: number
	end: number
	/** The string VALUE's content span (inside the quotes), when it is a plain string. */
	valueStart: number | null
	valueEnd: number | null
	/** The raw value text, when plain. Null for expression values. */
	value: string | null
}

export interface TextSpan {
	/** Trimmed content span — never includes the surrounding whitespace, so a
	 * splice can never read or write indentation (the compounding-indent bug). */
	start: number
	end: number
	text: string
}

export interface IndexedElement {
	caretId: string
	tagName: string
	/** The whole element. */
	start: number
	end: number
	/** End of the opening tag — where a new attribute can be inserted (just before `>` / `/>`). */
	openingInsertAt: number
	attributes: Map<string, AttributeSpan>
	/** Direct JSXText children with non-empty trimmed content. */
	textSpans: TextSpan[]
	/** A direct child is a JSX expression — the text comes from data, not source. */
	hasDynamicText: boolean
	/** Inside `.map()`/`.forEach()`/… — one source span, N rendered rows. */
	inIterator: boolean
}

export interface SourceIndex {
	hash: string
	elements: Map<string, IndexedElement>
	/** Set when the file didn't parse; the index is empty and writes must refuse. */
	parseError?: string
}

const ITERATOR_METHODS = new Set(["map", "forEach", "flatMap", "filter"])

export function hashSource(source: string): string {
	return crypto.createHash("sha1").update(source).digest("hex")
}

/** Builds the index. Pure — no filesystem, no cache. */
export function indexSource(source: string): SourceIndex {
	const hash = hashSource(source)
	const elements = new Map<string, IndexedElement>()

	let ast: unknown
	try {
		ast = parse(source, {
			sourceType: "module",
			plugins: ["jsx", "typescript"],
			errorRecovery: false,
		})
	} catch (err) {
		return { hash, elements, parseError: err instanceof Error ? err.message : String(err) }
	}

	// biome-ignore lint/suspicious/noExplicitAny: walking Babel's untyped tree by shape
	const visit = (node: any, inIterator: boolean): void => {
		if (!node || typeof node !== "object") return

		if (Array.isArray(node)) {
			for (const child of node) visit(child, inIterator)
			return
		}

		const iteratorHere = inIterator
		if (
			node.type === "CallExpression" &&
			node.callee?.type === "MemberExpression" &&
			node.callee.property?.type === "Identifier" &&
			ITERATOR_METHODS.has(node.callee.property.name)
		) {
			// Everything under the call's arguments renders once per item.
			for (const argument of node.arguments ?? []) visit(argument, true)
			visit(node.callee, inIterator)
			return
		}

		if (node.type === "JSXElement") {
			indexElement(node, iteratorHere)
		}

		for (const key of Object.keys(node)) {
			if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue
			const value = node[key]
			if (value && typeof value === "object") visit(value, iteratorHere)
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: Babel node by shape
	const indexElement = (node: any, inIterator: boolean): void => {
		const opening = node.openingElement
		if (!opening) return

		const tagName =
			opening.name?.type === "JSXIdentifier"
				? opening.name.name
				: opening.name?.type === "JSXMemberExpression"
					? `${opening.name.object?.name ?? ""}.${opening.name.property?.name ?? ""}`
					: ""

		const attributes = new Map<string, AttributeSpan>()
		let caretId: string | null = null

		for (const attr of opening.attributes ?? []) {
			if (attr.type !== "JSXAttribute" || attr.name?.type !== "JSXIdentifier") continue
			const plain = attr.value?.type === "StringLiteral"
			attributes.set(attr.name.name, {
				start: attr.start,
				end: attr.end,
				valueStart: plain ? attr.value.start + 1 : null,
				valueEnd: plain ? attr.value.end - 1 : null,
				value: plain ? attr.value.value : null,
			})
			if (attr.name.name === "data-caret-id" && plain) caretId = attr.value.value
		}

		if (caretId && !elements.has(caretId)) {
			const textSpans: TextSpan[] = []
			let hasDynamicText = false
			for (const child of node.children ?? []) {
				if (
					child.type === "JSXExpressionContainer" &&
					child.expression?.type !== "StringLiteral" &&
					child.expression?.type !== "JSXEmptyExpression"
				) {
					hasDynamicText = true
				}
				if (child.type !== "JSXText") continue
				const raw: string = child.value ?? ""
				const trimmed = raw.trim()
				if (!trimmed) continue
				const leading = raw.indexOf(trimmed)
				textSpans.push({ start: child.start + leading, end: child.start + leading + trimmed.length, text: trimmed })
			}

			// Insertion point for a new attribute: after the last attribute, before
			// any trailing whitespace and the `/>` or `>` — so ` foo=""` inserted
			// there reads naturally in both `<img src=x />` and `<div>` shapes.
			const selfClosing = Boolean(opening.selfClosing)
			let openingInsertAt = opening.end - 1
			if (selfClosing) openingInsertAt -= 1
			while (openingInsertAt > opening.start && /\s/.test(source[openingInsertAt - 1])) openingInsertAt -= 1

			elements.set(caretId, {
				caretId,
				tagName,
				start: node.start,
				end: node.end,
				openingInsertAt,
				attributes,
				textSpans,
				hasDynamicText,
				inIterator,
			})
		}
	}

	visit(ast, false)
	return { hash, elements }
}

// ---------------------------------------------------------------------------
// The per-file cache, hash-checked on every access.
// ---------------------------------------------------------------------------

const cache = new Map<string, SourceIndex>()

/**
 * The index for this source, from cache when the content hash matches and
 * rebuilt when it does not. Callers pass the source they are about to splice —
 * the same bytes, always.
 */
export function getIndex(filePath: string, source: string): SourceIndex {
	const cached = cache.get(filePath)
	if (cached && cached.hash === hashSource(source)) return cached
	const fresh = indexSource(source)
	cache.set(filePath, fresh)
	return fresh
}

/** For tests and unusual invalidation (a file deleted mid-session). */
export function dropIndex(filePath: string): void {
	cache.delete(filePath)
}
