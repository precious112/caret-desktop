/**
 * Compiles the slop list Caret ships: `src/core/design/design-pass/slop-list.json`.
 *
 * Development only. The research files (`research/*.json`, format in
 * `research/SCHEMA.md`) are reports of AI design habits gathered from the web;
 * `groups.json` groups those reports once, so one habit has one source count and
 * its name stays stable across refreshes. This script joins the two and writes
 * the compact file the Design pass reads at runtime. Nothing here runs on a
 * user's machine — the list ships inside Caret updates, never downloaded live.
 *
 *   npx tsx scripts/slop-list/build.ts
 */
import * as fs from "fs"
import * as path from "path"

interface ResearchEntry {
	id: string
	kind: "element" | "treatment" | "layout" | "copy" | "foundation" | "font"
	name: string
	description?: string
	detect?: { values?: string[] }
	evidence?: Array<{ url?: string }>
	independent_sources?: number
	older_than_7_months?: boolean
}

const HERE = path.dirname(new URL(import.meta.url).pathname)
const OUT = path.resolve(HERE, "../../src/core/design/design-pass/slop-list.json")

/** Habits about corner radius: a foundation radius the user approved exempts them. */
const RADIUS_HABITS = new Set(["pill-buttons", "over-rounded-surfaces"])

/**
 * Few-option patterns are never slop signs: with two or three sensible ways to
 * do a thing (a centred hero, a list versus a grid), converging on one is the
 * obvious choice, not a habit. They stay in the file, visibly, but are never checked.
 */
const FEW_OPTIONS = new Set(["centered-hero"])

const slug = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
const isHex = (v: string) => /^#[0-9a-f]{3,8}$/i.test(v.trim())
const isFontName = (v: string) => !isHex(v) && /^[A-Z][A-Za-z ]+$/.test(v)

export function compile(entries: ResearchEntry[], groups: Array<{ name: string; ids: string[] }>) {
	const current = entries.filter((e) => !e.older_than_7_months)
	const byId = new Map(current.map((e) => [e.id, e]))
	const fontEntry = (e: ResearchEntry) => ["font", "foundation"].includes(e.kind) && (e.detect?.values ?? []).some(isFontName)
	const colourEntry = (e: ResearchEntry) => (e.detect?.values ?? []).some(isHex)
	const valueEntry = (e: ResearchEntry) => fontEntry(e) || colourEntry(e)

	const habits = groups.map((group) => {
		const members = group.ids.map((id) => byId.get(id)).filter((e): e is ResearchEntry => !!e)
		const urls = new Set(
			members.flatMap((e) =>
				(e.evidence ?? [])
					.map((v) =>
						String(v.url ?? "")
							.replace(/[#?].*$/, "")
							.replace(/\/$/, ""),
					)
					.filter(Boolean),
			),
		)
		// Some entries list fewer links than the research counted, so take the larger.
		const sources = Math.max(urls.size, ...members.map((e) => e.independent_sources ?? 1), 0)
		const words = members.filter((e) => !valueEntry(e))
		const id = slug(group.name)
		return {
			id,
			name: group.name,
			sources,
			kinds: [...new Set(members.map((e) => e.kind))],
			/** The sources' own names for it, for the checker. Empty when only code can check it. */
			terms: [...new Set(words.map((e) => e.name))],
			description: String(words[0]?.description ?? "")
				.split(/(?<=\.)\s/)[0]
				.slice(0, 110),
			colours: [...new Set(members.filter(colourEntry).flatMap((e) => (e.detect?.values ?? []).filter(isHex)))],
			fonts: [...new Set(members.filter(fontEntry).flatMap((e) => (e.detect?.values ?? []).filter(isFontName)))],
			radius: RADIUS_HABITS.has(id),
			fewOptions: FEW_OPTIONS.has(id),
		}
	})
	return { entries: current.length, habits: habits.filter((h) => h.sources > 0) }
}

function main(): void {
	const research = ["claude", "gpt", "others"].flatMap(
		(file) => JSON.parse(fs.readFileSync(path.join(HERE, "research", `${file}.json`), "utf-8")) as ResearchEntry[],
	)
	const groups = JSON.parse(fs.readFileSync(path.join(HERE, "groups.json"), "utf-8")).groups
	const grouped = new Set(groups.flatMap((g: { ids: string[] }) => g.ids))
	const ungrouped = research.filter((e) => !e.older_than_7_months && !grouped.has(e.id))
	if (ungrouped.length) {
		// A refresh adds reports; each one must join a habit (or start one) before it ships.
		throw new Error(`entries not in any group (add them to groups.json): ${ungrouped.map((e) => e.id).join(", ")}`)
	}
	const list = compile(research, groups)
	fs.writeFileSync(OUT, `${JSON.stringify(list, null, "\t")}\n`)
	console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${list.entries} entries, ${list.habits.length} habits`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main()
