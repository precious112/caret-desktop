/**
 * Row-content resolution for `.map()` lists — Phase 8.6's split:
 *
 *   LOOK edits (classes, params) hit the TEMPLATE element — one source span,
 *   every row follows. That path needs nothing from this module; a template
 *   element with a caret-id is an ordinary splice target.
 *
 *   CONTENT edits (the text of row 2) hit the DATA — the array item the row
 *   rendered from. This module resolves a caret-id + instance index to the
 *   string literal inside the data array, when the data is reachable:
 *
 *     shape 1  `items.map(...)` over a same-file `const items = [...]`   → edit
 *     shape 2  `[...].map(...)` over an inline array literal             → edit
 *     shape 3  props / imports / call results — data lives elsewhere     → typed refusal
 *
 * Identity is positional over the source literal (row N ↔ element N), which is
 * exactly right for the literal shapes: the render order IS the literal order.
 * Anything reordered at runtime (sort, filter chains) fails the shape test and
 * refuses rather than guessing.
 */
import { parse } from "@babel/parser"

import type { SpliceEdit } from "./splice"

export type RowTextResolution =
	| { kind: "edit"; edits: SpliceEdit[]; itemLabel: string }
	| { kind: "refusal"; reason: string }
	| { kind: "unhandled" }

// biome-ignore lint/suspicious/noExplicitAny: walking Babel's untyped tree by shape
type Node = any

function parseOrNull(source: string): Node | null {
	try {
		return parse(source, { sourceType: "module", plugins: ["jsx", "typescript"], errorRecovery: false })
	} catch {
		return null
	}
}

/** Depth-first walk calling `fn` on every node; `fn` returning false prunes the subtree. */
function walk(node: Node, fn: (node: Node) => boolean | undefined): void {
	if (!node || typeof node !== "object") return
	if (Array.isArray(node)) {
		for (const child of node) walk(child, fn)
		return
	}
	if (typeof node.type === "string" && fn(node) === false) return
	for (const key of Object.keys(node)) {
		if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue
		const value = node[key]
		if (value && typeof value === "object") walk(value, fn)
	}
}

interface RowContext {
	element: Node
	/** The `.map()`/iterator call this element renders inside (nearest). */
	call: Node
	/** The iterator callback's item parameter name, if a plain identifier. */
	itemParam: string | null
}

const ITERATOR_METHODS = new Set(["map", "forEach", "flatMap", "filter"])

/** Finds the caret-id element and its nearest enclosing iterator call. */
function findRowContext(ast: Node, caretId: string): RowContext | null {
	let found: RowContext | null = null

	const visit = (node: Node, call: Node | null, itemParam: string | null): void => {
		if (!node || typeof node !== "object" || found) return
		if (Array.isArray(node)) {
			for (const child of node) visit(child, call, itemParam)
			return
		}
		if (typeof node.type !== "string") {
			for (const key of Object.keys(node)) {
				const value = node[key]
				if (value && typeof value === "object") visit(value, call, itemParam)
			}
			return
		}

		if (
			node.type === "CallExpression" &&
			node.callee?.type === "MemberExpression" &&
			node.callee.property?.type === "Identifier" &&
			ITERATOR_METHODS.has(node.callee.property.name)
		) {
			const callback = (node.arguments ?? [])[0]
			const param = callback?.params?.[0]
			const name = param?.type === "Identifier" ? param.name : null
			for (const argument of node.arguments ?? []) visit(argument, node, name)
			visit(node.callee, call, itemParam)
			return
		}

		if (node.type === "JSXElement" && call) {
			for (const attr of node.openingElement?.attributes ?? []) {
				if (
					attr.type === "JSXAttribute" &&
					attr.name?.type === "JSXIdentifier" &&
					attr.name.name === "data-caret-id" &&
					attr.value?.type === "StringLiteral" &&
					attr.value.value === caretId
				) {
					found = { element: node, call, itemParam }
					return
				}
			}
		}

		for (const key of Object.keys(node)) {
			if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue
			const value = node[key]
			if (value && typeof value === "object") visit(value, call, itemParam)
		}
	}

	visit(ast, null, null)
	return found
}

/** `item.a.b` rooted at `itemParam` → ["a","b"]; anything else null. */
function memberPathFrom(expr: Node, itemParam: string): string[] | null {
	const path: string[] = []
	let current = expr
	while (current?.type === "MemberExpression" && !current.computed && current.property?.type === "Identifier") {
		path.unshift(current.property.name)
		current = current.object
	}
	// An empty path is a real answer: `{tag}` over `["Bright", "Fruity"]`
	// renders the item itself — the rows are primitives, not objects. Requiring
	// a member access here misclassified that case as "computed" and refused an
	// edit the data literal supports perfectly well.
	if (current?.type === "Identifier" && current.name === itemParam) return path
	return null
}

/** The array literal `.map()` iterates, when it is reachable in this file. */
function resolveArrayLiteral(ast: Node, call: Node): Node | null {
	const target = call.callee.object

	if (target?.type === "ArrayExpression") return target

	if (target?.type === "Identifier") {
		let literal: Node | null = null
		walk(ast, (node) => {
			if (
				node.type === "VariableDeclarator" &&
				node.id?.type === "Identifier" &&
				node.id.name === target.name &&
				node.init?.type === "ArrayExpression"
			) {
				literal = node.init
			}
			return undefined
		})
		return literal
	}

	return null
}

/** Follows ["a","b"] through an object literal to the value node. */
function valueAtPath(objectExpr: Node, path: string[]): Node | null {
	let current: Node = objectExpr
	for (const segment of path) {
		if (current?.type !== "ObjectExpression") return null
		const prop = (current.properties ?? []).find(
			(p: Node) =>
				(p.type === "ObjectProperty" || p.type === "Property") &&
				((p.key?.type === "Identifier" && p.key.name === segment) ||
					(p.key?.type === "StringLiteral" && p.key.value === segment)),
		)
		if (!prop) return null
		current = prop.value
	}
	return current
}

/**
 * Resolves a text edit on row `instanceIndex` of the list element `caretId`
 * to a splice into the data literal — or a refusal that names what stands in
 * the way. `unhandled` means "not a row-content case at all" (no iterator, no
 * dynamic member text): the caller's ordinary chain should proceed.
 */
export function resolveRowTextEdit(
	source: string,
	caretId: string,
	instanceIndex: number,
	newText: string,
	oldText?: string,
): RowTextResolution {
	const ast = parseOrNull(source)
	if (!ast) return { kind: "unhandled" }

	const context = findRowContext(ast, caretId)
	if (!context) return { kind: "unhandled" }

	if (!context.itemParam) {
		return {
			kind: "refusal",
			reason: "This list's callback has a destructured or missing parameter — the row's data can't be traced to a name.",
		}
	}

	// The element's dynamic children that are member paths on the item.
	const candidates: Array<{ path: string[]; expr: Node }> = []
	let computed = 0
	for (const child of context.element.children ?? []) {
		if (child.type !== "JSXExpressionContainer") continue
		if (child.expression?.type === "JSXEmptyExpression" || child.expression?.type === "StringLiteral") continue
		const path = memberPathFrom(child.expression, context.itemParam)
		if (path) candidates.push({ path, expr: child.expression })
		else computed++
	}

	if (candidates.length === 0) {
		if (computed > 0) {
			return {
				kind: "refusal",
				reason: "This row's text is computed (a function call or expression), not read straight from the data — edit the data or the computation instead.",
			}
		}
		return { kind: "unhandled" }
	}
	if (candidates.length > 1) {
		return {
			kind: "refusal",
			reason: "This element renders several data fields — select the one you mean, or describe the change to the agent.",
		}
	}

	const arrayLiteral = resolveArrayLiteral(ast, context.call)
	if (!arrayLiteral) {
		return {
			kind: "refusal",
			reason: "This list's data comes from elsewhere (props, an import, or a call) — edit it at its source, or describe the change to the agent.",
		}
	}

	const items = (arrayLiteral.elements ?? []).filter(Boolean)
	if (instanceIndex < 0 || instanceIndex >= items.length) {
		return {
			kind: "refusal",
			reason: `Row ${instanceIndex + 1} has no matching item in the data literal (${items.length} items).`,
		}
	}

	const item = items[instanceIndex]
	let value: Node | null
	if (candidates[0].path.length === 0) {
		// `{tag}` renders the item itself: the row IS the value.
		value = item
	} else {
		if (item?.type !== "ObjectExpression") {
			return { kind: "refusal", reason: "The data item isn't an object literal — its fields can't be addressed by name." }
		}
		value = valueAtPath(item, candidates[0].path)
		if (!value) {
			return { kind: "refusal", reason: `The data item has no "${candidates[0].path.join(".")}" field to edit.` }
		}
	}

	const fieldLabel =
		candidates[0].path.length === 0
			? `item ${instanceIndex + 1}`
			: `item ${instanceIndex + 1} · ${candidates[0].path.join(".")}`

	if (value.type === "StringLiteral") {
		// Redelivery guard, same contract as spliceTextEdit: already-correct is
		// success without a write, and a stale oldText refuses.
		if (value.value === newText.trim()) return { kind: "edit", edits: [], itemLabel: fieldLabel }
		if (oldText !== undefined && value.value !== oldText.trim() && oldText.trim() !== "") {
			// Say what was compared: the page-side text against the data. Blaming
			// "the data changed" guessed at a cause — in the field the mismatch was
			// the page's own leftover text, and the message sent the user reloading
			// for nothing.
			return {
				kind: "refusal",
				reason: `The page showed "${oldText.trim()}" but the data says "${value.value}" — the page looks out of date. Reload it and try the edit again.`,
			}
		}
		return {
			kind: "edit",
			edits: [{ start: value.start, end: value.end, text: JSON.stringify(newText.trim()) }],
			itemLabel: fieldLabel,
		}
	}

	const fieldName = candidates[0].path.length === 0 ? "this item" : `"${candidates[0].path.join(".")}"`

	if (value.type === "NumericLiteral") {
		const numeric = Number(newText.trim())
		if (!Number.isFinite(numeric)) {
			return {
				kind: "refusal",
				reason: `${fieldName} is a number in the data — the new value must be numeric.`,
			}
		}
		return { kind: "edit", edits: [{ start: value.start, end: value.end, text: String(numeric) }], itemLabel: fieldLabel }
	}

	return {
		kind: "refusal",
		reason: `${fieldName} isn't a plain string or number in the data — edit the data directly.`,
	}
}
