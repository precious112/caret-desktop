/**
 * The overlay verify loop's host half: after an overlay edit's turn settles,
 * re-render the page in a hidden window, re-measure the elements the user
 * painted over, and resume the same session with the numbers (and, when the
 * model can see, a fresh screenshot of the region).
 *
 * Sibling of `DesignChecksService`, not part of it: different trigger (the
 * task context an overlay edit carries, not "files under `.caret/pages/`
 * changed"), different cadence (a capped loop, not once-per-activity), and a
 * different payload (geometry + pixels, not findings text). The two coexist
 * because each ignores the other's turns — a design-checks feedback turn
 * carries no overlay context, and an overlay verify turn is recognised by its
 * own note.
 *
 * The loop's state travels IN the context it re-attaches (round counter and
 * the previous round's measurements) rather than in a map keyed on activity
 * ids — every `run()` mints a new activity, so an id-keyed counter would never
 * accumulate, and stateless survives anything that recreates this service.
 */
import { BrowserWindow } from "electron"

import { type AgentConversation, pageIdsFromFiles, type RunOutcome, type RunRequest, readAssetIndex } from "../../src/core/design"
import {
	buildOverlayMeasureScript,
	formatVerifyPrompt,
	geometryStable,
	OVERLAY_VERIFY_NOTE,
	type OverlayMeasurement,
	readOverlayVerifyContext,
} from "../../src/core/design/visual-editing/verify-script"
import { Logger } from "../../src/shared/services/Logger"
import { settleScript } from "./page-settle"
import { canSeeImages } from "./vision-cache"

/**
 * Two rounds: the first catches the edit that missed, the second catches the
 * correction that overshot. Past that, geometry that still disagrees is a
 * problem the numbers alone are not fixing, and more turns only spend tokens
 * repeating themselves.
 */
const MAX_ROUNDS = 2

/** Padding around the measured region in the verification screenshot. */
const CROP_PAD = 48

export interface OverlayVerifyOptions {
	projectPath: string
	/** The design preview's base URL, or null while Vite is still starting. */
	baseUrl(): string | null
}

export class OverlayVerifyService {
	private closed = false

	constructor(private readonly options: OverlayVerifyOptions) {}

	close(): void {
		this.closed = true
	}

	/** Wired beside `DesignChecksService.afterTurn` on `onTurnComplete`. */
	afterTurn(conversation: AgentConversation, outcome: RunOutcome, request: RunRequest): void {
		if (this.closed) return
		const ctx = readOverlayVerifyContext(request.context)
		if (!ctx) return

		const isVerifyTurn = request.note === OVERLAY_VERIFY_NOTE
		const round = isVerifyTurn ? Number(request.context?.overlayVerifyRound) || 0 : 0

		// A turn that changed nothing ends the loop before it starts a render: on
		// a verify turn that is the model answering DONE (the cleanest exit), and
		// on the original edit it means no edit happened — the model refused or
		// asked something, and measuring an unchanged page would argue with it.
		if (outcome.filesChanged.length === 0) return
		if (!outcome.ok) return
		if (round >= MAX_ROUNDS) return

		void this.verify(conversation, outcome, request, round).catch((err) => {
			Logger.warn(`[overlay-verify] verification failed: ${err instanceof Error ? err.message : String(err)}`)
		})
	}

	private async verify(
		conversation: AgentConversation,
		outcome: RunOutcome,
		request: RunRequest,
		round: number,
	): Promise<void> {
		const ctx = readOverlayVerifyContext(request.context)
		if (!ctx) return

		const base = this.options.baseUrl()
		if (!base) return
		const pageId = pageIdsFromFiles([ctx.filePath])[0]
		if (!pageId) return

		const rendered = await this.renderAndMeasure(pageId, base, ctx.caretIds, ctx.viewport)
		if (!rendered) return
		const { measurements, screenshotDataUrl } = rendered

		if (measurements.every((m) => !m.found)) {
			// Nothing to measure — the model may have rebuilt the region wholesale.
			// One informing turn would only be able to say "not found", which the
			// user can already see on the canvas. Stop instead of guessing.
			Logger.info(`[overlay-verify] none of the painted elements exist after the edit — not verifying`)
			return
		}

		const previous = (request.context?.overlayVerifyMeasurements as OverlayMeasurement[] | undefined) ?? null
		if (previous && geometryStable(previous, measurements)) {
			// The edit landed (or stopped reaching these elements). Either way
			// another round would repeat itself verbatim.
			Logger.info(`[overlay-verify] geometry stable after round ${round} — loop complete`)
			return
		}

		const state = conversation.getState()
		const vision = await canSeeImages(state.backendId ?? "", state.model ?? "", this.options.projectPath).catch(
			() => ({ sees: false }) as const,
		)
		const images = vision.sees && screenshotDataUrl ? [screenshotDataUrl] : undefined

		const prompt = formatVerifyPrompt({
			round: round + 1,
			maxRounds: MAX_ROUNDS,
			instruction: ctx.instruction,
			measurements,
			assets: (await readAssetIndex(this.options.projectPath)).assets,
			imageAttached: images !== undefined,
		})

		Logger.info(
			`[overlay-verify] round ${round + 1}/${MAX_ROUNDS} on ${pageId}${images ? " with screenshot" : " (numbers only)"}`,
		)
		await conversation.run({
			kind: state.activity?.kind ?? "edit",
			title: state.activity?.title ?? "Edit",
			mode: "write",
			prompt,
			displayPrompt: "Caret re-measured the edited region and is showing the agent the result.",
			images,
			resumeSessionId: state.activity?.sessionId || outcome.sessionId || undefined,
			note: OVERLAY_VERIFY_NOTE,
			context: {
				...request.context,
				overlayVerifyRound: round + 1,
				overlayVerifyMeasurements: measurements,
			},
		})
	}

	/**
	 * Isolated render, measure, crop. Same deadline-and-destroy discipline as
	 * `DesignChecksService.checkRendered`: a page whose module graph never
	 * settles must not wedge the loop, and no hidden window may outlive it.
	 */
	private async renderAndMeasure(
		pageId: string,
		base: string,
		caretIds: string[],
		viewport: { width: number; height: number },
	): Promise<{ measurements: OverlayMeasurement[]; screenshotDataUrl: string | null } | null> {
		try {
			return await Promise.race([
				this.doRenderAndMeasure(pageId, base, caretIds, viewport),
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
			])
		} finally {
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

	private async doRenderAndMeasure(
		pageId: string,
		base: string,
		caretIds: string[],
		viewport: { width: number; height: number },
	): Promise<{ measurements: OverlayMeasurement[]; screenshotDataUrl: string | null }> {
		// The user's viewport, so the layout being measured is the layout they
		// were looking at — clamped to something a hidden window can be.
		const width = Math.min(3840, Math.max(320, Math.round(viewport.width) || 1440))
		const height = Math.min(2400, Math.max(240, Math.round(viewport.height) || 900))

		const window = new BrowserWindow({
			show: false,
			width,
			height,
			paintWhenInitiallyHidden: true,
			// backgroundThrottling off: the settle waits on rAF, and Chromium
			// parks rAF in hidden windows — same as every capture window.
			webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
		})

		try {
			await window.loadURL(`${base}?page=${encodeURIComponent(pageId)}&isolated=1`)
			// Same settle contract as the checks path: what gets measured must be
			// the finished page, and geometry against fallback type lies.
			await window.webContents.executeJavaScript(settleScript(4000)).catch(() => {})

			const measurements = (await window.webContents.executeJavaScript(buildOverlayMeasureScript(caretIds))) as
				| OverlayMeasurement[]
				| null
			if (!Array.isArray(measurements)) return { measurements: [], screenshotDataUrl: null }

			const screenshotDataUrl = await this.captureRegion(window, measurements, width, height)
			return { measurements, screenshotDataUrl }
		} finally {
			if (!window.isDestroyed()) window.destroy()
		}
	}

	/** The union of the found rects, padded, clamped to the viewport. */
	private async captureRegion(
		window: BrowserWindow,
		measurements: OverlayMeasurement[],
		viewportWidth: number,
		viewportHeight: number,
	): Promise<string | null> {
		const rects = measurements.filter((m) => m.found && m.rect).map((m) => m.rect as NonNullable<OverlayMeasurement["rect"]>)
		if (rects.length === 0) return null

		const left = Math.min(...rects.map((r) => r.x)) - CROP_PAD
		const top = Math.min(...rects.map((r) => r.y)) - CROP_PAD
		const right = Math.max(...rects.map((r) => r.x + r.width)) + CROP_PAD
		const bottom = Math.max(...rects.map((r) => r.y + r.height)) + CROP_PAD

		const x = Math.max(0, Math.round(left))
		const y = Math.max(0, Math.round(top))
		const crop = {
			x,
			y,
			width: Math.max(1, Math.min(viewportWidth, Math.round(right)) - x),
			height: Math.max(1, Math.min(viewportHeight, Math.round(bottom)) - y),
		}

		try {
			const image = await window.webContents.capturePage(crop)
			const png = image.toPNG()
			return png.length > 0 ? `data:image/png;base64,${png.toString("base64")}` : null
		} catch (err) {
			Logger.warn(`[overlay-verify] capture failed: ${err}`)
			return null
		}
	}
}
