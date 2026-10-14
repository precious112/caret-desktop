/**
 * Standard design terms. The planner names every part with one of these; the
 * checker reads the synonyms, so a renamed or merely described part is still
 * recognised ("a short line of tiny spaced-out capitals above the heading" is an
 * eyebrow). Neutral terms are included on purpose, so the list does not nudge
 * the planner toward the habits it is checked against.
 */
export const GLOSSARY: ReadonlyArray<readonly [term: string, synonyms: string]> = [
	["nav bar", "top navigation, header menu"],
	["hero", "masthead, top section, above the fold"],
	["headline", "main heading, h1, title"],
	["oversized headline", "giant headline, display headline, very large hero type"],
	["eyebrow", "kicker, overline, pretitle, supertitle, small label above a heading, section label"],
	["pill badge", "chip, tag, lozenge, announcement pill, rounded label"],
	["button", "call to action, CTA"],
	["pill button", "fully rounded button, capsule button"],
	["text link", "inline link, arrow link"],
	["image", "photo, picture, illustration"],
	["product shot", "product photo, packshot"],
	["card", "tile, panel, box, block"],
	["card grid", "row of cards, card row, tiles side by side, bento grid"],
	["icon tile", "icon in a rounded square, icon badge, icon chip"],
	["list", "stacked rows, table rows, list items"],
	["table", "data table, comparison table"],
	["stat banner", "metrics strip, numbers row, KPI band, stats bar"],
	["testimonial", "quote, review, customer quote"],
	["logo row", "logo strip, trusted-by bar"],
	["form", "input fields, sign-up form"],
	["footer", "bottom section, site footer"],
	["numbered labels", "01 02 03 markers, step numbers, index numbers"],
	["timeline", "steps in order, process line"],
	["status dot", "live dot, pulsing dot, indicator dot"],
	["side stripe", "coloured left border, accent border on one side"],
	["gradient background", "colour fade, gradient wash, ombre background"],
	["gradient text", "text filled with a gradient, clipped gradient text"],
	["glow", "coloured shadow, neon glow, halo, aurora, blurred orb"],
	["glass panel", "frosted glass, blurred translucent panel, backdrop blur, glassmorphism"],
	["grid background", "dot grid, graph-paper background, line pattern"],
	["noise texture", "grain, film grain overlay"],
	["italic accent word", "one word in italic serif inside a headline"],
	["em dash", "long dash in copy, —"],
	["middot separator", "· between phrases, dot-separated meta line"],
	["arrow in button", "→ or ↗ after button text"],
	["divider", "hairline rule, separator line"],
]

export function glossaryText(): string {
	return GLOSSARY.map(([term, synonyms]) => `- ${term}: ${synonyms}`).join("\n")
}
