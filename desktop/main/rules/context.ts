/**
 * What agents read about this project: the rules (a small core plus the design
 * layer's detail) and the compact context every tool reply carries.
 */
import * as path from "path"

import {
	CARET_ID_RULES,
	type FoundationTokens,
	INLINE_EDITING_RULES,
	listPages,
	readAssetIndex,
	readCatalogLock,
	readFoundationTokens,
	readPromotedRules,
} from "../../../src/core/design"
import { foundationSummary } from "../../../src/core/design/defaults/foundation-summary"
import { bannedHabitLines } from "../../../src/core/design/defaults/slop-list"
import { type LibraryDefinition, librarySearchParagraph } from "../../../src/core/design/libraries/catalog"

/**
 * What every MCP tool reply carries, so the foundation cannot be skipped: the
 * approved values in a few lines, and counts. Fixed size whatever the project
 * holds — the lists themselves come from `get_project` and `list_assets`, a
 * page at a time.
 */
export interface FoundationContext {
	project: string
	/** The approved foundation, compactly; null before one exists. */
	foundation: string | null
	pages: number
	assets: number
}

export async function buildFoundationContext(projectPath: string): Promise<FoundationContext> {
	const [tokens, pages, assets] = await Promise.all([
		readFoundationTokens(projectPath).catch(() => null),
		listPages(projectPath).catch(() => []),
		readAssetIndex(projectPath).catch(() => ({ version: 1 as const, assets: [] })),
	])
	return {
		project: path.basename(projectPath),
		foundation: foundationSummary(tokens),
		// Variant takes are transient working copies, not pages.
		pages: pages.filter((p) => !p.variantOf).length,
		assets: assets.assets.length,
	}
}

/**
 * Components this project already installed, so an agent reuses them instead
 * of choosing again. Only what is installed: what could be installed is
 * searched for on purpose (the libraries' tools), never listed here.
 */
async function installedComponentLines(projectPath: string): Promise<string> {
	const lock = await readCatalogLock(projectPath).catch(() => ({ version: 1 as const, installed: [] }))
	if (lock.installed.length === 0) return "None installed yet."
	return lock.installed
		.map(
			(entry) =>
				`- \`${(entry.files[0] ?? `${entry.library}/${entry.component}`).replace(/\.tsx?$/, "")}\` (${entry.library}/${entry.component})`,
		)
		.join("\n")
}

/**
 * The rules, in two layers — the shape every coding agent's own instructions
 * take: a small core loaded every time, and details loaded when the work
 * reaches the files they are about.
 *
 * - **The core** (`buildCore`) is Caret's block in AGENTS.md, CLAUDE.md and the
 *   always-on Cursor rule. Fixed size whatever the project holds: anything
 *   that grows (pages, assets, standing corrections, installed components) is
 *   a count and a pointer. Under 200 lines and well under Codex's 32 KiB, which
 *   cuts longer files silently; a test holds both.
 * - **The design layer** (`buildDesignLayer`) is `.caret/AGENTS.md`, read by
 *   the agent before it touches `.caret/`. Caret's chat refuses design-layer
 *   writes until a session has read it, and Caret's page tools do the same for
 *   outside agents, so it cannot be skipped.
 *
 * The reasons stay in the prose. "Never put a caret-id inside `.map()`" reads as
 * an arbitrary restriction until you know the id would be duplicated across
 * every row; an agent that knows the reason generalises it.
 */

/** Short rules that must hold everywhere, so they live in the core. */
const HARD_RULES = `- Style with Tailwind utility classes only. Never \`style={{}}\`, never \`@import "tailwindcss"\`
  (the shell loads it once), never a \`tailwind.config\`.
- Colour, type, radius, shadows and motion come from the foundation's token classes below. Never
  a raw value (\`text-[#1a2b3c]\`) for something the foundation names.
- Every element keeps the \`data-caret-id\` scheme in \`.caret/AGENTS.md\`; the visual editor depends on it.
- Never edit the shell's generated files (\`vite.config.ts\`, \`global.css\`, \`main.tsx\`,
  \`index.html\`, \`caret-theme.css\`, \`caret-fonts.css\`), and never run a dev server: Caret runs Vite.
- Never invent an image URL and never leave a grey placeholder box: use the project's assets, or say
  what is missing.`

/** The libraries that are on, as the rules name them. Set by main at startup; none until then. */
let librariesOn: () => Promise<ReadonlyArray<Pick<LibraryDefinition, "id" | "name" | "kind">>> = async () => []

export function setLibrariesOnSource(source: typeof librariesOn): void {
	librariesOn = source
}

export async function buildCore(projectPath: string): Promise<string> {
	const [tokens, pages, assets, promoted, lock] = await Promise.all([
		readFoundationTokens(projectPath).catch(() => null),
		listPages(projectPath).catch(() => []),
		readAssetIndex(projectPath).catch(() => ({ version: 1 as const, assets: [] })),
		readPromotedRules(projectPath).catch(() => ({ version: 1 as const, rules: [] })),
		readCatalogLock(projectPath).catch(() => ({ version: 1 as const, installed: [] })),
	])
	const librarySearch = librarySearchParagraph(await librariesOn().catch(() => []))
	const pageCount = pages.filter((p) => !p.variantOf).length
	const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`

	return `# Caret design layer

This repo has a design layer in \`.caret/\`: plain React + Tailwind v4 pages, under version control,
where designs are worked out before they are synced into the app. It is not the shipped app.

**Before you read, write or edit anything in \`.caret/\`, read \`.caret/AGENTS.md\`.** It holds the full
authoring rules (caret-ids, inline editing, page metadata, states, shared components, packages).
Caret refuses design-layer writes until it has been read. If the file is missing, Caret's \`get_guide\`
tool returns the same text.

## Hard rules

${HARD_RULES}

## Foundation

${tokens ? tokenVocabulary(tokens) : NO_FOUNDATION}

## Common AI design habits to avoid

People keep reporting these in AI-made designs; they make a page look generic. Don't use them
unless the user asks for one by name:
${bannedHabitLines()
	.map((name) => `- ${name}`)
	.join("\n")}

## How to work

Plan the page section by section, then build it, then check it: call \`run_design_checks\` on every
page you wrote and fix what it reports. Make it work like a normal app, and look like this product.
${librarySearch ? `\n## Component and reference libraries\n\n${librarySearch}\n` : ""}
## Where everything is

- Pages: ${plural(pageCount, "page")}. \`get_project\` lists them, a page at a time.
- Assets: ${plural(assets.assets.length, "asset")}. \`list_assets\` lists them (search, filter, a page at a time);
  \`get_asset\` shows one. When the user writes \`@tag\`, they mean an asset.
- Tokens: \`get_tokens\` returns every value.
- Standing corrections from the user: ${promoted.rules.length}. They are in \`.caret/AGENTS.md\`; never repeat a corrected mistake.
- Installed components: ${lock.installed.length}. Listed in \`.caret/AGENTS.md\`.
`
}

const NO_FOUNDATION = `**This project has no foundation yet.** Don't generate pages: everything would have to be
re-styled once foundations exist. Run the foundation interview first (the \`foundation_interview\`
prompt on Caret's MCP server: \`present_question\`, \`present_options\`, \`commit_foundation\`). Ask
about the product, never about design terms.`

/** The token class names, never the full data: \`get_tokens\` has the values. */
function tokenVocabulary(tokens: FoundationTokens): string {
	const roles = [tokens.color?.secondary ? "`secondary-*`" : "", tokens.color?.accent ? "`accent-*` (used rarely)" : ""].filter(
		Boolean,
	)
	const lines = [
		`- Colour: \`brand-50\` … \`brand-950\` and bare \`brand\` (seed ${tokens.color.brand.seed})${roles.length ? `, ${roles.join(", ")}` : ""}; greys are \`neutral-*\` (never \`slate\`/\`gray\`/\`zinc\`/\`stone\`); \`success\`, \`warning\`, \`error\`, \`info\`.`,
		tokens.color?.on
			? "- Text: `text-on-surface`, `text-on-surface-muted`, and `text-on-brand` on a brand background (never white by habit)."
			: "",
		`- Type: \`font-display\` (${tokens.typography.displayFamily ?? tokens.typography.fontFamily}) for headings, \`font-sans\` (${tokens.typography.fontFamily}) for body; sizes \`text-xs\` … \`text-5xl\` carry their own line heights.`,
		`- Radius: \`rounded-sm\` … \`rounded-xl\` (${tokens.radius.character}).`,
		tokens.elevation
			? "- Depth: `shadow-raised`, `shadow-floating`, `shadow-overlay`; hairlines `border-border`; focus `ring-ring`."
			: "",
		tokens.motion
			? "- Motion: `duration-fast`/`duration-base`/`duration-slow` with `ease-standard` or `ease-decelerate`."
			: "",
		tokens.meta?.rule ? `\n**This foundation's restraint rule:** ${tokens.meta.rule}` : "",
	]
	return lines.filter(Boolean).join("\n")
}

/**
 * The design layer's own rules: `.caret/AGENTS.md`. Read before work in
 * `.caret/` begins, so it may be as detailed as the work needs — but it holds
 * no growing lists either, except the standing corrections and installed
 * components that exist precisely to be reused.
 */
export async function buildDesignLayer(projectPath: string): Promise<string> {
	const [tokens, promoted, assets] = await Promise.all([
		readFoundationTokens(projectPath).catch(() => null),
		readPromotedRules(projectPath).catch(() => ({ version: 1 as const, rules: [] })),
		readAssetIndex(projectPath).catch(() => ({ version: 1 as const, assets: [] })),
	])
	const hasModels = assets.assets.some((asset) => asset.kind === "model")

	const paletteRoleLines = [
		tokens?.color?.secondary
			? "- Secondary scale: `text-secondary-500`, `bg-secondary-50` … the supporting colour, same steps as brand."
			: "",
		tokens?.color?.accent ? "- Accent scale: `text-accent-500`, `bg-accent-50` … used rarely, per the restraint rule." : "",
		tokens?.color?.on
			? "- On-colours: text on a brand background is `text-on-brand` (and `text-on-secondary`/`text-on-accent`\n  where those roles exist), never white by habit. Body text on the page is `text-on-surface`;\n  de-emphasised text is `text-on-surface-muted`. Each is contrast-checked against its background."
			: "",
	]
		.filter(Boolean)
		.join("\n")

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
	tokens
		? `Style from this project's tokens (\`get_tokens\` has every value), not from values you pick
yourself — a colour that is close to the brand colour but not it is the single most visible
way generated UI reads as generated. They are defined into the Tailwind theme
(\`.caret/caret-theme.css\`, generated — never edit it), so use them as ordinary utilities:

- Brand scale: \`text-brand-500\`, \`bg-brand-50\`, \`border-brand-950\` … plus bare \`brand\` for the seed.
- Neutral scale: \`text-neutral-600\`, \`bg-neutral-50\` … THIS project's tinted neutrals, not
  Tailwind's stock grey. Never \`slate\`/\`gray\`/\`zinc\`/\`stone\`, which bypass the foundation.
${paletteRoleLines ? `${paletteRoleLines}\n` : ""}- Semantic: \`text-success\`, \`text-warning\`, \`text-error\`, \`text-info\` (and \`bg-\`/\`border-\`).
- Type: the body face is \`font-sans\`, the heading face is \`font-display\`. The size steps
  (\`text-xs\` … \`text-5xl\`) follow the foundation's own ratio, and each carries its own line
  height, so never set an arbitrary leading or font size.
- Radius: \`rounded-sm\` … \`rounded-xl\` follow the foundation's radius character.
${tokens.elevation ? "- Shadows: `shadow-raised`, `shadow-floating`, `shadow-overlay` (also over `shadow-sm/md/lg`), tinted to\n  this project; never invent a shadow value. Hairlines are `border-border`; the focus ring is `ring-ring`.\n" : ""}${tokens.motion ? "- Motion: every transition uses `duration-fast`/`duration-base`/`duration-slow` with `ease-standard`\n  (or `ease-decelerate` for things entering). What animates and why is yours to design; the timing is not.\n" : ""}
These are **live bindings**: when a token changes, every page using the token class updates
instantly. A raw value is frozen at what the token happened to be today and silently stops
matching when the foundation moves.`
		: "This project has no foundation tokens yet. Don't generate pages until it has: run the foundation interview first."
}
${promotedSection}
## Assets

List them with \`list_assets\` (search and filter; a page at a time) and look at one with
\`get_asset\` before placing it somewhere the composition matters. They are served from
\`/caret-assets/\` and already work in the canvas. Respect the intrinsic size: an asset placed
into a box much larger than itself will look soft, and one whose aspect ratio is far from its box
will lose most of the picture to cropping. Say so rather than doing it. **Never invent an image URL
and never leave a grey placeholder box.** If a design needs a picture you do not have, say so and
ask: the user can add one, or Caret can generate it.${
		hasModels
			? `

A \`model\` asset is a 3D \`.glb\` — it is NOT an image and an \`<img>\` tag cannot show it. To put
it on a page: install a viewer into the page workspace (\`npm install --prefix .caret
@google/model-viewer --ignore-scripts\`, import it once), then \`<model-viewer src="/caret-assets/<file>" camera-controls
auto-rotate>\` sized like an image. Start the camera on the object's front (\`camera-orbit\`), and
prefer a gentle sway over a full spin — reconstruction seams live on the diagonal angles.`
			: ""
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
effect immediately; nothing needs restarting. UI *components* are different — never from npm.

## Ready-made components

Pages are composed from the foundation first: type, colour, spacing. A ready-made component
is for a job plain HTML and CSS cannot do as well, or one the user asked for by name. Never
decoration for its own sake. Install one with \`install_component\` ("@registry/name" from
@shadcn, @magicui, @aceternity, @smoothui or @kokonutui, or "21st:<id>"), import the path it
returns, and fill it with this page's real content, never the component's sample data. The
source lands in \`.caret/components/catalog/\`, where you can read and edit it like any other file.

Installed in this project (import from \`../../components/catalog/<path>\` in a page):
${await installedComponentLines(projectPath)}

## Styling one element precisely

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

## Do not run the dev server

Caret already runs Vite for this design layer and reloads your changes as you write them.
Do not run \`npm run dev\`, \`vite\`, or any server command inside \`.caret/\` — it will fight
the running one. To see build or runtime errors, read \`.caret/vite.log\`.
`
}
