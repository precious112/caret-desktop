/**
 * The overlay verify loop's pure half.
 *
 * After an overlay edit, the desktop re-renders the page in a hidden window
 * and re-measures the elements the user painted over. What to inject, how to
 * compare two rounds of measurements, and what to say to the model all live
 * here where they are testable without Electron; the window dance stays in
 * `desktop/main/overlay-verify.ts`.
 *
 * The loop exists because a model can see that a thing is off-center but not
 * by how much — geometry turns "move it right a bit" into a subtraction. The
 * verify turn closes the loop: the model computed a delta, edited, and now
 * gets told what the numbers actually became.
 */
import type { AssetEntry } from "../assets/types"
import type { OverlayElementInfo } from "../rendering-shell/messages"
import { describeMeasuredElements } from "./context-builder"

/** `RunRequest.note` on a verify turn. Also the loop's own re-entry marker. */
export const OVERLAY_VERIFY_NOTE = "Overlay verify"

/** One re-measured element, viewport coordinates of the hidden render. */
export interface OverlayMeasurement {
	caretId: string
	found: boolean
	tag?: string
	src?: string
	rect?: { x: number; y: number; width: number; height: number }
}

/** What `handleOverlayEdit` stows in the task context for the loop to read. */
export interface OverlayVerifyContext {
	filePath: string
	caretIds: string[]
	instruction: string
	viewport: { width: number; height: number }
}

export function readOverlayVerifyContext(context: Record<string, unknown> | undefined): OverlayVerifyContext | null {
	const raw = context?.overlayVerify as Partial<OverlayVerifyContext> | undefined
	if (!raw || typeof raw !== "object") return null
	if (typeof raw.filePath !== "string" || typeof raw.instruction !== "string") return null
	if (!Array.isArray(raw.caretIds) || raw.caretIds.length === 0) return null
	const viewport =
		raw.viewport && Number.isFinite(raw.viewport.width) && Number.isFinite(raw.viewport.height)
			? raw.viewport
			: { width: 1440, height: 900 }
	return {
		filePath: raw.filePath,
		caretIds: raw.caretIds.filter((id): id is string => typeof id === "string" && id.length > 0),
		instruction: raw.instruction,
		viewport,
	}
}

/**
 * The `executeJavaScript` string that re-measures the painted elements.
 *
 * Scrolls the first found element into view before measuring, so the returned
 * client rects are also valid crop coordinates for `capturePage`. Same
 * inject-a-string idiom as `DESIGN_CHECKS_DOM_SCRIPT`; the caretIds are
 * embedded as JSON, never interpolated raw.
 */
export function buildOverlayMeasureScript(caretIds: string[]): string {
	return `(async () => {
		const ids = ${JSON.stringify(caretIds)}
		const first = ids.map((id) => document.querySelector('[data-caret-id="' + CSS.escape(id) + '"]')).find(Boolean)
		if (first) {
			first.scrollIntoView({ block: "center", inline: "nearest" })
			await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
		}
		return ids.map((id) => {
			const el = document.querySelector('[data-caret-id="' + CSS.escape(id) + '"]')
			if (!el) return { caretId: id, found: false }
			const r = el.getBoundingClientRect()
			const out = {
				caretId: id,
				found: true,
				tag: el.tagName.toLowerCase(),
				rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
			}
			const src = el.tagName === "IMG" ? el.getAttribute("src") : null
			if (src) out.src = src
			return out
		})
	})()`
}

/**
 * Whether two rounds of measurements describe the same layout, within
 * tolerance. A verify turn that moved nothing is the loop's natural end:
 * either the model declared the result correct, or its edit is not reaching
 * these elements — and in both cases another round would only repeat itself.
 */
export function geometryStable(a: OverlayMeasurement[], b: OverlayMeasurement[], tolerancePx = 2): boolean {
	const byId = new Map(a.map((m) => [m.caretId, m]))
	for (const current of b) {
		const previous = byId.get(current.caretId)
		if (!previous) return false
		if (previous.found !== current.found) return false
		if (!current.found || !current.rect || !previous.rect) continue
		const p = previous.rect
		const c = current.rect
		if (
			Math.abs(p.x - c.x) > tolerancePx ||
			Math.abs(p.y - c.y) > tolerancePx ||
			Math.abs(p.width - c.width) > tolerancePx ||
			Math.abs(p.height - c.height) > tolerancePx
		) {
			return false
		}
	}
	return true
}

/** Measurements as prompt-ready lines, reusing the edit prompt's own format. */
function measurementLines(measurements: OverlayMeasurement[], assets: AssetEntry[]): string[] {
	const found: OverlayElementInfo[] = measurements
		.filter((m): m is OverlayMeasurement & { rect: NonNullable<OverlayMeasurement["rect"]> } => m.found && !!m.rect)
		.map((m) => ({ caretId: m.caretId, tag: m.tag ?? "element", rect: m.rect, ...(m.src ? { src: m.src } : {}) }))
	return describeMeasuredElements(found, assets)
}

/**
 * The verify turn's prompt. Numbers first, then the rule for ending the loop:
 * a satisfied instruction is answered with DONE and no edit, so an empty
 * files-changed on this turn is itself a stop signal the service can read.
 */
export function formatVerifyPrompt(input: {
	round: number
	maxRounds: number
	instruction: string
	measurements: OverlayMeasurement[]
	assets: AssetEntry[]
	imageAttached: boolean
}): string {
	const sections: string[] = []
	sections.push(
		`Caret re-rendered the page after your edit and re-measured the elements under the user's painted region (verification ${input.round} of ${input.maxRounds}).`,
	)
	const missing = input.measurements.filter((m) => !m.found).map((m) => m.caretId)
	const lines = measurementLines(input.measurements, input.assets)
	if (lines.length > 0) {
		sections.push(
			`Current geometry (viewport pixel coordinates${input.imageAttached ? ", matching the attached screenshot" : ""}):`,
		)
		sections.push(...lines)
	}
	if (missing.length > 0) {
		sections.push(
			`Not found in the render: ${missing.map((id) => `data-caret-id="${id}"`).join(", ")} — if you removed or replaced ${missing.length === 1 ? "it" : "them"}, say so.`,
		)
	}
	sections.push(`\nThe user's instruction was: "${input.instruction}"`)
	sections.push(
		`If the current geometry satisfies the instruction, reply DONE and change nothing. Otherwise compute the remaining delta from these numbers, state the arithmetic, and make one corrective edit.`,
	)
	return sections.join("\n")
}
