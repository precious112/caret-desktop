import type { FoundationTokensDraft } from "../TokenWizard"

export function tokensToCssVars(tokens: FoundationTokensDraft): Record<string, string> {
	const vars: Record<string, string> = {}

	// Brand colors
	if (tokens.color.brand.scale) {
		for (const [step, color] of Object.entries(tokens.color.brand.scale)) {
			vars[`--color-brand-${step}`] = color as string
		}
	}
	vars["--color-brand-seed"] = tokens.color.brand.seed

	// Optional palette roles
	if (tokens.color.secondary) vars["--color-secondary-seed"] = tokens.color.secondary.seed
	if (tokens.color.accent) vars["--color-accent-seed"] = tokens.color.accent.seed

	// Semantic colors
	vars["--color-success"] = tokens.color.semantic.success
	vars["--color-warning"] = tokens.color.semantic.warning
	vars["--color-error"] = tokens.color.semantic.error
	vars["--color-info"] = tokens.color.semantic.info

	// Typography
	vars["--font-family"] = tokens.typography.fontFamily
	vars["--font-fallback"] = tokens.typography.fallback
	vars["--font-base-size"] = `${tokens.typography.baseSize}px`

	const baseSize = tokens.typography.baseSize
	const ratio = tokens.typography.scaleRatio
	const typLabels = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl"]
	const baseIndex = 2
	for (let i = 0; i < typLabels.length; i++) {
		const size = Math.round(baseSize * ratio ** (i - baseIndex) * 100) / 100
		vars[`--font-size-${typLabels[i]}`] = `${size}px`
	}

	// Spacing — scale entries are px values; the base unit is the rhythm.
	for (const px of tokens.spacing.scale) {
		vars[`--space-${px}`] = `${px}px`
	}

	// Radius
	const radiusLabels = ["none", "sm", "md", "lg", "xl", "full"]
	for (let i = 0; i < Math.min(tokens.radius.scale.length, radiusLabels.length); i++) {
		const val = tokens.radius.scale[i]
		vars[`--radius-${radiusLabels[i]}`] = val === 9999 ? "9999px" : `${val}px`
	}

	return vars
}
