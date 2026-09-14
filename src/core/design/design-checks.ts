/**
 * The deterministic acceptance checker — Caret-run, never an agent
 * honor-system self-check.
 *
 * An agent that must *choose* to self-check will not (the pull-only
 * `get_guide` failure mode, again), so Caret computes the documented slop
 * tells on the RENDERED page itself: contrast, identical card rows, a border
 * on everything, missing alt text, images stretched past their pixels, grey
 * placeholder boxes, and happy-path-only state declarations. Every check is
 * mechanical — a judgment call would produce confident false findings, and a
 * checker that cries wolf gets its feedback loop turned off.
 *
 * The check list is versioned WITH the design (`.caret/checks.json`): which
 * tells this project cares about is a design decision, reviewable in a PR,
 * and extensible as captured corrections harden into rules.
 *
 * This module is host-free: the DOM script is a string a host evaluates in a
 * rendered page (the desktop app uses its isolated screenshot window), and
 * everything else is pure.
 */
import * as fs from "fs/promises"
import * as path from "path"

import { runExclusive, writeFileAtomic } from "./file-mutation-queue"
import type { PageMeta } from "./types"

export type CheckSeverity = "error" | "warn" | "info"

export interface CheckFinding {
	/** Which check fired — a key in `checks.json`. */
	check: string
	severity: CheckSeverity
	message: string
	pageId: string
}

export interface PageCheckResult {
	pageId: string
	findings: CheckFinding[]
	at: string
}

export interface ChecksResults {
	version: 1
	pages: PageCheckResult[]
}

/** Every built-in check, with the one-line reason it exists. Seeded into `checks.json`. */
export const BUILTIN_CHECKS: Record<string, string> = {
	contrast: "text the reader cannot read is not a style choice (WCAG AA, computed by axe-core)",
	"identical-cards": "three cards with the same words is generated filler, not content",
	"border-on-everything": "outlining every box is the tell of a page that outlines instead of composes",
	"missing-alt": "an image with no alt text ships an accessibility bug",
	"image-upscaled": "an image stretched past its pixels reads soft on every real screen",
	"placeholder-box": "an empty grey rectangle where an asset belongs is the exact failure the asset library exists to end",
	"missing-states": "a page that declares only its happy path has not been designed, only sketched",
	"restraint-budget": "one signature move per page — a second showpiece component is how premium libraries become slop",
	"catalog-unknown": "an import that looks like a catalog path but names nothing in the catalog will never resolve",
	"page-error": "a page that fails to compile or crashes on load shows an error card, not a design",
	"tailwind-setup": "Tailwind is loaded once by the shell — a second import or a config file breaks the build or misleads it",
}

export const CHECKS_CONFIG_FILE = "checks.json"
export const CHECKS_RESULTS_FILE = ".checks-results.json"

export interface ChecksConfig {
	version: 1
	/** check id → enabled. Absent ids default to enabled. */
	checks: Record<string, boolean>
}

export async function readChecksConfig(workspacePath: string): Promise<ChecksConfig> {
	try {
		const raw = JSON.parse(await fs.readFile(path.join(workspacePath, ".caret", CHECKS_CONFIG_FILE), "utf-8"))
		return { version: 1, checks: raw?.checks && typeof raw.checks === "object" ? raw.checks : {} }
	} catch {
		return { version: 1, checks: {} }
	}
}

export function checkEnabled(config: ChecksConfig, check: string): boolean {
	return config.checks[check] !== false
}

/** The seed for `.caret/checks.json` — the list itself is design content. */
export function defaultChecksConfigJson(): string {
	return JSON.stringify(
		{
			version: 1,
			$comment:
				"Caret's deterministic design checks, run on every rendered page after an agent writes one. Set a check to false to disable it for this project. This file is versioned with the design — disabling a check is a design decision.",
			checks: Object.fromEntries(Object.keys(BUILTIN_CHECKS).map((id) => [id, true])),
			descriptions: BUILTIN_CHECKS,
		},
		null,
		2,
	)
}

/**
 * The DOM half, as a script a host evaluates in the rendered page. Returns
 * `Array<{ check, severity, message }>`. Self-contained on purpose: it runs in
 * a page Caret does not control the code of.
 */
export const DESIGN_CHECKS_DOM_SCRIPT = `(() => {
	const findings = []
	const push = (check, severity, message) => {
		if (findings.filter((f) => f.check === check).length < 5) findings.push({ check, severity, message })
	}

	// Identical card rows: siblings that repeat the same substantial text.
	for (const el of document.querySelectorAll("*")) {
		if (el.children.length < 3) continue
		const texts = Array.from(el.children)
			.map((c) => ((c instanceof HTMLElement ? c.innerText : c.textContent) || "").trim())
			.filter((t) => t.length > 24)
		const seen = new Set()
		for (const t of texts) {
			if (seen.has(t)) {
				push("identical-cards", "warn", 'sibling cards repeat the same text ("' + t.slice(0, 48) + '…")')
				break
			}
			seen.add(t)
		}
	}

	// A border on everything.
	let bordered = 0
	let boxes = 0
	for (const el of document.querySelectorAll("div,section,article,li")) {
		const r = el.getBoundingClientRect()
		if (r.width < 48 || r.height < 48) continue
		const cs = getComputedStyle(el)
		boxes++
		if (cs.borderTopStyle !== "none" && parseFloat(cs.borderTopWidth) > 0 && parseFloat(cs.borderBottomWidth) > 0) bordered++
	}
	if (boxes >= 8 && bordered / boxes > 0.6) {
		push("border-on-everything", "warn", bordered + " of " + boxes + " boxes draw a border — compose with space and surface instead")
	}

	// Images: alt text and upscaling.
	let noAlt = 0
	for (const img of document.images) {
		if (!img.hasAttribute("alt")) noAlt++
		if (img.naturalWidth > 0) {
			const r = img.getBoundingClientRect()
			if (r.width >= 48 && r.width / img.naturalWidth > 1.5) {
				push(
					"image-upscaled",
					"error",
					"an image is stretched " + (r.width / img.naturalWidth).toFixed(1) + "x past its pixels (" + img.naturalWidth + "px drawn at " + Math.round(r.width) + "px)",
				)
			}
		}
	}
	if (noAlt > 0) push("missing-alt", "error", noAlt + " image(s) have no alt attribute")

	// Grey placeholder boxes where content belongs.
	for (const el of document.querySelectorAll("div")) {
		const r = el.getBoundingClientRect()
		if (r.width < 120 || r.height < 80) continue
		if (el.children.length > 0 || (el.textContent || "").trim() !== "") continue
		const cs = getComputedStyle(el)
		if (cs.backgroundImage !== "none") continue
		const m = cs.backgroundColor.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/)
		if (!m) continue
		const [red, green, blue] = [Number(m[1]), Number(m[2]), Number(m[3])]
		const grey = Math.abs(red - green) < 14 && Math.abs(green - blue) < 14 && red > 120 && red < 235
		if (grey) {
			push("placeholder-box", "error", "an empty " + Math.round(r.width) + "x" + Math.round(r.height) + " grey box — a placeholder where content (likely an image) belongs")
		}
	}

	return findings
})()`

/**
 * The metadata half — computable without a render. A page that declares only
 * `default` has only its happy path; info-level, surfaced but never fed back.
 */
export function metaFindings(meta: PageMeta): CheckFinding[] {
	const states = (meta.states ?? []).filter((s) => s !== "default")
	if (states.length === 0) {
		return [
			{
				check: "missing-states",
				severity: "info",
				message: "only the happy path is declared — no loading, empty or error state",
				pageId: meta.id,
			},
		]
	}
	return []
}

/**
 * Source-level Tailwind setup tells, computable with the renderer down.
 *
 * The shell loads Tailwind v4 exactly once, from `global.css`; the theme comes
 * from the foundation. A second `@import "tailwindcss"` in any stylesheet
 * breaks the build, and a `tailwind.config.*` file has no effect in v4 — its
 * presence means whoever wrote it believes the setup works differently than it
 * does, and the next edit made under that belief fails too.
 */
export function tailwindFindings(
	pageId: string,
	cssFiles: Array<{ file: string; content: string }>,
	configFiles: string[],
): CheckFinding[] {
	const findings: CheckFinding[] = []
	for (const { file, content } of cssFiles) {
		if (/@import\s+["']tailwindcss/.test(content)) {
			findings.push({
				check: "tailwind-setup",
				severity: "error",
				message: `${file} imports Tailwind a second time — the shell already loads it once in global.css; remove the import`,
				pageId,
			})
		}
	}
	for (const file of configFiles) {
		findings.push({
			check: "tailwind-setup",
			severity: "error",
			message: `${file} has no effect — Tailwind v4 takes no config file here; delete it (the theme comes from the foundation via caret-theme.css)`,
			pageId,
		})
	}
	return findings
}

/** `.caret/pages/<id>/…` files out of a turn's change list → distinct page ids, variant takes excluded. */
export function pageIdsFromFiles(files: string[]): string[] {
	const ids = new Set<string>()
	for (const file of files) {
		const normalised = file.split(path.sep).join("/")
		const match = /\.caret\/pages\/([^/]+)\//.exec(normalised)
		if (match && !/--v\d+$/.test(match[1])) ids.add(match[1])
	}
	return [...ids]
}

export function filterByConfig(findings: CheckFinding[], config: ChecksConfig): CheckFinding[] {
	return findings.filter((f) => checkEnabled(config, f.check))
}

/**
 * Whether a session's findings warrant a feedback turn. Only errors — feeding
 * back style warnings would send a model turn per session for judgement calls,
 * and a checker that nags gets turned off.
 */
export function shouldFeedBack(findings: CheckFinding[]): boolean {
	return findings.some((f) => f.severity === "error")
}

/** The feedback message Caret sends into the session that wrote the pages. */
export function formatFeedback(findings: CheckFinding[]): string {
	const errors = findings.filter((f) => f.severity === "error")
	const lines = errors.map((f) => `- [${f.pageId}] ${f.message} (${f.check})`)
	return `Caret ran its deterministic design checks on the pages you just wrote and found ${errors.length} problem${
		errors.length === 1 ? "" : "s"
	} that must be fixed:

${lines.join("\n")}

Fix these in the same pages now. These are mechanical checks, not taste: every one names a real defect.`
}

// ---------------------------------------------------------------------------
// Results persistence — scratch the canvas reads, not design content.
// ---------------------------------------------------------------------------

function resultsPath(workspacePath: string): string {
	return path.join(workspacePath, ".caret", CHECKS_RESULTS_FILE)
}

export async function readChecksResults(workspacePath: string): Promise<ChecksResults> {
	try {
		const raw = JSON.parse(await fs.readFile(resultsPath(workspacePath), "utf-8"))
		return { version: 1, pages: Array.isArray(raw?.pages) ? raw.pages : [] }
	} catch {
		return { version: 1, pages: [] }
	}
}

/**
 * Replaces the stored result for the pages just checked, keeping the others.
 * When `livePageIds` is given, entries for pages that no longer exist are
 * dropped — a finding pointing at a deleted page is a ghost the canvas would
 * show forever.
 */
export async function storeChecksResults(
	workspacePath: string,
	results: PageCheckResult[],
	livePageIds?: string[],
): Promise<void> {
	const target = resultsPath(workspacePath)
	await runExclusive(target, async () => {
		const current = await readChecksResults(workspacePath)
		const replaced = new Set(results.map((r) => r.pageId))
		const live = livePageIds ? new Set(livePageIds) : null
		const pages = [...current.pages.filter((p) => !replaced.has(p.pageId) && (!live || live.has(p.pageId))), ...results]
		await writeFileAtomic(target, JSON.stringify({ version: 1, pages }, null, 2))
	})
}
