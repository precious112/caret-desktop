/**
 * What the explainer page gets to call.
 *
 * Bundled from the **real** generators rather than reimplemented in the page.
 * A hand-written copy would drift, and then the page would be arguing for
 * something the product does not do — which is worse than not having the page.
 */
import { ASSET_RECIPES, composeVariants, derivePalette, GENERATORS, runGenerator } from "../src/core/design/asset-library"
import type { FoundationTokens } from "../src/core/design/types"

/** A foundation built from the three controls the page exposes. */
function foundation(input: {
	brand: string
	neutral: FoundationTokens["color"]["neutral"]["character"]
	surface: "light" | "dark"
}): FoundationTokens {
	return {
		vibe: { description: "", tags: [] },
		color: {
			brand: { seed: input.brand, scale: {} },
			neutral: { character: input.neutral, scale: {} },
			semantic: { success: "#16a34a", warning: "#ca8a04", error: "#dc2626", info: "#2563eb" },
			surface: input.surface,
		},
		typography: { fontFamily: "Inter", fallback: "system-ui", scaleRatio: 1.25, baseSize: 16, scale: {} },
		spacing: { baseUnit: 4, scale: [0, 4, 8] },
		radius: { character: "soft", scale: [0, 4, 8] },
	}
}

Object.assign(window as unknown as Record<string, unknown>, {
	CARET: { GENERATORS, runGenerator, derivePalette, ASSET_RECIPES, composeVariants, foundation },
})
