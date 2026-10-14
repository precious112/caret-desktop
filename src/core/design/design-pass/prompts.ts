/**
 * Every prompt the Design pass sends. Each step is a fresh session that sees
 * only what is written here — the checkers never see the planner's
 * conversation, and the judges never see the defender's — so these texts are
 * the whole contract of each step.
 */
import type { Item } from "./findings"
import { glossaryText } from "./glossary"
import type { DesignPlan, PlanSection } from "./plan"
import { PLAN_FORMAT } from "./plan"
import { bannedHabitNames, habitsText } from "./slop-list"

export interface PassContext {
	/** The user's own words for this page. */
	brief: string
	/** The project's committed foundation, compactly. Null before one exists. */
	foundation: string | null
	/** Pages that already exist, so the plan fits the product. */
	existingPages: string[]
	/** The page being planned, when Caret knows it. */
	pageId?: string
}

/** What was taken out of the plan, carried into every later step so nothing comes back. */
export interface RemovedPart {
	section: string
	was: string
	habit: string
	action: "removed" | "replaced"
	now?: string
}

export const PERSONA =
	"You are a product designer with more than fifteen years of experience, known for work that is exceptional: precise, alive and a pleasure to look at, never generic."

const foundationBlock = (context: PassContext) =>
	context.foundation
		? `The approved design foundation (the user chose these values; use them):\n${context.foundation}`
		: "There is no approved foundation yet: choose values that suit this product, and write them exactly."

export function planPrompt(context: PassContext): string {
	return `Plan this page, section by section. Do not write code and do not create or edit any file.
What the user asked for, in their own words:
${context.brief}

${foundationBlock(context)}
${context.existingPages.length ? `\nPages that already exist in this project (you may read them to fit the product): ${context.existingPages.join(", ")}` : ""}

Name every part with the standard design term from this glossary when one fits (the glossary is only for naming; it is not a list of things to include):
${glossaryText()}

Be concrete: exact colours (hex), font names, sizes and corner radius in px, and the exact copy. Name the page's one main action, and what it shows while loading, when empty and on error (or "none" when a state cannot happen).
Reply with JSON only, in exactly this format:
${PLAN_FORMAT}`
}

const CHECK_RULES = `You are checking ONE section of a web page design plan against a list of known AI design habits.
You did not write this plan. Your only job: find every part of this section that IS one of the listed habits.
- Match on what it would look like on the page, not on the name. A renamed or merely described part still counts.
- Do not judge whether it is a good idea and do not excuse anything. Only say what matches.
- For each match, copy a short phrase from the plan WORD FOR WORD that shows it, and give the habit id.
- Do not judge exact colour or font values (hex codes, font names); those are checked separately. Judge what things are and how they look.
- Only report habits the plan actually describes. If you are unsure, still report it with "confidence": "low".`

export function checkPrompt(section: PlanSection): string {
	return `${CHECK_RULES}

Synonyms for common design terms:
${glossaryText()}

The habits:
${habitsText()}

The section:
${JSON.stringify(section, null, 1)}

Reply with JSON only: {"matches": [{"id": "habit id", "quote": "words copied from the plan", "confidence": "high" or "low"}]}`
}

export const CHECK_SCHEMA = {
	type: "object",
	properties: {
		matches: {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: { type: "string" },
					quote: { type: "string" },
					confidence: { type: "string", enum: ["high", "low"] },
				},
				required: ["id", "quote"],
			},
		},
	},
	required: ["matches"],
}

const bannedList = () =>
	bannedHabitNames()
		.map((name) => `- ${name}`)
		.join("\n")

export function revisePrompt(
	context: PassContext,
	plan: DesignPlan,
	flagged: Array<Pick<Item, "section" | "quote" | "names">>,
): string {
	return `You planned this page for: ${context.brief}
${foundationBlock(context)}
Your plan:
${JSON.stringify(plan)}

These parts were flagged: they are among the most common AI design habits. A habit is not necessarily bad design, but people have seen it so often that it makes a page look generic, and visitors stop paying attention.
${flagged.map((b, k) => `${k + 1}. In section "${b.section}": "${b.quote}" (${b.names[0]})`).join("\n")}

For EACH flagged part, decide in this order:
1. Would the page lose anything if this part were simply gone? Often the habit is decoration or repetition, and the page is better with less. If nothing is lost, remove it. That is the whole fix.
2. If it does a real job, name that job (for example "tells the visitor which product line they are in"). Then do that job with a different UI concept, principle or component, one that suits THIS product and is not a common default. Do not re-skin the same habit (a pill instead of an eyebrow is the same habit).
Your replacements must not be any of these habits either; they are banned on every page:
${bannedList()}

Change only the sections that contain flagged parts, and keep their ids. Use the same glossary terms as before.
Reply with JSON only:
{"changes": [{"n": 1, "job": "the job it did, or 'none'", "action": "removed" or "replaced", "now": "what replaces it, or empty", "why": "one sentence"}],
 "sections": [only the sections you changed, complete, in the plan format]}`
}

export function justifyPrompt(context: PassContext, plan: DesignPlan, items: Item[]): string {
	return `You planned a page for: ${context.brief}
Your plan: ${JSON.stringify(plan)}
These parts were flagged as common AI design habits:
${items.map((it, k) => `${k + 1}. In section "${it.section}": "${it.quote}" (looks like the common habit: ${it.names[0]})`).join("\n")}
For EACH one: keep it, with the reason it belongs on THIS page and the exact words in the user's request that call for it; or remove it. Give a separate, specific reason for each one you keep.
Reply with JSON only: {"answers": [{"n": 1, "decision": "keep" or "remove", "reason": "...", "brief_quote": "exact words from the user's request, or empty"}]}`
}

export const JUSTIFY_SCHEMA = {
	type: "object",
	properties: {
		answers: {
			type: "array",
			items: {
				type: "object",
				properties: {
					n: { type: "number" },
					decision: { type: "string", enum: ["keep", "remove"] },
					reason: { type: "string" },
					brief_quote: { type: "string" },
				},
				required: ["n", "decision", "reason"],
			},
		},
	},
	required: ["answers"],
}

export function judgePrompt(
	brief: string,
	defences: Array<{ quote: string; habit: string; reason: string; briefQuote: string }>,
): string {
	return `A product request, and design choices someone defended.
The request: ${brief}
${defences.map((d, i) => `${i + 1}. The choice: "${d.quote}" (${d.habit})\n   Their reason: ${d.reason}\n   The words they say call for it: "${d.briefQuote}"`).join("\n")}
For EACH choice ask: would a different product, with a different request, need this choice just as much? If yes, the request does not really call for it: answer "anchored": false. Only answer true when these specific words make this specific choice necessary, and a generic reason would not.
Reply with JSON only: {"verdicts": [{"n": 1, "anchored": true or false, "why": "one sentence"}]}`
}

export const JUDGE_SCHEMA = {
	type: "object",
	properties: {
		verdicts: {
			type: "array",
			items: {
				type: "object",
				properties: { n: { type: "number" }, anchored: { type: "boolean" }, why: { type: "string" } },
				required: ["n", "anchored"],
			},
		},
	},
	required: ["verdicts"],
}

export const REVISE_SCHEMA = {
	type: "object",
	properties: {
		changes: {
			type: "array",
			items: {
				type: "object",
				properties: {
					n: { type: "number" },
					job: { type: "string" },
					action: { type: "string", enum: ["removed", "replaced"] },
					now: { type: "string" },
					why: { type: "string" },
				},
				required: ["n", "action"],
			},
		},
		sections: { type: "array", items: { type: "object" } },
	},
	required: ["sections"],
}

export interface TasteTools {
	/** Library names the designer can explore this time, with what each gives. */
	libraries: Array<{ name: string; gives: string; kind: "components" | "inspiration" }>
	/** Caret's own tool that shows the designer a reference image from a link. */
	viewTool: string
}

const removedList = (removed: RemovedPart[]) => removed.map((r) => `- "${r.was}" (${r.habit})`).join("\n") || "- (nothing)"

export function tastePrompt(context: PassContext, plan: DesignPlan, removed: RemovedPart[], tools: TasteTools): string {
	const inspiration = tools.libraries.filter((l) => l.kind === "inspiration")
	const components = tools.libraries.filter((l) => l.kind === "components")
	return `${PERSONA}
What the user asked for: ${context.brief}
${foundationBlock(context)}
The current plan:
${JSON.stringify(plan.sections, null, 1)}

Your job: refine this plan so the page looks markedly better, more crafted, more alive and more pleasing, section by section. Do not redesign it from scratch and do not add sections for the sake of it.
${
	inspiration.length
		? `\nFirst, look at real shipped pages that would teach you something SPECIFIC for this page (a layout problem, a way to show a product, a type pairing, a section you find weak). Search with your tools: ${inspiration.map((l) => `${l.name} (${l.gives})`).join("; ")}. When a result gives a screenshot as a link, look at it with ${tools.viewTool}. Learn principles from what you see; never copy a layout or style.`
		: ""
}
${
	components.length
		? `\nComponent libraries are available through your tools: ${components.map((l) => `${l.name} (${l.gives})`).join("; ")}. Search them by the JOB you need done, for any section where a ready-made component might do a job better than plain HTML and CSS. Use one ONLY if it does a real job plain markup cannot do as well; decoration for its own sake does not count. Choosing none is a perfectly good outcome.
Name a chosen component so it can be installed: "@registry/name" for registry items (for example "@magicui/marquee" or "@aceternity/world-map"), or "21st:<id>" for a 21st.dev component.`
		: ""
}
If a library's tool fails or is rate-limited, move on to another one; do not retry it more than once.

For EACH section, think it through like this before changing anything:
- Focus: what is the ONE thing a visitor should see first here, and does everything else step back from it?
- Hierarchy and scale: are the type sizes, weights and colours doing distinct jobs, or are several things competing?
- Spacing and rhythm: is the space between things consistent and intentional, with more room between groups than inside them?
- Alignment and measure: do edges line up; is body text a comfortable width (about 60-75 characters) and leading?
- Content: is every word specific and real for this product? Replace anything vague.
- Detail: the small things a careful designer would not leave alone (numerals, prices, captions, image framing, hover and empty states, how sections meet each other).

Do NOT bring back anything that was removed while cleaning this plan:
${removedList(removed)}
And do not use any of these common AI design habits:
${bannedList()}

Name parts with these standard terms where they fit:
${glossaryText()}

Do not create or edit any file. When you are done, reply with JSON only:
{"sections": [the complete refined plan, every section, same format and ids],
 "refinements": [{"section": "id", "what": "what you changed", "why": "the detail it fixes"}],
 "references": [{"what": "the page or screen you looked at", "learned": "one line"}],
 "components": [{"component": "@registry/name or 21st:<id>", "section": "id", "job": "...", "why_not_plain": "..."}]}`
}

export const TASTE_SCHEMA = {
	type: "object",
	properties: {
		sections: { type: "array", items: { type: "object" } },
		refinements: {
			type: "array",
			items: {
				type: "object",
				properties: { section: { type: "string" }, what: { type: "string" }, why: { type: "string" } },
			},
		},
		references: {
			type: "array",
			items: { type: "object", properties: { what: { type: "string" }, learned: { type: "string" } } },
		},
		components: {
			type: "array",
			items: {
				type: "object",
				properties: {
					component: { type: "string" },
					section: { type: "string" },
					job: { type: "string" },
					why_not_plain: { type: "string" },
				},
				required: ["component", "section"],
			},
		},
	},
	required: ["sections"],
}

export function componentJudgePrompt(
	brief: string,
	picks: Array<{ component: string; section: string; job: string; whyNotPlain: string }>,
): string {
	return `A designer picked ready-made components for a page for: ${brief}
${picks.map((p, i) => `${i + 1}. ${p.component} in section "${p.section}". Job: ${p.job}. Why not plain HTML/CSS: ${p.whyNotPlain}`).join("\n")}
For EACH: does it do a real job on this page that plain HTML and CSS could not do as well? Decoration for its own sake, or "it looks more dynamic", is not a real job.
Reply with JSON only: {"verdicts": [{"n": 1, "keep": true or false, "why": "one sentence"}]}`
}

export const COMPONENT_JUDGE_SCHEMA = {
	type: "object",
	properties: {
		verdicts: {
			type: "array",
			items: {
				type: "object",
				properties: { n: { type: "number" }, keep: { type: "boolean" }, why: { type: "string" } },
				required: ["n", "keep"],
			},
		},
	},
	required: ["verdicts"],
}

export interface BuildComponent {
	/** The import path the page uses. */
	importPath: string
	/** The export to import, when the file has no default export. */
	namedExport?: string
	section: string
	job: string
}

/**
 * The build turn's instructions. No separate AI check of the built page: the
 * builder carries the banned list, everything removed from this plan, and the
 * plan itself as the only thing to build.
 */
export function buildInstructions(plan: DesignPlan, removed: RemovedPart[], components: BuildComponent[]): string {
	return `Build this page from the approved plan below. It went through Caret's Design pass: it was checked against common AI design habits and refined by a designer.
- Build only what the plan says, section by section, with its exact copy and values.
- Fill any component with this page's real content, never the component's sample data.
- Never use any of these common AI design habits:
${bannedList()}
- Don't bring back anything removed from this plan:
${removedList(removed)}
${
	components.length
		? `- Use these installed components where the plan places them:\n${components.map((c) => `  - section "${c.section}": import ${c.namedExport ? `{ ${c.namedExport} }` : "the default export"} from "${c.importPath}" (${c.job})`).join("\n")}`
		: ""
}

The plan:
${JSON.stringify(plan, null, 1)}`
}

/**
 * Does this chat message ask for a page to be built? Only then does the pass
 * run: a small edit ("make the button blue") goes straight to the chat, as it
 * would with the pass off.
 */
export function pageWorkPrompt(message: string, existingPages: string[]): string {
	return `A user of a design tool sent this message to its AI:
"""
${message}
"""
Pages that already exist: ${existingPages.length ? existingPages.join(", ") : "(none)"}

Does the message ask the AI to create a new page, or to redesign an existing page as a whole (its layout, sections or look across the page)?
Answer false for anything smaller or different: an edit to one element or one section's text, a colour or spacing tweak, a question, a fix, a sync, assets, or tokens.
Reply with JSON only: {"pageWork": true or false, "page": "the page's id when it is an existing one, else a short id for the new page"}`
}

export const PAGE_WORK_SCHEMA = {
	type: "object",
	properties: { pageWork: { type: "boolean" }, page: { type: "string" } },
	required: ["pageWork"],
}
