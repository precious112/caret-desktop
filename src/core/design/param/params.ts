/**
 * The Param model — the vocabulary a hand and an agent share.
 *
 * **Source writes, runtime verifies.** Computed style is a lossy projection:
 * `p-4 md:p-8` computes to one number with no hint which class produced it,
 * px→step is ambiguous, shorthands collapse, and typography is overwhelmingly
 * inherited. So resolution is inverted: the class list IS the declaration
 * list (a controlled Tailwind environment makes expanding it exact), and the
 * runtime's computed value is a *check* — when source resolution and the
 * runtime disagree, something else is in play (an inline style, a wrapper
 * class) and the honest answer is `writable: false` with a reason, never a
 * confident wrong write.
 *
 * Everything here is pure string/offset work over the source index — no DOM,
 * no filesystem — so the rules that must be right are unit-testable without a
 * running canvas.
 */
import type { FoundationTokens } from "../types"
import { foundationTokenForClass, tokenValue } from "../visual-editing/token-colors"
import type { IndexedElement } from "./source-index"
import type { SpliceEdit } from "./splice"

// ---------------------------------------------------------------------------
// The descriptor
// ---------------------------------------------------------------------------

export type ParamType = "color" | "length" | "number" | "enum" | "string" | "keyword"

export type ParamOrigin = "literal" | "token" | "inherited" | "computed" | "data"

export interface Param {
	/** `<caretId>/style/<property>` — the address a hand and an agent share. */
	path: string
	property: string
	type: ParamType
	/**
	 * The resolved value as source declares it: a hex for a token, `16px` for
	 * a step, the raw suffix for anything unmapped. Null when nothing declares
	 * it (inherited/computed).
	 */
	value: string | null
	/** The splice span of the ACTIVE utility inside the file, when one exists. */
	source: { start: number; end: number } | null
	origin: ParamOrigin
	writable: boolean
	reason?: string
	/** The token name when origin is `token` (`brand-500`). */
	token?: string
	/** The responsive variant the active utility belongs to (`md`), null for base. */
	variant: string | null
	/** The raw active utility (`md:bg-brand-500`), for display. */
	utility: string | null
}

// ---------------------------------------------------------------------------
// className parsing
// ---------------------------------------------------------------------------

export interface ParsedUtility {
	/** The whole class token as written (`md:hover:bg-brand-500`). */
	raw: string
	/** Offsets of the token within the className STRING VALUE. */
	start: number
	end: number
	/** Variant prefixes in order (`["md", "hover"]`). */
	variants: string[]
	/** The unprefixed utility (`bg-brand-500`). */
	base: string
}

export function parseClassName(value: string): ParsedUtility[] {
	const utilities: ParsedUtility[] = []
	const pattern = /\S+/g
	for (const match of value.matchAll(pattern)) {
		const raw = match[0]
		// Split variants on `:` — but never inside arbitrary values `[...]`.
		const parts: string[] = []
		let depth = 0
		let current = ""
		for (const char of raw) {
			if (char === "[") depth++
			if (char === "]") depth--
			if (char === ":" && depth === 0) {
				parts.push(current)
				current = ""
			} else {
				current += char
			}
		}
		parts.push(current)
		utilities.push({
			raw,
			start: match.index,
			end: match.index + raw.length,
			variants: parts.slice(0, -1),
			base: parts[parts.length - 1],
		})
	}
	return utilities
}

// ---------------------------------------------------------------------------
// Utility → property mapping
// ---------------------------------------------------------------------------

/** Breakpoint minimums, matching the shell's Tailwind defaults. */
export const BREAKPOINTS: Record<string, number> = { sm: 640, md: 768, lg: 1024, xl: 1280, "2xl": 1536 }

/** State variants — real, but not part of the RESTING value the panel edits. */
const STATE_VARIANTS = new Set(["hover", "focus", "active", "visited", "disabled", "group-hover", "peer-hover", "dark"])

const FONT_SIZE_NAMES = new Set(["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl"])
const FONT_WEIGHT_NAMES: Record<string, string> = {
	thin: "100",
	extralight: "200",
	light: "300",
	normal: "400",
	medium: "500",
	semibold: "600",
	bold: "700",
	extrabold: "800",
	black: "900",
}

/** Inheritable CSS properties — absence means "comes from an ancestor". */
const INHERITABLE = new Set(["color", "font-size", "font-weight", "line-height", "letter-spacing", "font-family"])

interface PropertyMatch {
	property: string
	type: ParamType
	/** The value half of the utility (`brand-500`, `[13px]`, `4`, `xl`). */
	suffix: string
}

/**
 * Which CSS property a utility declares, for the property set the panel
 * supports. Returns null for utilities outside that set (`flex`, `items-*`) —
 * unknown is unknown, not guessed.
 */
export function propertyOf(base: string): PropertyMatch | null {
	const arbitrary = (suffix: string) => suffix.startsWith("[") && suffix.endsWith("]")

	// text- is the ambiguous family: size, colour, or alignment.
	if (base.startsWith("text-")) {
		const suffix = base.slice(5)
		if (["left", "center", "right", "justify", "start", "end"].includes(suffix)) return null
		if (FONT_SIZE_NAMES.has(suffix)) return { property: "font-size", type: "length", suffix }
		if (arbitrary(suffix)) {
			const inner = suffix.slice(1, -1)
			return /^\d/.test(inner)
				? { property: "font-size", type: "length", suffix }
				: { property: "color", type: "color", suffix }
		}
		return { property: "color", type: "color", suffix }
	}

	const colorFamilies: Array<[string, string]> = [
		["bg-", "background-color"],
		["border-", "border-color"],
		["ring-", "--tw-ring-color"],
		["fill-", "fill"],
		["stroke-", "stroke"],
	]
	for (const [prefix, property] of colorFamilies) {
		if (!base.startsWith(prefix)) continue
		const suffix = base.slice(prefix.length)
		// border-2 is a width; border-dashed a style — colours are name-number,
		// bare names the theme defines, or arbitrary colour values. The width
		// guard must cover the SIDE variants too: `border-y-2` was classified as
		// a border colour, so a colour edit on an element carrying it replaced
		// the border WIDTH with a colour class (found in the field on Voltaine's
		// marquee band). Side-specific colours (`border-t-brand-600`) stay
		// colours: a side alone or side-number is a width, side-name is not.
		if (
			prefix === "border-" &&
			(/^([xytrbles]|[xytrbles]-\d+|\d+)$/.test(suffix) ||
				["solid", "dashed", "dotted", "double", "hidden", "none"].includes(suffix))
		) {
			return null
		}
		if (arbitrary(suffix) && !/^\[#|^\[rgb|^\[hsl|^\[oklch/.test(suffix)) return null
		return { property, type: "color", suffix }
	}

	const spacing: Array<[string, string]> = [
		["p-", "padding"],
		["pt-", "padding-top"],
		["pr-", "padding-right"],
		["pb-", "padding-bottom"],
		["pl-", "padding-left"],
		["px-", "padding-inline"],
		["py-", "padding-block"],
		["m-", "margin"],
		["mt-", "margin-top"],
		["mr-", "margin-right"],
		["mb-", "margin-bottom"],
		["ml-", "margin-left"],
		["mx-", "margin-inline"],
		["my-", "margin-block"],
		["gap-", "gap"],
		["w-", "width"],
		["h-", "height"],
		["basis-", "flex-basis"],
		["shrink-", "flex-shrink"],
		["grow-", "flex-grow"],
	]
	if (base.startsWith("flex-")) {
		const suffix = base.slice("flex-".length)
		if (["1", "auto", "initial", "none"].includes(suffix) || arbitrary(suffix)) {
			return { property: "flex", type: "keyword", suffix }
		}
	}
	for (const [prefix, property] of spacing) {
		if (!base.startsWith(prefix)) continue
		const suffix = base.slice(prefix.length)
		if (
			/^\d+(\.\d+)?$/.test(suffix) ||
			arbitrary(suffix) ||
			["px", "full", "auto", "screen", "fit", "min", "max"].includes(suffix)
		) {
			return { property, type: "length", suffix }
		}
		return null
	}

	if (base.startsWith("rounded")) {
		const suffix = base === "rounded" ? "DEFAULT" : base.startsWith("rounded-") ? base.slice(8) : null
		if (suffix === null) return null
		if (["DEFAULT", "none", "sm", "md", "lg", "xl", "2xl", "3xl", "full"].includes(suffix) || arbitrary(suffix)) {
			return { property: "border-radius", type: "length", suffix }
		}
		return null
	}

	if (base.startsWith("font-")) {
		const suffix = base.slice(5)
		if (suffix in FONT_WEIGHT_NAMES) return { property: "font-weight", type: "number", suffix }
		return null // font-sans / font-display are families — panel v2
	}

	if (base.startsWith("opacity-")) {
		return { property: "opacity", type: "number", suffix: base.slice(8) }
	}

	return null
}

// ---------------------------------------------------------------------------
// Active-utility resolution
// ---------------------------------------------------------------------------

/**
 * The utility that decides `property` at `viewportWidth`, or null.
 *
 * Responsive variants are media queries: active when the viewport is at least
 * their breakpoint, and a higher active breakpoint beats a lower one beats
 * base. State variants (`hover:`) never contribute to the resting value.
 * Ties (two active utilities at the same breakpoint) go to the LAST — the
 * order Tailwind's generated stylesheet resolves same-specificity conflicts.
 */
export function activeUtilityFor(
	utilities: ParsedUtility[],
	property: string,
	viewportWidth: number,
): (ParsedUtility & { match: PropertyMatch }) | null {
	let best: (ParsedUtility & { match: PropertyMatch }) | null = null
	let bestBreakpoint = -1

	for (const utility of utilities) {
		const match = propertyOf(utility.base)
		if (!match || match.property !== property) continue

		if (utility.variants.some((variant) => STATE_VARIANTS.has(variant))) continue

		let breakpoint = 0
		let active = true
		for (const variant of utility.variants) {
			const min = BREAKPOINTS[variant]
			if (min === undefined) {
				active = false // an unknown variant — not the resting value
				break
			}
			breakpoint = Math.max(breakpoint, min)
			if (viewportWidth < min) active = false
		}
		if (!active) continue

		if (breakpoint >= bestBreakpoint) {
			best = { ...utility, match }
			bestBreakpoint = breakpoint
		}
	}
	return best
}

// ---------------------------------------------------------------------------
// Value resolution
// ---------------------------------------------------------------------------

const SPACING_PX_PER_STEP = 4

/** The CSS value a suffix means, where it is computable without the runtime. */
export function cssValueOf(match: PropertyMatch, tokens: FoundationTokens | null): string | null {
	const { suffix } = match
	if (suffix.startsWith("[") && suffix.endsWith("]")) return suffix.slice(1, -1).replace(/_/g, " ")

	if (match.type === "color") {
		const token = tokens ? tokenValue(tokens, suffix) : null
		if (token) return token
		return null // stock palette — the runtime check supplies the value
	}

	if (match.property === "font-size") {
		const fromTokens = tokens?.typography?.scale?.[suffix]
		if (typeof fromTokens === "number") return `${fromTokens}px`
		return null
	}

	if (match.property === "font-weight") return FONT_WEIGHT_NAMES[suffix] ?? null

	if (match.property === "opacity") {
		const n = Number(suffix)
		return Number.isFinite(n) ? String(n / 100) : null
	}

	if (match.property === "border-radius") {
		const scale = tokens?.radius?.scale
		const namedIndex: Record<string, number> = { none: 0, sm: 1, md: 2, lg: 3, xl: 4, full: 5 }
		if (scale && suffix in namedIndex && typeof scale[namedIndex[suffix]] === "number") {
			const value = scale[namedIndex[suffix]]
			return value >= 9999 ? "9999px" : `${value}px`
		}
		return null
	}

	// Spacing / sizes on the numeric scale.
	if (/^\d+(\.\d+)?$/.test(suffix)) return `${Number(suffix) * SPACING_PX_PER_STEP}px`
	if (suffix === "px") return "1px"
	if (suffix === "full") return "100%"
	if (suffix === "auto") return "auto"
	return null
}

// ---------------------------------------------------------------------------
// resolveParam — the chain
// ---------------------------------------------------------------------------

export interface ResolveContext {
	viewportWidth: number
	tokens: FoundationTokens | null
}

/** The property set the panel offers, in display order. */
export const PANEL_PROPERTIES = [
	"color",
	"background-color",
	"border-color",
	"font-size",
	"font-weight",
	"padding",
	"padding-top",
	"padding-right",
	"padding-bottom",
	"padding-left",
	"margin",
	"margin-top",
	"margin-right",
	"margin-bottom",
	"margin-left",
	"gap",
	"width",
	"height",
	"border-radius",
	"opacity",
] as const

/**
 * Resolves one property of one element to a Param.
 *
 * The chain: a dynamic className is `data` (typed refusal) → an active
 * utility resolves to `token` or `literal` with its splice span → absence is
 * `inherited` for inheritable properties and `computed` otherwise, both
 * writable (a write appends a declaration).
 */
export function resolveParam(element: IndexedElement, property: string, context: ResolveContext): Param {
	const path = `${element.caretId}/style/${property}`
	const base: Omit<Param, "origin" | "writable"> = {
		path,
		property,
		type: property.includes("color") || property === "fill" || property === "stroke" ? "color" : "length",
		value: null,
		source: null,
		token: undefined,
		variant: null,
		utility: null,
	}

	const classAttr = element.attributes.get("className")
	// Iterator elements resolve normally: a look param lives on the TEMPLATE —
	// one source span, every row follows (Phase 8.6). Row-specific CONTENT goes
	// through the data literal, not through here.
	if (classAttr && classAttr.value === null) {
		return {
			...base,
			origin: "data",
			writable: false,
			reason: "className is a dynamic expression — editing it blind would overwrite logic",
		}
	}

	const classValue = classAttr?.value ?? ""
	const utilities = parseClassName(classValue)
	const active = activeUtilityFor(utilities, property, context.viewportWidth)

	if (active) {
		const token = foundationTokenForClass(active.base, context.tokens)
		const valueStart = classAttr?.valueStart ?? 0
		return {
			...base,
			type: active.match.type,
			value: token ? (context.tokens ? tokenValue(context.tokens, token) : null) : cssValueOf(active.match, context.tokens),
			source: { start: valueStart + active.start, end: valueStart + active.end },
			origin: token ? "token" : "literal",
			token: token ?? undefined,
			writable: true,
			variant: active.variants.length > 0 ? active.variants[active.variants.length - 1] : null,
			utility: active.raw,
		}
	}

	if (INHERITABLE.has(property)) {
		return { ...base, origin: "inherited", writable: true, reason: undefined }
	}
	return { ...base, origin: "computed", writable: true, reason: undefined }
}

// ---------------------------------------------------------------------------
// Writes — every edit is a splice
// ---------------------------------------------------------------------------

const PROPERTY_PREFIX: Record<string, string> = {
	color: "text-",
	"background-color": "bg-",
	"border-color": "border-",
	"font-size": "text-",
	"font-weight": "font-",
	padding: "p-",
	"padding-top": "pt-",
	"padding-right": "pr-",
	"padding-bottom": "pb-",
	"padding-left": "pl-",
	margin: "m-",
	"margin-top": "mt-",
	"margin-right": "mr-",
	"margin-bottom": "mb-",
	"margin-left": "ml-",
	flex: "flex-",
	"flex-basis": "basis-",
	"flex-shrink": "shrink-",
	"flex-grow": "grow-",
	gap: "gap-",
	width: "w-",
	height: "h-",
	"border-radius": "rounded-",
	opacity: "opacity-",
}

export interface ParamWrite {
	/** A token name (`brand-500`) — writes the token class. */
	token?: string
	/** A raw CSS value (`#ff0000`, `13px`) — writes an arbitrary-value class. */
	raw?: string
}

/**
 * The splice for setting `property` on `element`. Replaces the active
 * utility's span when one exists (keeping its variant prefix — an edit at the
 * md: viewport edits the md: declaration); otherwise appends a new class to
 * className, or creates the attribute.
 */
export function writeParam(
	element: IndexedElement,
	property: string,
	next: ParamWrite,
	context: ResolveContext,
): SpliceEdit[] | { refused: string } {
	const prefix = PROPERTY_PREFIX[property]
	if (!prefix) return { refused: `no utility family maps to ${property}` }

	const param = resolveParam(element, property, context)
	if (!param.writable) return { refused: param.reason ?? "not writable" }

	const suffix = next.token ?? `[${(next.raw ?? "").replace(/\s+/g, "_")}]`
	if (!next.token && !next.raw) return { refused: "nothing to write" }

	if (param.source && param.utility) {
		// Keep the variant prefix: `md:bg-brand-500` edited at ≥768px stays md:.
		const variantPrefix = param.utility.slice(0, param.utility.length - param.utility.split(":").pop()!.length)
		return [{ start: param.source.start, end: param.source.end, text: `${variantPrefix}${prefix}${suffix}` }]
	}

	const classAttr = element.attributes.get("className")
	if (classAttr && classAttr.valueStart !== null && classAttr.valueEnd !== null) {
		const insertAt = classAttr.valueEnd
		const needsSpace = (classAttr.value ?? "").length > 0
		return [{ start: insertAt, end: insertAt, text: `${needsSpace ? " " : ""}${prefix}${suffix}` }]
	}

	// No className at all — create one at the opening tag's insertion point.
	return [{ start: element.openingInsertAt, end: element.openingInsertAt, text: ` className="${prefix}${suffix}"` }]
}
