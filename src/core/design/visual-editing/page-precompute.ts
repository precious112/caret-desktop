import * as recast from "recast"

import { applyEdits, type SpliceEdit } from "../param/splice"
import { parseSource } from "./ast-editor"

type ASTNode = recast.types.namedTypes.Node

export type DiagnosticCode = "dynamic-text" | "dynamic-image-src" | "dynamic-tailwind-class"

export interface DynamicRange {
	startLine: number
	startCol: number
	endLine: number
	endCol: number
	diagnostics: DiagnosticCode[]
}

/**
 * Counts of caret-id rule violations the precompute pass had to auto-heal. A
 * non-zero total means the AI ignored the design-layer caret-id rules — surfaced
 * so the breakage is observable, not silent.
 */
export interface CaretIdViolations {
	/** `data-caret-id={expr}` (not a string literal) → rewritten to a unique static id. */
	dynamic: number
	/** Same static id used on multiple elements → later ones renamed unique. */
	duplicate: number
	/** A `data-caret-id` on an element inside `.map()`/iterator → stripped. */
	inIterator: number
}

export interface PrecomputeResult {
	filePath: string
	modified: boolean
	correctedSource?: string
	dynamicRanges: DynamicRange[]
	caretIdViolations: CaretIdViolations
}

const VISIBLE_TAGS = new Set([
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"p",
	"span",
	"a",
	"button",
	"img",
	"input",
	"textarea",
	"label",
])

const ITERATOR_METHODS = new Set(["map", "forEach", "flatMap", "filter"])

const TAILWIND_COLOR_PREFIXES = [
	"bg-",
	"text-",
	"border-",
	"ring-",
	"from-",
	"to-",
	"via-",
	"outline-",
	"accent-",
	"fill-",
	"stroke-",
]

const CSS_TO_TAILWIND: Record<string, string> = {
	background: "bg",
	backgroundColor: "bg",
	color: "text",
	fontSize: "text",
	padding: "p",
	paddingTop: "pt",
	paddingRight: "pr",
	paddingBottom: "pb",
	paddingLeft: "pl",
	margin: "m",
	marginTop: "mt",
	marginRight: "mr",
	marginBottom: "mb",
	marginLeft: "ml",
	width: "w",
	height: "h",
	maxWidth: "max-w",
	minWidth: "min-w",
	maxHeight: "max-h",
	minHeight: "min-h",
	borderRadius: "rounded",
	borderColor: "border",
	gap: "gap",
	top: "top",
	right: "right",
	bottom: "bottom",
	left: "left",
	opacity: "opacity",
	zIndex: "z",
}

function isNativeElement(tagName: string): boolean {
	return tagName[0] === tagName[0].toLowerCase()
}

function isVisibleTag(tagName: string): boolean {
	return VISIBLE_TAGS.has(tagName)
}

/** Native DOM tag name (lowercase JSX identifier) or null. Drives inline-style conversion. */
function getTagName(node: recast.types.namedTypes.JSXElement): string | null {
	const name = node.openingElement.name
	if (name.type === "JSXIdentifier") return name.name
	return null
}

/**
 * The "effective" tag for caret-id targeting. Resolves a plain identifier (`h1`,
 * `div`, `Button`) AND a member expression's property (`motion.h2` → `"h2"`),
 * since framer-motion forwards `data-*` attributes to the underlying DOM tag.
 * Gated downstream by `isVisibleTag`, so only `motion.<visible-tag>` qualifies —
 * `motion.div` / `Tooltip.Trigger` fall out.
 */
function getCaretTagName(node: recast.types.namedTypes.JSXElement): string | null {
	const name = node.openingElement.name
	if (name.type === "JSXIdentifier") return name.name
	if (name.type === "JSXMemberExpression" && name.property.type === "JSXIdentifier") {
		return name.property.name
	}
	return null
}

function getCaretIdAttrs(node: recast.types.namedTypes.JSXElement): recast.types.namedTypes.JSXAttribute[] {
	const found: recast.types.namedTypes.JSXAttribute[] = []
	for (const attr of node.openingElement.attributes || []) {
		if (attr.type === "JSXAttribute" && attr.name.type === "JSXIdentifier" && attr.name.name === "data-caret-id") {
			found.push(attr)
		}
	}
	return found
}

function getSemanticHint(node: recast.types.namedTypes.JSXElement): string | null {
	const hintAttrs = ["alt", "placeholder", "aria-label"]
	for (const attr of node.openingElement.attributes || []) {
		if (
			attr.type === "JSXAttribute" &&
			attr.name.type === "JSXIdentifier" &&
			hintAttrs.includes(attr.name.name) &&
			attr.value?.type === "StringLiteral" &&
			attr.value.value.trim()
		) {
			return attr.value.value
				.trim()
				.toLowerCase()
				.replace(/[^a-z0-9\s-]/g, "")
				.replace(/\s+/g, "-")
				.slice(0, 30)
		}
	}
	return null
}

function toKebabId(prefix: string, hint: string | null): string {
	if (hint) return `${prefix}-${hint}`
	return prefix
}

/**
 * Whether an expression can actually PAINT text when it renders.
 *
 * The distinction this draws: `{cond && <li>…</li>}` is conditional
 * *presence* of static markup — every word inside is a string literal in the
 * file, and inline editing works on all of it. Flagging it as dynamic text
 * poisoned entire subtrees (field-measured: a filterable card grid wrapped
 * each card in `&&`, one range covered ~480 lines, and every static chip in
 * it refused "Edit text"). Only branches that can render as text — strings,
 * numbers, identifiers, calls — make text dynamic; markup, null and booleans
 * are structure.
 */
function rendersAsText(expr: { type: string } & Record<string, unknown>): boolean {
	switch (expr.type) {
		case "JSXElement":
		case "JSXFragment":
		case "NullLiteral":
		case "BooleanLiteral":
			return false
		case "LogicalExpression":
			// `a && b` renders `b`; a truthy guard never paints. (A falsy string
			// left side can technically render — rare enough to accept.)
			return rendersAsText(expr.right as never)
		case "ConditionalExpression":
			return rendersAsText(expr.consequent as never) || rendersAsText(expr.alternate as never)
		case "ParenthesizedExpression":
			return rendersAsText(expr.expression as never)
		default:
			return true
	}
}

function hasDynamicTextChild(node: recast.types.namedTypes.JSXElement): boolean {
	for (const child of node.children || []) {
		if (child.type !== "JSXExpressionContainer") continue
		const expr = child.expression
		if (expr.type === "StringLiteral" || expr.type === "JSXEmptyExpression") continue
		// Conditional structure whose every rendering branch is markup/null/
		// boolean carries no dynamic text of its own. A branch that IS a string
		// (`{cond ? "Easy" : "Hard"}`) still flags: it paints text from an
		// expression position, which the inline splice cannot edit.
		if ((expr.type === "LogicalExpression" || expr.type === "ConditionalExpression") && !rendersAsText(expr as never)) {
			continue
		}
		return true
	}
	return false
}

function hasDynamicImageSrc(node: recast.types.namedTypes.JSXElement): boolean {
	for (const attr of node.openingElement.attributes || []) {
		if (
			attr.type === "JSXAttribute" &&
			attr.name.type === "JSXIdentifier" &&
			attr.name.name === "src" &&
			attr.value?.type === "JSXExpressionContainer" &&
			attr.value.expression.type !== "StringLiteral"
		) {
			return true
		}
	}
	return false
}

function getClassNameAttr(node: recast.types.namedTypes.JSXElement): recast.types.namedTypes.JSXAttribute | null {
	for (const attr of node.openingElement.attributes || []) {
		if (attr.type === "JSXAttribute" && attr.name.type === "JSXIdentifier" && attr.name.name === "className") {
			return attr
		}
	}
	return null
}

function hasDynamicTailwindClass(node: recast.types.namedTypes.JSXElement): boolean {
	const attr = getClassNameAttr(node)
	if (!attr || attr.value?.type !== "JSXExpressionContainer") return false

	const expr = attr.value.expression
	if (expr.type === "TemplateLiteral" && expr.expressions.length > 0) {
		for (const quasi of expr.quasis) {
			const raw = quasi.value.raw
			if (
				TAILWIND_COLOR_PREFIXES.some(
					(p) => raw.endsWith(p) || (raw.includes(p) && raw.indexOf(p) < raw.length - p.length),
				)
			) {
				return true
			}
		}
	}
	return false
}

function getElementRange(node: recast.types.namedTypes.JSXElement): {
	startLine: number
	startCol: number
	endLine: number
	endCol: number
} | null {
	if (!node.loc) return null
	return {
		startLine: node.loc.start.line,
		startCol: node.loc.start.column,
		endLine: node.loc.end.line,
		endCol: node.loc.end.column,
	}
}

// ---------------------------------------------------------------------------
// Splice planning
//
// Detection walks the recast AST; every WRITE is a span edit against the
// original source, applied in one back-to-front pass by `applyEdits`. No
// `recast.print()`: a reprint diffs the whole tree and re-indents whatever it
// touches, which is the bug class the splice substrate exists to retire.
// ---------------------------------------------------------------------------

/** Character offsets straight from @babel/parser, present on every node. */
function spanOf(node: unknown): { start: number; end: number } {
	const n = node as { start?: number; end?: number }
	if (typeof n.start !== "number" || typeof n.end !== "number") {
		throw new Error("AST node carries no character offsets — parser configuration changed?")
	}
	return { start: n.start, end: n.end }
}

/** Removal span for an attribute, consuming the whitespace BEFORE it. */
function attrRemovalEdit(source: string, attr: unknown, floor: number): SpliceEdit {
	const { start, end } = spanOf(attr)
	let from = start
	while (from > floor && /\s/.test(source[from - 1])) from--
	return { start: from, end, text: "" }
}

/** Insertion point just inside the opening tag's `>` or `/>`. */
function beforeTagCloseInsertAt(source: string, opening: unknown): number {
	const { end } = spanOf(opening)
	let at = source.startsWith("/>", end - 2) ? end - 2 : end - 1
	while (at > 0 && /\s/.test(source[at - 1])) at--
	return at
}

const UNITLESS_PROPS = new Set(["opacity", "zIndex"])

/** The `background` shorthand converts only when it is plainly a colour — a gradient or image stays inline. */
function isPlainColorValue(value: string): boolean {
	return /^(#|rgb|rgba|hsl|hsla|oklch|oklab)/.test(value.trim())
}

interface InlineStylePlan {
	classes: string[]
	styleAttr: recast.types.namedTypes.JSXAttribute
	styleExpr: recast.types.namedTypes.ObjectExpression
	/** Property nodes that stay inline, kept as their original source slices. */
	remaining: Array<{ start: number; end: number }>
}

/**
 * Plans the inline-style conversion without touching the AST: which classes to
 * add, and which properties survive in the style object. Converted properties
 * LEAVE the object — the half-converted state used to keep them, so every
 * healer pass re-converted the same properties and appended the same classes
 * again: an unbounded `w-[320] h-[200] w-[320] …` write loop. With removal,
 * a second pass finds only unconvertible leftovers and plans nothing.
 */
function planInlineStyleConversion(node: recast.types.namedTypes.JSXElement): InlineStylePlan | null {
	let styleAttr: recast.types.namedTypes.JSXAttribute | null = null
	let styleExpr: recast.types.namedTypes.ObjectExpression | null = null

	for (const attr of node.openingElement.attributes || []) {
		if (
			attr.type === "JSXAttribute" &&
			attr.name.type === "JSXIdentifier" &&
			attr.name.name === "style" &&
			attr.value?.type === "JSXExpressionContainer" &&
			attr.value.expression.type === "ObjectExpression"
		) {
			styleAttr = attr
			styleExpr = attr.value.expression as recast.types.namedTypes.ObjectExpression
			break
		}
	}

	if (!styleAttr || !styleExpr) return null

	const classes: string[] = []
	const remaining: Array<{ start: number; end: number }> = []

	for (const prop of styleExpr.properties) {
		if (prop.type !== "ObjectProperty" && prop.type !== "Property") {
			remaining.push(spanOf(prop))
			continue
		}

		const key = prop.key.type === "Identifier" ? prop.key.name : prop.key.type === "StringLiteral" ? prop.key.value : ""
		const twPrefix = CSS_TO_TAILWIND[key]

		if (!twPrefix) {
			remaining.push(spanOf(prop))
			continue
		}

		let value: string | null = null
		if (prop.value.type === "StringLiteral") {
			value = prop.value.value
			// `background: "linear-gradient(...)"` is not `bg-[...]`'s job.
			if (key === "background" && !isPlainColorValue(value)) value = null
		} else if (
			prop.value.type === "NumericLiteral" ||
			(prop.value.type === "Literal" && typeof (prop.value as any).value === "number")
		) {
			// A number in a JSX style object means pixels — `w-[320]` is an inert
			// class; `w-[320px]` is the value the author wrote.
			const numeric = String((prop.value as any).value)
			value = UNITLESS_PROPS.has(key) ? numeric : `${numeric}px`
		}

		if (value !== null) {
			classes.push(`${twPrefix}-[${value.replace(/\s+/g, "_")}]`)
		} else {
			remaining.push(spanOf(prop))
		}
	}

	if (classes.length === 0) return null
	return { classes, styleAttr, styleExpr, remaining }
}

/**
 * The `dynamic-tailwind-class` AUTOFIX, for the one shape that is fixable
 * deterministically: a template className whose only interpolation is a
 * ternary of two string literals. Tailwind's JIT cannot see partial class
 * names in either arm, so the fix hoists the ternary to full class strings:
 *
 *     className={`p-4 bg-${dark ? "black" : "white"}`}
 *  →  className={dark ? "p-4 bg-black" : "p-4 bg-white"}
 *
 * Anything wider (multiple interpolations, non-literal arms, computed lookups)
 * stays a diagnostic — expanding it would guess at runtime values.
 */
function planDynamicClassAutofix(source: string, node: recast.types.namedTypes.JSXElement): SpliceEdit | null {
	const attr = getClassNameAttr(node)
	if (!attr || attr.value?.type !== "JSXExpressionContainer") return null
	const expr = attr.value.expression
	if (expr.type !== "TemplateLiteral" || expr.expressions.length !== 1 || expr.quasis.length !== 2) return null

	const inner = expr.expressions[0]
	if (inner.type !== "ConditionalExpression") return null
	if (inner.consequent.type !== "StringLiteral" || inner.alternate.type !== "StringLiteral") return null

	const pre = expr.quasis[0].value.cooked ?? expr.quasis[0].value.raw
	const post = expr.quasis[1].value.cooked ?? expr.quasis[1].value.raw
	const arm = (lit: string) => JSON.stringify(`${pre}${lit}${post}`.trim())
	const test = spanOf(inner.test)
	const whole = spanOf(expr)
	return {
		start: whole.start,
		end: whole.end,
		text: `${source.slice(test.start, test.end)} ? ${arm(inner.consequent.value)} : ${arm(inner.alternate.value)}`,
	}
}

function isInsideIterator(path: any): boolean {
	let current = path.parent
	while (current) {
		const node = current.node || current.value
		if (!node) break

		if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
			const grandparent = current.parent
			if (grandparent) {
				const gpNode = grandparent.node || grandparent.value
				if (gpNode && gpNode.type === "CallExpression" && gpNode.callee) {
					const callee = gpNode.callee
					if (
						callee.type === "MemberExpression" &&
						callee.property.type === "Identifier" &&
						ITERATOR_METHODS.has(callee.property.name)
					) {
						return true
					}
				}
			}
		}

		current = current.parent
	}
	return false
}

export function precomputePage(source: string, filePath: string): PrecomputeResult {
	let ast: ASTNode
	try {
		ast = parseSource(source)
	} catch (err) {
		console.error(`[design] precompute: failed to parse ${filePath}:`, err)
		return { filePath, modified: false, dynamicRanges: [], caretIdViolations: { dynamic: 0, duplicate: 0, inIterator: 0 } }
	}

	const dynamicRanges: DynamicRange[] = []
	const edits: SpliceEdit[] = []
	const idCounters = new Map<string, number>()
	const violations: CaretIdViolations = { dynamic: 0, duplicate: 0, inIterator: 0 }

	// Pre-pass: every static caret-id literal already in the file. Generated ids
	// must avoid these so we never collide with an author-provided id that appears
	// later in the document.
	const existingIds = new Set<string>()
	recast.types.visit(ast, {
		visitJSXElement(path) {
			const attr = getCaretIdAttrs(path.node)[0]
			if (attr?.value?.type === "StringLiteral") existingIds.add(attr.value.value)
			return this.traverse(path)
		},
	})

	// Caret-ids confirmed/assigned so far in document order — the uniqueness set.
	const usedIds = new Set<string>()

	function freshId(tagName: string, node: recast.types.namedTypes.JSXElement): string {
		const hint = getSemanticHint(node)
		let candidate: string
		do {
			const count = (idCounters.get(tagName) || 0) + 1
			idCounters.set(tagName, count)
			candidate = toKebabId(`${tagName}-${count}`, hint)
		} while (existingIds.has(candidate) || usedIds.has(candidate))
		usedIds.add(candidate)
		return candidate
	}

	recast.types.visit(ast, {
		visitJSXElement(path) {
			const node = path.node
			const nativeTag = getTagName(node)
			const caretTag = getCaretTagName(node)
			const nameEnd = spanOf(node.openingElement.name).end

			// Zero-width inserts directly after the tag name, combined into ONE
			// edit — applyEdits rightly refuses two inserts at the same offset.
			const nameEndInserts: string[] = []

			const inIterator = isInsideIterator(path)
			const range = getElementRange(node)

			// The fixable shape of dynamic-tailwind-class is FIXED, not reported.
			let dynamicClassFixed = false
			if (hasDynamicTailwindClass(node)) {
				const fix = planDynamicClassAutofix(source, node)
				if (fix) {
					edits.push(fix)
					dynamicClassFixed = true
				}
			}

			if (inIterator && range && caretTag) {
				const diagnostics: DiagnosticCode[] = []
				if (isVisibleTag(caretTag) && hasDynamicTextChild(node)) diagnostics.push("dynamic-text")
				if (caretTag === "img" && hasDynamicImageSrc(node)) diagnostics.push("dynamic-image-src")
				if (hasDynamicTailwindClass(node) && !dynamicClassFixed) diagnostics.push("dynamic-tailwind-class")
				if (diagnostics.length === 0 && !dynamicClassFixed) diagnostics.push("dynamic-text")
				if (diagnostics.length > 0) dynamicRanges.push({ ...range, diagnostics })
			}

			// Convert inline styles — native DOM elements only (never motion.* etc.,
			// whose `style` can carry animated motion values).
			if (nativeTag && isNativeElement(nativeTag)) {
				const plan = planInlineStyleConversion(node)
				if (plan) {
					if (plan.remaining.length === 0) {
						edits.push(attrRemovalEdit(source, plan.styleAttr, nameEnd))
					} else {
						const kept = plan.remaining.map((span) => source.slice(span.start, span.end)).join(", ")
						const exprSpan = spanOf(plan.styleExpr)
						edits.push({ start: exprSpan.start, end: exprSpan.end, text: `{ ${kept} }` })
					}

					const classStr = plan.classes.join(" ")
					const classAttr = getClassNameAttr(node)
					if (classAttr && classAttr.value?.type === "StringLiteral") {
						const valueSpan = spanOf(classAttr.value)
						edits.push({
							start: valueSpan.end - 1,
							end: valueSpan.end - 1,
							text: classAttr.value.value.length > 0 ? ` ${classStr}` : classStr,
						})
					} else {
						// No className, or a dynamic one: a new static attribute goes
						// last in the opening tag, so React's last-prop-wins keeps the
						// converted classes — the same outcome the AST push had.
						const at = beforeTagCloseInsertAt(source, node.openingElement)
						edits.push({ start: at, end: at, text: ` className="${classStr}"` })
					}
				}
			}

			// Normalize caret-ids on visible elements (native + motion.<visible-tag>):
			// every one must be a UNIQUE STATIC string literal, or the AST-based inline
			// editor can't locate it. This both auto-corrects and counts AI rule breaks.
			// Append-only: an existing valid id is never rewritten, and a clean rerun
			// plans zero edits — no write, no HMR, no heal loop.
			//
			// Iterator elements are seeded too (Phase 8.6): the id addresses the
			// TEMPLATE — one source span, N rendered rows — and the runtime side
			// carries the instance index. Look edits reach every row through the
			// template; content edits reach one row through the data literal.
			if (caretTag && isVisibleTag(caretTag)) {
				const idAttrs = getCaretIdAttrs(node)
				if (idAttrs.length === 0) {
					nameEndInserts.push(` data-caret-id="${freshId(caretTag, node)}"`)
				} else {
					const attr = idAttrs[0]
					if (attr.value?.type !== "StringLiteral") {
						// Dynamic id (`{expr}` / template / ternary) — the AST matcher only
						// matches string literals. Replace with a unique static one.
						const span = spanOf(attr)
						edits.push({ start: span.start, end: span.end, text: `data-caret-id="${freshId(caretTag, node)}"` })
						violations.dynamic++
					} else if (usedIds.has(attr.value.value)) {
						// Duplicate static id — rename the later occurrence.
						const valueSpan = spanOf(attr.value)
						edits.push({ start: valueSpan.start + 1, end: valueSpan.end - 1, text: freshId(caretTag, node) })
						violations.duplicate++
					} else {
						usedIds.add(attr.value.value)
					}
					// Extra data-caret-id attributes are always a mistake — drop them.
					for (const extra of idAttrs.slice(1)) edits.push(attrRemovalEdit(source, extra, nameEnd))
				}
			}

			if (nameEndInserts.length > 0) {
				edits.push({ start: nameEnd, end: nameEnd, text: nameEndInserts.join("") })
			}

			if (!inIterator && range && caretTag) {
				const diagnostics: DiagnosticCode[] = []
				if (hasDynamicTextChild(node)) diagnostics.push("dynamic-text")
				if (caretTag === "img" && hasDynamicImageSrc(node)) diagnostics.push("dynamic-image-src")
				if (hasDynamicTailwindClass(node) && !dynamicClassFixed) diagnostics.push("dynamic-tailwind-class")
				if (diagnostics.length > 0) {
					dynamicRanges.push({ ...range, diagnostics })
				}
			}

			return this.traverse(path)
		},
	})

	const totalViolations = violations.dynamic + violations.duplicate + violations.inIterator
	if (totalViolations > 0) {
		console.warn(
			`[design] precompute: auto-healed ${totalViolations} caret-id violation(s) in ${filePath} ` +
				`(dynamic: ${violations.dynamic}, duplicate: ${violations.duplicate}, in-iterator: ${violations.inIterator}) — ` +
				`AI likely ignored the design-layer caret-id rules`,
		)
	}

	const result: PrecomputeResult = { filePath, modified: false, dynamicRanges, caretIdViolations: violations }
	if (edits.length > 0) {
		try {
			const corrected = applyEdits(source, edits)
			if (corrected !== source) {
				result.modified = true
				result.correctedSource = corrected
			}
		} catch (err) {
			// Overlapping spans mean the plan was wrong for this shape — refuse the
			// whole write rather than corrupt the file. Detection results stand.
			console.error(`[design] precompute: splice plan failed for ${filePath}, leaving file untouched:`, err)
		}
	}
	return result
}
