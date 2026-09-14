/**
 * Splice-backed inline editors — the primary write path for text and colour.
 *
 * These replace the recast reprint path for the operations that are pure span
 * replacement, which retires its bug class: recast re-indented the reprinted
 * subtree, the next edit read the inflated whitespace back, and indentation
 * grew a level per edit. A splice writes only the span; the whitespace is
 * never read or written.
 *
 * The recast editors remain as the FALLBACK for the shapes an index lookup
 * cannot serve (no caret-id, colour inside a style object, line-only
 * addressing) — recast is still correct for genuine restructuring; splice is
 * simply the right tool for span replacement, and span replacement is what
 * inline editing overwhelmingly is.
 */
import type { FoundationTokens } from "../types"
import { resolveRowTextEdit } from "./map-rows"
import { type ParamWrite, parseClassName, propertyOf, resolveParam, writeParam } from "./params"
import { getIndex } from "./source-index"
import { type SpliceEdit, spliceFile } from "./splice"

export interface SpliceEditOutcome {
	/** True when the splice path handled the edit (successfully or as a clean no-op). */
	handled: boolean
	/** True when a write happened (or the value was already correct — idempotent success). */
	ok: boolean
	/** The class the colour edit replaced, for detach detection. */
	replacedClass?: string
	/** Typed refusal: WHY the edit can't land, named for the user. */
	reason?: string
}

const NOT_HANDLED: SpliceEditOutcome = { handled: false, ok: false }

/**
 * Text edit by caret-id: replaces the trimmed content span whose text matches
 * `oldText` (or the element's single span). Never touches whitespace.
 * Idempotent: current === new is success without a write.
 */
export async function spliceTextEdit(
	filePath: string,
	caretId: string | undefined,
	newText: string,
	oldText?: string,
): Promise<SpliceEditOutcome> {
	if (!caretId) return NOT_HANDLED

	let outcome: SpliceEditOutcome = NOT_HANDLED
	await spliceFile(filePath, (source) => {
		const index = getIndex(filePath, source)
		if (index.parseError) return null
		const element = index.elements.get(caretId)
		if (!element) return null

		// Absorbed rule, typed refusal: text that comes from data has no source
		// span an inline edit could reach. Refusing with the cause beats the
		// recast fallback failing with a shrug.
		if (element.textSpans.length === 0) {
			if (element.hasDynamicText) {
				outcome = {
					handled: true,
					ok: false,
					reason: "This text comes from data (a JSX expression), so an inline edit can't reach it. Edit the underlying value, or describe the change to the agent.",
				}
			}
			return null
		}

		// The span to edit: the one carrying oldText when given (guards against
		// a stale target after HMR), else the only span. Multiple spans with no
		// oldText is ambiguous — leave it to the fallback chain.
		const candidates = oldText
			? element.textSpans.filter((span) => span.text === oldText.trim())
			: element.textSpans.length === 1
				? element.textSpans
				: []
		if (candidates.length !== 1) {
			// Redelivery guard: if some span already carries the new text, the
			// edit already landed — success without a write.
			if (element.textSpans.some((span) => span.text === newText.trim())) {
				outcome = { handled: true, ok: true }
			}
			return null
		}

		const span = candidates[0]
		outcome = { handled: true, ok: true }
		if (span.text === newText.trim()) return null
		return [{ start: span.start, end: span.end, text: newText.trim() }]
	})
	return outcome
}

/**
 * Colour edit by caret-id, targeting the property the gesture actually edited.
 *
 * `targetProperty` is which colour the popover previewed ("background" when
 * the element has a visible background, else "text"). The utility of THAT
 * family is what gets replaced — an unprefixed one first, then a varianted
 * one, then the old first-any-colour behaviour as the fallback. Without the
 * preference, "replace the first colour utility" edited the marquee band's
 * BORDER while the user watched a background preview: the toast said bound,
 * the preview lifted, and the cream came back.
 * `tokenClass` writes the token name instead of an arbitrary value.
 */
export async function spliceColorEdit(
	filePath: string,
	caretId: string | undefined,
	newColor: string,
	tokenClass?: string,
	targetProperty?: "background" | "text",
): Promise<SpliceEditOutcome> {
	if (!caretId) return NOT_HANDLED

	let outcome: SpliceEditOutcome = NOT_HANDLED
	await spliceFile(filePath, (source) => {
		const index = getIndex(filePath, source)
		if (index.parseError) return null
		const element = index.elements.get(caretId)
		if (!element) return null

		const classAttr = element.attributes.get("className")

		// A dynamic className or a colour living in style={{}} is the recast
		// fallback's job — not handled here.
		if (classAttr && classAttr.value === null) return null

		const value = classAttr?.value ?? ""
		const utilities = parseClassName(value)
		const colorUtilities = utilities.filter((utility) => propertyOf(utility.base)?.type === "color")
		const preferredFamily = targetProperty === "background" ? "bg-" : targetProperty === "text" ? "text-" : null
		const unvarianted = (utility: (typeof utilities)[number]) => utility.raw === utility.base
		const target =
			(preferredFamily &&
				(colorUtilities.find((u) => u.base.startsWith(preferredFamily) && unvarianted(u)) ??
					colorUtilities.find((u) => u.base.startsWith(preferredFamily)))) ||
			colorUtilities[0]
		const suffix = tokenClass ?? `[${newColor}]`

		if (target && classAttr?.valueStart !== null && classAttr !== undefined) {
			const family = [
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
			].find((prefix) => target.base.startsWith(prefix))
			if (!family) return null
			const variantPrefix = target.raw.slice(0, target.raw.length - target.base.length)
			const start = (classAttr.valueStart ?? 0) + target.start
			const end = (classAttr.valueStart ?? 0) + target.end
			outcome = { handled: true, ok: true, replacedClass: target.base }
			const replacement = `${variantPrefix}${family}${suffix}`
			if (source.slice(start, end) === replacement) return null
			return [{ start, end, text: replacement }]
		}

		// No colour class: append one of the edited family (or create className).
		const appendFamily = preferredFamily ?? "text-"
		if (classAttr && classAttr.valueStart !== null && classAttr.valueEnd !== null) {
			outcome = { handled: true, ok: true }
			const needsSpace = value.length > 0
			return [
				{ start: classAttr.valueEnd, end: classAttr.valueEnd, text: `${needsSpace ? " " : ""}${appendFamily}${suffix}` },
			]
		}
		if (!classAttr) {
			outcome = { handled: true, ok: true }
			return [
				{ start: element.openingInsertAt, end: element.openingInsertAt, text: ` className="${appendFamily}${suffix}"` },
			]
		}
		return null
	})
	return outcome
}

/**
 * Row-content text edit (Phase 8.6): the text of row N routes to the data
 * literal the row rendered from. Returns unhandled when the element is not a
 * row-content case at all; a refusal names exactly what stands in the way.
 */
export async function spliceRowTextEdit(
	filePath: string,
	caretId: string,
	instanceIndex: number,
	newText: string,
	oldText?: string,
): Promise<{ kind: "edit" | "refusal" | "unhandled"; reason?: string; itemLabel?: string }> {
	let outcome: { kind: "edit" | "refusal" | "unhandled"; reason?: string; itemLabel?: string } = { kind: "unhandled" }
	await spliceFile(filePath, (source) => {
		const resolution = resolveRowTextEdit(source, caretId, instanceIndex, newText, oldText)
		if (resolution.kind === "edit") {
			outcome = { kind: "edit", itemLabel: resolution.itemLabel }
			return resolution.edits.length > 0 ? resolution.edits : null
		}
		outcome = resolution.kind === "refusal" ? { kind: "refusal", reason: resolution.reason } : { kind: "unhandled" }
		return null
	})
	return outcome
}

/**
 * The generalized Param edit: `<caretId>/style/<property>` set to a token or
 * raw value at a viewport. This is what the property panel speaks, and the
 * `{path, value}` payload the plan generalizes InlineEditPayload toward.
 */
export async function spliceParamEdit(
	filePath: string,
	caretId: string,
	property: string,
	next: ParamWrite,
	viewportWidth: number,
	tokens: FoundationTokens | null,
): Promise<{ ok: boolean; refused?: string }> {
	let refused: string | undefined
	let wrote = false

	await spliceFile(filePath, (source) => {
		const index = getIndex(filePath, source)
		if (index.parseError) {
			refused = `the file does not parse: ${index.parseError}`
			return null
		}
		const element = index.elements.get(caretId)
		if (!element) {
			refused = `no element with caret-id "${caretId}" in this file`
			return null
		}
		const edits = writeParam(element, property, next, { viewportWidth, tokens })
		if ("refused" in edits) {
			refused = edits.refused
			return null
		}
		wrote = true
		return edits as SpliceEdit[]
	})

	return refused ? { ok: false, refused } : { ok: wrote }
}

/** The panel's read side: every supported property of one element, resolved. */
export function resolveParamsFor(
	source: string,
	filePath: string,
	caretId: string,
	properties: readonly string[],
	viewportWidth: number,
	tokens: FoundationTokens | null,
) {
	const index = getIndex(filePath, source)
	const element = index.elements.get(caretId)
	if (!element) return null
	return properties.map((property) => resolveParam(element, property, { viewportWidth, tokens }))
}
