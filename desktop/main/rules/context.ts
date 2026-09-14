/**
 * The foundational context every agent must have, in two forms.
 *
 * **JSON for the machine.** Tokens, the page inventory, the flow graph — things
 * the agent looks values up in. Benchmarks put structured context at roughly 80%
 * fewer tokens than the same content as Markdown, with materially fewer
 * hallucinations, and none of it benefits from prose.
 *
 * **Prose for judgment.** The authoring rules are the opposite case: they are
 * conventions with reasons, and an agent that has only seen the shape of a
 * caret-id will still put one inside a `.map()`. That half stays as written
 * English and ships through `get_guide` and the rules files.
 */
import * as path from "path"

import {
	CARET_ID_RULES,
	CATALOG,
	type FoundationTokens,
	INLINE_EDITING_RULES,
	listFlows,
	listPages,
	readAssetIndex,
	readCatalogLock,
	readFoundationTokens,
	readPromotedRules,
	summariseForRules,
} from "../../../src/core/design"

export interface FoundationContext {
	project: string
	tokens: FoundationTokens | null
	/** Page ids with their states, so an agent can see what already exists. */
	pages: Array<{ id: string; title: string; tags: string[]; states: string[] }>
	flows: Array<{ id: string; name: string; pages: string[] }>
	/**
	 * One line per asset — tag, kind, size, path, character.
	 *
	 * Always-on rather than behind `list_assets`, for the same reason the tokens
	 * are: an agent that must *choose* to enumerate the project's assets will not,
	 * and will emit a placeholder rectangle instead. The pixels stay pull-only.
	 */
	assets: string[]
}

export async function buildFoundationContext(projectPath: string): Promise<FoundationContext> {
	const [tokens, pages, flows, assets] = await Promise.all([
		readFoundationTokens(projectPath).catch(() => null),
		listPages(projectPath).catch(() => []),
		listFlows(projectPath).catch(() => []),
		readAssetIndex(projectPath).catch(() => ({ version: 1 as const, assets: [] })),
	])

	return {
		project: path.basename(projectPath),
		tokens: tokens ?? null,
		// Variant takes are transient working copies — an agent building "what
		// already exists" from them would treat a half-finished pick as pages.
		pages: pages
			.filter((p) => !p.variantOf)
			.map((p) => ({ id: p.id, title: p.title ?? p.id, tags: p.tags ?? [], states: p.states ?? [] })),
		flows: flows
			.filter((f) => !f.invalid)
			.map((f) => ({
				id: f.id,
				name: f.name ?? f.id,
				pages: (f.steps ?? []).map((s) => s.page).filter(Boolean),
			})),
		assets: assets.assets.map(summariseForRules),
	}
}

/**
 * The prose half: how to author a page here, and why each rule exists.
 *
 * The reasons are load-bearing. "Never put a caret-id inside `.map()`" reads as
 * an arbitrary restriction until you know the id would be duplicated across
 * every row and the editor would mutate the wrong one — and an agent that knows
 * the reason generalises it to cases this text does not list.
 */
/**
 * Who the guide is being written for.
 *
 * `mcp` is an external agent, which reaches Caret only through tools and has to
 * be told their names. `embedded` is the coding backend Caret drives itself:
 * this text is injected straight into its system prompt, it has no Caret tools
 * at all, and naming tools it cannot call is worse than saying nothing — it will
 * try, fail, and report the failure as the user's problem.
 */
export type GuideAudience = "mcp" | "embedded"

/**
 * The catalog index: one line per component, with editability and the
 * signature marker visible — the data the restraint rules refer to. Installed
 * components are marked so the agent reuses them instead of re-choosing.
 */
async function catalogIndexLines(projectPath: string): Promise<string> {
	const lock = await readCatalogLock(projectPath).catch(() => ({ version: 1 as const, installed: [] }))
	const lines: string[] = []
	for (const library of CATALOG) {
		lines.push(`**${library.name}** (${library.licence}) — ${library.useWhen}`)
		for (const component of library.components) {
			const installed = lock.installed.some((entry) => entry.library === library.id && entry.component === component.id)
			const marks = [
				component.signature ? "⚡" : "",
				component.editable === "full" ? "[full]" : "[props]",
				installed ? "(installed)" : "",
			]
				.filter(Boolean)
				.join(" ")
			lines.push(`- \`${library.id}/${component.id}\` ${marks} — ${component.useWhen}`)
		}
		lines.push("")
	}
	return lines.join("\n")
}

export async function buildGuide(projectPath: string, audience: GuideAudience = "mcp"): Promise<string> {
	const context = await buildFoundationContext(projectPath)
	const promoted = await readPromotedRules(projectPath).catch(() => ({ version: 1 as const, rules: [] }))

	// Vocabulary lines for token groups a foundation only sometimes carries.
	const tokens = context.tokens
	const paletteRoleLines = [
		tokens?.color?.secondary
			? "- Secondary scale: `text-secondary-500`, `bg-secondary-50` … the supporting colour, same steps as brand."
			: "",
		tokens?.color?.accent
			? "- Accent scale: `text-accent-500`, `bg-accent-50` … used rarely, per the restraint rule below."
			: "",
		tokens?.color?.on
			? "- On-colours: text on a brand background is `text-on-brand` (and `text-on-secondary`/`text-on-accent`\n  where those roles exist) — never white by habit. Body text on the page is `text-on-surface`;\n  de-emphasised text is `text-on-surface-muted`. Each is contrast-checked against its background."
			: "",
	]
		.filter(Boolean)
		.join("\n")
	const depthLines = tokens?.elevation
		? `- Shadows: \`shadow-raised\`, \`shadow-floating\`, \`shadow-overlay\` (also aliased over \`shadow-sm/md/lg\`)
  come from the foundation, tinted to this project — never invent a shadow value.
- Borders: hairlines are \`border-border\` at the foundation's width; the focus ring colour is \`ring-ring\`.`
		: ""
	const motionLines = tokens?.motion
		? `- Motion: every transition uses \`duration-fast\`/\`duration-base\`/\`duration-slow\` with
  \`ease-standard\` (or \`ease-decelerate\` for things entering). Choreography — what animates
  and why — is yours to design; the timing vocabulary is not.`
		: ""
	const restraintLine = tokens?.meta?.rule
		? `

**This foundation's restraint rule:** ${tokens.meta.rule}
`
		: ""

	const promotedSection =
		promoted.rules.length === 0
			? ""
			: `

## Standing corrections (promoted by the user — never violate these)

The user made each of these corrections repeatedly by hand until Caret promoted it into a
standing rule. Repeating the mistake a rule exists to prevent is the single worst thing an
agent can do here.

${promoted.rules.map((rule) => `- ${rule.text}`).join("\n")}
`

	return `# Authoring the Caret design layer

You are writing pages into \`.caret/\`, a design layer that lives in this repo under
version control. It is not the shipped app — it is the place designs are worked out
before being synced into the app. Pages here are plain React + Tailwind v4 with no
backend, so anything a page displays it carries as its own sample data.

## Directory structure

\`\`\`
.caret/
├── tokens/foundation.json   foundation tokens (colour, type, spacing, radius)
├── pages/<page-id>/
│   ├── index.tsx            the page component
│   └── meta.json            { id, title, type, states, tags }
├── components/              shared components, hoisted out of pages
├── layouts/                 layout templates
├── flows/*.flow.json        multi-page user flows
└── assets/                  static assets
\`\`\`

## Styling

Tailwind v4 is loaded globally. Do **not** \`@import "tailwindcss"\` in a page or
component — it is already there, and a second import breaks the build.

- Use utility classes for all styling. Never \`style={{}}\` or \`React.CSSProperties\`,
  not even for one-off values: \`style={{ padding: "13px" }}\` becomes \`className="p-[13px]"\`.
  The inline editor reads classes; an inline style is invisible to it.
- No \`@apply\`, no \`@layer\` in component files, no \`tailwind.config\` — v4 has no config file,
  and creating one does nothing except mislead the next reader.
- Never build a class name by concatenation (\`\\\`bg-\${color}-500\\\`\`). Tailwind's compiler
  scans for whole class strings and cannot see a constructed one, so the style silently
  never ships. Use a lookup object with full class strings instead.
- Tailwind scans \`pages/\`, \`components/\`, \`layouts/\` and \`lib/\` only. Source anywhere else
  contributes no styles, silently — keep every component inside those directories.
- The shell's own files — \`vite.config.ts\`, \`global.css\`, \`main.tsx\`, \`index.html\`,
  \`caret-theme.css\`, \`caret-fonts.css\` — are generated by Caret, which restores them if
  they change. Never edit them; work in pages, components and the foundation instead.

## Responsive

Prefer one tree that reflows (\`flex-col md:flex-row\`) over separate mobile and desktop
trees. Two trees means every future edit has to be made twice, and one of them will
eventually be missed.

${INLINE_EDITING_RULES}

${CARET_ID_RULES}

## Page metadata

Every page needs a \`meta.json\` beside it. Always give meaningful \`tags\` — the canvas
groups pages by them, and an untagged page lands in "other". Declare the \`states\` a page
has (\`default\`, \`loading\`, \`empty\`, \`error\`) rather than only building the happy path.

## Shared components

Before writing a page, look at \`.caret/components/\`. If a pattern will appear on more
than one page, put it there first and import it (\`../../components/Name\`). Hoisting after
the fact means finding every copy.

## Foundation tokens

${
	context.tokens
		? `This project's tokens are below. Style from these, not from values you pick yourself —
a colour that is close to the brand colour but not it is the single most visible way
generated UI reads as generated.

**These tokens are defined into the Tailwind theme** (\`.caret/caret-theme.css\`, generated —
never edit it), so use them as ordinary utilities:

- Brand scale: \`text-brand-500\`, \`bg-brand-50\`, \`border-brand-950\` … every step in the
  scale below, plus bare \`brand\` for the seed itself. Use these — never a stock palette
  colour that merely looks similar.
- Neutral scale: \`text-neutral-600\`, \`bg-neutral-50\` … resolve to THIS project's tinted
  neutrals, not Tailwind's stock grey. Use \`neutral-*\` for greys — never \`slate\`/\`gray\`/
  \`zinc\`/\`stone\`, which bypass the foundation.
${paletteRoleLines ? `${paletteRoleLines}\n` : ""}- Semantic: \`text-success\`, \`text-warning\`, \`text-error\`, \`text-info\` (and \`bg-\`/\`border-\`).
- Type: the body face is \`font-sans\`, the heading face is \`font-display\`. The size steps
  (\`text-xs\` … \`text-5xl\`) follow the foundation's own ratio, not Tailwind's defaults —
  each carries its own line height, so never set an arbitrary leading or font size.
- Radius: \`rounded-sm\` … \`rounded-xl\` follow the foundation's radius character.
${depthLines ? `${depthLines}\n` : ""}${motionLines ? `${motionLines}\n` : ""}${restraintLine}

These are **live bindings**: when a token changes, every page using the token class updates
instantly. A raw value (\`text-[#1a2b3c]\`) is frozen at what the token happened to be today
and silently stops matching when the foundation moves — never write one for a colour, size
or radius the foundation already names.

\`\`\`json
${JSON.stringify(context.tokens, null, 2)}
\`\`\``
		: `**This project has no foundation tokens yet.** Do not start generating pages —
everything you write would have to be re-styled once foundations exist.

Run the foundation interview first: use \`present_question\` to ask the user a few
plain-language questions about the product and how it should feel, then
\`present_options\` with the vibe tags you infer, then \`commit_foundation\` with the
candidate they pick. The full script is in the \`foundation_interview\` prompt on the
Caret MCP server.

Ask about the product, never about design terms. "What are you building?" gets an
answer; "what type scale do you want?" gets a guess.`
}
${promotedSection}
## What already exists

${
	context.pages.length === 0
		? "No pages yet."
		: context.pages.map((p) => `- \`${p.id}\` — ${p.title}${p.tags.length ? ` [${p.tags.join(", ")}]` : ""}`).join("\n")
}

## Assets

${
	context.assets.length === 0
		? `No assets yet. **Never invent an image URL and never leave a grey placeholder box.** If a
design needs a photograph, an icon or a logo you do not have, say so and ask — the user can add
one, or Caret can generate it.`
		: `Reference these by path. They are served from \`/caret-assets/\` and already work in the canvas.

${context.assets.map((line) => `- ${line}`).join("\n")}

When the user writes \`@tag\`, they mean one of these.${
				audience === "mcp"
					? " Use `get_asset` to see the actual image\nbefore placing it somewhere the composition matters."
					: ""
			} Respect the intrinsic size: an asset
placed into a box much larger than itself will look soft, and one whose aspect ratio is far from
its box will lose most of the picture to cropping. Say so rather than doing it.${
				context.assets.some((line) => line.includes("(model"))
					? `

A \`model\` asset is a 3D \`.glb\` — it is NOT an image and an \`<img>\` tag cannot show it. To put
it on a page: install a viewer into the page workspace (\`npm install --prefix .caret
@google/model-viewer --ignore-scripts\`, import it once), then \`<model-viewer src="/caret-assets/<file>" camera-controls
auto-rotate>\` sized like an image. Start the camera on the object's front (\`camera-orbit\`), and
prefer a gentle sway over a full spin — reconstruction seams live on the diagonal angles.`
					: ""
			}`
}

## npm libraries

Plain libraries — animation (gsap, motion), 3D viewers, data and date utilities, anything
that is not a UI component — come from npm into the design layer's own workspace. An import
of a package that is not installed does not fail politely: the whole page stops rendering.
So before writing the import, make sure the package is installed — check that
\`.caret/node_modules/<package>\` exists, and when it does not, install it FIRST:

\`\`\`
npm install --prefix .caret <package> --ignore-scripts
\`\`\`

Run it from the project root, exactly in that shape. Mid-session installs are fine and take
effect immediately; nothing needs restarting. UI *components* are different — those come
only from the catalog below, never from npm.

## The component catalog

A curated set of animated components you may use — **and the only external components you may
use**: never install or hand-roll an equivalent of something below, and never import a
component that is not listed. Import the documented path and Caret installs the source
automatically after your write lands (into \`.caret/components/catalog/\`, where you can read
and edit it like any other file).

**Restraint rules, enforced mechanically — not suggestions:**
- The catalog is NOT a default ingredient. Pages are composed from the foundation (type,
  colour, spacing). Reach for the catalog only when the user's own words ask for that kind of
  thing, or a declared page state needs it (a loader for \`loading\`).
- **One signature move per page.** Components marked ⚡ below are signature pieces. A second
  ⚡ import on a page will NOT be supplied — the import stays visibly broken and the design
  checks flag it. The reference designs this product is measured against won by being
  restrained everywhere except one move.
- Prefer the most editable thing that does the job: [full] components are plain source the
  visual editor can restyle; [props] components have a sealed canvas/WebGL interior — every
  one you use is a place the user cannot correct with the editor, so it needs a reason.
- Unsure whether a signature piece helps? Offer it as ONE take in a playground round
  (\`propose_variants\`), never as the default.

Import shape: \`import X from "../../components/catalog/<library>/<component>"\` (from a page).

${await catalogIndexLines(projectPath)}

${
	audience === "mcp"
		? `## Styling one element precisely

For a targeted style change, \`get_params\` then \`set_param\` beat editing the file: they
resolve the element the way the user's own property panel does (token bindings named, the
responsive variant picked by viewport, refusals typed) and the write is a minimal splice on
the same undo stack as the user's edits. Prefer a token name over a raw value — a raw value
detaches the element from the design's token system.

## Before you declare page work finished

Call \`run_design_checks\` on every page you wrote or changed, and fix what it reports.
The checks are mechanical, not taste — contrast failures, repeated card text, missing alt,
upscaled images, placeholder boxes — and Caret runs the same checks itself and shows the
user every finding, so a defect you skip is a defect the user is shown with your name on it.

## When the user wants to explore, not specify

"Try a few directions", "show me some options", "make it feel more premium" — anything that
cannot be said precisely in words wants a pick, not one attempt. Write two or three variant
pages (ids like \`<pageId>--v1\`, \`meta.variantOf\` set to the original page id), each a
genuinely different reading of the request, then call \`propose_variants\`. Caret shows them
side by side in its playground, where the user can also branch further rounds from any take;
the chosen take replaces the page and every take directory is cleaned up.

`
		: ""
}## Do not run the dev server

Caret already runs Vite for this design layer and reloads your changes as you write them.
Do not run \`npm run dev\`, \`vite\`, or any server command inside \`.caret/\` — it will fight
the running one. To see build or runtime errors, read \`.caret/vite.log\`.
`
}
