/**
 * The colour half of live token bindings.
 *
 * Three questions, answered from `foundation.json` alone so the answers stay
 * consistent with the generated theme (`caret-theme.css` is derived from the
 * same object):
 *
 *  - does this class name a foundation token?         → {@link foundationTokenForClass}
 *  - does this picked hex exactly equal a token?      → {@link tokenClassForHex}
 *  - how many places would a token edit reach?        → {@link countTokenUses}
 *
 * Everything here is exact-match by design. "Close to brand-500" is precisely
 * the judgment Caret must NOT make silently — a near-match bound to a token
 * would change the user's picked colour out from under them.
 */
import * as fs from "fs/promises"
import * as path from "path"

import type { FoundationTokens } from "../types"

/**
 * Utility families that take a colour. Shared with the AST editor's replacer —
 * one list, or the recogniser and the binder drift on what a colour class is.
 */
export const COLOR_UTILITY_PREFIXES = [
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

const SEMANTIC_NAMES = ["success", "warning", "error", "info"] as const

/** `#abc` → `#aabbcc`, lowercased. Null for anything that is not a plain hex colour. */
export function normalizeHex(value: string): string | null {
	const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(value.trim())
	if (!m) return null
	const hex = m[1].toLowerCase()
	if (hex.length === 3) {
		return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
	}
	return `#${hex}`
}

/**
 * The token a class binds to, or null. `bg-brand-500` → `"brand-500"` only when
 * the foundation actually defines that step — `bg-brand-475` is someone's typo,
 * not a token, and treating it as one would invent a foundation entry on promote.
 */
export function foundationTokenForClass(cls: string, tokens: FoundationTokens | null): string | null {
	if (!tokens) return null
	const prefix = COLOR_UTILITY_PREFIXES.find((p) => cls.startsWith(p))
	if (!prefix) return null
	const suffix = cls.slice(prefix.length)
	return tokenValue(tokens, suffix) !== null ? suffix : null
}

/** The hex a token currently resolves to, or null when the foundation doesn't define it. */
export function tokenValue(tokens: FoundationTokens, name: string): string | null {
	if (name === "brand") return tokens.color?.brand?.seed || null
	const scaleMatch = /^(brand|neutral)-(\d+)$/.exec(name)
	if (scaleMatch) {
		const scale = scaleMatch[1] === "brand" ? tokens.color?.brand?.scale : tokens.color?.neutral?.scale
		const value = (scale as Record<string, string> | undefined)?.[scaleMatch[2]]
		return typeof value === "string" && value.length > 0 ? value : null
	}
	if ((SEMANTIC_NAMES as readonly string[]).includes(name)) {
		const value = tokens.color?.semantic?.[name as (typeof SEMANTIC_NAMES)[number]]
		return typeof value === "string" && value.length > 0 ? value : null
	}
	return null
}

/**
 * The token whose value exactly equals the picked hex, or null. Scale steps
 * beat the bare seed (`brand-500` says more than `brand`), brand beats neutral
 * beats semantic — when two tokens share a value the more specific claim wins.
 */
export function tokenClassForHex(hex: string, tokens: FoundationTokens | null): string | null {
	if (!tokens) return null
	const wanted = normalizeHex(hex)
	if (!wanted) return null

	for (const [scaleName, scale] of [
		["brand", tokens.color?.brand?.scale],
		["neutral", tokens.color?.neutral?.scale],
	] as const) {
		for (const [step, value] of Object.entries(scale ?? {})) {
			if (typeof value === "string" && normalizeHex(value) === wanted) return `${scaleName}-${step}`
		}
	}
	for (const name of SEMANTIC_NAMES) {
		const value = tokens.color?.semantic?.[name]
		if (typeof value === "string" && normalizeHex(value) === wanted) return name
	}
	if (tokens.color?.brand?.seed && normalizeHex(tokens.color.brand.seed) === wanted) return "brand"
	return null
}

/**
 * Points a token at a new value, in place. Returns false when the name is not a
 * foundation token — the caller must not write a foundation.json it didn't change.
 */
export function setFoundationTokenValue(tokens: FoundationTokens, name: string, hex: string): boolean {
	const value = normalizeHex(hex)
	if (!value) return false
	if (name === "brand") {
		if (!tokens.color?.brand) return false
		tokens.color.brand.seed = value
		return true
	}
	const scaleMatch = /^(brand|neutral)-(\d+)$/.exec(name)
	if (scaleMatch) {
		const holder = scaleMatch[1] === "brand" ? tokens.color?.brand : tokens.color?.neutral
		if (!holder) return false
		// Only repoint steps that exist: promote follows a detach FROM this step,
		// so absence means the foundation changed underneath — refuse, don't invent.
		const scale = (holder.scale ?? {}) as Record<string, string>
		if (!(scaleMatch[2] in scale)) return false
		scale[scaleMatch[2]] = value
		holder.scale = scale as never
		return true
	}
	if ((SEMANTIC_NAMES as readonly string[]).includes(name) && tokens.color?.semantic) {
		tokens.color.semantic[name as (typeof SEMANTIC_NAMES)[number]] = value
		return true
	}
	return false
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Directories whose `.tsx` files can reference token utilities. */
const SCAN_DIRS = ["pages", "components", "layouts"]

export interface TokenUseCount {
	/** Total utility occurrences (`bg-brand-500`, `hover:text-brand-500`, …). */
	occurrences: number
	/** Distinct files containing at least one. */
	files: number
}

async function countPattern(caretDir: string, pattern: RegExp): Promise<TokenUseCount> {
	let occurrences = 0
	let files = 0

	async function scanDir(dir: string): Promise<void> {
		const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
		for (const entry of entries) {
			const full = path.join(dir, entry.name)
			if (entry.isDirectory()) {
				await scanDir(full)
			} else if (entry.isFile() && entry.name.endsWith(".tsx")) {
				const source = await fs.readFile(full, "utf-8").catch(() => "")
				const matches = source.match(pattern)
				if (matches && matches.length > 0) {
					occurrences += matches.length
					files += 1
				}
			}
		}
	}

	for (const dir of SCAN_DIRS) {
		await scanDir(path.join(caretDir, dir))
	}
	return { occurrences, files }
}

/**
 * The blast radius of editing a token: every colour-utility use of it across
 * the design layer's authored source. Computed by scanning `.caret/` — which
 * Caret can do exactly, and is the number that justifies defaulting inline
 * edits to detach (one element) rather than token edit (all of these at once).
 */
export async function countTokenUses(caretDir: string, tokenName: string): Promise<TokenUseCount> {
	const families = COLOR_UTILITY_PREFIXES.map((p) => p.slice(0, -1)).join("|")
	const pattern = new RegExp(`(?:^|[^\\w-])(?:${families})-${escapeRegExp(tokenName)}(?![\\w-])`, "g")
	return countPattern(caretDir, pattern)
}

/** Every colour token the foundation currently defines, by utility name. */
export function allTokenNames(tokens: FoundationTokens): string[] {
	const names: string[] = []
	if (tokens.color?.brand?.seed) names.push("brand")
	for (const step of Object.keys(tokens.color?.brand?.scale ?? {})) names.push(`brand-${step}`)
	for (const step of Object.keys(tokens.color?.neutral?.scale ?? {})) names.push(`neutral-${step}`)
	for (const name of SEMANTIC_NAMES) {
		if (tokens.color?.semantic?.[name]) names.push(name)
	}
	return names
}

/**
 * The blast radius of re-running the foundation entirely: every colour-utility
 * use of ANY defined token. What the re-run warning shows — "N places across M
 * files restyle live" is a number, not a vibe.
 */
export async function countAllTokenUses(caretDir: string, tokens: FoundationTokens | null): Promise<TokenUseCount> {
	const names = tokens ? allTokenNames(tokens) : []
	if (names.length === 0) return { occurrences: 0, files: 0 }
	const families = COLOR_UTILITY_PREFIXES.map((p) => p.slice(0, -1)).join("|")
	// Longest-first so `brand-500` wins over the `brand` prefix without leaning
	// on the engine's backtracking order.
	const alternation = names
		.slice()
		.sort((a, b) => b.length - a.length)
		.map(escapeRegExp)
		.join("|")
	const pattern = new RegExp(`(?:^|[^\\w-])(?:${families})-(?:${alternation})(?![\\w-])`, "g")
	return countPattern(caretDir, pattern)
}
