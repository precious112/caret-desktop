/**
 * Curated typeface pairings.
 *
 * Typeface is the highest-leverage single decision in a design and the one a
 * developer reliably gets wrong, because the safe-looking answer — Inter for
 * everything — is also the answer that makes a product look like every other
 * product. Every option here is chosen so that picking *any* of them produces
 * something that reads as deliberate.
 *
 * The agent's job is to **narrow this list**, never to invent a font name. That
 * is the whole anti-slop mechanism: the floor is set by curation, so it holds
 * regardless of which agent is connected or how bland its taste is.
 *
 * **Licensing.** Every family here is SIL OFL 1.1, verified from the typeface's
 * own source repository rather than from a marketing page — the same discipline
 * the component catalog uses. OFL permits commercial use, self-hosting and
 * bundling, which is what a design layer that ships into a real app needs.
 */

export interface TypefacePairing {
	id: string
	/** Display name for the pick screen. Plain language, no type jargon. */
	name: string
	/** One line on what this feels like — the thing a non-designer actually chooses on. */
	feel: string
	/** Vibe tags the agent narrows against. */
	tags: string[]
	display: TypefaceRole
	body: TypefaceRole
	/** Optional monospace, for products that show code or data. */
	mono?: TypefaceRole
	/** Type scale ratio that suits this pairing. */
	scaleRatio: number
	/**
	 * The palettes and shape presets this typeface is actually good with.
	 *
	 * Curating ingredients is not curating designs. Ranking typefaces, palettes
	 * and presets separately and zipping them by index can produce a rounded,
	 * airy preset under a high-contrast editorial serif — a combination worse
	 * than either choice on its own. Compatibility has to be stated, because it
	 * is the part that cannot be inferred from tags.
	 */
	pairsWith: { palettes: string[]; shapes: string[] }
	/** Why this pairing works, for the agent — not shown to the user. */
	rationale: string
}

export interface TypefaceRole {
	family: string
	fallback: string
	weights: string[]
	licence: "OFL-1.1"
	source: string
}

const INTER: TypefaceRole = {
	family: "Inter",
	fallback: "system-ui, sans-serif",
	weights: ["400", "500", "600", "700"],
	licence: "OFL-1.1",
	source: "https://github.com/rsms/inter",
}

const GEIST_MONO: TypefaceRole = {
	family: "Geist Mono",
	fallback: "ui-monospace, monospace",
	weights: ["400", "500"],
	licence: "OFL-1.1",
	source: "https://github.com/vercel/geist-font",
}

const IBM_PLEX_MONO: TypefaceRole = {
	family: "IBM Plex Mono",
	fallback: "ui-monospace, monospace",
	weights: ["400", "500"],
	licence: "OFL-1.1",
	source: "https://github.com/IBM/plex",
}

export const TYPEFACE_PAIRINGS: TypefacePairing[] = [
	{
		id: "editorial-instrument",
		pairsWith: { palettes: ["mono-accent", "quiet-institutional"], shapes: ["editorial-open", "soft-comfortable"] },
		name: "Editorial",
		feel: "Considered and magazine-like. Big quiet headlines, plain readable text underneath.",
		tags: ["editorial", "premium", "calm", "content", "marketing", "considered"],
		display: {
			family: "Instrument Serif",
			fallback: "Georgia, serif",
			weights: ["400"],
			licence: "OFL-1.1",
			source: "https://github.com/Instrument/instrument-serif",
		},
		body: INTER,
		scaleRatio: 1.333,
		rationale:
			"A high-contrast display serif against a neutral sans is the single most reliable way to look expensive without decorating anything. Instrument Serif only has one weight, which removes the most common failure — a heading set in a serif bold that was never drawn.",
	},
	{
		id: "technical-geist",
		pairsWith: {
			palettes: ["deep-technical", "mono-accent", "quiet-institutional"],
			shapes: ["sharp-dense", "soft-comfortable"],
		},
		name: "Technical",
		feel: "Precise and modern. Reads like a well-built tool.",
		tags: ["technical", "developer", "product", "dashboard", "precise", "modern", "saas"],
		display: {
			family: "Geist",
			fallback: "system-ui, sans-serif",
			weights: ["400", "500", "600", "700"],
			licence: "OFL-1.1",
			source: "https://github.com/vercel/geist-font",
		},
		body: {
			family: "Geist",
			fallback: "system-ui, sans-serif",
			weights: ["400", "500", "600"],
			licence: "OFL-1.1",
			source: "https://github.com/vercel/geist-font",
		},
		mono: GEIST_MONO,
		scaleRatio: 1.25,
		rationale:
			"One family across display, body and mono. Matched superfamilies never clash, which makes this the safest pick when the product is the interface rather than the content.",
	},
	{
		id: "warm-fraunces",
		pairsWith: { palettes: ["warm-earth", "single-bold"], shapes: ["round-airy", "soft-comfortable"] },
		name: "Warm",
		feel: "Friendly and a bit characterful. Softer than most software.",
		tags: ["warm", "friendly", "human", "playful", "consumer", "wellness", "craft"],
		display: {
			family: "Fraunces",
			fallback: "Georgia, serif",
			weights: ["400", "600", "700"],
			licence: "OFL-1.1",
			source: "https://github.com/undercasetype/Fraunces",
		},
		body: {
			family: "Public Sans",
			fallback: "system-ui, sans-serif",
			weights: ["400", "500", "600"],
			licence: "OFL-1.1",
			source: "https://github.com/uswds/public-sans",
		},
		scaleRatio: 1.25,
		rationale:
			"Fraunces has a wonk axis and soft terminals, so it carries personality without being a novelty face. Public Sans underneath keeps the body text sober so the warmth reads as intentional rather than twee.",
	},
	{
		id: "bold-bricolage",
		pairsWith: { palettes: ["single-bold", "mono-accent"], shapes: ["pill-expressive", "soft-comfortable"] },
		name: "Bold",
		feel: "Loud and a little odd. Wants to be noticed.",
		tags: ["bold", "loud", "creative", "agency", "launch", "expressive", "unusual"],
		display: {
			family: "Bricolage Grotesque",
			fallback: "system-ui, sans-serif",
			weights: ["600", "700", "800"],
			licence: "OFL-1.1",
			source: "https://github.com/ateliertriay/bricolage",
		},
		body: INTER,
		scaleRatio: 1.414,
		rationale:
			"Bricolage is deliberately irregular — the odd width and unusual joins read as designed rather than defaulted. Pair it with a neutral body and use it for one or two things per page; used everywhere it becomes noise.",
	},
	{
		id: "crisp-space",
		pairsWith: { palettes: ["deep-technical", "single-bold"], shapes: ["sharp-dense", "soft-comfortable"] },
		name: "Crisp",
		feel: "Geometric and slightly retro-technical.",
		tags: ["technical", "geometric", "retro", "crypto", "developer", "data", "startup"],
		display: {
			family: "Space Grotesk",
			fallback: "system-ui, sans-serif",
			weights: ["500", "600", "700"],
			licence: "OFL-1.1",
			source: "https://github.com/floriankarsten/space-grotesk",
		},
		body: INTER,
		mono: IBM_PLEX_MONO,
		scaleRatio: 1.25,
		rationale:
			"Space Grotesk's tight apertures and distinctive digits make numeric UI look intentional. It is strong enough to carry a brand at display sizes and too characterful to set long body text in, hence Inter beneath it.",
	},
	{
		id: "institutional-plex",
		pairsWith: { palettes: ["quiet-institutional", "mono-accent"], shapes: ["sharp-dense", "soft-comfortable"] },
		name: "Institutional",
		feel: "Serious and solid. Trustworthy rather than fashionable.",
		tags: ["serious", "enterprise", "fintech", "healthcare", "government", "trustworthy", "dense"],
		display: {
			family: "IBM Plex Sans",
			fallback: "system-ui, sans-serif",
			weights: ["500", "600", "700"],
			licence: "OFL-1.1",
			source: "https://github.com/IBM/plex",
		},
		body: {
			family: "IBM Plex Sans",
			fallback: "system-ui, sans-serif",
			weights: ["400", "500", "600"],
			licence: "OFL-1.1",
			source: "https://github.com/IBM/plex",
		},
		mono: IBM_PLEX_MONO,
		scaleRatio: 1.2,
		rationale:
			"A superfamily with matching sans, serif and mono. The slightly narrow set width survives dense tables and forms, which is where serious products actually live.",
	},
	{
		id: "newsroom-newsreader",
		pairsWith: { palettes: ["warm-earth", "mono-accent"], shapes: ["editorial-open", "round-airy"] },
		name: "Newsroom",
		feel: "Text-first. Built for reading a lot of words.",
		tags: ["editorial", "content", "reading", "publishing", "blog", "documentation", "calm"],
		display: {
			family: "Newsreader",
			fallback: "Georgia, serif",
			weights: ["400", "500", "600"],
			licence: "OFL-1.1",
			source: "https://github.com/productiontype/Newsreader",
		},
		body: {
			family: "Newsreader",
			fallback: "Georgia, serif",
			weights: ["400", "500"],
			licence: "OFL-1.1",
			source: "https://github.com/productiontype/Newsreader",
		},
		scaleRatio: 1.25,
		rationale:
			"Setting body text in a serif is unusual in software and immediately distinguishing. Newsreader has an optical-size axis, so headlines and paragraphs stay properly drawn instead of being one shape scaled.",
	},
	{
		id: "neutral-archivo",
		pairsWith: {
			palettes: ["mono-accent", "quiet-institutional", "single-bold"],
			shapes: ["soft-comfortable", "sharp-dense"],
		},
		name: "Neutral",
		feel: "Clean and unfussy. Gets out of the way.",
		tags: ["neutral", "clean", "minimal", "utility", "internal", "flexible"],
		display: {
			family: "Archivo",
			fallback: "system-ui, sans-serif",
			weights: ["500", "600", "700"],
			licence: "OFL-1.1",
			source: "https://github.com/Omnibus-Type/Archivo",
		},
		body: {
			family: "Archivo",
			fallback: "system-ui, sans-serif",
			weights: ["400", "500", "600"],
			licence: "OFL-1.1",
			source: "https://github.com/Omnibus-Type/Archivo",
		},
		scaleRatio: 1.25,
		rationale:
			"A grotesque with a width axis, so headlines can be set condensed or expanded for emphasis without reaching for a second family. The honest choice when the content should do the work.",
	},
]

export function findPairing(id: string): TypefacePairing | undefined {
	return TYPEFACE_PAIRINGS.find((p) => p.id === id)
}

/**
 * Ranks pairings by tag overlap. Used to shortlist rather than to decide — the
 * user always picks from what comes back, and an empty query returns everything
 * rather than nothing.
 */
export function narrowPairings(tags: string[], limit = 3): TypefacePairing[] {
	if (tags.length === 0) return TYPEFACE_PAIRINGS.slice(0, limit)
	const wanted = new Set(tags.map((t) => t.toLowerCase()))
	return [...TYPEFACE_PAIRINGS]
		.map((pairing) => ({ pairing, score: pairing.tags.filter((t) => wanted.has(t)).length }))
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((entry) => entry.pairing)
}

/** Google Fonts CSS URL for a pairing, used by the preview and the entry CSS. */
export function googleFontsUrl(pairing: TypefacePairing): string {
	const families = [pairing.display, pairing.body, pairing.mono].filter(Boolean) as TypefaceRole[]
	const seen = new Set<string>()
	const params: string[] = []
	for (const role of families) {
		if (seen.has(role.family)) continue
		seen.add(role.family)
		params.push(`family=${role.family.replace(/ /g, "+")}:wght@${role.weights.join(";")}`)
	}
	return `https://fonts.googleapis.com/css2?${params.join("&")}&display=swap`
}
