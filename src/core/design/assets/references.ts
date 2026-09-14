/**
 * Turning `@tag` into something an agent can act on.
 *
 * The reference is expanded **here, before the instruction is sent** — not
 * passed through as `@hero-shot` for the agent to look up. Passing a token and
 * trusting a lookup is the same failure as a pull-only context tool, with a
 * worse failure mode: an agent that does not resolve it does not error, it
 * invents an asset that fits the name and carries on.
 */

import { assetUrl, findAsset } from "./store"
import { findTagReferences } from "./tags"
import type { AssetEntry, AssetIndex } from "./types"

export interface ExpansionResult {
	/** The instruction with every known reference replaced by a full description. */
	text: string
	/** Assets referenced, in order of first appearance. */
	resolved: AssetEntry[]
	/** Referenced tags with no matching asset. */
	unknown: string[]
}

/**
 * Replaces every `@tag` in an instruction with the asset's real details.
 *
 * Unknown tags are left as written and reported rather than stripped. A user
 * who typed `@hero-shoot` should see their typo survive into the instruction —
 * silently deleting it produces an instruction that reads as though they never
 * asked for an image.
 */
export function expandReferences(text: string, index: AssetIndex): ExpansionResult {
	const referenced = findTagReferences(text)
	const resolved: AssetEntry[] = []
	const unknown: string[] = []

	let expanded = text
	for (const tag of referenced) {
		const entry = findAsset(index, tag)
		if (!entry) {
			unknown.push(tag)
			continue
		}
		resolved.push(entry)
		expanded = expanded.replaceAll(`@${tag}`, describeInline(entry))
	}

	return { text: expanded, resolved, unknown }
}

/**
 * One line an agent can place from without another call.
 *
 * Dimensions and the character description together, because either alone
 * leaves the decision underdetermined: the size says whether it fits, the
 * description says whether a headline can sit on it.
 */
export function describeInline(entry: AssetEntry): string {
	const parts = [`the ${entry.kind} at ${assetUrl(entry)}`]
	if (entry.width && entry.height) parts.push(`${entry.width}x${entry.height}`)
	if (entry.description) parts.push(entry.description)
	if (entry.alt) parts.push(`alt: "${entry.alt}"`)
	return `${parts.join(", ")}`
}

/**
 * The always-on index line for the generated rules files.
 *
 * Short by design. This is context every agent carries on every request, so it
 * covers what to reach for; the pixels and the full record stay behind
 * `get_asset`.
 */
export function summariseForRules(entry: AssetEntry): string {
	const size = entry.width && entry.height ? ` ${entry.width}x${entry.height}` : ""
	const description = entry.description ? ` — ${entry.description}` : ""
	return `@${entry.tag} (${entry.kind}${size}) ${assetUrl(entry)}${description}`
}

/**
 * Whether an asset is a bad fit for a box, and why.
 *
 * Caret does not decide placement — the agent has the geometry and makes that
 * call. What Caret supplies is the ability to *refuse*, because the failure this
 * prevents is silent: a small asset stretched into a large slot looks like a
 * rendering bug rather than a choice, and nobody reports it as a decision.
 */
export function fitWarning(entry: AssetEntry, box: { width: number; height: number }): string | null {
	if (!entry.width || !entry.height || box.width <= 0 || box.height <= 0) return null

	// 1.5x is where upscaling becomes visible on a normal display; below that it
	// is a judgment call and not worth interrupting anyone over.
	const upscale = Math.max(box.width / entry.width, box.height / entry.height)
	if (upscale > 1.5) {
		return `@${entry.tag} is ${entry.width}x${entry.height} and would be upscaled ${upscale.toFixed(1)}x to fill ${box.width}x${box.height}. It will look soft.`
	}

	const assetRatio = entry.width / entry.height
	const boxRatio = box.width / box.height
	const ratioGap = Math.max(assetRatio / boxRatio, boxRatio / assetRatio)
	if (ratioGap > 2) {
		return `@${entry.tag} is ${assetRatio.toFixed(2)}:1 and the box is ${boxRatio.toFixed(2)}:1. Cropping to fit will lose most of the image.`
	}

	return null
}
