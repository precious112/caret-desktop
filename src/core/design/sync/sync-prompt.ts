import { readFile } from "fs/promises"
import { join } from "path"

import type { DesignChangedFile, DesignChangeStatus } from "@/utils/git"
import { readAssetIndex } from "../assets"
import { listFlows } from "../flow-meta"
import { listPages } from "../page-meta"
import { readFoundationTokens } from "../tokens"

/**
 * The ledger's cap when injected into the prompt. The file is model-written and
 * could bloat over many syncs; past this, the head carries the stack decisions
 * (written first) and the model can read the file itself for the tail.
 */
const SYNC_NOTES_PROMPT_CAP = 6_000

/** The decisions-and-stubs ledger from earlier syncs, or null before the first apply. */
async function readSyncNotes(workspacePath: string): Promise<string | null> {
	try {
		const raw = await readFile(join(workspacePath, ".caret", "sync-notes.md"), "utf-8")
		const trimmed = raw.trim()
		if (trimmed === "") return null
		return trimmed.length > SYNC_NOTES_PROMPT_CAP
			? `${trimmed.slice(0, SYNC_NOTES_PROMPT_CAP)}\n… (truncated — read .caret/sync-notes.md for the rest)`
			: trimmed
	} catch {
		return null
	}
}

export interface SyncPromptInput {
	/** Net cumulative changed design files since the last sync (no file content). */
	changedFiles: DesignChangedFile[]
	/** True when there is no prior bookmark — the whole design layer is new. */
	isFirstSync: boolean
	/** Commit-subject narrative — context only, may list superseded changes. */
	intentLog?: string
	/** Caret's id for this sync, which an external agent echoes back via `complete_sync`. */
	syncId: string
	/**
	 * Who is being asked.
	 *
	 * `backend` is the agent Caret drives: it is in a read-only plan session, it
	 * has no Caret tools, and Caret advances the bookmark itself once the user
	 * accepts and the apply finishes. `mcp` is an external agent in the user's own
	 * terminal, which has to be told to call `complete_sync` because Caret cannot
	 * observe when it is done.
	 */
	audience?: "backend" | "mcp"
}

/**
 * Builds the design inventory block — metadata only, never full page source.
 * The AI reads the specific page `index.tsx` files it needs on demand.
 */
async function buildInventory(workspacePath: string): Promise<string> {
	const [allPages, flows, tokens, assets] = await Promise.all([
		listPages(workspacePath),
		listFlows(workspacePath),
		readFoundationTokens(workspacePath),
		readAssetIndex(workspacePath).catch(() => ({ version: 1 as const, assets: [] })),
	])

	// Variant takes never sync: they are transient working copies of a pick in
	// progress, and their dirs are gitignored so the worklist can't see them
	// either — this keeps the inventory consistent with that.
	const pages = allPages.filter((p) => !p.variantOf)

	// All of this is AI-generated/edited and may be missing fields — stay defensive
	// so the sync prompt never crashes on an incomplete meta.json / flow / tokens file.
	const pageLines =
		pages.length === 0
			? "(none)"
			: pages
					.map(
						(p) =>
							` ${p.id} [${p.type ?? "page"}] — "${p.title ?? p.id}" · states: ${(p.states ?? []).join(", ") || "—"}`,
					)
					.join("\n")

	const flowLines =
		flows.length === 0
			? "(none)"
			: flows
					.map((f) => {
						const chain = (f.steps ?? [])
							.map((s) => s?.page)
							.filter(Boolean)
							.join(" → ")
						return ` ${f.id} (${f.name ?? f.id}): ${chain}`
					})
					.join("\n")

	const tokenLine = tokens
		? `brand ${tokens.color?.brand?.seed ?? "—"} · font ${tokens.typography?.fontFamily ?? "—"} · radius ${tokens.radius?.character ?? "—"} · spacing ${tokens.spacing?.baseUnit ?? "—"}px` +
			` (read .caret/tokens/foundation.json for full scales)`
		: "(no foundation tokens configured)"

	// Assets are the one part of the design layer that does not translate as code.
	// A page referencing /caret-assets/x.png syncs into an app that has no such
	// path, and the result is a broken image rather than a compile error — so the
	// copy has to be spelled out rather than left implied by the page source.
	const assetLines =
		assets.assets.length === 0
			? "(none)"
			: assets.assets
					.map((a) => ` ${a.file} → referenced as /caret-assets/${a.file}${a.alt ? ` · alt: "${a.alt}"` : ""}`)
					.join("\n")

	return [
		"DESIGN INVENTORY (metadata only — read page sources on demand)",
		`PAGES (${pages.length}):`,
		pageLines,
		`FLOWS (${flows.length}):`,
		flowLines,
		`TOKENS: ${tokenLine}`,
		`ASSETS (${assets.assets.length}) — in .caret/assets/:`,
		assetLines,
		assets.assets.length > 0
			? "Copy every asset a synced page uses into the app's own static/public directory and rewrite the path to match. Carry the alt text across. Do not hotlink /caret-assets/ — that path only exists inside Caret's preview."
			: "",
	]
		.filter(Boolean)
		.join("\n")
}

/** Derive a page id from a `.caret/pages/<id>/...` path, or null if not a page file. */
function pageIdFromPath(path: string): string | null {
	const segments = path.split("/")
	if (segments[0] === ".caret" && segments[1] === "pages" && segments.length >= 3) {
		return segments[2]
	}
	return null
}

function statusLabel(statuses: Set<DesignChangeStatus>): string {
	return [...statuses].join(", ")
}

/**
 * Renders the net-changed worklist: changed pages (by id) and changed shared
 * design (components/tokens/layouts/flows). No file content — just the list of
 * what to read and reconcile.
 */
function buildWorklist(changedFiles: DesignChangedFile[], isFirstSync: boolean): string {
	if (changedFiles.length === 0) {
		return isFirstSync
			? "CHANGED DESIGN FILES: first sync — treat the ENTIRE current design layer (see inventory below) as new and reconcile every page into the app."
			: "CHANGED DESIGN FILES: none detected at file level — reconcile the full current design state against the app."
	}

	// Aggregate page files by id; everything else is shared design.
	const pageStatuses = new Map<string, Set<DesignChangeStatus>>()
	const shared: DesignChangedFile[] = []
	for (const file of changedFiles) {
		const id = pageIdFromPath(file.path)
		if (id) {
			const set = pageStatuses.get(id) ?? new Set<DesignChangeStatus>()
			set.add(file.status)
			pageStatuses.set(id, set)
		} else {
			shared.push(file)
		}
	}

	const lines: string[] = [
		"CHANGED DESIGN FILES TO RECONCILE (net changes since last sync — read each current source, do not assume from this list):",
	]
	if (isFirstSync) {
		lines.push("(First sync — every file below is new.)")
	}

	if (pageStatuses.size > 0) {
		lines.push("", "Pages — read .caret/pages/<id>/index.tsx and reconcile the matching app page:")
		for (const [id, statuses] of pageStatuses) {
			const deleted = statuses.has("deleted") && statuses.size === 1
			const note = deleted ? " — page removed from the design; remove it from the app" : ""
			lines.push(` - ${id} (${statusLabel(statuses)})${note}`)
		}
	}

	if (shared.length > 0) {
		lines.push(
			"",
			"Shared design (components / tokens / layouts / flows) — read each and reconcile EVERY page/app area that uses it:",
		)
		for (const file of shared) {
			lines.push(` - ${file.path} (${file.status})`)
		}
	}

	return lines.join("\n")
}

/**
 * Assembles the full sync task prompt: instruction header + changed-files worklist
 * + (optional) commit-intent hint + design inventory. Contains NO file/diff content
 * — the AI reads the current `.caret/` and app sources itself and infers the changes.
 * Fed into a plan-mode `initTask`.
 */
export async function buildSyncPrompt(workspacePath: string, input: SyncPromptInput): Promise<string> {
	const [inventory, syncNotes] = await Promise.all([buildInventory(workspacePath), readSyncNotes(workspacePath)])
	const worklist = buildWorklist(input.changedFiles, input.isFirstSync)

	const header = `<explicit_instructions type="sync">
You are syncing the DESIGN layer (.caret/) into the APPLICATION layer (the user's shipped app).

AUTHORITY IS SPLIT, AND EACH LAYER OWNS ITS HALF. The .caret/ design files are the SINGLE SOURCE OF TRUTH for how the app looks and flows: layout, styling, copy, navigation, which states exist. The APPLICATION is the source of truth for how things actually work: where data really comes from, API wiring, validation, auth — everything the design cannot know. When one file carries both (most pages do), apply the design's changes to the presentation and KEEP the app's wiring exactly as you found it — a hand-written fetch call, store, or handler survives a sync even where the design shows sample data, because the sample data was only ever a stand-in. When the two genuinely conflict (the design shows a field the app's data does not carry), do not silently pick a winner: name the conflict and your recommendation in your reply.

Below is ONLY the list of design files that changed since the last sync — NOT their contents. For EACH item you MUST:
  1. READ the current .caret/ source in full (the desired state) — e.g. .caret/pages/<id>/index.tsx plus any shared components/tokens it imports.
  2. READ the corresponding current application source.
  3. Compare them yourself and infer + apply the changes that make the app match the design. Cover UI translation AND any business-logic, state, routing, API, or data-shape changes the design implies — a small design change can imply large app work.

Always reconcile against the CURRENT file contents — never apply a remembered or precomputed diff. A file may have changed many times since the last sync; only its current state matters. If the design needs something the current architecture can't support without a refactor, say so honestly rather than forcing a half-baked patch.

The \`data-caret-id\` attributes in the design sources are Caret's visual-editor tooling metadata (they make inline editing of the .caret/ design UIs deterministic). They have NO meaning in the shipped app — do NOT copy them into the application code. Omit them entirely when translating; carry over only real UI, content, and behavior.

TOKEN TRANSLATION. Design pages style with theme tokens that exist ONLY inside .caret/ — the brand scale (\`bg-brand-500\`), the foundation's \`neutral-*\`, the semantic colours (\`text-success\` …), \`font-display\`, and foundation-driven \`text-*\`/\`rounded-*\` steps. They are defined in \`.caret/caret-theme.css\` (generated from foundation.json), which the app does not load. When translating, resolve each token by this policy:
  1. If the app has its own design system (its own Tailwind theme, CSS variables, or token file), map onto the app's EQUIVALENT token — read the app's theme first; \`brand-500\` means "the brand colour at mid strength", not a hex to copy blindly.
  2. If the app has no equivalent, carry the definitions across: copy the needed entries from .caret/caret-theme.css into the app's global stylesheet (as \`@theme\` entries if the app is on Tailwind v4, else as CSS variables or resolved values), so the classes you write actually resolve.
Never ship a class that resolves to nothing — a \`bg-brand-500\` in an app whose Tailwind has no \`brand\` scale generates NO CSS and fails silently. After translating, verify every custom class you carried over is defined somewhere the app loads.

PAGE COVERAGE. You cannot invent the user's business layer — you do not know their endpoints, their auth, or their rules — so track it instead of guessing. For EVERY page you reconcile, decide what it needs beyond UI (a data source, actions, auth) and which bucket it is in:
  - SPECIFIED: the user has said how it works, or the app already carries real wiring for it. Use that, exactly.
  - STUB: nothing specifies it. Build a working local placeholder (in-memory or local storage, seeded with the design's sample data) — never a broken screen, and never an invented API call.
Keep the ledger at .caret/sync-notes.md up to date whenever you apply changes: a short markdown file recording the stack decisions made and, per page, what is real and what is stubbed — with one line on what making it real would take. When earlier notes appear below, honor the decisions recorded there instead of re-deciding them, and update any entry your changes make stale. The file is the user's map of what is still fake, and the next sync's memory.

Completion criteria: every changed page and shared item listed below is reflected in the app, verified against its current design source.

${
	input.audience === "backend"
		? `RIGHT NOW YOU ARE PLANNING, NOT CHANGING ANYTHING. Read whatever you need and write the plan
as your reply: which app files you would change, and what each change is. Do not edit a single
application file in this turn — the user reviews the plan first, and any write you attempt will be
refused. If they accept, you will be asked to carry it out. The user may reply with revisions;
answer each with the complete updated plan, restated in full — your latest reply IS the plan.

Shape the plan so ONE reply can settle it. Open with the questions that need the user's word —
BATCHED (pages sharing an answer share one question), numbered, each with a default marked — then
the coverage: one line per page with unmet needs naming its bucket, and the rest collapsed to a
single line ("N pages are display-only"). Never interrogate page by page. If the user accepts the
plan without answering, the marked defaults apply — the plan must say so.

Do NOT edit .caret/sync-state.json. Caret records the sync itself once the changes are applied.`
		: `As you translate, call \`report_sync_mapping\` on the Caret MCP server once per design file, at the moment its app files are written — you know which app files a design file's content landed in right now, and Caret cannot infer it later. The mapping is what makes the NEXT sync incremental and app-side drift visible; skip it and both are lost.

When you are done, call the \`complete_sync\` tool on the Caret MCP server with syncId "${input.syncId}". That is the ONLY way to record the sync. Do NOT edit .caret/sync-state.json by hand — Caret owns that file, and writing it yourself will be overwritten.`
}
</explicit_instructions>`

	const sections = [header, "", "─".repeat(60), worklist]

	// Injected rather than left for the model to discover: the ledger is what
	// keeps sync N+1 consistent with the decisions of sync N, and a fresh
	// session reliably reads what is in its prompt and only sometimes goes
	// looking for what isn't.
	if (syncNotes) {
		sections.push(
			"",
			"─".repeat(60),
			[
				"SYNC NOTES FROM EARLIER SYNCS (.caret/sync-notes.md — the decisions already made and the current real-vs-stub ledger; honor these instead of re-deciding, and update the file as part of applying):",
				syncNotes,
			].join("\n"),
		)
	}

	if (input.intentLog) {
		sections.push(
			"",
			"─".repeat(60),
			[
				"DESIGN COMMITS SINCE LAST SYNC (context only — this history may list changes that were later superseded; the CURRENT files above are authoritative, not this log):",
				input.intentLog,
			].join("\n"),
		)
	}

	sections.push("", "─".repeat(60), inventory)
	return sections.join("\n")
}
