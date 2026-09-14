/**
 * Tools v1 — the whole surface an external agent drives Caret through.
 *
 * Two rules shape this file.
 *
 * **Every result echoes the foundational context.** An agent asked to "build me
 * a card" that has to *choose* to look up spacing and typography will not — it
 * fills the gap from its training data, confidently and wrongly. The primary
 * delivery for foundations is the generated rules files (which every mainstream
 * agent auto-loads), because an MCP server cannot inject into a client's
 * context. This echo is the backstop for an agent that only touches the tools.
 *
 * **Structured for the machine, prose only for judgment.** Token tables, page
 * inventories and flow graphs go out as JSON — measurably fewer tokens and fewer
 * hallucinations than the same content as Markdown. `get_guide` carries the
 * prose half, which is the part that genuinely needs reading rather than parsing.
 */
import * as fs from "fs/promises"
import * as path from "path"
import { z } from "zod"

import {
	ASSETS_DIR,
	assetsDirectory,
	assetUrl,
	caretDirectoryExists,
	completeSync,
	computeDrift,
	describeAsset,
	type FlowDefinition,
	findAsset,
	type InstallResult,
	isViewable,
	listFlows,
	listPages,
	type PageCheckResult,
	type PageMeta,
	posterPath,
	readAssetIndex,
	readFoundationTokens,
	readPageMeta,
	readSyncState,
	recordMappings,
	registerExternalRound,
	runSync,
	startReverseSyncProposal,
	validateFoundationTokens,
	validatePageMeta,
	writeFoundationTokens,
	writePageMeta,
} from "../../../src/core/design"
import { runExclusive, writeFileAtomic } from "../../../src/core/design/file-mutation-queue"
import { mutateFlowDefinition, writeFlowDefinition } from "../../../src/core/design/flow-meta"
import { resolveParamsFor, spliceParamEdit } from "../../../src/core/design/param/edit"
import { PANEL_PROPERTIES } from "../../../src/core/design/param/params"
import { recordEdit } from "../../../src/core/design/provenance"
import { captureUndoStep } from "../../../src/core/design/undo/design-undo"
import { Logger } from "../../../src/shared/services/Logger"
import { getDesignLayerChangedFiles, getLatestGitCommitHash } from "../../../src/utils/git"
import { buildFoundationContext, buildGuide } from "../rules/context"
import type { ScreenshotResult } from "../types"

export interface ToolContext {
	projectPath: string
	/** Renders one page and captures it (one part of frames), or says why it could not. */
	screenshot(pageId: string, part?: number): Promise<ScreenshotResult>
	/** Runs the deterministic design checks on one page (or all). */
	runChecks(pageId?: string): Promise<PageCheckResult[]>
	/** Installs an allowlisted catalog component (consent-gated). */
	installComponent(libraryId: string, componentId: string): Promise<InstallResult>
}

export interface ToolResult {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>
	isError?: boolean
}

/**
 * Wraps a payload as a tool result with the foundational context attached.
 *
 * The context comes second so the agent reads the answer to its question first,
 * but it is always present — the whole point is that it cannot be skipped.
 */
async function reply(ctx: ToolContext, payload: unknown): Promise<ToolResult> {
	const foundation = await buildFoundationContext(ctx.projectPath)
	return {
		content: [
			{ type: "text", text: JSON.stringify(payload, null, 2) },
			{ type: "text", text: `<caret_foundation>\n${JSON.stringify(foundation)}\n</caret_foundation>` },
		],
	}
}

function fail(message: string): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }], isError: true }
}

/**
 * Refuses any path that escapes `.caret/`.
 *
 * An agent is not assumed hostile, but it is assumed to make mistakes, and a
 * `write_page` with `../../.ssh/authorized_keys` is a mistake with a very bad
 * ending. Resolution happens before the check so `..` segments and symlinked
 * prefixes cannot slip through.
 */
function resolveInCaret(projectPath: string, relative: string): string | null {
	const caretDir = path.resolve(projectPath, ".caret")
	const resolved = path.resolve(caretDir, relative)
	return resolved === caretDir || resolved.startsWith(caretDir + path.sep) ? resolved : null
}

export interface ToolDefinition {
	name: string
	title: string
	description: string
	inputSchema: z.ZodRawShape
	handler: (ctx: ToolContext, args: any) => Promise<ToolResult>
}

/**
 * The tools that change the design layer, for the chat agent's permission gate.
 *
 * The bundled backend's permission config gates its *own* tools; a call to one
 * of these — which are MCP tools from its point of view — used to run without
 * ever raising an ask, so the chat transcript carried no record of a write the
 * agent chose to make through Caret. `verify:app`'s `ee` caught it: the model
 * edited a page with `caret_write_page` instead of `edit`, the file changed,
 * and no auto-approval appeared anywhere. These names become `caret_<name>`
 * permission keys at spawn (see `desktop/main/index.ts`), and Caret's own
 * ruling auto-allows them as design-layer writes — same policy, same note, as
 * an `edit` aimed at `.caret/`.
 *
 * Reads stay off this list on purpose: a permission row per `get_page` would
 * bury the rows that matter. A new tool that writes anything must be added
 * here — `mcp-tool-permissions.test.ts` fails if the sets drift.
 */
export const MUTATING_TOOL_NAMES = [
	"create_page",
	"write_page",
	"update_tokens",
	"write_flow",
	"install_component",
	"describe_asset",
	"propose_variants",
	"set_param",
	"start_sync",
	"propose_design_update",
	"report_sync_mapping",
	"complete_sync",
	// From the interview surface (`interview-tools.ts`): these two write the
	// foundation and the asset library respectively.
	"commit_foundation",
	"generate_asset",
] as const

export const TOOLS: ToolDefinition[] = [
	{
		name: "get_project",
		title: "Read the design layer",
		description:
			"The structure of this project's design layer: every page with its metadata, every flow, and the current sync state. Call this first — it is the map.",
		inputSchema: {},
		async handler(ctx) {
			if (!(await caretDirectoryExists(ctx.projectPath))) {
				return fail("This project has no .caret/ design layer yet.")
			}
			const [pages, flows, sync] = await Promise.all([
				listPages(ctx.projectPath),
				listFlows(ctx.projectPath),
				readSyncState(ctx.projectPath),
			])
			return reply(ctx, {
				project: path.basename(ctx.projectPath),
				pages: pages.map(summarisePage),
				flows: flows.map(summariseFlow),
				lastSyncedCommit: sync.lastSyncedCommit,
			})
		},
	},

	{
		name: "get_page",
		title: "Read one page",
		description: "The full source and metadata of a single design page.",
		inputSchema: { pageId: z.string().describe("Page id, matching the directory under .caret/pages/") },
		async handler(ctx, { pageId }: { pageId: string }) {
			const dir = resolveInCaret(ctx.projectPath, path.join("pages", pageId))
			if (!dir) return fail(`Invalid page id: ${pageId}`)
			try {
				const source = await fs.readFile(path.join(dir, "index.tsx"), "utf-8")
				const meta = await readPageMeta(ctx.projectPath, pageId)
				return reply(ctx, { pageId, meta, source })
			} catch {
				return fail(`No page "${pageId}" in this design layer.`)
			}
		},
	},

	{
		name: "get_tokens",
		title: "Read foundation tokens",
		description:
			"This project's foundation tokens — colour, typography, spacing, radius. These are binding: styling that does not come from here will look wrong next to everything that does.",
		inputSchema: {},
		async handler(ctx) {
			const tokens = await readFoundationTokens(ctx.projectPath)
			return tokens ? reply(ctx, tokens) : fail("This project has no foundation tokens yet.")
		},
	},

	{
		name: "get_flows",
		title: "Read flows and page states",
		description: "The flow graph (which page leads where, including error paths) and each page's declared states.",
		inputSchema: {},
		async handler(ctx) {
			const [flows, pages] = await Promise.all([listFlows(ctx.projectPath), listPages(ctx.projectPath)])
			return reply(ctx, {
				flows: flows.map(summariseFlow),
				pageStates: Object.fromEntries(pages.map((p) => [p.id, p.states ?? []])),
			})
		},
	},

	{
		name: "get_screenshot",
		title: "Screenshot a page",
		description:
			"A rendered screenshot of a design page's FULL scroll height, captured fresh at 1440px wide and delivered as 900px-tall frames (top to bottom) so nothing is downscaled. A long page arrives in parts; the result says how many frames remain and which part to request next. Use this to look at your own work: after writing a page, screenshot it and check the whole page renders the way you intended.",
		inputSchema: {
			pageId: z.string().describe("Page id, matching the directory under .caret/pages/"),
			part: z
				.number()
				.int()
				.min(1)
				.optional()
				.describe("Which batch of frames, 1-based. Omit for the first; the result says when there is a next part."),
		},
		async handler(ctx, { pageId, part = 1 }: { pageId: string; part?: number }) {
			// Checked before rendering, because an unknown id does not error — the
			// shell serves an empty document and the capture succeeds. Handing an
			// agent a blank white image is worse than refusing: it looks like
			// evidence that the page is broken.
			const dir = resolveInCaret(ctx.projectPath, path.join("pages", pageId))
			if (!dir || !(await exists(path.join(dir, "index.tsx")))) {
				const available = await listPageIds(ctx.projectPath)
				return fail(`No page "${pageId}" in this design layer. Available pages: ${available.join(", ") || "none"}.`)
			}

			const result = await ctx.screenshot(pageId, part)
			if (!result.ok) return fail(result.reason)

			// Leading text rather than images alone, so a client that drops image
			// content degrades honestly. There is no capability negotiation for
			// content types, so Caret cannot ask whether images will be honoured
			// and gets no signal when they are not — without this the agent
			// receives an empty result and answers plausibly from context instead
			// of saying it saw nothing.
			const caution = result.warning ? ` Note: ${result.warning}.` : ""
			const lastFrame = result.firstFrame + result.frames.length - 1
			const whichPart =
				result.parts > 1 ? ` This is part ${part} of ${result.parts}: frames ${result.firstFrame}–${lastFrame}.` : ""
			const content: ToolResult["content"] = [
				{
					type: "text",
					text: `Screenshot of page "${pageId}", captured just now: ${result.pageHeight}px tall at 1440px wide, as ${result.totalFrames} frame(s) of up to 900px, top to bottom.${whichPart}${caution}`,
				},
			]
			for (const [i, frame] of result.frames.entries()) {
				const index = result.firstFrame + i
				const [, mimeType = "image/png", data = ""] = /^data:([^;]+);base64,(.*)$/.exec(frame.dataUrl) ?? []
				if (!data) return fail(`page "${pageId}" was captured but frame ${index} could not be encoded`)
				content.push(
					{
						type: "text",
						text: `Frame ${index} of ${result.totalFrames} — y ${frame.top}–${frame.top + frame.height}px:`,
					},
					{ type: "image", data, mimeType },
				)
			}
			if (lastFrame < result.totalFrames) {
				content.push({
					type: "text",
					text: `The page continues below frame ${lastFrame}: ${result.totalFrames - lastFrame} more frame(s). Call get_screenshot again with part: ${part + 1} to see them.`,
				})
			}
			return { content }
		},
	},

	{
		name: "list_assets",
		title: "List this project's assets",
		description:
			"Every image, vector, video and 3D model the user has added, with its tag, size and description. The same list is in your always-on context; call this when you need it fresh after an upload.",
		inputSchema: {},
		async handler(ctx) {
			const index = await readAssetIndex(ctx.projectPath)
			return reply(ctx, {
				assets: index.assets.map((asset) => ({
					tag: asset.tag,
					url: assetUrl(asset),
					kind: asset.kind,
					width: asset.width,
					height: asset.height,
					alt: asset.alt,
					description: asset.description,
					origin: asset.origin.type,
				})),
			})
		},
	},

	{
		name: "get_asset",
		title: "Look at an asset",
		description:
			"The actual pixels of an asset, plus its metadata. Use this before placing an asset somewhere the composition matters — the description tells you the size, but only the image tells you whether a headline can sit on it.",
		inputSchema: { tag: z.string().describe("The asset's tag, without the leading @") },
		async handler(ctx, { tag }: { tag: string }) {
			const index = await readAssetIndex(ctx.projectPath)
			const entry = findAsset(index, tag.replace(/^@/, ""))
			if (!entry) {
				const available = index.assets.map((a) => `@${a.tag}`).join(", ")
				return fail(`No asset tagged "${tag}". Available: ${available || "none — this project has no assets yet"}.`)
			}

			const summary = {
				tag: entry.tag,
				url: assetUrl(entry),
				kind: entry.kind,
				mime: entry.mime,
				width: entry.width,
				height: entry.height,
				bytes: entry.bytes,
				alt: entry.alt,
				description: entry.description,
				origin: entry.origin,
			}

			// Video and 3D cannot be handed over as their own bytes. A video has a
			// poster frame once the library has shown it, and one frame answers the
			// question an agent actually has — what does this look like. A client
			// that received an unreadable blob would be worse off than one told
			// plainly that it has metadata only.
			const viewable = isViewable(entry.kind)
			const poster = viewable ? null : posterPath(ctx.projectPath, entry)
			if (!viewable && !poster) {
				return reply(ctx, { ...summary, note: `${entry.kind} assets cannot be shown directly; use the description.` })
			}

			const file = poster ?? path.join(assetsDirectory(ctx.projectPath), entry.file)
			const mimeType = poster ? "image/png" : entry.mime

			try {
				const bytes = await fs.readFile(file)
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								poster
									? { ...summary, note: "The image below is a frame from this video, not the whole thing." }
									: summary,
								null,
								2,
							),
						},
						{ type: "image" as const, data: bytes.toString("base64"), mimeType },
					],
				}
			} catch (err) {
				// A poster is derived and gitignored, so a fresh clone has none. Falling
				// back to the metadata reply is the honest answer, not an error.
				if (poster) {
					return reply(ctx, { ...summary, note: `${entry.kind} assets cannot be shown directly; use the description.` })
				}
				return fail(`"${tag}" is indexed but its file could not be read: ${err instanceof Error ? err.message : err}`)
			}
		},
	},

	{
		name: "describe_asset",
		title: "Describe an asset",
		description:
			"Writes the alt text and the plain-language description of what an asset looks like. Do this after looking at a new asset: the description is what every later session reads instead of the pixels, so 'wide, dark, empty space top-left' is worth more than 'a photo'.",
		inputSchema: {
			tag: z.string(),
			alt: z.string().optional().describe("Alt text for screen readers"),
			description: z.string().optional().describe("What it looks like — composition, tone, where the empty space is"),
		},
		async handler(ctx, args: { tag: string; alt?: string; description?: string }) {
			const result = await describeAsset(ctx.projectPath, args.tag.replace(/^@/, ""), {
				alt: args.alt,
				description: args.description,
			})
			if (!result.ok) return fail(result.reason)

			await recordEdit(ctx.projectPath, {
				actor: "agent",
				action: "write",
				file: path.join(ASSETS_DIR, "index.json"),
				note: `described @${result.entry.tag}`,
			})
			return reply(ctx, { tag: result.entry.tag, alt: result.entry.alt, description: result.entry.description })
		},
	},

	{
		name: "get_sync_worklist",
		title: "Read the sync worklist",
		description:
			"The design files that changed since the last design→app sync. A net cumulative list: a change made and later reverted does not appear.",
		inputSchema: {},
		async handler(ctx) {
			const { lastSyncedCommit } = await readSyncState(ctx.projectPath)
			const changed = await getDesignLayerChangedFiles(ctx.projectPath, lastSyncedCommit)
			return reply(ctx, { since: lastSyncedCommit, isFirstSync: lastSyncedCommit === null, changed })
		},
	},

	{
		name: "get_guide",
		title: "Read the authoring guide",
		description:
			"How to author pages in this design layer — the conventions that keep the visual editor working. Read this before writing a page for the first time in a session.",
		inputSchema: {},
		async handler(ctx) {
			return { content: [{ type: "text", text: await buildGuide(ctx.projectPath) }] }
		},
	},

	{
		name: "create_page",
		title: "Create a page",
		description: "Creates a new design page with its metadata sidecar. Fails if the page already exists.",
		inputSchema: {
			pageId: z.string().describe('Directory-safe id, e.g. "checkout-review"'),
			source: z.string().describe("The full index.tsx source"),
			meta: z
				.object({
					title: z.string(),
					type: z.string().default("page"),
					states: z.array(z.string()).default([]),
					tags: z.array(z.string()).default([]),
				})
				.describe("Page metadata. Always give meaningful tags — the canvas groups by them."),
		},
		async handler(ctx, args: { pageId: string; source: string; meta: Omit<PageMeta, "id"> }) {
			const dir = resolveInCaret(ctx.projectPath, path.join("pages", args.pageId))
			if (!dir) return fail(`Invalid page id: ${args.pageId}`)
			if (await exists(dir)) return fail(`Page "${args.pageId}" already exists — use write_page to change it.`)

			const meta: PageMeta = { id: args.pageId, ...args.meta }
			if (!validatePageMeta(meta)) return fail("Invalid page metadata — id, title, type, states and tags are all required.")

			await fs.mkdir(dir, { recursive: true })
			const indexPath = path.join(dir, "index.tsx")
			await runExclusive(indexPath, () => writeFileAtomic(indexPath, args.source))
			await writePageMeta(ctx.projectPath, args.pageId, meta)
			await recordEdit(ctx.projectPath, { actor: "agent", action: "create", file: indexPath })

			return reply(ctx, { ok: true, pageId: args.pageId })
		},
	},

	{
		name: "write_page",
		title: "Replace a page's source",
		description:
			"Replaces the source of an existing page. Prefer this over your own file tools: it writes atomically, validates, and records what changed.",
		inputSchema: { pageId: z.string(), source: z.string() },
		async handler(ctx, args: { pageId: string; source: string }) {
			const dir = resolveInCaret(ctx.projectPath, path.join("pages", args.pageId))
			if (!dir) return fail(`Invalid page id: ${args.pageId}`)
			const indexPath = path.join(dir, "index.tsx")
			if (!(await exists(indexPath))) return fail(`No page "${args.pageId}" — use create_page.`)

			const before = await fs.readFile(indexPath, "utf-8").catch(() => "")
			await runExclusive(indexPath, () => writeFileAtomic(indexPath, args.source))
			await recordEdit(ctx.projectPath, {
				actor: "agent",
				action: "write",
				file: indexPath,
				sizeBefore: before.length,
				sizeAfter: args.source.length,
			})
			return reply(ctx, { ok: true, pageId: args.pageId })
		},
	},

	{
		name: "update_tokens",
		title: "Update foundation tokens",
		description:
			"Replaces the foundation tokens and regenerates the rules files every agent reads. Changing these changes how everything in the project looks, so make the change the user asked for and nothing else.",
		inputSchema: { tokens: z.record(z.string(), z.unknown()).describe("A complete FoundationTokens object") },
		async handler(ctx, args: { tokens: Record<string, unknown> }) {
			if (!validateFoundationTokens(args.tokens)) {
				return fail("Invalid foundation tokens — expected the full { vibe, color, typography, spacing, radius } shape.")
			}

			await writeFoundationTokens(ctx.projectPath, args.tokens)
			await recordEdit(ctx.projectPath, { actor: "agent", action: "write", file: "tokens/foundation.json" })
			return reply(ctx, { ok: true })
		},
	},

	{
		name: "write_flow",
		title: "Write a flow",
		description:
			"Creates or replaces a flow definition — the user-journey arrows drawn between pages on the canvas. " +
			"Steps name pages by id; `next` lists the step pages an arrow leads to. " +
			"Always use this rather than writing .caret/flows/ files yourself: the file format is Caret's to own.",
		inputSchema: {
			flowId: z.string().describe("Flow id, kebab-case; also the filename"),
			name: z.string().optional().describe('Human title shown on the canvas, e.g. "First launch". Required to create.'),
			steps: z.array(
				z.object({
					page: z.string(),
					label: z.string().optional(),
					next: z.array(z.string()).default([]),
					onError: z.array(z.string()).optional(),
				}),
			),
		},
		async handler(ctx, args: { flowId: string; name?: string; steps: FlowDefinition["steps"] }) {
			// Update-or-create, deliberately. The first shipped version only
			// updated, and an agent asked by its own plan to define flows was
			// refused twice, hand-wrote the files, and guessed the format one
			// field wrong — a red "invalid flow files" banner over otherwise good
			// design work. A missing `name` in an existing file is healed for the
			// same reason: that IS the one field the hand-rolled files got wrong.
			const found = await mutateFlowDefinition(ctx.projectPath, args.flowId, (flow) => {
				flow.steps = args.steps
				if (args.name) flow.name = args.name
				if (!flow.name) flow.name = args.name ?? humanizeFlowId(args.flowId)
			})
			if (!found) {
				if (!args.name) {
					return fail(`No flow "${args.flowId}" exists yet — pass \`name\` to create it.`)
				}
				await writeFlowDefinition(ctx.projectPath, args.flowId, {
					id: args.flowId,
					name: args.name,
					steps: args.steps,
				})
			}
			await recordEdit(ctx.projectPath, { actor: "agent", action: "write", file: `flows/${args.flowId}.flow.json` })
			return reply(ctx, { ok: true, flowId: args.flowId, created: !found })
		},
	},

	{
		name: "install_component",
		title: "Install a catalog component",
		description:
			"Installs an allowlisted component from Caret's curated catalog into .caret/components/catalog/. " +
			"Only catalog ids install — the catalog index (names + use-when) is in the rules files. " +
			"Prefer simply IMPORTING the documented path in your page source: Caret auto-supplies missing catalog " +
			"imports after every write, budget permitting. Call this only when you want the source present before writing.",
		inputSchema: {
			libraryId: z.string().describe("Catalog library id, e.g. 'magicui'"),
			componentId: z.string().describe("Component id within the library, e.g. 'marquee'"),
		},
		async handler(ctx, args: { libraryId: string; componentId: string }) {
			const result = await ctx.installComponent(args.libraryId, args.componentId)
			if (!result.ok) return fail(result.reason ?? "install failed")
			return reply(ctx, {
				ok: true,
				installed: `${args.libraryId}/${args.componentId}`,
				importPath: `../../components/catalog/${args.libraryId}/${args.componentId}`,
				alreadyInstalled: result.alreadyInstalled ?? false,
			})
		},
	},

	{
		name: "run_design_checks",
		title: "Run Caret's deterministic design checks",
		description:
			"Runs the mechanical slop-tell checks on a rendered page (or every page): contrast, identical card rows, " +
			"a border on everything, missing alt text, upscaled images, placeholder boxes, happy-path-only states. " +
			"Call this BEFORE declaring page work finished — Caret runs the same checks itself after its own sessions, " +
			"and a finding you fixed unprompted is a finding the user never sees.",
		inputSchema: { pageId: z.string().optional().describe("A page id, or omit to check every page") },
		async handler(ctx, args: { pageId?: string }) {
			try {
				const results = await ctx.runChecks(args.pageId)
				const findings = results.flatMap((r) => r.findings)
				return reply(ctx, {
					ok: true,
					pages: results.length,
					findings,
					verdict:
						findings.length === 0
							? "clean — no mechanical defects found"
							: `${findings.length} finding(s) — fix the errors before finishing`,
				})
			} catch (err) {
				return fail(err instanceof Error ? err.message : String(err))
			}
		},
	},

	{
		name: "propose_variants",
		title: "Offer variant takes for the user to pick from",
		description:
			"Registers N variant pages you already wrote as takes on one page, so Caret shows them in the playground for a " +
			"side-by-side pick. Write each take first as its own page (id like '<pageId>--v1', meta.variantOf set to the " +
			"original page id, same content shape as the original), then call this. The user picks one in Caret — and can " +
			"branch further rounds from any take there; the chosen take replaces the original page and every take directory " +
			"is cleaned up — the takes belong to the exploration once proposed.",
		inputSchema: {
			pageId: z.string().describe("The original page the takes are variants of"),
			variantIds: z.array(z.string()).min(2).describe("The variant page ids you wrote"),
			instruction: z.string().describe("What the takes explore, in the user's words"),
		},
		async handler(ctx, args: { pageId: string; variantIds: string[]; instruction: string }) {
			try {
				const exploration = await registerExternalRound(ctx.projectPath, args.pageId, args.variantIds, args.instruction)
				return reply(ctx, { ok: true, pageId: exploration.pageId, takes: exploration.nodes.length })
			} catch (err) {
				return fail(err instanceof Error ? err.message : String(err))
			}
		},
	},

	{
		name: "get_params",
		title: "Read an element's resolved style Params",
		description:
			"Resolves every panel property of one element FROM SOURCE: token bindings named as bindings, the responsive " +
			"variant active at the given viewport, inherited/computed origins, and typed refusals where a write cannot " +
			"land. This is the same resolution the property panel shows the user — read it before styling an element so " +
			"your edit speaks the same vocabulary (tokens first, exact values second).",
		inputSchema: {
			pageId: z.string().describe("The page the element lives on"),
			caretId: z.string().describe("The element's data-caret-id"),
			viewportWidth: z.number().optional().describe("Viewport in px for responsive resolution (default 1440)"),
		},
		async handler(ctx, args: { pageId: string; caretId: string; viewportWidth?: number }) {
			try {
				const filePath = path.join(ctx.projectPath, ".caret", "pages", args.pageId, "index.tsx")
				const source = await fs.readFile(filePath, "utf-8")
				const tokens = await readFoundationTokens(ctx.projectPath)
				const params = resolveParamsFor(
					source,
					filePath,
					args.caretId,
					PANEL_PROPERTIES,
					args.viewportWidth ?? 1440,
					tokens,
				)
				if (!params) return fail(`no element with caret-id "${args.caretId}" on page "${args.pageId}"`)
				return reply(ctx, { ok: true, caretId: args.caretId, params })
			} catch (err) {
				return fail(err instanceof Error ? err.message : String(err))
			}
		},
	},

	{
		name: "set_param",
		title: "Set one element's style Param",
		description:
			"Writes `<caretId>/style/<property>` as a minimal source splice — the exact write path the user's own panel " +
			"edits take, undoable on the same stack. Prefer `token` (a foundation token name like 'brand-500') over `raw`; " +
			"a raw value detaches the element from the token system. The edit lands on the responsive variant active at " +
			"the given viewport. A refusal names its cause — respect it rather than editing the file around it.",
		inputSchema: {
			pageId: z.string().describe("The page the element lives on"),
			caretId: z.string().describe("The element's data-caret-id"),
			property: z.string().describe("CSS property (background-color, padding, font-size, ...)"),
			token: z.string().optional().describe("A foundation token name — wins over raw"),
			raw: z.string().optional().describe("An exact CSS value (#0b7aff, 24px)"),
			viewportWidth: z.number().optional().describe("Viewport in px the edit targets (default 1440)"),
		},
		async handler(
			ctx,
			args: { pageId: string; caretId: string; property: string; token?: string; raw?: string; viewportWidth?: number },
		) {
			try {
				if (!args.token && !args.raw) return fail("one of token or raw is required")
				const filePath = path.join(ctx.projectPath, ".caret", "pages", args.pageId, "index.tsx")
				const tokens = await readFoundationTokens(ctx.projectPath)
				await captureUndoStep(ctx.projectPath, `agent set_param: ${args.property} on ${args.caretId}`, "agent")
				const result = await spliceParamEdit(
					filePath,
					args.caretId,
					args.property,
					{ token: args.token, raw: args.raw },
					args.viewportWidth ?? 1440,
					tokens,
				)
				if (!result.ok) return fail(result.refused ?? "the edit was refused")
				void recordEdit(ctx.projectPath, {
					actor: "agent",
					action: "write",
					file: filePath,
					param: `${args.caretId}/style/${args.property}`,
					newValue: args.token ?? args.raw,
				})
				return reply(ctx, { ok: true, param: `${args.caretId}/style/${args.property}`, value: args.token ?? args.raw })
			} catch (err) {
				return fail(err instanceof Error ? err.message : String(err))
			}
		},
	},

	{
		name: "start_sync",
		title: "Start a design → app sync",
		description:
			"Hands YOU the design→app sync worklist: the returned `prompt` is the full task. Carry it out, call report_sync_mapping per design file as you write its app files, and finish with complete_sync. Call it only when the user asks you to sync.",
		inputSchema: {},
		async handler(ctx) {
			// autoFix: an agent has no preflight buttons to click, and the fixes are
			// .caret/-scoped commits Caret would have made for the user anyway.
			const result = await runSync(ctx.projectPath, { audience: "mcp", autoFix: true })
			return reply(ctx, result)
		},
	},

	{
		name: "get_drift",
		title: "Where the app and the design disagree",
		description:
			"Compares content hashes recorded at the last sync against the files on disk, both directions. " +
			"'forward' entries are ordinary design→app syncs waiting to happen; 'app-drift' entries are app files " +
			"someone changed directly since their design was translated — the design layer no longer tells the " +
			"truth about them; 'conflict' means both sides moved and a human must choose. Only mapped files appear: " +
			"the mapping comes from report_sync_mapping calls during past syncs.",
		inputSchema: {},
		async handler(ctx) {
			try {
				const report = await computeDrift(ctx.projectPath)
				return reply(ctx, { ok: true, ...report })
			} catch (err) {
				return fail(err instanceof Error ? err.message : String(err))
			}
		},
	},

	{
		name: "propose_design_update",
		title: "Start an app→design review for a drifted page",
		description:
			"When get_drift shows 'app-drift' or 'conflict' on a page, this starts the reverse half: Caret's agent " +
			"translates the app's current truth back into a PROPOSAL page, and the user reviews it side by side " +
			"against the current design and chooses. Nothing is written to the design without that choice — " +
			"never write .caret/ pages yourself to 'fix' drift.",
		inputSchema: {
			designPath: z.string().describe("The drifted design file, e.g. .caret/pages/checkout/index.tsx"),
		},
		async handler(ctx, args: { designPath: string }) {
			try {
				const result = await startReverseSyncProposal(ctx.projectPath, args.designPath)
				return result.ok
					? reply(ctx, { ok: true, proposalId: result.proposalId })
					: fail(result.reason ?? "could not start the review")
			} catch (err) {
				return fail(err instanceof Error ? err.message : String(err))
			}
		},
	},

	{
		name: "report_sync_mapping",
		title: "Record which app files a design file translated into",
		description:
			"Call this DURING a design→app sync, once per design file, at the moment its app files are written — " +
			"you know the correspondence right now, and Caret cannot infer it later. The mapping powers drift " +
			"detection and incremental sync: skip it and the next sync re-reports everything you just did, and " +
			"app-side edits to these files become invisible to the design layer. Report every app file the design " +
			"file's content landed in (a page split across a route and extracted components lists them all).",
		inputSchema: {
			mappings: z
				.array(
					z.object({
						designPath: z.string().describe("The design file you translated, e.g. .caret/pages/checkout/index.tsx"),
						appPaths: z.array(z.string()).min(1).describe("Every app file its content landed in"),
					}),
				)
				.min(1),
		},
		async handler(ctx, args: { mappings: Array<{ designPath: string; appPaths: string[] }> }) {
			try {
				const head = await getLatestGitCommitHash(ctx.projectPath)
				const result = await recordMappings(ctx.projectPath, args.mappings, head)
				return reply(ctx, {
					ok: result.refused.length === 0,
					recorded: result.recorded,
					...(result.refused.length > 0 ? { refused: result.refused } : {}),
				})
			} catch (err) {
				return fail(err instanceof Error ? err.message : String(err))
			}
		},
	},

	{
		name: "complete_sync",
		title: "Record a sync as done",
		description:
			"Call this when you have finished a design→app sync, with the syncId you were given. This is the only thing that advances Caret's sync bookmark — skip it and the next sync will re-report everything you just did.",
		inputSchema: { syncId: z.string().describe("The syncId from the sync prompt") },
		async handler(ctx, { syncId }: { syncId: string }) {
			const outcome = await completeSync(ctx.projectPath, syncId)
			if (outcome === "advanced" || outcome === "already-applied") {
				return reply(ctx, { ok: true, outcome })
			}
			return fail(`Could not record the sync (${outcome}).`)
		},
	},
]

function summarisePage(page: PageMeta) {
	return {
		id: page.id,
		title: page.title,
		type: page.type ?? "page",
		states: page.states ?? [],
		tags: page.tags ?? [],
		source: `.caret/pages/${page.id}/index.tsx`,
	}
}

/** `daily-logging` → `Daily logging`, for a healed flow whose name was never given. */
function humanizeFlowId(flowId: string): string {
	const words = flowId.replace(/[-_]+/g, " ").trim()
	return words.charAt(0).toUpperCase() + words.slice(1)
}

function summariseFlow(flow: FlowDefinition) {
	return flow.invalid
		? { id: flow.id, invalid: true, error: flow.error }
		: {
				id: flow.id,
				name: flow.name ?? flow.id,
				description: flow.description,
				steps: (flow.steps ?? []).map((s) => ({ page: s.page, label: s.label, next: s.next ?? [], onError: s.onError })),
			}
}

async function exists(target: string): Promise<boolean> {
	try {
		await fs.access(target)
		return true
	} catch {
		return false
	}
}

/** Page ids in this design layer, for naming the alternatives in a refusal. */
async function listPageIds(projectPath: string): Promise<string[]> {
	const dir = resolveInCaret(projectPath, "pages")
	if (!dir) return []
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true })
		return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
	} catch {
		return []
	}
}

export function logToolError(name: string, err: unknown): ToolResult {
	Logger.error(`[mcp] tool ${name} failed:`, err)
	return fail(err instanceof Error ? err.message : String(err))
}
