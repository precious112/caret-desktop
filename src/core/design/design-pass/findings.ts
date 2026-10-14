/**
 * Turning checker reports and exact-value scans into levelled items.
 *
 * Nothing a checker says is taken on trust: the habit must exist on the list
 * (and be strong enough to act on) and the quote must really be in the section,
 * or the claim is thrown out. Exact colours and fonts never come from a checker
 * at all — code measures them. And anything the user chose (in the approved
 * foundation, or named in their own words) is level 0: never flagged.
 */
import type { FoundationTokens } from "../types"
import { closeMatch, hexesIn, isUninformative, parseHex, type Rgb, sameColour } from "./colour"
import type { DesignPlan, PlanSection } from "./plan"
import { activeHabits, FLOOR, habitById, type Level, levelOf } from "./slop-list"

/** What the user approved: the committed foundation's values. */
export interface Approved {
	colours: Rgb[]
	/** Lower-cased family names. */
	fonts: string[]
	/** Corner radii in px from the foundation's scale. */
	radii: number[]
	radiusCharacter?: "sharp" | "soft" | "round" | "pill"
}

export const NOTHING_APPROVED: Approved = { colours: [], fonts: [], radii: [] }

/** Every value in a committed foundation, as the Design pass compares against it. */
export function approvedFrom(tokens: FoundationTokens | null | undefined): Approved {
	if (!tokens) return NOTHING_APPROVED
	const hexes: string[] = []
	const collect = (value: unknown): void => {
		if (typeof value === "string") {
			if (parseHex(value)) hexes.push(value)
		} else if (value && typeof value === "object") {
			for (const inner of Object.values(value)) collect(inner)
		}
	}
	collect(tokens.color)
	const fonts = [tokens.typography?.fontFamily, tokens.typography?.displayFamily]
		.filter((f): f is string => !!f)
		.map((f) => f.toLowerCase().trim())
	return {
		colours: hexes.map(parseHex).filter((c): c is Rgb => !!c),
		fonts: [...new Set(fonts)],
		radii: (tokens.radius?.scale ?? []).filter((r) => Number.isFinite(r)),
		radiusCharacter: tokens.radius?.character,
	}
}

export interface CheckerMatch {
	id: string
	quote: string
	confidence?: "high" | "low"
}

export interface Finding {
	section: string
	habit: string
	quote: string
	by: "checker" | "code"
	/** The user chose this (foundation or brief): level 0, never flagged. */
	userChose: boolean
}

export interface Rejected extends CheckerMatch {
	section: string
	why: string
}

export const normalize = (value: string): string =>
	String(value ?? "")
		.toLowerCase()
		.replace(/[‘’]/g, "'")
		.replace(/[“”]/g, '"')
		.replace(/\s+/g, " ")
		.trim()

/**
 * Is the quote really in the section? Word for word after normalising, or — for
 * a quote that stitches two adjacent fields together — at least 85% of its
 * words present. A made-up quote shares a few words by chance, never most.
 */
export function quoteIn(quote: string, section: PlanSection): boolean {
	const hay = normalize(JSON.stringify(section).replace(/\\"/g, '"'))
	const q = normalize(quote)
	if (!q) return false
	if (hay.includes(q)) return true
	const words = q.split(/[^a-z0-9#]+/).filter((w) => w.length > 2)
	return words.length > 0 && words.filter((w) => hay.includes(w)).length / words.length >= 0.85
}

const wordPattern = (phrase: string) =>
	new RegExp(
		`(^|[^a-z])${phrase
			.toLowerCase()
			.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
			.replace(/ /g, "\\s+")}([^a-z]|$)`,
	)

/** True when every colour and font the quote names is approved (and it names at least one). */
export function onlyApprovedValues(quote: string, approved: Approved): boolean {
	const colours = hexesIn(quote)
		.map(parseHex)
		.filter((c): c is Rgb => !!c)
	const lower = quote.toLowerCase()
	const fonts = approved.fonts.filter((font) => wordPattern(font).test(lower))
	if (colours.length === 0 && fonts.length === 0) return false
	return colours.every((colour) => approved.colours.some((a) => sameColour(a, colour)))
}

/**
 * A radius habit ("pill buttons", "over-rounded surfaces") described with a
 * radius the foundation itself defines. The interview approved it; the slop
 * list does not get to overrule that.
 */
export function usesApprovedRadius(quote: string, section: PlanSection, approved: Approved): boolean {
	// The quote often names the part ("pill button") while its radius sits in the
	// same component's `looks`, so read both.
	const q = normalize(quote)
	const owner = section.components.filter((c) => normalize(`${c.term} ${c.looks} ${c.content}`).includes(q))
	const text = [quote, ...owner.map((c) => c.looks)].join(" ")
	const radii = [
		...text.matchAll(
			/(\d+(?:\.\d+)?)\s*px\s*(?:corners?|radius|rounded)|(?:corners?|radius|rounded)[^0-9]{0,12}(\d+(?:\.\d+)?)\s*px/gi,
		),
	].map((m) => Number(m[1] ?? m[2]))
	const fully = /fully rounded|pill|capsule|9999|999px|rounded-full/i.test(text)
	if (fully) return approved.radiusCharacter === "pill" || approved.radii.some((r) => r >= 999)
	return radii.length > 0 && radii.every((r) => approved.radii.includes(r))
}

/** Checks one checker report against the list and the section itself. */
export function verifyMatches(
	section: PlanSection,
	matches: CheckerMatch[],
	approved: Approved,
): { findings: Finding[]; rejected: Rejected[] } {
	const findings: Finding[] = []
	const rejected: Rejected[] = []
	for (const match of matches) {
		const habit = habitById(String(match.id ?? ""))
		if (!habit || habit.sources < FLOOR || habit.fewOptions) {
			rejected.push({ section: section.id, ...match, why: "unknown habit id" })
			continue
		}
		if (!quoteIn(String(match.quote ?? ""), section)) {
			rejected.push({ section: section.id, ...match, why: "quote not in the plan" })
			continue
		}
		const valueHabit = habit.kinds.includes("foundation") || habit.kinds.includes("font")
		const userChose =
			(valueHabit && onlyApprovedValues(match.quote, approved)) ||
			(habit.radius && usesApprovedRadius(match.quote, section, approved))
		findings.push({ section: section.id, habit: habit.id, quote: match.quote, by: "checker", userChose })
	}
	return { findings, rejected }
}

/**
 * Reported exact values in the plan, measured by code. `brief` is the user's own
 * words: a colour or font they named there is theirs, not a habit.
 */
export function valueFindings(plan: DesignPlan, approved: Approved, brief: string): Finding[] {
	const out: Finding[] = []
	const lowerBrief = brief.toLowerCase()
	const briefColours = hexesIn(brief)
		.map(parseHex)
		.filter((c): c is Rgb => !!c)
	const habits = activeHabits()
	const scan = (where: string, text: string) => {
		for (const hex of hexesIn(text)) {
			const colour = parseHex(hex)
			if (!colour || isUninformative(colour)) continue
			for (const habit of habits) {
				for (const reported of habit.colours) {
					const target = parseHex(reported)
					if (!target || isUninformative(target) || closeMatch(colour, target) === null) continue
					const userChose =
						approved.colours.some((a) => sameColour(a, colour)) || briefColours.some((b) => sameColour(b, colour))
					out.push({ section: where, habit: habit.id, quote: hex, by: "code", userChose })
				}
			}
		}
		const lower = text.toLowerCase()
		for (const habit of habits) {
			for (const font of habit.fonts) {
				const name = font.toLowerCase()
				if (name.length < 4 || !wordPattern(name).test(lower)) continue
				const userChose = approved.fonts.includes(name) || wordPattern(name).test(lowerBrief)
				out.push({ section: where, habit: habit.id, quote: font, by: "code", userChose })
			}
		}
	}
	for (const section of plan.sections) scan(section.id, JSON.stringify(section))
	// One finding per (section, habit, value): the same hex matching two reported
	// shades of one habit is one finding, not two.
	const seen = new Set<string>()
	return out.filter((f) => {
		const key = `${f.section}|${f.habit}|${normalize(f.quote)}`
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})
}

/** One flagged part of the plan: a quote in a section, and the habits it matched. */
export interface Item {
	section: string
	quote: string
	habits: string[]
	names: string[]
	/** The strongest matched habit's source count. */
	sources: number
	/** How many sections the strongest-spread matched habit appears in. */
	spread: number
	level: Level
	by: Array<"checker" | "code">
}

/**
 * Groups findings into items (one per section + quote) and gives each a level.
 * An item's frequency is the highest source count among the habits it matched;
 * its spread is how many sections those habits were found in. Anything the user
 * chose is level 0, whatever the list says.
 */
export function applyLevels(findings: Finding[]): Item[] {
	const sectionsPerHabit = new Map<string, Set<string>>()
	for (const f of findings) {
		if (f.userChose) continue
		const set = sectionsPerHabit.get(f.habit) ?? new Set<string>()
		set.add(f.section)
		sectionsPerHabit.set(f.habit, set)
	}
	const groups = new Map<
		string,
		{ section: string; quote: string; habits: Set<string>; userChose: boolean; by: Set<"checker" | "code"> }
	>()
	for (const f of findings) {
		const key = `${f.section}|${normalize(f.quote)}`
		const group = groups.get(key) ?? {
			section: f.section,
			quote: f.quote,
			habits: new Set(),
			userChose: false,
			by: new Set(),
		}
		group.habits.add(f.habit)
		group.by.add(f.by)
		if (f.userChose) group.userChose = true
		groups.set(key, group)
	}
	return [...groups.values()].map((group) => {
		const habits = [...group.habits].map((id) => habitById(id)).filter((h) => !!h)
		const ordered = habits.sort((a, b) => b.sources - a.sources)
		const sources = ordered[0]?.sources ?? 0
		const spread = Math.max(1, ...ordered.map((h) => sectionsPerHabit.get(h.id)?.size ?? 1))
		return {
			section: group.section,
			quote: group.quote,
			habits: ordered.map((h) => h.id),
			names: ordered.map((h) => h.name),
			sources,
			spread,
			level: group.userChose ? 0 : levelOf(sources, spread),
			by: [...group.by],
		}
	})
}

export const isBanned = (item: Item): boolean => item.level === 1 || item.level === 2
