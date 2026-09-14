import * as fs from "fs/promises"
import { createRequire } from "module"

import * as recast from "recast"

import { writeFileAtomic } from "../file-mutation-queue"
import { COLOR_UTILITY_PREFIXES } from "./token-colors"

/**
 * `recast/parsers/babel-ts` is CommonJS and has no ESM entry point, and a bare
 * `require` does not exist inside an ES module — which is what the main process
 * bundle is. `createRequire` is the supported way to reach a CJS-only module
 * from ESM, and it keeps the parser object's shape intact (a plain `import`
 * would go through default-interop and hand recast the wrong thing).
 */
const babelParser = createRequire(import.meta.url)("recast/parsers/babel-ts")

type ASTNode = recast.types.namedTypes.Node

export function parseSource(source: string) {
	return recast.parse(source, {
		parser: babelParser,
		sourceFileName: "source.tsx",
	})
}

export function findJSXElementByCaretId(ast: ASTNode, caretId: string): recast.types.namedTypes.JSXElement | null {
	let match: recast.types.namedTypes.JSXElement | null = null

	recast.types.visit(ast, {
		visitJSXElement(path) {
			const node = path.node
			for (const attr of node.openingElement.attributes || []) {
				if (
					attr.type === "JSXAttribute" &&
					attr.name.type === "JSXIdentifier" &&
					attr.name.name === "data-caret-id" &&
					attr.value?.type === "StringLiteral" &&
					attr.value.value === caretId
				) {
					match = node
					return false
				}
			}
			return this.traverse(path)
		},
	})

	return match
}

export function findJSXElementAtLine(
	ast: ASTNode,
	lineNumber: number,
	tagName?: string,
): recast.types.namedTypes.JSXElement | null {
	let match: recast.types.namedTypes.JSXElement | null = null

	recast.types.visit(ast, {
		visitJSXElement(path) {
			const node = path.node
			const startLine = node.loc?.start.line
			if (startLine === lineNumber) {
				if (tagName) {
					const opening = node.openingElement
					if (opening.name.type === "JSXIdentifier" && opening.name.name.toLowerCase() === tagName) {
						match = node
						return false
					}
				} else {
					match = node
					return false
				}
			}
			return this.traverse(path)
		},
	})

	if (!match && tagName) {
		let closestDist = Number.POSITIVE_INFINITY
		recast.types.visit(ast, {
			visitJSXElement(path) {
				const node = path.node
				const startLine = node.loc?.start.line
				if (startLine) {
					const dist = Math.abs(startLine - lineNumber)
					if (dist < closestDist) {
						const opening = node.openingElement
						if (opening.name.type === "JSXIdentifier" && opening.name.name.toLowerCase() === tagName) {
							closestDist = dist
							match = node
						}
					}
				}
				this.traverse(path)
			},
		})
	}

	return match
}

export function findJSXElementAtPosition(ast: ASTNode, line: number, column: number): recast.types.namedTypes.JSXElement | null {
	let match: recast.types.namedTypes.JSXElement | null = null

	recast.types.visit(ast, {
		visitJSXElement(path) {
			const node = path.node
			const loc = node.loc
			if (!loc) return this.traverse(path)

			const afterStart = line > loc.start.line || (line === loc.start.line && column >= loc.start.column)
			const beforeEnd = line < loc.end.line || (line === loc.end.line && column <= loc.end.column)

			if (afterStart && beforeEnd) {
				match = node
			}

			this.traverse(path)
		},
	})

	return match
}

export async function editJSXText(
	filePath: string,
	lineNumber: number,
	tagName: string,
	newText: string,
	oldText?: string,
	caretId?: string,
): Promise<boolean> {
	try {
		console.log(
			`[design] editJSXText: file=${filePath} line=${lineNumber} tag=${tagName} caretId=${caretId} newText=${newText} oldText=${oldText}`,
		)
		const source = await fs.readFile(filePath, "utf-8")
		console.log(`[design] editJSXText: file read OK, ${source.length} chars`)
		const ast = parseSource(source)
		console.log(`[design] editJSXText: AST parsed OK`)
		const element = caretId
			? findJSXElementByCaretId(ast, caretId) || findJSXElementAtLine(ast, lineNumber, tagName)
			: findJSXElementAtLine(ast, lineNumber, tagName)
		console.log(`[design] editJSXText: element found=${!!element}`)

		if (!element) {
			console.warn(`[design] AST: no JSX element found at ${filePath}:${lineNumber} (tag=${tagName})`)
			return oldText ? fallbackTextReplace(filePath, source, oldText, newText) : false
		}

		// Stale-target guard: the client captured oldText from the DOM, but the
		// file may have shifted since (HMR, external edits). Only mutate content
		// that still matches what the user saw.
		//
		// Two distinct non-matching cases, and they must not share a fate:
		//
		// - Current text already equals **newText**: this edit has been applied
		//   once and is arriving again (a transport layer delivered it twice —
		//   observed). Report success and write nothing. Applying it anyway is
		//   how "Find your lane" -> "Find your lanes" produced "Find your
		//   laness": the raw fallback matched the old text as a prefix of the new.
		// - Current text is something else entirely: this node is not the target.
		//   Skip it and let the guarded unique-occurrence fallback look for the
		//   user's text elsewhere in the file.
		const normalize = (s: string) => s.replace(/\s+/g, " ").trim()
		const matchesOld = (current: string) => !oldText || normalize(current) === normalize(oldText)
		const alreadyApplied = (current: string) => normalize(current) === normalize(newText)

		const settle = (current: string): "write" | "done" | "skip" => {
			if (matchesOld(current)) return "write"
			if (alreadyApplied(current)) return "done"
			// Neither the text the user saw nor the one they asked for: leave this
			// node alone and let the unique-occurrence fallback look elsewhere — a
			// wrong-element hit with the real text further down the file is a case
			// it genuinely rescues. The fallback carries its own guard against the
			// one dangerous shape (oldText found inside an already-applied newText).
			return "skip"
		}

		for (const child of element.children || []) {
			if (child.type === "JSXText" && typeof child.value === "string" && child.value.trim()) {
				const verdict = settle(child.value)
				if (verdict === "done") {
					console.log(
						`[design] AST: text at ${filePath}:${lineNumber} already matches newText — duplicate edit, no write`,
					)
					return true
				}
				if (verdict === "skip") {
					console.warn(`[design] AST: text at ${filePath}:${lineNumber} no longer matches oldText — stale target`)
					continue
				}
				const leading = child.value.match(/^(\s*)/)?.[1] || ""
				const trailing = child.value.match(/(\s*)$/)?.[1] || ""
				child.value = leading + newText + trailing
				const output = recast.print(ast).code
				await writeFileAtomic(filePath, output)
				return true
			}
			if (child.type === "JSXExpressionContainer" && child.expression && child.expression.type === "StringLiteral") {
				const verdict = settle(child.expression.value)
				if (verdict === "done") return true
				if (verdict === "skip") continue
				child.expression.value = newText
				const output = recast.print(ast).code
				await writeFileAtomic(filePath, output)
				return true
			}
		}

		const attrs = element.openingElement.attributes || []
		for (const attr of attrs) {
			if (attr.type !== "JSXAttribute") continue
			const name = attr.name.type === "JSXIdentifier" ? attr.name.name : ""
			if (["label", "title", "placeholder", "alt", "children"].includes(name)) {
				if (attr.value?.type === "StringLiteral") {
					const verdict = settle(attr.value.value)
					if (verdict === "done") return true
					if (verdict === "skip") continue
					attr.value.value = newText
					const output = recast.print(ast).code
					await writeFileAtomic(filePath, output)
					return true
				}
			}
		}

		console.warn(`[design] AST: found element but no editable text content at ${filePath}:${lineNumber}`)
		if (oldText) return fallbackTextReplace(filePath, source, oldText, newText)
		return false
	} catch (err) {
		console.error(`[design] AST text edit failed:`, err)
		return false
	}
}

async function fallbackTextReplace(filePath: string, source: string, oldText: string, newText: string): Promise<boolean> {
	const idx = source.indexOf(oldText)
	if (idx === -1) {
		console.warn(`[design] fallback: oldText not found in source: "${oldText.slice(0, 50)}"`)
		return false
	}
	if (source.indexOf(oldText, idx + 1) !== -1) {
		console.warn(`[design] fallback: oldText appears multiple times, refusing ambiguous replace: "${oldText.slice(0, 50)}"`)
		return false
	}

	// The prefix trap. `indexOf` matches substrings, so once this edit has been
	// applied, an oldText that is contained in newText still "matches" — inside
	// the new text. Replacing there is the corruption this function shipped:
	// "Find your lane" found inside "Find your lanes" turned it into
	// "Find your laness". If the sole occurrence of oldText sits within an
	// occurrence of newText, the edit already happened; say so and write nothing.
	if (newText.includes(oldText)) {
		let cursor = source.indexOf(newText)
		while (cursor !== -1) {
			if (idx >= cursor && idx + oldText.length <= cursor + newText.length) {
				console.log(`[design] fallback: newText already present at offset ${cursor} — duplicate edit, no write`)
				return true
			}
			cursor = source.indexOf(newText, cursor + 1)
		}
	}

	const updated = source.slice(0, idx) + newText + source.slice(idx + oldText.length)
	await writeFileAtomic(filePath, updated)
	console.log(`[design] fallback: replaced text at offset ${idx}`)
	return true
}

// One list shared with the token binder — the recogniser and the binder must
// agree on what a colour class is.
const TAILWIND_COLOR_PREFIXES = COLOR_UTILITY_PREFIXES

const TAILWIND_COLOR_NAMES = new Set([
	"slate",
	"gray",
	"zinc",
	"neutral",
	"stone",
	"red",
	"orange",
	"amber",
	"yellow",
	"lime",
	"green",
	"emerald",
	"teal",
	"cyan",
	"sky",
	"blue",
	"indigo",
	"violet",
	"purple",
	"fuchsia",
	"pink",
	"rose",
	"white",
	"black",
	"transparent",
	"inherit",
	"current",
])

/**
 * Utility families that look like `prefix-name-number` but are not colours:
 * `ring-offset-2` is a width, `bg-opacity-50` (v3 legacy) is an alpha.
 */
const NON_COLOR_SUFFIX_FAMILIES = new Set(["opacity", "offset"])

function isTailwindColorClass(cls: string): boolean {
	return TAILWIND_COLOR_PREFIXES.some((prefix) => {
		if (!cls.startsWith(prefix)) return false
		const suffix = cls.slice(prefix.length)
		if (suffix.startsWith("[")) {
			const value = suffix.slice(1, -1)
			return /^#[0-9a-fA-F]{3,8}$/.test(value) || /^rgba?\(/.test(value) || /^hsla?\(/.test(value)
		}
		const parts = suffix.split("-")
		if (TAILWIND_COLOR_NAMES.has(parts[0])) return true

		// Custom theme colours. The foundation writes its own scale into the
		// generated theme — `text-brand-950`, straight from `foundation.json` —
		// and the design rules tell every agent to use it. A colour editor that
		// recognises only the stock palette cannot edit the very classes Caret's
		// own system produces, which is exactly the shape it will meet most.
		// The tell for "custom colour" versus "sized utility" is the shade: a
		// colour is `name…-number` with at least two segments (`brand-950`),
		// while widths are bare numbers (`border-2` → one segment) and sizes are
		// not numeric at all (`text-4xl`).
		if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1]) && !NON_COLOR_SUFFIX_FAMILIES.has(parts[0])) {
			return true
		}
		return false
	})
}

/**
 * Replaces the first colour class with `prefix + newSuffix` and reports which
 * class it replaced. The suffix is either an arbitrary value (`[#ff0000]` — a
 * detach) or a theme token name (`brand-500` — a bind); the replacer doesn't
 * care, but the caller uses `replacedClass` to notice a detach FROM a token.
 */
function replaceTailwindColorClass(className: string, newSuffix: string): { value: string; replacedClass: string } | null {
	const classes = className.split(/\s+/)
	let replacedClass: string | null = null

	const result = classes.map((cls) => {
		if (!replacedClass && isTailwindColorClass(cls)) {
			const prefix = TAILWIND_COLOR_PREFIXES.find((p) => cls.startsWith(p))!
			replacedClass = cls
			return `${prefix}${newSuffix}`
		}
		return cls
	})

	return replacedClass ? { value: result.join(" "), replacedClass } : null
}

const COLOR_STYLE_PROPS = ["color", "backgroundColor", "borderColor", "outlineColor", "fill", "stroke"]

export interface ColorEditResult {
	ok: boolean
	/** The class the edit replaced, when it replaced one (`text-brand-950`, `bg-[#101010]`, …). */
	replacedClass?: string
}

/**
 * @param tokenClass When set, writes this theme token suffix (`brand-500`)
 * instead of the arbitrary value — the picked colour exactly matched a token,
 * so the element binds to it rather than detaching to a magic number.
 */
export async function editJSXColor(
	filePath: string,
	lineNumber: number,
	newColor: string,
	caretId?: string,
	tokenClass?: string,
): Promise<ColorEditResult> {
	const newSuffix = tokenClass || `[${newColor}]`
	try {
		const source = await fs.readFile(filePath, "utf-8")
		const ast = parseSource(source)
		const element = caretId
			? findJSXElementByCaretId(ast, caretId) || findJSXElementAtLine(ast, lineNumber)
			: findJSXElementAtLine(ast, lineNumber)

		if (!element) {
			console.warn(`[design] AST: no JSX element found at ${filePath}:${lineNumber}`)
			return { ok: false }
		}

		const attrs = element.openingElement.attributes || []

		for (const attr of attrs) {
			if (attr.type !== "JSXAttribute") continue
			const name = attr.name.type === "JSXIdentifier" ? attr.name.name : ""

			if (name === "className" && attr.value) {
				if (attr.value.type === "StringLiteral") {
					const replaced = replaceTailwindColorClass(attr.value.value, newSuffix)
					if (replaced) {
						attr.value.value = replaced.value
						await writeFileAtomic(filePath, recast.print(ast).code)
						return { ok: true, replacedClass: replaced.replacedClass }
					}
				}
				if (attr.value.type === "JSXExpressionContainer") {
					const expr = attr.value.expression
					if (expr.type === "TemplateLiteral") {
						for (const quasi of expr.quasis) {
							const replaced = replaceTailwindColorClass(quasi.value.raw, newSuffix)
							if (replaced) {
								quasi.value.raw = replaced.value
								quasi.value.cooked = replaced.value
								await writeFileAtomic(filePath, recast.print(ast).code)
								return { ok: true, replacedClass: replaced.replacedClass }
							}
						}
					}
				}
			}

			if (name === "style" && attr.value?.type === "JSXExpressionContainer") {
				const expr = attr.value.expression
				if (expr.type === "ObjectExpression") {
					if (replaceColorInObjectExpression(expr, newColor)) {
						await writeFileAtomic(filePath, recast.print(ast).code)
						return { ok: true }
					}
				}
			}
		}

		if (replaceColorInStyleObject(ast, lineNumber, newColor)) {
			await writeFileAtomic(filePath, recast.print(ast).code)
			return { ok: true }
		}

		// Nothing to replace is not nothing to do. An element with no colour
		// class inherits its colour, and "make this text red" on it is the most
		// ordinary request the colour picker gets — refusing it with "use AI
		// Edit" turns a one-token change into a model call. Append the class
		// instead (or create className outright), the same suffix form the
		// replacer writes.
		for (const attr of attrs) {
			if (attr.type !== "JSXAttribute") continue
			const name = attr.name.type === "JSXIdentifier" ? attr.name.name : ""
			if (name === "className" && attr.value?.type === "StringLiteral") {
				attr.value.value = `${attr.value.value.trim()} text-${newSuffix}`.trim()
				await writeFileAtomic(filePath, recast.print(ast).code)
				console.log(`[design] AST: no colour class on the element — appended text-${newSuffix}`)
				return { ok: true }
			}
		}

		const hasClassName = attrs.some(
			(attr) => attr.type === "JSXAttribute" && attr.name.type === "JSXIdentifier" && attr.name.name === "className",
		)
		if (hasClassName) {
			// It exists but is not a plain string — a template literal or a computed
			// expression. Appending next to it would leave two classNames, and
			// editing inside it is genuinely a job for the model.
			console.warn(`[design] AST: className at ${filePath}:${lineNumber} is dynamic — deferring to AI edit`)
			return { ok: false }
		}

		const builders = recast.types.builders
		element.openingElement.attributes = [
			...attrs,
			builders.jsxAttribute(builders.jsxIdentifier("className"), builders.stringLiteral(`text-${newSuffix}`)),
		]
		await writeFileAtomic(filePath, recast.print(ast).code)
		console.log(`[design] AST: element had no className — added one with text-${newSuffix}`)
		return { ok: true }
	} catch (err) {
		console.error(`[design] AST color edit failed:`, err)
		return { ok: false }
	}
}

function replaceColorInObjectExpression(obj: recast.types.namedTypes.ObjectExpression, newColor: string): boolean {
	for (const prop of obj.properties) {
		if (prop.type !== "ObjectProperty" && prop.type !== "Property") continue
		const key = prop.key.type === "Identifier" ? prop.key.name : prop.key.type === "StringLiteral" ? prop.key.value : ""
		if (COLOR_STYLE_PROPS.includes(key) && (prop.value.type === "StringLiteral" || prop.value.type === "Literal")) {
			if (prop.value.type === "StringLiteral") {
				prop.value.value = newColor
			} else if ("value" in prop.value && typeof prop.value.value === "string") {
				prop.value.value = newColor
			}
			return true
		}
	}
	return false
}

function replaceColorInStyleObject(ast: ASTNode, lineNumber: number, newColor: string): boolean {
	let found = false
	recast.types.visit(ast, {
		visitObjectExpression(path) {
			const node = path.node
			const startLine = node.loc?.start.line || 0
			const endLine = node.loc?.end.line || 0
			if (startLine <= lineNumber + 5 && endLine >= lineNumber - 5) {
				if (replaceColorInObjectExpression(node, newColor)) {
					found = true
					return false
				}
			}
			return this.traverse(path)
		},
	})
	return found
}

export async function editJSXImageSrc(filePath: string, lineNumber: number, newSrc: string, caretId?: string): Promise<boolean> {
	try {
		const source = await fs.readFile(filePath, "utf-8")
		const ast = parseSource(source)
		const element = caretId
			? findJSXElementByCaretId(ast, caretId) || findJSXElementAtLine(ast, lineNumber, "img")
			: findJSXElementAtLine(ast, lineNumber, "img")

		if (!element) {
			console.warn(`[design] AST: no img element found at ${filePath}:${lineNumber}`)
			return false
		}

		const attrs = element.openingElement.attributes || []
		for (const attr of attrs) {
			if (attr.type !== "JSXAttribute") continue
			if (attr.name.type === "JSXIdentifier" && attr.name.name === "src") {
				if (attr.value?.type === "StringLiteral") {
					attr.value.value = newSrc
					await writeFileAtomic(filePath, recast.print(ast).code)
					return true
				}
			}
		}

		console.warn(`[design] AST: no src attribute found on img at ${filePath}:${lineNumber}`)
		return false
	} catch (err) {
		console.error(`[design] AST image edit failed:`, err)
		return false
	}
}
