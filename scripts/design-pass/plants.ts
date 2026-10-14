/**
 * Habits planted into clean plans, each written three ways: by its standard
 * term, by another name, and only described. The answer key comes by
 * construction (we know what we planted, and where), so nobody labels anything.
 * `accept` lists every habit that fairly describes the plant; the checker gets
 * credit for any of them, and the plant's expected level is its first habit's.
 */
import type { DesignPlan, PlanComponent } from "../../src/core/design/design-pass/plan"

const comp = (term: string, looks: string, content: string): PlanComponent => ({ term, looks, content })

export type Form = "term" | "alias" | "described"

export interface Plant {
	accept: string[]
	/** Planted in the first (hero) section. */
	hero?: boolean
	/** Planted as body copy rather than a component. */
	copy?: boolean
	forms: Record<Form, PlanComponent | string>
}

export const PLANTS: Record<string, Plant> = {
	eyebrow: {
		accept: ["eyebrow-labels", "hero-badge", "centered-hero-with-three-cards", "monospace-labels"],
		forms: {
			term: comp("eyebrow", "11px uppercase, letter-spacing 0.18em, grey", "SMALL BATCH, EST. 2019"),
			alias: comp("kicker", "11px uppercase, letter-spacing 0.18em, grey", "SMALL BATCH, EST. 2019"),
			described: comp(
				"other",
				"a short line of tiny, widely spaced capital letters sitting just above the section's heading, 11px, grey",
				"SMALL BATCH, EST. 2019",
			),
		},
	},
	"purple-gradient": {
		accept: ["purple-indigo-gradients", "decorative-ui-gradients"],
		forms: {
			term: comp("gradient background", "purple to indigo, full width behind the section", "background"),
			alias: comp("ombre background", "violet melting into indigo behind the whole section", "background"),
			described: comp(
				"other",
				"the section's background goes from violet in the top left corner to deep indigo in the bottom right",
				"background",
			),
		},
	},
	"icon-cards": {
		accept: [
			"feature-card-icon-tiles",
			"default-card-grids",
			"centered-hero-with-three-cards",
			"ornamental-icon-rows",
			"lucide-icons",
		],
		forms: {
			term: comp(
				"card grid",
				"three equal cards, each with an icon tile (24px icon in a 48px rounded square), a bold title and two lines of text",
				"Easy setup / Secure by default / Friendly support",
			),
			alias: comp(
				"feature tiles",
				"three tiles of the same size, each led by an icon badge, then a bold title and two lines",
				"Easy setup / Secure by default / Friendly support",
			),
			described: comp(
				"other",
				"three boxes of the same size side by side; each starts with a small icon inside a tinted rounded square, then a bold title and two short lines",
				"Easy setup / Secure by default / Friendly support",
			),
		},
	},
	"oversized-headline": {
		hero: true,
		accept: ["oversized-hero-headline", "serif-display-hero", "tight-display-leading", "negative-heading-tracking"],
		forms: {
			term: comp("oversized headline", "128px, weight 800, line height 0.9, filling the width", "the headline"),
			alias: comp("display headline", "128px, weight 800, line height 0.9, filling the width", "the headline"),
			described: comp(
				"headline",
				"enormous type, about 128px, so tight the lines nearly touch, stretching edge to edge",
				"the headline",
			),
		},
	},
	"status-dot": {
		accept: ["pulsing-status-dots"],
		forms: {
			term: comp("status dot", "8px green dot that pulses, beside the words 'Open now'", "Open now"),
			alias: comp("live indicator", "8px green dot that pulses, beside the words 'Open now'", "Open now"),
			described: comp("other", "a tiny green circle that slowly fades in and out, beside the words 'Open now'", "Open now"),
		},
	},
	emoji: {
		accept: ["emoji-icons", "em-dash-copy"],
		forms: {
			term: comp("list", "each row starts with an emoji as its icon", "🔥 Quick / 🌊 Fresh / ✨ Simple"),
			alias: comp("emoji bullets", "a list whose bullets are emoji", "🔥 Quick / 🌊 Fresh / ✨ Simple"),
			described: comp("list", "each line opens with a small picture character", "🔥 Quick / 🌊 Fresh / ✨ Simple"),
		},
	},
	glass: {
		accept: ["glassmorphism"],
		forms: {
			term: comp("glass panel", "frosted, background blur 14px, white at 40% opacity", "a short note"),
			alias: comp("glassmorphism card", "white at 40% opacity with a 14px blur", "a short note"),
			described: comp("card", "a see-through panel that blurs whatever is behind it, white at 40% opacity", "a short note"),
		},
	},
	"stat-banner": {
		accept: ["stat-metrics"],
		forms: {
			term: comp("stat banner", "three big numbers with captions", "10k+ customers | 99% satisfaction | 24/7 support"),
			alias: comp("metrics strip", "three big numbers with captions", "10k+ customers | 99% satisfaction | 24/7 support"),
			described: comp(
				"other",
				"a row of three very large numbers, each with a small caption under it",
				"10k+ customers, 99% satisfaction, 24/7 support",
			),
		},
	},
	"gradient-text": {
		hero: true,
		accept: ["gradient-headline-text", "coloured-glow-effects", "decorative-ui-gradients"],
		forms: {
			term: comp("gradient text", "the headline filled with a pink to orange gradient", "the headline"),
			alias: comp("clipped gradient type", "pink to orange gradient clipped to the headline letters", "the headline"),
			described: comp(
				"headline",
				"the headline's letters are coloured with a pink-to-orange fade instead of one solid colour",
				"the headline",
			),
		},
	},
	"side-stripe": {
		accept: ["card-side-stripes"],
		forms: {
			term: comp("side stripe", "note card with a 4px brand-colour left border", "A note about delivery"),
			alias: comp("callout with accent border", "a 4px brand-colour border on the left edge only", "A note about delivery"),
			described: comp(
				"card",
				"a note box whose left edge is a thick coloured line while the other edges have no border",
				"A note about delivery",
			),
		},
	},
	"italic-accent": {
		hero: true,
		accept: ["italic-accent-word"],
		forms: {
			term: comp("italic accent word", "the last word of the headline in italic serif", "the headline"),
			alias: comp("emphasised word", "one word of the headline switched to an italic serif", "the headline"),
			described: comp("headline", "the last word is in a slanted serif font while the rest stays upright", "the headline"),
		},
	},
	aphorism: {
		copy: true,
		accept: ["aphoristic-contrast-copy", "fragmented-taglines", "generic-saas-copy"],
		forms: {
			term: "Made for people, not spreadsheets.",
			alias: "It's not a tool. It's a ritual.",
			described: "Less noise. More focus. Better days.",
		},
	},
}

/** Each variant gets 4 plants, spread over different sections (the footer is never used). */
export const GROUPS: string[][] = [
	["eyebrow", "icon-cards", "glass", "aphorism"],
	["purple-gradient", "status-dot", "stat-banner", "italic-accent"],
	["oversized-headline", "emoji", "side-stripe", "gradient-text"],
]

export function plant(plan: DesignPlan, keys: string[], form: Form): { plan: DesignPlan; where: Record<string, string> } {
	const copy = JSON.parse(JSON.stringify(plan)) as DesignPlan
	const body = copy.sections.filter((s) => s.id !== "footer")
	const used = new Set<string>()
	const where: Record<string, string> = {}
	for (const key of keys) {
		const p = PLANTS[key]
		let section = p.hero
			? body[0]
			: (body.find((x, i) => i > 0 && !used.has(x.id)) ?? body.find((x) => !used.has(x.id)) ?? body[1])
		if (p.hero && used.has(body[0].id)) section = body[1]
		used.add(section.id)
		where[key] = section.id
		const planted = p.forms[form]
		if (typeof planted === "string") section.copy.body = `${section.copy.body ? `${section.copy.body} ` : ""}${planted}`
		else section.components.push({ ...planted })
	}
	return { plan: copy, where }
}
