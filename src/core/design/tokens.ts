import * as fs from "fs/promises"
import * as path from "path"

import { runExclusive, writeFileAtomic } from "./file-mutation-queue"
import type { FoundationTokens } from "./types"

/**
 * Reads foundation tokens from .caret/tokens/foundation.json
 */
export async function readFoundationTokens(workspacePath: string): Promise<FoundationTokens | null> {
	const filePath = path.join(workspacePath, ".caret", "tokens", "foundation.json")
	try {
		const content = await fs.readFile(filePath, "utf-8")
		return JSON.parse(content) as FoundationTokens
	} catch {
		return null
	}
}

/**
 * Writes foundation tokens to .caret/tokens/foundation.json
 *
 * Atomic and serialized, like every other design-layer write. This was the last
 * one that wasn't, and it is the file with the most concurrent readers: the
 * rules generator regenerates on every token change, the canvas's Vite plugin
 * serves it, the healer reads it, and `get_tokens` hands it to an agent. A
 * reader that catches the write mid-flight gets a truncated file — observed as
 * "Unexpected end of JSON input" in a certification run, where the failure was
 * at least visible. In the rules generator it would silently produce a project
 * whose always-on context has no foundation in it.
 */
export async function writeFoundationTokens(workspacePath: string, tokens: FoundationTokens): Promise<void> {
	const dir = path.join(workspacePath, ".caret", "tokens")
	const target = path.join(dir, "foundation.json")
	await fs.mkdir(dir, { recursive: true })
	await runExclusive(target, () => writeFileAtomic(target, JSON.stringify(tokens, null, 2)))
}

/**
 * Reads component-level tokens from .caret/tokens/components/<name>.json
 */
export async function readComponentTokens(workspacePath: string, componentName: string): Promise<unknown | null> {
	const filePath = path.join(workspacePath, ".caret", "tokens", "components", `${componentName}.json`)
	try {
		const content = await fs.readFile(filePath, "utf-8")
		return JSON.parse(content)
	} catch {
		return null
	}
}

/**
 * Validates that an object conforms to the FoundationTokens shape.
 */
export function validateFoundationTokens(obj: unknown): obj is FoundationTokens {
	if (!obj || typeof obj !== "object") {
		return false
	}

	const tokens = obj as Record<string, unknown>

	if (!tokens.vibe || typeof tokens.vibe !== "object") return false
	if (!tokens.color || typeof tokens.color !== "object") return false
	if (!tokens.typography || typeof tokens.typography !== "object") return false
	if (!tokens.spacing || typeof tokens.spacing !== "object") return false
	if (!tokens.radius || typeof tokens.radius !== "object") return false

	const vibe = tokens.vibe as Record<string, unknown>
	if (typeof vibe.description !== "string") return false
	if (!Array.isArray(vibe.tags)) return false

	const color = tokens.color as Record<string, unknown>
	if (!color.brand || typeof color.brand !== "object") return false
	if (!color.neutral || typeof color.neutral !== "object") return false
	if (!color.semantic || typeof color.semantic !== "object") return false

	// Optional palette roles: absent is fine, present must be a seeded role.
	for (const role of ["secondary", "accent"]) {
		const entry = color[role]
		if (entry === undefined) continue
		if (!entry || typeof entry !== "object") return false
		if (typeof (entry as Record<string, unknown>).seed !== "string") return false
	}

	// Optional provenance/rationale block.
	if (tokens.meta !== undefined && (!tokens.meta || typeof tokens.meta !== "object")) return false

	const typography = tokens.typography as Record<string, unknown>
	if (typeof typography.fontFamily !== "string") return false
	if (typeof typography.baseSize !== "number") return false
	if (typeof typography.scaleRatio !== "number") return false

	const spacing = tokens.spacing as Record<string, unknown>
	if (spacing.baseUnit !== 4 && spacing.baseUnit !== 8) return false
	if (!Array.isArray(spacing.scale)) return false

	const radius = tokens.radius as Record<string, unknown>
	if (!["sharp", "soft", "round", "pill"].includes(radius.character as string)) return false
	if (!Array.isArray(radius.scale)) return false

	return true
}
