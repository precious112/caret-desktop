/**
 * The manual editor's data layer, shared with the design-system view.
 *
 * The draft holds only what the step components edit. Loading narrows the
 * saved file into a draft; saving merges the draft OVER the file as loaded, so
 * fields the editor does not know about (`meta`, on-colours, motion, whatever
 * arrives next) survive the round-trip. `color.surface` was silently dropped
 * on every save before this merge existed.
 */

export type FoundationTokensDraft = {
	vibe: { description: string; tags: string[] }
	color: {
		brand: { seed: string; scale: Record<string, string> }
		/** Optional palette roles — absent until the user adds them. */
		secondary?: { seed: string; scale: Record<string, string> }
		accent?: { seed: string; scale: Record<string, string> }
		neutral: { character: string; scale: Record<string, string> }
		surface: "light" | "dark"
		semantic: { success: string; warning: string; error: string; info: string }
	}
	typography: {
		fontFamily: string
		fallback: string
		displayFamily?: string
		displayFallback?: string
		scaleRatio: number
		baseSize: number
		scale: Record<string, string>
		weights?: { display: number[]; body: number[] }
	}
	spacing: { baseUnit: number; scale: number[] }
	radius: { character: string; scale: number[] }
	elevation?: { character: "flat" | "subtle" | "pronounced" }
	border?: { width: number; focusRing: { width: number } }
}

export const DEFAULT_TOKENS: FoundationTokensDraft = {
	vibe: { description: "", tags: [] },
	color: {
		brand: { seed: "#3b82f6", scale: {} },
		neutral: { character: "cool", scale: {} },
		surface: "light",
		semantic: { success: "#22c55e", warning: "#eab308", error: "#ef4444", info: "#3b82f6" },
	},
	typography: {
		fontFamily: "Inter",
		fallback: "system-ui, sans-serif",
		scaleRatio: 1.25,
		baseSize: 16,
		scale: {},
	},
	spacing: { baseUnit: 4, scale: [0, 1, 2, 4, 6, 8, 12, 16, 24, 32, 48, 64] },
	radius: { character: "soft", scale: [0, 2, 4, 8, 12, 9999] },
}

/** Narrow the saved file into the editable draft. */
export function draftFromSaved(saved: Record<string, any>): FoundationTokensDraft {
	const prev = DEFAULT_TOKENS
	return {
		...prev,
		vibe: { ...prev.vibe, ...saved.vibe },
		color: {
			...prev.color,
			...saved.color,
			brand: { ...prev.color.brand, ...saved.color?.brand },
			neutral: { ...prev.color.neutral, ...saved.color?.neutral },
			surface: saved.color?.surface === "dark" ? "dark" : "light",
			semantic: { ...prev.color.semantic, ...saved.color?.semantic },
		},
		typography: { ...prev.typography, ...saved.typography },
		spacing: { ...prev.spacing, ...saved.spacing },
		radius: { ...prev.radius, ...saved.radius },
		elevation: saved.elevation ? { character: saved.elevation.character } : undefined,
		border: saved.border
			? { width: saved.border.width, focusRing: { width: saved.border.focusRing?.width ?? 2 } }
			: undefined,
	}
}

/**
 * Draft over loaded file: the editor's sections replace what they own,
 * everything else in the file rides through untouched. A role the user removed
 * must actually go, so absent draft roles are deleted.
 */
export function mergeDraftOverSaved(savedRaw: Record<string, any> | null, tokens: FoundationTokensDraft): Record<string, any> {
	const merged: Record<string, any> = {
		...savedRaw,
		...tokens,
		color: { ...savedRaw?.color, ...tokens.color },
		typography: { ...savedRaw?.typography, ...tokens.typography },
	}
	if (!tokens.color.secondary) delete merged.color.secondary
	if (!tokens.color.accent) delete merged.color.accent
	if (tokens.elevation) merged.elevation = { ...savedRaw?.elevation, ...tokens.elevation }
	else delete merged.elevation
	if (tokens.border) {
		merged.border = {
			...savedRaw?.border,
			width: tokens.border.width,
			focusRing: { ...savedRaw?.border?.focusRing, width: tokens.border.focusRing.width },
		}
	}
	return merged
}
