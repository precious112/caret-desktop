/**
 * The acceptance checker's host half: render each page in a hidden window,
 * run axe-core's contrast audit plus the DOM slop-tell script, and drive the
 * enforcement loop — after every backend session that wrote pages, the checks
 * run, the results land where the canvas can show them, and errors are fed
 * back into the very session that produced them, once.
 */
import { createRequire } from "node:module"
import { BrowserWindow } from "electron"
import * as fs from "fs/promises"

import * as path from "path"

import {
	type AgentConversation,
	type CheckFinding,
	catalogFindings,
	DESIGN_CHECKS_DOM_SCRIPT,
	filterByConfig,
	formatFeedback,
	listPages,
	metaFindings,
	type PageCheckResult,
	pageIdsFromFiles,
	type RunOutcome,
	type RunRequest,
	readCatalogLock,
	readChecksConfig,
	shouldFeedBack,
	storeChecksResults,
	tailwindFindings,
} from "../../src/core/design"
import { Logger } from "../../src/shared/services/Logger"
import { settleScript } from "./page-settle"

/** axe-core's minified source, read once — injected into each rendered page. */
let axeSource: string | null = null
async function loadAxe(): Promise<string> {
	if (axeSource) return axeSource
	const require = createRequire(import.meta.url)
	axeSource = await fs.readFile(require.resolve("axe-core/axe.min.js"), "utf-8")
	return axeSource
}

export interface DesignChecksOptions {
	projectPath: string
	/** The design preview's base URL, or null while Vite is still starting. */
	baseUrl(): string | null
	/** Tells the renderer/canvas results changed (the results file also HMRs the canvas). */
	onResults?(results: PageCheckResult[]): void
}

export class DesignChecksService {
	/** Activities already fed back into — one feedback turn per activity, ever. */
	private fedActivities = new Set<string>()
	private closed = false

	constructor(private readonly options: DesignChecksOptions) {}

	close(): void {
		this.closed = true
	}

	/**
	 * The enforcement hook, wired to `ConversationDeps.onTurnComplete`. Fires
	 * the checker when the turn wrote design pages, and feeds error findings
	 * back into the session — once per activity, so a model that cannot fix
	 * them does not loop forever.
	 */
	afterTurn(conversation: AgentConversation, outcome: RunOutcome, request: RunRequest): void {
		if (this.closed) return
		const pageIds = pageIdsFromFiles(outcome.filesChanged)
		if (pageIds.length === 0) return

		void (async () => {
			try {
				const results = await this.run(pageIds)
				const findings = results.flatMap((r) => r.findings)
				if (!shouldFeedBack(findings)) return

				const activity = conversation.getState().activity
				const activityId = activity?.id ?? `session-${outcome.sessionId}`
				if (this.fedActivities.has(activityId)) {
					Logger.info(`[checks] ${findings.length} finding(s) remain after feedback — surfacing on the canvas only`)
					return
				}
				// The turn that carried the feedback must not re-trigger it.
				if (request.note === FEEDBACK_NOTE) return
				this.fedActivities.add(activityId)

				Logger.info(
					`[checks] feeding ${findings.filter((f) => f.severity === "error").length} error(s) back into the session`,
				)
				await conversation.run({
					kind: activity?.kind ?? "chat",
					title: activity?.title ?? "Design checks",
					mode: "write",
					prompt: formatFeedback(findings),
					displayPrompt: "Design checks found problems in what was just written — asking the agent to fix them.",
					resumeSessionId: activity?.sessionId || outcome.sessionId || undefined,
					note: FEEDBACK_NOTE,
				})
			} catch (err) {
				Logger.warn(`[checks] post-session check failed: ${err}`)
			}
		})()
	}

	/** Runs the checks on the named pages (or every page), stores and returns results. */
	async run(pageIds?: string[]): Promise<PageCheckResult[]> {
		const config = await readChecksConfig(this.options.projectPath)
		const pages = (await listPages(this.options.projectPath)).filter((p) => !p.variantOf)
		const targets = pageIds ? pages.filter((p) => pageIds.includes(p.id)) : pages

		const results: PageCheckResult[] = []
		const rendererUp = this.options.baseUrl() !== null
		const lock = await readCatalogLock(this.options.projectPath)
		// A stray tailwind.config.* affects the whole layer, not one page —
		// reported once, on the first page checked, or it becomes a chorus.
		const tailwindConfigs = await this.tailwindConfigFiles()
		let configsReported = false
		for (const page of targets) {
			const findings: CheckFinding[] = [...metaFindings(page)]
			// Catalog restraint findings are computed from SOURCE — a budget breach
			// must flag even when the renderer is down.
			const pageSource = await fs
				.readFile(path.join(this.options.projectPath, ".caret", "pages", page.id, "index.tsx"), "utf-8")
				.catch(() => "")
			if (pageSource) findings.push(...catalogFindings(pageSource, page.id, lock))
			findings.push(...tailwindFindings(page.id, await this.pageCssFiles(page.id), configsReported ? [] : tailwindConfigs))
			configsReported = true
			if (rendererUp) {
				const rendered = await this.checkRendered(page.id).catch((err) => {
					Logger.warn(`[checks] could not render ${page.id}: ${err}`)
					return [] as CheckFinding[]
				})
				findings.push(...rendered)
			} else {
				// Saying so beats a silent half-answer: a clean result that only ran
				// the metadata checks would read as "the page renders fine".
				findings.push({
					check: "render-unavailable",
					severity: "info",
					message: "the design preview is still starting — only the metadata checks ran; run again shortly",
					pageId: page.id,
				})
			}
			results.push({ pageId: page.id, findings: filterByConfig(findings, config), at: new Date().toISOString() })
		}

		await storeChecksResults(
			this.options.projectPath,
			results,
			pages.map((p) => p.id),
		)
		this.options.onResults?.(results)
		return results
	}

	/** `tailwind.config.*` files at the design layer's root — none should exist. */
	private async tailwindConfigFiles(): Promise<string[]> {
		const caretDir = path.join(this.options.projectPath, ".caret")
		const entries = await fs.readdir(caretDir).catch(() => [] as string[])
		return entries.filter((name) => /^tailwind\.config\.[cm]?[jt]s$/.test(name)).map((name) => `.caret/${name}`)
	}

	/** The stylesheets inside one page's directory, path + content. */
	private async pageCssFiles(pageId: string): Promise<Array<{ file: string; content: string }>> {
		const dir = path.join(this.options.projectPath, ".caret", "pages", pageId)
		const entries = await fs.readdir(dir, { recursive: true }).catch(() => [] as string[])
		const files: Array<{ file: string; content: string }> = []
		for (const entry of entries) {
			if (typeof entry !== "string" || !entry.endsWith(".css")) continue
			const content = await fs.readFile(path.join(dir, entry), "utf-8").catch(() => "")
			if (content) files.push({ file: `pages/${pageId}/${entry.split(path.sep).join("/")}`, content })
		}
		return files
	}

	/** One page: isolated render, axe contrast audit, DOM slop-tell script. */
	private async checkRendered(pageId: string): Promise<CheckFinding[]> {
		const base = this.options.baseUrl()
		if (!base) return []

		// The whole render is DEADLINED. A page whose module graph never settles
		// (an unresolvable import leaves the dev server holding the request) hangs
		// loadURL forever, and an unbounded await here wedged run_design_checks,
		// the MCP reply carrying it, and three full certification runs in a row.
		// A hang is reported the same way a down server is: honestly.
		try {
			return await Promise.race([
				this.renderAndAudit(pageId, base),
				new Promise<CheckFinding[]>((resolve) =>
					setTimeout(
						() =>
							resolve([
								{
									// An error, not an info: the usual cause is an import the
									// dev server cannot resolve, which is the page author's to
									// fix — and only errors are fed back into the session.
									check: "page-error",
									severity: "error",
									message:
										"the page render did not settle within 20s — usually an import the dev server cannot resolve; verify every import in the page resolves (and its package is installed) and run the checks again",
									pageId,
								},
							]),
						20_000,
					),
				),
			])
		} finally {
			// Whichever branch won, no isolated window may outlive the check.
			for (const window of BrowserWindow.getAllWindows()) {
				if (
					!window.isDestroyed() &&
					window.webContents.getURL().includes(`page=${encodeURIComponent(pageId)}&isolated=1`)
				) {
					window.destroy()
				}
			}
		}
	}

	private async renderAndAudit(pageId: string, base: string): Promise<CheckFinding[]> {
		const window = new BrowserWindow({
			show: false,
			width: 1440,
			height: 900,
			paintWhenInitiallyHidden: true,
			// backgroundThrottling off: the settle waits on rAF, and Chromium
			// parks rAF in hidden windows — same as every capture window.
			webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
		})

		try {
			await window.loadURL(`${base}?page=${encodeURIComponent(pageId)}&isolated=1`)
			// Same settle contract as the screenshot path: what the checks see must
			// be the finished page, and a check against fallback type lies.
			await window.webContents.executeJavaScript(settleScript(4000)).catch(() => {})

			// A page that error-carded is not a design to audit — it is one finding,
			// carrying the real error, which the enforcement loop feeds back to the
			// agent that wrote the page. Running the slop checks over an error card
			// would bury that signal under meaningless ones.
			const pageError = (await window.webContents
				.executeJavaScript(
					`document.querySelector("[data-caret-page-error]")?.getAttribute("data-caret-page-error") ?? null`,
				)
				.catch(() => null)) as string | null
			if (pageError) {
				return [{ check: "page-error", severity: "error", message: `the page does not render: ${pageError}`, pageId }]
			}

			const findings: CheckFinding[] = []

			const domFindings = (await window.webContents.executeJavaScript(DESIGN_CHECKS_DOM_SCRIPT).catch((err) => {
				Logger.warn(`[checks] DOM script failed on ${pageId}: ${err}`)
				return []
			})) as Array<Omit<CheckFinding, "pageId">>
			for (const finding of domFindings) {
				findings.push({ ...finding, pageId })
			}

			try {
				await window.webContents.executeJavaScript(await loadAxe())
				const contrast = (await window.webContents.executeJavaScript(
					`axe.run(document, { runOnly: ["color-contrast"], resultTypes: ["violations"] }).then((r) =>
						r.violations.flatMap((v) => v.nodes.slice(0, 5).map((n) => n.failureSummary || v.help)))`,
				)) as string[]
				for (const message of contrast.slice(0, 5)) {
					findings.push({ check: "contrast", severity: "error", message, pageId })
				}
			} catch (err) {
				Logger.warn(`[checks] axe run failed on ${pageId}: ${err}`)
			}

			return findings
		} finally {
			if (!window.isDestroyed()) window.destroy()
		}
	}
}

const FEEDBACK_NOTE = "Design checks"
