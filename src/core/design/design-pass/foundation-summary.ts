/**
 * The approved foundation as the planner and designer read it: the values the
 * user chose, compactly. The full token file is mostly derived ramps, which say
 * nothing a plan needs and cost a lot of context to repeat in every step.
 */
import type { FoundationTokens } from "../types"

export function foundationSummary(tokens: FoundationTokens | null): string | null {
	if (!tokens) return null
	const { color, typography, radius, spacing } = tokens
	const role = (name: string, value: { seed: string } | undefined) => (value ? `${name} ${value.seed}` : null)
	const neutral = color.neutral?.scale ?? {}
	const lines = [
		`Colours: ${[role("brand", color.brand), role("secondary", color.secondary), role("accent", color.accent)].filter(Boolean).join(", ")}`,
		`Surface: ${color.surface ?? "light"}; neutrals (${color.neutral?.character ?? "true"}) ${[neutral[50], neutral[100], neutral[500], neutral[900], neutral[950]].filter(Boolean).join(" ")}`,
		color.on ? `Text: on surface ${color.on.surface}, muted ${color.on.surfaceMuted}, on brand ${color.on.brand}` : null,
		`Fonts: headings ${typography.displayFamily ?? typography.fontFamily}, body ${typography.fontFamily}; base ${typography.baseSize}px, scale ratio ${typography.scaleRatio}`,
		typography.weights
			? `Weights: display ${typography.weights.display.join("/")}, body ${typography.weights.body.join("/")}`
			: null,
		`Corner radius (${radius.character}): ${radius.scale.join(", ")} px`,
		`Spacing: base ${spacing.baseUnit}px`,
		tokens.meta?.rule ? `Restraint rule: ${tokens.meta.rule}` : null,
		tokens.vibe?.description ? `Feel: ${tokens.vibe.description}` : null,
	]
	return lines.filter(Boolean).join("\n")
}
