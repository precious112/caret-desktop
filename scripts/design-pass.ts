/**
 * The Design pass's development-only script. You run it; users never do.
 *
 *   npx tsx scripts/design-pass.ts regression [--checker <model>] [--tag <name>]
 *     Plants known habits into clean plans (by term, by another name, only
 *     described) and runs the real checking step on them: is each one caught,
 *     at the right level, and how many false catches do clean plans get? The
 *     answer key comes by construction; nobody labels anything.
 *
 *   npx tsx scripts/design-pass.ts builders <project> [--checker <model>]
 *     Reads every page a project already built and reports banned habits the
 *     builder added. The Design pass has no build-vs-plan check; this is the
 *     measurement that decides whether it needs one.
 *
 *   npx tsx scripts/design-pass.ts refresh [--model <model>] [--since YYYY-MM-DD]
 *     Searches the web for new reports of AI design habits, drops entries older
 *     than seven months, merges new reports into existing habit groups (so
 *     names stay stable), rebuilds the shipped list, and prints a short change
 *     list for review — especially habits crossing the level-1 or level-2 line.
 *     Review it with `git diff`; nothing ships until you commit it.
 */
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { extendOpencodeServerConfig, OpencodeBackend } from "../src/core/design/agent/opencode"
import { stopOpencodeServer } from "../src/core/design/agent/opencode/server"
import { parseHex, type Rgb } from "../src/core/design/design-pass/colour"
import { checkPlan } from "../src/core/design/design-pass/engine"
import type { Approved, CheckerMatch } from "../src/core/design/design-pass/findings"
import type { DesignPlan } from "../src/core/design/design-pass/plan"
import { CHECK_SCHEMA, checkPrompt } from "../src/core/design/design-pass/prompts"
import { BAN, BAN_IF_REPEATED, habitById, levelOf } from "../src/core/design/design-pass/slop-list"
import { type Form, GROUPS, PLANTS, plant } from "./design-pass/plants"
import { compile, type ResearchEntry } from "./slop-list/build"

const HERE = path.dirname(new URL(import.meta.url).pathname)
const arg = (name: string, fallback: string) => {
	const i = process.argv.indexOf(name)
	return i > 0 ? process.argv[i + 1] : fallback
}
const log = (...parts: unknown[]) => console.log(new Date().toTimeString().slice(0, 8), ...parts)

/** Runs at most `limit` tasks at once: a free tier rate-limits a burst of section checks. */
async function pool<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length)
	let next = 0
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const index = next++
				out[index] = await run(items[index])
			}
		}),
	)
	return out
}

function checker(model: string, dir: string) {
	const backend = new OpencodeBackend()
	return async (section: unknown): Promise<{ matches?: CheckerMatch[] } | null> => {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const answer = await backend.structured<{ matches?: CheckerMatch[] }>({
					workingDirectory: dir,
					prompt: checkPrompt(section as never),
					schema: CHECK_SCHEMA,
					model,
					tools: { "caret_*": false },
				})
				return answer.value
			} catch (err) {
				if (attempt === 2) throw err
			}
		}
		return null
	}
}

interface Base {
	brief: string
	foundation: { colors: Record<string, string>; fonts: Record<string, string>; radius: number[] }
	plan: DesignPlan
}

const approvedOf = (foundation: Base["foundation"]): Approved => ({
	colours: Object.values(foundation.colors)
		.map(parseHex)
		.filter((c): c is Rgb => !!c),
	fonts: Object.values(foundation.fonts).map((f) => f.toLowerCase()),
	radii: foundation.radius,
})

async function regression(): Promise<void> {
	const model = arg("--checker", "opencode-go/claude-haiku-5-5")
	const tag = arg("--tag", `regression-${new Date().toISOString().slice(0, 10)}`)
	const out = path.join(HERE, "design-pass", "results", tag)
	fs.mkdirSync(out, { recursive: true })
	const bases = JSON.parse(fs.readFileSync(path.join(HERE, "design-pass", "fixtures", "bases.json"), "utf-8")) as Record<
		string,
		Base
	>
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caret-regression-"))
	const ask = checker(model, dir)
	const expected = (key: string, spread = 1) => levelOf(habitById(PLANTS[key].accept[0])?.sources ?? 0, spread)

	interface Variant {
		id: string
		base: string
		form: Form | "clean" | "value"
		plan: DesignPlan
		approved: Approved
		plants: Record<string, { section: string; also?: string; accept?: string[]; level: number }>
	}
	const variants: Variant[] = []
	for (const [name, base] of Object.entries(bases)) {
		const approved = approvedOf(base.foundation)
		variants.push({ id: `${name}-clean`, base: name, form: "clean", plan: base.plan, approved, plants: {} })
		for (const [g, keys] of GROUPS.entries()) {
			for (const form of ["term", "alias", "described"] as const) {
				const planted = plant(base.plan, keys, form)
				variants.push({
					id: `${name}-g${g + 1}-${form}`,
					base: name,
					form,
					plan: planted.plan,
					approved,
					plants: Object.fromEntries(keys.map((k) => [k, { section: planted.where[k], level: expected(k) }])),
				})
			}
		}
		// The same habit in two sections: banned for repeating.
		const repeated = JSON.parse(JSON.stringify(base.plan)) as DesignPlan
		const body = repeated.sections.filter((s) => s.id !== "footer")
		const cards = PLANTS["icon-cards"].forms.term as never
		body[1].components.push({ ...(cards as object) } as never)
		body[2].components.push({ ...(cards as object) } as never)
		variants.push({
			id: `${name}-repeat-cards`,
			base: name,
			form: "term",
			plan: repeated,
			approved,
			plants: { "icon-cards": { section: body[1].id, also: body[2].id, level: expected("icon-cards", 2) } },
		})
		// Exact values the user did not choose: banned. The same values approved: never flagged.
		const valued = JSON.parse(JSON.stringify(base.plan)) as DesignPlan
		valued.sections[1].components.push({
			term: "card",
			looks: "background #F4F1EA, body text set in Inter 16px",
			content: "a note",
		})
		const valuePlants = (level: number) => ({
			"cream-value": { section: valued.sections[1].id, accept: ["warm-cream-background"], level },
			"inter-value": { section: valued.sections[1].id, accept: ["default-sans-font"], level },
		})
		variants.push({ id: `${name}-values`, base: name, form: "value", plan: valued, approved, plants: valuePlants(1) })
		variants.push({
			id: `${name}-values-approved`,
			base: name,
			form: "value",
			plan: valued,
			approved: { ...approved, colours: [...approved.colours, parseHex("#F4F1EA")!], fonts: [...approved.fonts, "inter"] },
			plants: valuePlants(0),
		})
	}

	const rows = await pool(variants, 4, async (variant) => {
		const { items, rejected } = await checkPlan(ask, variant.plan, variant.approved, bases[variant.base].brief)
		const explained = new Set<object>()
		const plants: Record<string, { caught: boolean; expected: number; got: number | null }> = {}
		for (const [key, p] of Object.entries(variant.plants)) {
			const accept = p.accept ?? PLANTS[key].accept
			const hits = items.filter(
				(i) => (i.section === p.section || i.section === p.also) && i.habits.some((h) => accept.includes(h)),
			)
			for (const hit of hits) explained.add(hit)
			plants[key] = {
				caught: hits.length > 0,
				expected: p.level,
				got: hits.length ? Math.min(...hits.map((h) => (h.level === 0 ? 99 : h.level))) : null,
			}
			if (plants[key].got === 99) plants[key].got = 0
		}
		const extra = items.filter((i) => !explained.has(i))
		fs.writeFileSync(
			path.join(out, `${variant.id}.json`),
			JSON.stringify({ variant: variant.id, plants, extra, items }, null, 1),
		)
		log(
			variant.id,
			Object.entries(plants)
				.map(([k, r]) => `${k}:${r.caught ? `L${r.got}` : "missed"}`)
				.join(" "),
			"| extra",
			extra.length,
			"| rejected",
			rejected,
		)
		return { variant, plants, extra, rejected }
	})

	const summary = {
		checker: model,
		byForm: {} as Record<string, { n: number; caught: number }>,
		levelRight: 0,
		levelTotal: 0,
		levelWrong: [] as string[],
		approvedFlagged: 0,
		approvedTotal: 0,
		cleanExtras: 0,
		plantedExtras: 0,
		rejected: 0,
	}
	for (const row of rows) {
		summary.rejected += row.rejected
		if (row.variant.form === "clean") summary.cleanExtras += row.extra.length
		else summary.plantedExtras += row.extra.length
		for (const [key, p] of Object.entries(row.plants)) {
			if (p.expected === 0) {
				summary.approvedTotal++
				if (p.caught && p.got !== 0) summary.approvedFlagged++
				continue
			}
			const form = (summary.byForm[row.variant.form] ??= { n: 0, caught: 0 })
			form.n++
			if (p.caught) form.caught++
			if (p.caught) {
				summary.levelTotal++
				if (p.got === p.expected) summary.levelRight++
				else summary.levelWrong.push(`${row.variant.id} ${key}: expected L${p.expected}, got L${p.got}`)
			}
		}
	}
	fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 1))
	console.log("\nCaught, by how the habit was written:")
	for (const [form, f] of Object.entries(summary.byForm)) console.log(`  ${form.padEnd(10)} ${f.caught}/${f.n}`)
	console.log(`Right level: ${summary.levelRight}/${summary.levelTotal}`)
	console.log(`Approved values wrongly flagged: ${summary.approvedFlagged}/${summary.approvedTotal}`)
	console.log(`False catches on the clean plans: ${summary.cleanExtras} (on planted plans: ${summary.plantedExtras})`)
	console.log(`Checker claims thrown out: ${summary.rejected}`)
	console.log(`Results: ${path.relative(process.cwd(), out)}`)
}

async function builders(): Promise<void> {
	const project = process.argv[3]
	if (!project || !fs.existsSync(path.join(project, ".caret", "pages")))
		throw new Error("usage: builders <project with .caret/pages>")
	const model = arg("--checker", "opencode-go/claude-haiku-5-5")
	const ask = checker(model, project)
	const pagesDir = path.join(project, ".caret", "pages")
	const pages = fs
		.readdirSync(pagesDir)
		.filter((id) => !id.includes("--v") && fs.existsSync(path.join(pagesDir, id, "index.tsx")))
	let withBanned = 0
	await pool(pages, 4, async (id) => {
		const source = fs.readFileSync(path.join(pagesDir, id, "index.tsx"), "utf-8")
		// The whole page as one "section": the checker quotes the source itself.
		const section = {
			id,
			purpose: "an already built page",
			layout: "",
			components: [{ term: "other", looks: "the page source", content: source }],
			copy: {},
		}
		const { items } = await checkPlan(() => ask(section), { sections: [section] }, { colours: [], fonts: [], radii: [] }, "")
		const banned = items.filter((i) => i.level === 1)
		if (banned.length) withBanned++
		log(id, banned.length ? `banned: ${banned.map((b) => b.names[0]).join(", ")}` : "no banned habits")
	})
	console.log(`\n${withBanned} of ${pages.length} built pages carry a banned habit (level 1 at ${BAN}+ sources).`)
}

async function refresh(): Promise<void> {
	const model = arg("--model", "opencode-go/gpt-5.6-luna")
	const today = new Date()
	const cutoff = new Date(today)
	cutoff.setMonth(cutoff.getMonth() - 7)
	const since = arg("--since", cutoff.toISOString().slice(0, 10))
	const researchDir = path.join(HERE, "slop-list", "research")
	const files = ["claude", "gpt", "others"]
	type Entry = ResearchEntry
	const research = Object.fromEntries(
		files.map((f) => [f, JSON.parse(fs.readFileSync(path.join(researchDir, `${f}.json`), "utf-8")) as Entry[]]),
	)
	const groupsFile = path.join(HERE, "slop-list", "groups.json")
	const groups = JSON.parse(fs.readFileSync(groupsFile, "utf-8")) as { groups: Array<{ name: string; ids: string[] }> }
	const before = compile(Object.values(research).flat(), groups.groups)

	// 1. Age: an entry whose newest source is older than seven months stops counting.
	const cutoffDay = cutoff.toISOString().slice(0, 10)
	for (const entries of Object.values(research)) {
		for (const entry of entries) {
			const newest =
				entry.newest_source_date ??
				entry.evidence
					?.map((e) => e.date ?? "")
					.sort()
					.pop() ??
				""
			entry.older_than_7_months = !!newest && newest < cutoffDay
		}
	}

	// 2. Research: new reports since the cutoff, with sources that can be checked.
	// This script's own server: web search on, and web tools allowed without
	// asking (nobody is there to answer a permission prompt).
	process.env.OPENCODE_ENABLE_EXA = "1"
	extendOpencodeServerConfig({ permission: { webfetch: "allow", websearch: "allow" } })
	const backend = new OpencodeBackend()
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caret-refresh-"))
	const known = Object.values(research)
		.flat()
		.map((e) => `- ${e.id}: ${e.name}`)
		.join("\n")
	const schemaText = fs.readFileSync(path.join(researchDir, "SCHEMA.md"), "utf-8")
	log(`researching reports since ${since} with ${model}…`)
	const found = await backend.structured<{ entries?: Entry[] }>({
		workingDirectory: dir,
		model,
		allowTools: true,
		tools: { websearch: true, webfetch: true, "caret_*": false },
		schema: { type: "object", properties: { entries: { type: "array", items: { type: "object" } } }, required: ["entries"] },
		prompt: `Search the web for reports, published on or after ${since}, of habits people see in web and app designs made by AI models (Claude, GPT, Gemini, Kimi, GLM, DeepSeek, Qwen, MiniMax and AI design tools): visual elements, treatments, layouts, copy, colours and fonts that make a design read as AI-made. Use web search, then open the sources to quote them.
Already known (report these only if you find NEW sources for them, under the same id):
${known}

Each entry must follow this format exactly:
${schemaText}

Only sources published on or after ${since}. Every entry needs at least one URL with its date and an exact quote. Never invent a URL, a date, a hex code or a font name.
Reply with JSON only: {"entries": [ ... ]}`,
	})
	const valid = (found.value.entries ?? []).filter(
		(e) =>
			e?.id &&
			e.name &&
			Array.isArray(e.evidence) &&
			e.evidence.some((v) => v.url?.startsWith("http") && (v.date ?? "") >= since && v.quote),
	)
	log(
		`${valid.length} usable entries (${(found.value.entries ?? []).length - valid.length} without a dated, quoted source were dropped)`,
	)

	// 3. Merge: new sources onto known ids, new entries into existing groups.
	const byId = new Map(
		Object.values(research)
			.flat()
			.map((e) => [e.id, e]),
	)
	const fresh: Entry[] = []
	for (const entry of valid) {
		const existing = byId.get(entry.id)
		if (existing) {
			const urls = new Set((existing.evidence ?? []).map((e) => e.url))
			existing.evidence = [...(existing.evidence ?? []), ...(entry.evidence ?? []).filter((e) => !urls.has(e.url))]
			existing.newest_source_date = [existing.newest_source_date ?? "", ...(entry.evidence ?? []).map((e) => e.date ?? "")]
				.sort()
				.pop()
			existing.older_than_7_months = false
		} else {
			fresh.push(entry)
		}
	}
	if (fresh.length) {
		const grouped = await backend.structured<{ assignments?: Array<{ id: string; group: string }> }>({
			workingDirectory: dir,
			model,
			schema: {
				type: "object",
				properties: { assignments: { type: "array", items: { type: "object" } } },
				required: ["assignments"],
			},
			prompt: `These are the existing habit groups of AI design habits:
${groups.groups.map((g) => `- ${g.name}`).join("\n")}

Put each new report into the existing group it is the same habit as, using the group's exact name. Only when it is genuinely a different habit, answer "NEW: <a short name in the same style>".
${fresh.map((e) => `- ${e.id}: ${e.name}. ${e.description ?? ""}`).join("\n")}

Reply with JSON only: {"assignments": [{"id": "...", "group": "..."}]}`,
		})
		for (const entry of fresh) {
			const assigned = grouped.value.assignments?.find((a) => a.id === entry.id)?.group?.trim() ?? `NEW: ${entry.name}`
			const name = assigned.replace(/^NEW:\s*/, "")
			const group =
				groups.groups.find((g) => g.name === name) ??
				(groups.groups.push({ name, ids: [] }), groups.groups[groups.groups.length - 1])
			group.ids.push(entry.id)
			const file = entry.family === "claude" ? "claude" : entry.family === "gpt" ? "gpt" : "others"
			research[file].push(entry)
		}
	}

	// 4. Write, rebuild the shipped list, and say what changed.
	for (const f of files) fs.writeFileSync(path.join(researchDir, `${f}.json`), `${JSON.stringify(research[f], null, 2)}\n`)
	fs.writeFileSync(groupsFile, `${JSON.stringify(groups, null, 1)}\n`)
	const after = compile(Object.values(research).flat(), groups.groups)
	fs.writeFileSync(
		path.join(HERE, "..", "src", "core", "design", "design-pass", "slop-list.json"),
		`${JSON.stringify(after, null, "\t")}\n`,
	)

	const level = (n: number) => (n >= BAN ? "L1" : n >= BAN_IF_REPEATED ? "L2" : n >= 3 ? "L3" : "ignored")
	const was = new Map(before.habits.map((h) => [h.id, h.sources]))
	const now = new Map(after.habits.map((h) => [h.id, h.sources]))
	console.log(`\nEntries: ${before.entries} → ${after.entries}. Habits: ${before.habits.length} → ${after.habits.length}.`)
	for (const habit of after.habits) {
		const old = was.get(habit.id)
		if (old === undefined) console.log(`  NEW   ${habit.name}: ${habit.sources} sources (${level(habit.sources)})`)
		else if (old !== habit.sources) {
			const crossed = level(old) !== level(habit.sources) ? `  ← crosses ${level(old)} → ${level(habit.sources)}` : ""
			console.log(`  ${habit.sources > old ? "UP  " : "DOWN"}  ${habit.name}: ${old} → ${habit.sources}${crossed}`)
		}
	}
	for (const habit of before.habits)
		if (!now.has(habit.id)) console.log(`  GONE  ${habit.name} (every report older than seven months)`)
	console.log("\nReview with `git diff scripts/slop-list src/core/design/design-pass/slop-list.json` before committing.")
}

const commands: Record<string, () => Promise<void>> = { regression, builders, refresh }
const command = commands[process.argv[2] ?? ""]
if (!command) {
	console.error("usage: npx tsx scripts/design-pass.ts regression | builders <project> | refresh")
	process.exitCode = 1
} else {
	command()
		.catch((error) => {
			console.error(error)
			process.exitCode = 1
		})
		.finally(() => stopOpencodeServer())
}
