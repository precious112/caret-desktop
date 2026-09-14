import * as fs from "fs/promises"
import * as path from "path"

import { describeInline, expandReferences, fitWarning, readAssetIndex } from "../assets"
import type { AssetEntry } from "../assets/types"
import type { AiEditRequestPayload, OverlayElementInfo } from "../rendering-shell/messages"
import { findJSXElementAtPosition, findJSXElementByCaretId, parseSource } from "./ast-editor"

function extractElementSource(
	source: string,
	node: { loc?: { start: { line: number; column: number }; end: { line: number; column: number } } | null },
): string | null {
	if (!node.loc) return null
	const lines = source.split("\n")
	const startLine = node.loc.start.line - 1
	const endLine = node.loc.end.line - 1
	if (startLine < 0 || endLine >= lines.length) return null

	if (startLine === endLine) {
		return lines[startLine].slice(node.loc.start.column, node.loc.end.column)
	}

	const result: string[] = []
	result.push(lines[startLine].slice(node.loc.start.column))
	for (let i = startLine + 1; i < endLine; i++) {
		result.push(lines[i])
	}
	result.push(lines[endLine].slice(0, node.loc.end.column))
	return result.join("\n")
}

type Rect = { x: number; y: number; width: number; height: number }

function isUsableRect(rect: unknown): rect is Rect {
	const r = rect as Partial<Rect> | null
	return (
		typeof r?.x === "number" &&
		typeof r.y === "number" &&
		typeof r.width === "number" &&
		typeof r.height === "number" &&
		[r.x, r.y, r.width, r.height].every(Number.isFinite) &&
		r.width > 0 &&
		r.height > 0
	)
}

/**
 * One line per measured element under the painted region, in the crop's own
 * pixel coordinates. Numbers arrive from the preview iframe, so each is
 * validated before being quoted to the model as fact (the `isUsableBox`
 * posture below).
 *
 * Exported for the overlay verify loop, which renders the same lines for its
 * post-edit re-measurements — the model reads one geometry format per edit.
 */
export function describeMeasuredElements(elements: OverlayElementInfo[], assets: AssetEntry[]): string[] {
	const lines: string[] = []
	let n = 0
	for (const el of elements) {
		if (typeof el.caretId !== "string" || !el.caretId) continue
		if (!isUsableRect(el.rect)) continue
		n += 1
		const r = el.rect
		const cx = Math.round(r.x + r.width / 2)
		const cy = Math.round(r.y + r.height / 2)
		const src = typeof el.src === "string" && el.src ? ` src="${el.src}"` : ""
		lines.push(
			`  ${n}. <${el.tag} data-caret-id="${el.caretId}">${src} — box ${r.width}x${r.height} at (${r.x},${r.y}), center (${cx},${cy})`,
		)

		// A cutout's rendered box includes its transparent margins; when the
		// asset index measured where the opaque pixels sit, translate that into
		// this element's rendered coordinates so alignment aims at the object,
		// not the margins. Skipped when the rendered aspect deviates from the
		// intrinsic one (object-fit would make the linear map wrong).
		const visual = visualCenterLine(el, assets)
		if (visual) lines.push(`     ${visual}`)
	}
	return lines
}

function visualCenterLine(el: OverlayElementInfo, assets: AssetEntry[]): string | null {
	if (el.tag !== "img" || typeof el.src !== "string" || !el.src) return null
	const file = el.src.split("/").pop() || ""
	const entry = assets.find((a) => a.file === file)
	if (!entry?.opaqueBox || !entry.width || !entry.height) return null
	if (!isUsableRect(el.rect) || !isUsableRect(entry.opaqueBox)) return null

	const renderedAspect = el.rect.width / el.rect.height
	const intrinsicAspect = entry.width / entry.height
	if (Math.abs(renderedAspect - intrinsicAspect) / intrinsicAspect > 0.05) return null

	const scaleX = el.rect.width / entry.width
	const scaleY = el.rect.height / entry.height
	const ob = entry.opaqueBox
	const w = Math.round(ob.width * scaleX)
	const h = Math.round(ob.height * scaleY)
	const vx = Math.round(el.rect.x + (ob.x + ob.width / 2) * scaleX)
	const vy = Math.round(el.rect.y + (ob.y + ob.height / 2) * scaleY)
	return `opaque pixels occupy ${w}x${h} within the box; visual center (${vx},${vy}) — the PNG has transparent margins, so center on the VISUAL center when aligning.`
}

function isUsableBox(box: unknown): box is { width: number; height: number } {
	const candidate = box as { width?: unknown; height?: unknown }
	return (
		typeof candidate?.width === "number" &&
		typeof candidate.height === "number" &&
		Number.isFinite(candidate.width) &&
		Number.isFinite(candidate.height) &&
		candidate.width > 0 &&
		candidate.height > 0
	)
}

export async function buildVisualEditPrompt(
	payload: AiEditRequestPayload & { elements?: OverlayElementInfo[] },
	workspacePath: string,
): Promise<string> {
	const sections: string[] = []

	const isOverlayEdit = payload.lineNumber === 0 && !payload.caretId

	// `@tag` is resolved here rather than passed through, and here rather than in
	// the canvas, so every surface that can send an instruction gets it — the
	// inline box, the painted overlay, and anything added later. An agent handed a
	// bare `@hero-shot` does not error when it fails to resolve it; it invents an
	// asset that suits the name and proceeds.
	const assetIndex = await readAssetIndex(workspacePath)
	const expansion = expandReferences(payload.instruction, assetIndex)
	const instruction = expansion.text

	if (isOverlayEdit) {
		// The crop is accurate — it is the painted region at the scroll position the
		// user was looking at. What the agent lacks is a method for finding that
		// region in the source, and left to itself it picks the wrong one: asked to
		// retexture a notecard, one model searched for the *image*, found the same
		// file used by two components, took the first hit and edited a section
		// several screens above the one on screen. The words in a crop are unique
		// where its graphics are not, so say to match on those.
		sections.push(`The user painted a region on the design preview and provided a screenshot of what they see.`)
		const measured = payload.elements?.length ? describeMeasuredElements(payload.elements, assetIndex.assets) : []
		if (measured.length > 0) {
			// Models see that a thing is off-center but cannot measure by how much
			// from pixels alone — that is the "move it right… no, back a bit" loop.
			// They are reliable at arithmetic, so hand them the rects the canvas
			// measured and make the move a subtraction, not a guess.
			sections.push(
				`\nCaret measured the elements under the painted region. Coordinates are pixels within the attached crop (origin at the crop's top-left):`,
				...measured,
				`\nThe data-caret-id attributes appear verbatim in the page source — locate elements by them, never by image filename. To move or align elements, do the arithmetic with these numbers: compute the target position, derive the CSS change, and state the arithmetic in your reply. After your edit Caret will re-measure the same elements and show you the result.`,
			)
		}
		if (measured.length > 0) {
			sections.push(
				`The screenshot is a crop of this page at the scroll position the user was looking at. If a data-caret-id above is not in the page source itself, it is inside a component the page imports — open that file and make the change there.`,
			)
		} else {
			sections.push(
				`The screenshot is a crop of this page at the scroll position the user was looking at. Locate that region in the source before you change anything. Anchor on the text visible in the crop — headings, labels, button text — and search for those exact words. That identifies the region unambiguously. If the crop carries no text, use the nearest text it does show and work outwards from there.`,
				`Do not identify it by the graphic or by an image filename. The same image is often used by more than one component, and taking the first match edits a part of the page the user is not looking at.`,
				`This page composes imported components. If the words you are looking for are not in the page source, they are in one of the components it imports — open that file and make the change there.`,
			)
		}
		sections.push(`\nUser instruction: "${instruction}"`)
	} else {
		sections.push(`The user selected a SPECIFIC element in the design preview and requested an edit.`)
		sections.push(`IMPORTANT: Only modify the element at the specified location. Do NOT change other elements in the file.`)
		sections.push(`\nUser instruction: "${instruction}"`)
	}

	if (expansion.resolved.length > 0) {
		sections.push(
			`\nThe user named ${expansion.resolved.length === 1 ? "an asset" : "assets"} from this project's library. Use ${expansion.resolved.length === 1 ? "it" : "them"} exactly — do not substitute a placeholder or a stock URL:`,
			...expansion.resolved.map((asset) => `  - ${describeInline(asset)}`),
			`Respect the intrinsic size. If an asset is much smaller than the space it is going into, or its aspect ratio is far from the target, say so rather than stretching it.`,
		)

		// The box the user is pointing at, measured in the canvas. With it, "much
		// smaller than the space" stops being a judgment the agent has to guess at
		// from the surrounding markup, and refusing becomes a decision it can
		// defend with numbers.
		//
		// Validated rather than trusted: this arrives from the preview iframe,
		// which runs generated and user-authored code, and a bad number here would
		// be quoted to the model as fact.
		const box = isUsableBox(payload.box) ? payload.box : null
		if (box) {
			const warnings = expansion.resolved
				.map((asset) => fitWarning(asset, box))
				.filter((warning): warning is string => warning !== null)

			sections.push(
				`\nThe target renders at ${box.width}x${box.height} CSS pixels.`,
				...(warnings.length > 0
					? [
							`Caret measured a poor fit:`,
							...warnings.map((warning) => `  - ${warning}`),
							`Do not paper over this. Make the change if it is still the best available option, and tell the user what is wrong with the fit and what would fix it (a larger asset, a different crop, a different slot). If it cannot be made to look right, refuse and say why — that is a better outcome than a stretched image the user has to notice for themselves.`,
						]
					: []),
			)
		}
	}

	if (expansion.unknown.length > 0) {
		// Named but missing. Saying so is the point: silently ignoring it produces
		// an edit that reads as though the user never asked for an image.
		sections.push(
			`\nThe user referred to ${expansion.unknown.map((tag) => `@${tag}`).join(", ")}, which ${expansion.unknown.length === 1 ? "is not an asset" : "are not assets"} in this project. Do not invent ${expansion.unknown.length === 1 ? "it" : "them"} — tell the user the tag does not exist and list what does, using list_assets.`,
		)
	}

	if (payload.filePath) {
		try {
			const source = await fs.readFile(payload.filePath, "utf-8")
			const lines = source.split("\n")
			const relPath = path.relative(workspacePath, payload.filePath)

			let elementCode: string | null = null
			let elementLine = payload.lineNumber
			let isInsideIterator = false

			try {
				const ast = parseSource(source)
				const node = payload.caretId
					? findJSXElementByCaretId(ast, payload.caretId) ||
						findJSXElementAtPosition(ast, payload.lineNumber, payload.columnNumber)
					: findJSXElementAtPosition(ast, payload.lineNumber, payload.columnNumber)

				if (node) {
					elementCode = extractElementSource(source, node)
					if (node.loc) elementLine = node.loc.start.line
				}
			} catch {
				// AST parsing failed — fall back to line-based context
			}

			if (elementCode) {
				if (payload.caretId) {
					sections.push(`\nThe user clicked on this specific element (data-caret-id="${payload.caretId}"):`)
				} else {
					sections.push(`\nThe user clicked on this specific element:`)
					isInsideIterator = true
				}
				sections.push("```tsx")
				sections.push(elementCode)
				sections.push("```")
				sections.push(
					`Located at line ${elementLine}${payload.columnNumber > 0 ? `, column ${payload.columnNumber}` : ""} in ${relPath}.`,
				)
				if (isInsideIterator) {
					sections.push(`This element may be inside a .map() or iteration callback.`)
				}
				sections.push(`Only modify this element. Do not change other elements.`)
			}

			if (payload.componentName) sections.push(`\nComponent: ${payload.componentName}`)
			sections.push(`File: ${relPath}`)

			sections.push(`\nSource file (${relPath}):`)
			sections.push("```tsx")
			sections.push(source)
			sections.push("```")

			if (elementLine > 0) {
				const start = Math.max(0, elementLine - 4)
				const end = Math.min(lines.length, elementLine + 6)
				const snippet = lines
					.slice(start, end)
					.map((l, i) => {
						const ln = start + i + 1
						const marker = ln === elementLine ? " >>>" : "    "
						return `${marker} ${ln}: ${l}`
					})
					.join("\n")
				sections.push(`\nSurrounding code:`)
				sections.push("```")
				sections.push(snippet)
				sections.push("```")
			}
		} catch {
			console.warn(`[design] Could not read source file: ${payload.filePath}`)
		}
	}

	const tokensPath = path.join(workspacePath, ".caret", "tokens", "foundation.json")
	try {
		const tokens = await fs.readFile(tokensPath, "utf-8")
		sections.push(`\nDesign tokens (foundation.json):`)
		sections.push("```json")
		sections.push(tokens)
		sections.push("```")
	} catch {
		console.info("[design] No foundation tokens found — skipping token context")
	}

	// Naming a tool here was a mistake: `write_to_file` exists in neither backend,
	// and the sessions show models spending turns hunting for it before improvising
	// with whatever they do have. Say what to accomplish and let the backend's own
	// toolset answer how.
	sections.push(`\nApply the requested change by editing the file. Change nothing the instruction did not ask for.`)

	return sections.join("\n")
}
