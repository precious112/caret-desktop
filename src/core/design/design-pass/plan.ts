/**
 * The page plan the Design pass works on: section by section, before any code.
 *
 * Standard names (from the glossary) and exact values (hex, font names, px) are
 * what make the checking reliable — a checker can only match what the plan
 * actually says, and code can only measure a value that is written down.
 */

export interface PlanComponent {
	/** A standard term from the glossary, or "other". */
	term: string
	/** What it looks like: size, colour (hex), font, corners (px). */
	looks: string
	/** The exact text, or what it shows. */
	content: string
	/** Set by the designer pass: a library component it chose for this part. */
	library?: string
}

export interface PlanSection {
	id: string
	/** What this section must do for the visitor. */
	purpose: string
	/** How it is arranged, in standard terms. */
	layout: string
	components: PlanComponent[]
	copy: { headline?: string; body?: string; cta?: string }
}

export interface DesignPlan {
	/** The page's one main action. */
	mainAction?: string
	/** What the page shows while loading, when empty, and on error. */
	states?: { loading?: string; empty?: string; error?: string }
	sections: PlanSection[]
}

/** The format as the planner is shown it. */
export const PLAN_FORMAT = `{
  "mainAction": "the one thing a visitor should do on this page",
  "states": { "loading": "what shows while data loads, or 'none'", "empty": "what shows with no data, or 'none'", "error": "what shows on failure, or 'none'" },
  "sections": [
    {
      "id": "short-id",
      "purpose": "what this section must do for the visitor",
      "layout": "how it is arranged, in standard terms",
      "components": [{ "term": "standard term from the glossary, or 'other'", "looks": "what it looks like: size, colour (hex), font, corners (px)", "content": "exact text, or what it shows" }],
      "copy": { "headline": "exact words", "body": "exact words", "cta": "exact words" }
    }
  ]
}`

const SECTION_SCHEMA = {
	type: "object",
	properties: {
		id: { type: "string" },
		purpose: { type: "string" },
		layout: { type: "string" },
		components: {
			type: "array",
			items: {
				type: "object",
				properties: { term: { type: "string" }, looks: { type: "string" }, content: { type: "string" } },
				required: ["term", "looks", "content"],
			},
		},
		copy: {
			type: "object",
			properties: { headline: { type: "string" }, body: { type: "string" }, cta: { type: "string" } },
		},
	},
	required: ["id", "purpose", "layout", "components", "copy"],
}

/** JSON schema for a whole plan, for structured calls. */
export const PLAN_SCHEMA = {
	type: "object",
	properties: {
		mainAction: { type: "string" },
		states: {
			type: "object",
			properties: { loading: { type: "string" }, empty: { type: "string" }, error: { type: "string" } },
		},
		sections: { type: "array", items: SECTION_SCHEMA },
	},
	required: ["sections"],
}

export { SECTION_SCHEMA }

const text = (value: unknown): string => (typeof value === "string" ? value : value == null ? "" : String(value))

/**
 * A model's plan, made safe to work on. Missing fields become empty, section ids
 * are made unique (the rewrite step replaces sections BY id, so a duplicate id
 * would silently drop a section), and a plan with no sections is refused.
 */
export function normalizePlan(raw: unknown): DesignPlan {
	const value = (raw ?? {}) as Record<string, unknown>
	const rawSections = Array.isArray(value.sections) ? value.sections : []
	const seen = new Set<string>()
	const sections: PlanSection[] = rawSections.map((entry, index) => normalizeSection(entry, index, seen))
	if (sections.length === 0) throw new Error("The plan has no sections.")
	const states = (value.states ?? undefined) as Record<string, unknown> | undefined
	return {
		...(text(value.mainAction) ? { mainAction: text(value.mainAction) } : {}),
		...(states && typeof states === "object"
			? { states: { loading: text(states.loading), empty: text(states.empty), error: text(states.error) } }
			: {}),
		sections,
	}
}

export function normalizeSection(raw: unknown, index: number, seen: Set<string> = new Set()): PlanSection {
	const value = (raw ?? {}) as Record<string, unknown>
	let id =
		text(value.id)
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") || `section-${index + 1}`
	while (seen.has(id)) id = `${id}-${index + 1}`
	seen.add(id)
	const components = (Array.isArray(value.components) ? value.components : []).map((c) => {
		const component = (c ?? {}) as Record<string, unknown>
		return {
			term: text(component.term) || "other",
			looks: text(component.looks),
			content: text(component.content),
			...(text(component.library) ? { library: text(component.library) } : {}),
		}
	})
	const copy = (value.copy ?? {}) as Record<string, unknown>
	return {
		id,
		purpose: text(value.purpose),
		layout: text(value.layout),
		components,
		copy: {
			...(text(copy.headline) ? { headline: text(copy.headline) } : {}),
			...(text(copy.body) ? { body: text(copy.body) } : {}),
			...(text(copy.cta) ? { cta: text(copy.cta) } : {}),
		},
	}
}

/**
 * Puts rewritten sections in place by id. Sections the rewrite did not touch stay
 * byte-identical, so re-checking them can reuse the earlier result. A returned
 * section whose id matches nothing is ignored rather than appended: a rewrite
 * changes sections, it does not grow the page.
 */
export function mergeSections(plan: DesignPlan, changed: PlanSection[]): DesignPlan {
	const byId = new Map(changed.map((section) => [section.id, section]))
	return { ...plan, sections: plan.sections.map((section) => byId.get(section.id) ?? section) }
}

/** A stable key for a section's content, for reusing check results. */
export function sectionKey(section: PlanSection): string {
	return JSON.stringify(section)
}
