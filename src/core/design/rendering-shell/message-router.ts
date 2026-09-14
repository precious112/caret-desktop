/**
 * Routes messages arriving from the canvas to the design core.
 *
 * This is the host-free half of what used to be `preview-panel.ts`: the same
 * handlers, with the VS Code webview replaced by the {@link DesignHost} seam.
 * Nothing in here knows whether it is running inside an Electron window, a test
 * harness, or nothing at all.
 */
import * as fs from "fs/promises"
import * as path from "path"

import { Logger } from "@/shared/services/Logger"
import { getLatestGitCommitHash } from "@/utils/git"
import type { AgentTask } from "../agent/bridge"
import { ExploreCancelledError } from "../agent/explore-lane"
import { markSignal, pendingSignals, signalKey } from "../corrections"
import { runExclusive } from "../file-mutation-queue"
import { mutateFlowDefinition } from "../flow-meta"
import { resolveParamsFor, spliceColorEdit, spliceParamEdit, spliceRowTextEdit, spliceTextEdit } from "../param/edit"
import { flexWidthEncodingFor } from "../param/encoding"
import { PANEL_PROPERTIES } from "../param/params"
import { getIndex } from "../param/source-index"
import { addPromotedRule } from "../promoted-rules"
import { readProvenance, recordEdit } from "../provenance"
import { bridgeFor, editLaneFor, exploreLaneFor, hostFor } from "../services"
import { recordMappings } from "../sync/mapping-manifest"
import { emitDesignEvent } from "../telemetry-hooks"
import { readFoundationTokens, writeFoundationTokens } from "../tokens"
import { captureUndoStep, redoStep, undoLastStep } from "../undo/design-undo"
import {
	applyLeaf,
	createExploration,
	discardExploration,
	type Exploration,
	type ExploreNode,
	readExploration,
	spawnRound,
	updateNodeStatus,
} from "../variants"
import { editJSXColor, editJSXImageSrc, editJSXText } from "../visual-editing/ast-editor"
import { buildVisualEditPrompt } from "../visual-editing/context-builder"
import { precomputePage } from "../visual-editing/page-precompute"
import { precomputeAndApply } from "../visual-editing/post-generation-hook"
import {
	countTokenUses,
	foundationTokenForClass,
	setFoundationTokenValue,
	tokenClassForHex,
} from "../visual-editing/token-colors"
import { writeThemeCss } from "./entry-template"
import type {
	AiEditRequestPayload,
	DesignInboundMessage,
	FlowEdgeCreatePayload,
	FlowEdgeDeletePayload,
	FlowEdgeUpdatePayload,
	InlineEditPayload,
	OverlayEditPayload,
	ParamEditPayload,
	ParamResolvePayload,
	PromoteTokenPayload,
} from "./messages"
import { isValidDesignMessagePayload } from "./messages"

export interface MessageRouterDeps {
	/** Absolute path of the project this canvas belongs to. */
	workspacePath: string
	/** Invoked when the canvas asks for a design→app sync (the toolbar button). */
	onSyncRequested: () => void | Promise<void>
}

export interface MessageRouter {
	handle(message: DesignInboundMessage): Promise<void>
}

export function createMessageRouter(deps: MessageRouterDeps): MessageRouter {
	return { handle: (message) => handleMessage(message, deps) }
}

function sendEditResult(workspacePath: string, payload: import("./messages").EditResultPayload): void {
	hostFor(workspacePath).sendToCanvas({ source: "caret-host", type: "edit-result", payload })
}

/**
 * Hands a task to the connected agent, turning the no-agent case into a visible
 * edit-result rather than a swallowed rejection. Returns whether it was accepted.
 *
 * Visual edits go to the edit lane when the host wired one: their own
 * conversation, narrated to the canvas pill, never touching the chat. Sync and
 * flow-sync stay on the chat bridge — those are conversations the user follows
 * in the sidebar. Hosts without a lane fall back to the chat bridge, which is
 * the old behaviour.
 */
async function requestAgent(workspacePath: string, task: AgentTask): Promise<boolean> {
	const bridge =
		task.kind === "visual-edit" ? (editLaneFor(workspacePath) ?? bridgeFor(workspacePath)) : bridgeFor(workspacePath)
	try {
		await bridge.request(task)
		return true
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		Logger.warn(`[design] agent request (${task.kind}) refused: ${message}`)
		sendEditResult(workspacePath, { kind: "agent", success: false, error: message })
		return false
	}
}

/**
 * Maps a path reported by the canvas onto a real file under `.caret/`.
 *
 * React fiber source paths arrive in several shapes depending on how the element
 * was authored, so each candidate location is probed rather than guessed at.
 */
async function resolveCaretPath(filePath: string, workspacePath: string): Promise<string> {
	if (!filePath) return filePath
	const caretDir = path.join(workspacePath, ".caret")
	const reported = normalizeFiberPath(filePath)

	if (path.isAbsolute(reported)) {
		if (startsWithPath(reported, caretDir)) return reported
		// The fiber reports sources through RESOLVED symlinks while the project
		// may have been opened through an alias (macOS: /var → /private/var, and
		// /tmp likewise). A prefix test on the raw strings concludes the file is
		// foreign and mangles the path — compare realpaths before giving up.
		try {
			const [realFile, realCaret] = await Promise.all([fs.realpath(reported), fs.realpath(caretDir)])
			if (startsWithPath(realFile, realCaret)) return reported
		} catch {}
	}

	const relative = reported.startsWith("/") ? reported.slice(1) : reported

	// Direct under .caret/ (handles "pages/home/index.tsx", "components/Button.tsx"),
	// then bare page names, then shared components.
	for (const candidate of [
		path.join(caretDir, relative),
		path.join(caretDir, "pages", relative),
		path.join(caretDir, "components", relative),
	]) {
		try {
			await fs.access(candidate)
			return candidate
		} catch {}
	}

	Logger.warn(`[design] Could not resolve caret path: "${filePath}" (tried under .caret/, .caret/pages/, .caret/components/)`)
	return path.join(caretDir, relative)
}

/**
 * Vite and React report fiber source paths with forward slashes on every OS,
 * and on Windows sometimes as "/C:/…". Bring them back to native form before
 * any comparison — a separator mismatch concludes the file is foreign and
 * mangles the path.
 */
function normalizeFiberPath(reported: string): string {
	if (process.platform !== "win32") return reported
	const stripped = /^\/[A-Za-z]:[/\\]/.test(reported) ? reported.slice(1) : reported
	return path.normalize(stripped)
}

/** Prefix test that respects Windows' case-insensitive filesystems. */
function startsWithPath(child: string, parent: string): boolean {
	if (process.platform !== "win32") return child.startsWith(parent)
	return child.toLowerCase().startsWith(parent.toLowerCase())
}

/**
 * Product events for canvas actions, keyed by message type — the action name
 * and nothing from the payload. One lookup here covers every canvas gesture,
 * so no individual case can grow tracking of its own content.
 */
const CANVAS_EVENTS: Partial<Record<DesignInboundMessage["type"], { event: string; props?: Record<string, unknown> }>> = {
	"inline-edit": { event: "canvas_action", props: { action: "inline_edit" } },
	"ai-edit-request": { event: "canvas_action", props: { action: "ai_edit" } },
	"overlay-edit": { event: "canvas_action", props: { action: "overlay_edit" } },
	"param-edit": { event: "canvas_action", props: { action: "param_edit" } },
	"resize-commit": { event: "canvas_action", props: { action: "resize_commit" } },
	"promote-token": { event: "canvas_action", props: { action: "promote_token" } },
	"flow-edge-create": { event: "canvas_action", props: { action: "flow_edge_create" } },
	"flow-edge-delete": { event: "canvas_action", props: { action: "flow_edge_delete" } },
	"flow-edge-update": { event: "canvas_action", props: { action: "flow_edge_update" } },
	"design-undo": { event: "canvas_action", props: { action: "design_undo" } },
	"design-redo": { event: "canvas_action", props: { action: "design_redo" } },
	"variant-request": { event: "explore_variants_requested" },
	"variant-pick": { event: "explore_variant_picked" },
	"variant-cancel": { event: "explore_cancelled" },
}

async function handleMessage(message: DesignInboundMessage, deps: MessageRouterDeps): Promise<void> {
	if (!isValidDesignMessagePayload(message.type, message.payload)) {
		Logger.error(`[design] Ignoring malformed ${message.type} payload: ${JSON.stringify(message.payload)}`)
		return
	}

	const tracked = CANVAS_EVENTS[message.type]
	if (tracked) emitDesignEvent(tracked.event, tracked.props)

	const { workspacePath } = deps

	switch (message.type) {
		case "log": {
			const { level, message: msg } = message.payload
			if (level === "error") {
				Logger.error(`[design:canvas] ${msg}`)
			} else {
				Logger.info(`[design:canvas] ${msg}`)
			}
			break
		}

		case "element-selected":
			message.payload.filePath = await resolveCaretPath(message.payload.filePath, workspacePath)
			Logger.debug(
				`[design] Element selected: ${message.payload.componentName} at ${message.payload.filePath}:${message.payload.lineNumber}`,
			)
			break

		case "open-file":
			await hostFor(workspacePath).openInEditor(
				await resolveCaretPath(message.payload.filePath, workspacePath),
				message.payload.lineNumber,
			)
			break

		case "inline-edit":
			message.payload.filePath = await resolveCaretPath(message.payload.filePath, workspacePath)
			await handleInlineEdit(message.payload, workspacePath)
			break

		case "ai-edit-request":
			message.payload.filePath = await resolveCaretPath(message.payload.filePath, workspacePath)
			await handleAiEdit(message.payload, workspacePath)
			break

		case "overlay-edit":
			await handleOverlayEdit(message.payload, workspacePath)
			break

		case "page-focused":
			await handlePageFocused(message.payload.filePath, workspacePath)
			break

		case "flow-edge-create":
			await handleFlowEdgeCreate(message.payload, workspacePath)
			break

		case "flow-edge-delete":
			await handleFlowEdgeDelete(message.payload, workspacePath)
			break

		case "flow-edge-update":
			await handleFlowEdgeUpdate(message.payload, workspacePath)
			break

		case "design-sync-now":
			await deps.onSyncRequested()
			break

		case "promote-token":
			message.payload.filePath = await resolveCaretPath(message.payload.filePath, workspacePath)
			await handlePromoteToken(message.payload, workspacePath)
			break

		case "variant-request":
			await handleVariantRequest(message.payload, workspacePath)
			break

		case "param-edit":
			message.payload.filePath = await resolveCaretPath(message.payload.filePath, workspacePath)
			await handleParamEdit(message.payload, workspacePath)
			break

		case "param-resolve":
			message.payload.filePath = await resolveCaretPath(message.payload.filePath, workspacePath)
			await handleParamResolve(message.payload, workspacePath)
			break

		case "resize-commit":
			message.payload.filePath = await resolveCaretPath(message.payload.filePath, workspacePath)
			await handleResizeCommit(message.payload, workspacePath)
			break

		case "variant-pick":
			await handleVariantPick(message.payload, workspacePath)
			break

		case "variant-cancel":
			await handleVariantCancel(message.payload, workspacePath)
			break

		case "design-undo": {
			const undo = await undoLastStep(workspacePath)
			hostFor(workspacePath).sendToCanvas({
				source: "caret-host",
				type: "undo-result",
				payload: { undone: undo.undone, label: undo.label ?? "", error: undo.error ?? "" },
			})
			break
		}

		case "design-redo": {
			const redo = await redoStep(workspacePath)
			hostFor(workspacePath).sendToCanvas({
				source: "caret-host",
				type: "undo-result",
				payload: { undone: redo.undone, label: redo.label ?? "", error: redo.error ?? "", redo: true },
			})
			break
		}

		case "edit-cancel":
			await editLaneFor(workspacePath)?.cancel()
			break

		case "edit-permission":
			await editLaneFor(workspacePath)?.respondToPermission(message.payload.requestId, message.payload.decision)
			break
	}
}

async function handleAiEdit(payload: AiEditRequestPayload, workspacePath: string): Promise<void> {
	try {
		await captureUndoStep(workspacePath, `agent edit: ${payload.instruction.slice(0, 60)}`, "agent")
		const prompt = await buildVisualEditPrompt(payload, workspacePath)
		if (
			await requestAgent(workspacePath, {
				kind: "visual-edit",
				prompt,
				displayPrompt: payload.instruction,
				context: { filePath: payload.filePath, caretId: payload.caretId },
			})
		) {
			// The instruction is the user's own correction, in their own words —
			// the raw material for "you've asked for this three times".
			void recordEdit(workspacePath, {
				actor: "inline",
				action: "write",
				file: payload.filePath,
				param: payload.caretId,
				note: "ai-edit instruction",
				detail: { kind: "instruction", text: payload.instruction },
			})
			void maybeOfferCorrections(workspacePath)
			sendEditResult(workspacePath, { kind: "agent", success: true })
		}
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err)
		Logger.error(`[design] AI edit failed: ${errorMsg}`)
		sendEditResult(workspacePath, { kind: "agent", success: false, error: errorMsg })
	}
}

async function handleOverlayEdit(payload: OverlayEditPayload, workspacePath: string): Promise<void> {
	try {
		await captureUndoStep(workspacePath, `overlay edit: ${payload.instruction.slice(0, 60)}`, "agent")
		const resolvedFilePath = payload.filePath ? await resolveCaretPath(payload.filePath, workspacePath) : ""
		const prompt = await buildVisualEditPrompt(
			{
				instruction: payload.instruction,
				filePath: resolvedFilePath,
				lineNumber: 0,
				columnNumber: 0,
				componentName: "",
				caretId: "",
				componentStack: "",
				// The painted region *is* the space the asset would go into, so an
				// overlay edit gets the same fit judgment as a selected element.
				box: payload.regionBounds
					? { width: Math.round(payload.regionBounds.width), height: Math.round(payload.regionBounds.height) }
					: undefined,
				elements: payload.elements,
			},
			workspacePath,
		)
		const images = payload.screenshotDataUrl ? [payload.screenshotDataUrl] : undefined
		if (
			await requestAgent(workspacePath, {
				kind: "visual-edit",
				prompt,
				displayPrompt: payload.instruction,
				images,
				context: {
					region: payload.regionBounds,
					// Read back by OverlayVerifyService.afterTurn — the post-edit
					// re-measure loop. Opaque to the conversation itself.
					overlayVerify: {
						filePath: resolvedFilePath,
						caretIds: (payload.elements ?? []).map((e) => e.caretId),
						instruction: payload.instruction,
						viewport: payload.viewport ?? { width: 1440, height: 900 },
					},
				},
			})
		) {
			void recordEdit(workspacePath, {
				actor: "inline",
				action: "write",
				file: resolvedFilePath || ".caret",
				note: "overlay instruction",
				detail: { kind: "instruction", text: payload.instruction },
			})
			void maybeOfferCorrections(workspacePath)
			sendEditResult(workspacePath, { kind: "agent", success: true })
		}
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err)
		Logger.error(`[design] Overlay edit failed: ${errorMsg}`)
		sendEditResult(workspacePath, { kind: "agent", success: false, error: errorMsg })
	}
}

function buildTakePrompt(exploration: Exploration, node: ExploreNode, roundSize: number): string {
	const deepening = node.parentId !== exploration.pageId
	const buildingNew = exploration.mode === "new" && !deepening
	const opening = buildingNew
		? `You are producing ${node.label} of ${roundSize} INDEPENDENT takes on a NEW page, for a
side-by-side pick. The page to build is .caret/pages/${node.id}/index.tsx — a stub created for
this take; the page "${exploration.pageId}" does not exist yet. Replace the stub with a real
"${exploration.title ?? exploration.pageId}" page, built on the project's foundation.`
		: `You are producing ${node.label} of ${roundSize} INDEPENDENT takes on one instruction,
for a side-by-side pick. The page to change is .caret/pages/${node.id}/index.tsx — a working
copy of "${node.parentId}" made for this take. Read its current source, then apply the instruction.`
	const lineage = deepening
		? `\nThis page is itself a chosen direction from an earlier round — keep its direction, and
push it further as the instruction asks rather than starting over.\n`
		: ""

	return `${opening}
${lineage}
${node.angle}

INSTRUCTION: ${node.instruction}

Rules for this take:
- Edit ONLY .caret/pages/${node.id}/index.tsx. Never touch .caret/pages/${exploration.pageId}/ or any other page.
- Shared components are read-only here: if the change wants a component edit, inline the changed
  markup into this page's own source instead.
- This take runs unattended: shell commands and anything else that needs permission will be
  DENIED automatically. Use only your file read and edit tools.
- Do not screenshot or otherwise visually verify your work — the user is watching this take
  render live while you write it, and the screenshot tool is disabled for this turn.
- The other takes read the same instruction differently — do not hedge toward a middle ground;
  commit fully to this take's reading.`
}

/**
 * A playground round, Caret-orchestrated: the branch point is copied N times
 * and each copy gets one independent UNATTENDED turn under a different reading
 * of the instruction. On hosts with an explore lane the takes run in parallel,
 * each on its own conversation; hosts without one fall back to the sequential
 * single-conversation bridge. The playground updates as takes land.
 */
async function handleVariantRequest(payload: import("./messages").VariantRequestPayload, workspacePath: string): Promise<void> {
	const lane = exploreLaneFor(workspacePath)
	const fallback = editLaneFor(workspacePath) ?? bridgeFor(workspacePath)
	if (!(lane ? lane.connected() : fallback.connected())) {
		sendEditResult(workspacePath, {
			kind: "agent",
			success: false,
			error: "Generating takes needs a coding backend — open Settings → Backend to connect one.",
		})
		return
	}

	let exploration: Exploration | null
	let round: ExploreNode[]
	try {
		if (payload.fromId) {
			round = await spawnRound(workspacePath, payload.fromId, payload.instruction)
			exploration = await readExploration(workspacePath)
		} else if (payload.newPage) {
			exploration = await createExploration(workspacePath, {
				mode: "new",
				name: payload.newPage.name,
				instruction: payload.instruction,
			})
			round = exploration.nodes
		} else {
			exploration = await createExploration(workspacePath, {
				pageId: payload.pageId ?? "",
				instruction: payload.instruction,
			})
			round = exploration.nodes
		}
		if (!exploration) throw new Error("The exploration disappeared while spawning the round.")
	} catch (err) {
		sendEditResult(workspacePath, { kind: "agent", success: false, error: err instanceof Error ? err.message : String(err) })
		return
	}

	const settled = exploration
	void recordEdit(workspacePath, {
		actor: "inline",
		action: "write",
		file: `.caret/pages/${settled.pageId}/index.tsx`,
		note: payload.fromId ? "explore round" : "explore request",
		detail: { kind: "instruction", text: payload.instruction },
	})
	sendEditResult(workspacePath, { success: true })

	const runTake = async (node: ExploreNode) => {
		const task: AgentTask = {
			kind: "visual-edit",
			prompt: buildTakePrompt(settled, node, round.length),
			displayPrompt: `${node.label}: ${payload.instruction}`,
			context: { filePath: `.caret/pages/${node.id}/index.tsx` },
			unattended: true,
			// The user is watching the take render live — a screenshot spends
			// minutes verifying what is already on screen.
			disabledTools: ["caret_get_screenshot"],
		}
		try {
			if (lane) await lane.run(node.id, task)
			else await fallback.request(task)
			await updateNodeStatus(workspacePath, node.id, "ready")
		} catch (err) {
			if (err instanceof ExploreCancelledError) {
				await updateNodeStatus(workspacePath, node.id, "cancelled")
				return
			}
			const message = err instanceof Error ? err.message : String(err)
			Logger.warn(`[design] take ${node.id} failed: ${message}`)
			await updateNodeStatus(workspacePath, node.id, "failed", message)
		}
	}

	// Fire and forget: the takes stream into the playground as they land.
	void (async () => {
		if (lane) await Promise.allSettled(round.map(runTake))
		else for (const node of round) await runTake(node)
	})()
}

async function handleVariantCancel(payload: import("./messages").VariantCancelPayload, workspacePath: string): Promise<void> {
	const lane = exploreLaneFor(workspacePath)
	if (lane) {
		if (payload.nodeId) await lane.cancel(payload.nodeId)
		else await lane.cancelAll()
		return
	}
	// Fallback hosts run takes through the edit lane one at a time; cancelling
	// the current one is the best that lane can offer.
	await editLaneFor(workspacePath)?.cancel()
}

async function handleVariantPick(payload: import("./messages").VariantPickPayload, workspacePath: string): Promise<void> {
	try {
		// Outstanding takes are fully stopped BEFORE anything is deleted — a turn
		// left running would keep editing directories that no longer exist.
		await exploreLaneFor(workspacePath)?.cancelAll()

		if (payload.variantId) {
			// The apply rewrites the root page's files — Caret's own write, not
			// an external hand-edit.
			const exploration = await readExploration(workspacePath)
			if (exploration) {
				const rootDir = path.join(workspacePath, ".caret", "pages", exploration.pageId)
				for (const file of ["index.tsx", "meta.json"]) {
					hostFor(workspacePath).noteSelfWrite(path.join(rootDir, file))
				}
			}
			await captureUndoStep(workspacePath, `apply ${payload.variantId} over ${exploration?.pageId ?? "the page"}`, "agent")
			await applyLeaf(workspacePath, payload.variantId)
			Logger.info(`[design] variant pick: ${payload.variantId} applied over ${exploration?.pageId}`)

			// A drift proposal accepted IS the reverse sync: the design now
			// reflects the app, so the mapping's hashes are re-recorded and the
			// entry reads clean (Phase 9.4). A normal explore pick changes the
			// design and must NOT refresh — that movement is forward-sync work.
			if (exploration?.kind === "drift-proposal" && exploration.proposalAppPaths?.length) {
				const head = await getLatestGitCommitHash(workspacePath)
				const refreshed = await recordMappings(
					workspacePath,
					[{ designPath: `.caret/pages/${exploration.pageId}/index.tsx`, appPaths: exploration.proposalAppPaths }],
					head,
				)
				Logger.info(`[design] reverse sync accepted for ${exploration.pageId}: mapping refreshed (${refreshed.recorded})`)
			}
		} else {
			await discardExploration(workspacePath)
			Logger.info(`[design] variant pick: exploration discarded, original untouched`)
		}
		sendEditResult(workspacePath, { success: true })
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err)
		Logger.error(`[design] variant pick failed: ${errorMsg}`)
		sendEditResult(workspacePath, { success: false, error: errorMsg })
	}
}

/**
 * The generalized edit: one Param path (`<caretId>/style/<property>`) set to a
 * token or a raw value, spliced onto the variant active at the canvas's
 * viewport. What the property panel speaks.
 */
/** The panel's read: every supported property of one element, resolved from source. */
async function handleParamResolve(payload: ParamResolvePayload, workspacePath: string): Promise<void> {
	try {
		const [source, tokens] = await Promise.all([fs.readFile(payload.filePath, "utf-8"), readFoundationTokens(workspacePath)])
		const params = resolveParamsFor(
			source,
			payload.filePath,
			payload.caretId,
			PANEL_PROPERTIES,
			payload.viewportWidth,
			tokens,
		)
		hostFor(workspacePath).sendToCanvas({
			source: "caret-host",
			type: "param-resolve-result",
			payload: { caretId: payload.caretId, params: (params ?? []) as unknown as Array<Record<string, unknown>> },
		})
	} catch (err) {
		Logger.warn(`[design] param resolve failed: ${err}`)
		hostFor(workspacePath).sendToCanvas({
			source: "caret-host",
			type: "param-resolve-result",
			payload: { caretId: payload.caretId, params: [] },
		})
	}
}

/**
 * A resize drag's commit — ONE write on release, encoded for the layout
 * context the resolver classified at pointerdown (Phase 10.2):
 *
 *   flex-main:   basis-[Npx] shrink-0 — writing w-* does nothing against
 *                flex-basis:0, and this is byte-identical to the clamp preview
 *   grid-track:  REFUSED with the constrainer named — a written width verifies
 *                clean on the node and visibly breaks the neighbours (measured)
 *   elsewhere:   w-[Npx] / h-[Npx] through the ordinary param path
 */
async function handleResizeCommit(payload: import("./messages").ResizeCommitPayload, workspacePath: string): Promise<void> {
	try {
		const tokens = await readFoundationTokens(workspacePath)
		hostFor(workspacePath).noteSelfWrite(payload.filePath)
		await captureUndoStep(workspacePath, `resize ${payload.axis} of ${payload.caretId} to ${payload.px}px`)

		if (payload.kind === "grid-track") {
			sendEditResult(workspacePath, {
				success: false,
				error: "This width is controlled by the parent's grid — writing it on the item would overlap its siblings. Edit the parent's columns instead (select it and change grid-cols / gap).",
			})
			return
		}

		const raw = `${Math.round(payload.px)}px`
		if (payload.kind === "flex-main" && payload.axis === "width") {
			// Project convention beats the context default: a design that already
			// writes flex-[0_0_Npx] is matched; the cold-start default is the
			// explicit basis-[Npx] shrink-0 — the encoding worth propagating,
			// since the first write seeds what every later write copies.
			const pageSources: string[] = []
			try {
				const pagesDir = path.join(workspacePath, ".caret", "pages")
				for (const entry of await fs.readdir(pagesDir, { withFileTypes: true })) {
					if (!entry.isDirectory()) continue
					const src = await fs.readFile(path.join(pagesDir, entry.name, "index.tsx"), "utf-8").catch(() => null)
					if (src) pageSources.push(src)
				}
			} catch {
				// No pages dir: cold start, the default applies.
			}
			if (flexWidthEncodingFor(pageSources) === "flex-shorthand") {
				const flex = await spliceParamEdit(
					payload.filePath,
					payload.caretId,
					"flex",
					{ raw: `0_0_${Math.round(payload.px)}px` },
					payload.viewportWidth,
					tokens,
				)
				if (!flex.ok) {
					sendEditResult(workspacePath, { success: false, error: flex.refused ?? "the resize was refused" })
					return
				}
			} else {
				const basis = await spliceParamEdit(
					payload.filePath,
					payload.caretId,
					"flex-basis",
					{ raw },
					payload.viewportWidth,
					tokens,
				)
				if (!basis.ok) {
					sendEditResult(workspacePath, { success: false, error: basis.refused ?? "the resize was refused" })
					return
				}
				await spliceParamEdit(
					payload.filePath,
					payload.caretId,
					"flex-shrink",
					{ token: "0" },
					payload.viewportWidth,
					tokens,
				)
			}
		} else {
			const result = await spliceParamEdit(
				payload.filePath,
				payload.caretId,
				payload.axis,
				{ raw },
				payload.viewportWidth,
				tokens,
			)
			if (!result.ok) {
				sendEditResult(workspacePath, { success: false, error: result.refused ?? "the resize was refused" })
				return
			}
		}

		void recordEdit(workspacePath, {
			actor: "inline",
			action: "write",
			file: payload.filePath,
			param: `${payload.caretId}/style/${payload.axis}`,
			newValue: raw,
			note: `resize (${payload.kind})`,
		})
		sendEditResult(workspacePath, {
			success: true,
			editTarget: { filePath: payload.filePath, lineNumber: 0, caretId: payload.caretId },
		})
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err)
		Logger.error(`[design] resize commit failed: ${errorMsg}`)
		sendEditResult(workspacePath, { success: false, error: errorMsg })
	}
}

async function handleParamEdit(payload: ParamEditPayload, workspacePath: string): Promise<void> {
	try {
		const tokens = await readFoundationTokens(workspacePath)
		hostFor(workspacePath).noteSelfWrite(payload.filePath)

		// Bulk edit: one gesture, several elements, ONE undo step. Failures are
		// per-element — a mixed selection reports what it could not reach.
		const targets = [payload.caretId, ...(payload.alsoCaretIds ?? [])]
		await captureUndoStep(
			workspacePath,
			targets.length > 1
				? `${payload.property} on ${targets.length} elements`
				: `${payload.property} on ${payload.caretId}`,
		)

		const refused: string[] = []
		for (const caretId of targets) {
			const result = await spliceParamEdit(
				payload.filePath,
				caretId,
				payload.property,
				{ token: payload.token, raw: payload.raw },
				payload.viewportWidth,
				tokens,
			)
			if (result.ok) {
				void recordEdit(workspacePath, {
					actor: "inline",
					action: "write",
					file: payload.filePath,
					param: `${caretId}/style/${payload.property}`,
					newValue: payload.token ?? payload.raw,
				})
			} else {
				refused.push(`${caretId}: ${result.refused ?? "refused"}`)
			}
		}

		if (refused.length === targets.length) {
			sendEditResult(workspacePath, { success: false, error: refused.join("; ") })
			return
		}
		sendEditResult(workspacePath, {
			success: true,
			...(refused.length > 0 ? { error: `some elements were skipped — ${refused.join("; ")}` } : {}),
			editTarget: { filePath: payload.filePath, lineNumber: 0, caretId: payload.caretId },
		})
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err)
		Logger.error(`[design] param edit failed: ${errorMsg}`)
		sendEditResult(workspacePath, { success: false, error: errorMsg })
	}
}

async function handleInlineEdit(payload: InlineEditPayload, workspacePath: string): Promise<void> {
	try {
		await captureUndoStep(workspacePath, `${payload.editType} edit on ${payload.caretId || `line ${payload.lineNumber}`}`)
		if (payload.editType === "color") {
			await handleColorEdit(payload, workspacePath)
			return
		}

		// The splice editors serialize internally through spliceFile's own
		// runExclusive — wrapping them again in the same key DEADLOCKS (the
		// queue is intentionally non-reentrant). Only the recast fallback and
		// the image path, which do their own read-modify-write, take the lock
		// here.
		hostFor(workspacePath).noteSelfWrite(payload.filePath)
		let refusal: string | undefined
		let success = false
		if (payload.editType === "text") {
			// Splice path first: replaces only the trimmed content span, so the
			// recast reprint (and its compounding-indentation bug) never runs
			// for the ordinary case. The recast chain stays as the fallback for
			// what an index lookup can't serve.
			const spliced = await spliceTextEdit(payload.filePath, payload.caretId, payload.newValue, payload.oldValue)
			if (spliced.handled) {
				refusal = spliced.reason
				success = spliced.ok
				// Dynamic text on a .map() row: the content edit belongs to the
				// DATA the row rendered from, not the template (Phase 8.6).
				if (!spliced.ok && payload.caretId && payload.instanceIndex !== undefined) {
					const row = await spliceRowTextEdit(
						payload.filePath,
						payload.caretId,
						payload.instanceIndex,
						payload.newValue,
						payload.oldValue,
					)
					if (row.kind === "edit") {
						refusal = undefined
						success = true
					} else if (row.kind === "refusal") {
						refusal = row.reason
						success = false
					}
				}
			} else {
				success = await runExclusive(payload.filePath, () =>
					editJSXText(
						payload.filePath,
						payload.lineNumber,
						payload.tagName || "",
						payload.newValue,
						payload.oldValue,
						payload.caretId,
					),
				)
			}
		} else if (payload.editType === "image") {
			const image = await runExclusive(payload.filePath, () => handleImageEdit(payload, workspacePath))
			refusal = image.reason
			success = image.ok
		}

		if (success) {
			void recordEdit(workspacePath, {
				actor: "inline",
				action: "write",
				file: payload.filePath,
				param: payload.caretId,
				oldValue: payload.oldValue || undefined,
				newValue: payload.newValue,
				note: payload.editType,
			})
			sendEditResult(workspacePath, { kind: "inline", success: true })
		} else {
			sendEditResult(workspacePath, {
				kind: "inline",
				success: false,
				error:
					refusal ??
					"This content can't be edited inline — it may use dynamic expressions. Use AI Edit to describe the change you want.",
				suggestAiEdit: true,
			})
		}
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err)
		Logger.error(`[design] Inline edit failed: ${errorMsg}`)
		sendEditResult(workspacePath, { kind: "inline", success: false, error: errorMsg })
	}
}

/**
 * The colour write policy, settled in Phase 7: an inline gesture points at ONE
 * element, so the default is detach — a wrong detach hits one element and is
 * visible immediately, a wrong token edit silently changes every use. Two
 * refinements keep the token system from eroding:
 *
 *  - **Bind on exact match.** A picked colour that IS a token's value writes
 *    the token class, not a magic number that happens to equal it today.
 *  - **Detach is promotable.** Replacing a token class reports what was
 *    detached and how many places the token reaches, so the canvas can offer
 *    "change the token instead" as one click rather than a modal in the way.
 */
async function handleColorEdit(payload: InlineEditPayload, workspacePath: string): Promise<void> {
	try {
		const tokens = await readFoundationTokens(workspacePath)
		const bindTo = tokenClassForHex(payload.newValue, tokens) ?? undefined

		hostFor(workspacePath).noteSelfWrite(payload.filePath)
		const spliced = await spliceColorEdit(payload.filePath, payload.caretId, payload.newValue, bindTo, payload.targetProperty)
		const result = spliced.handled
			? { ok: spliced.ok, replacedClass: spliced.replacedClass }
			: await runExclusive(payload.filePath, () =>
					editJSXColor(payload.filePath, payload.lineNumber, payload.newValue, payload.caretId, bindTo),
				)

		if (!result.ok) {
			sendEditResult(workspacePath, {
				kind: "inline",
				success: false,
				error: "This content can't be edited inline — it may use dynamic expressions. Use AI Edit to describe the change you want.",
				suggestAiEdit: true,
			})
			return
		}

		const editTarget = { filePath: payload.filePath, lineNumber: payload.lineNumber, caretId: payload.caretId }
		if (bindTo) {
			void recordEdit(workspacePath, {
				actor: "inline",
				action: "write",
				file: payload.filePath,
				param: payload.caretId,
				newValue: payload.newValue,
				detail: { kind: "color-bind", token: bindTo },
			})
			sendEditResult(workspacePath, { kind: "inline", success: true, boundTo: bindTo, editTarget })
			return
		}

		const detachedFrom = result.replacedClass ? foundationTokenForClass(result.replacedClass, tokens) : null
		if (detachedFrom) {
			void recordEdit(workspacePath, {
				actor: "inline",
				action: "write",
				file: payload.filePath,
				param: payload.caretId,
				oldValue: result.replacedClass,
				newValue: payload.newValue,
				detail: { kind: "color-detach", token: detachedFrom, hex: payload.newValue },
			})
			// +1: the scan runs after the detach, so the element in hand no longer
			// counts itself — but promoting re-binds it, so it is part of the reach.
			const uses = await countTokenUses(path.join(workspacePath, ".caret"), detachedFrom)
			sendEditResult(workspacePath, {
				kind: "inline",
				success: true,
				detachedFrom,
				tokenUses: uses.occurrences + 1,
				editTarget,
			})
			void maybeOfferCorrections(workspacePath)
			return
		}

		void recordEdit(workspacePath, {
			actor: "inline",
			action: "write",
			file: payload.filePath,
			param: payload.caretId,
			newValue: payload.newValue,
			detail: { kind: "color", hex: payload.newValue },
		})
		sendEditResult(workspacePath, { kind: "inline", success: true, editTarget })
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err)
		Logger.error(`[design] Colour edit failed: ${errorMsg}`)
		sendEditResult(workspacePath, { kind: "inline", success: false, error: errorMsg })
	}
}

/**
 * Correction capture: when the log shows the SAME correction made repeatedly,
 * offer to promote it — a colour into the token, an instruction into the
 * always-on rules. One offer at a time, each raised exactly once; an explicit
 * "no" is remembered so the offer never nags.
 */
async function maybeOfferCorrections(workspacePath: string): Promise<void> {
	try {
		const records = await readProvenance(workspacePath)
		const signals = await pendingSignals(workspacePath, records)
		const signal = signals[0]
		if (!signal) return

		const key = signalKey(signal)
		await markSignal(workspacePath, key, "offered")
		const host = hostFor(workspacePath)

		if (signal.kind === "token") {
			const across = signal.places.length > 1 ? ` across ${signal.places.length} places` : ""
			const choice = await host.notify(
				"info",
				`You've overridden ${signal.token} to ${signal.hex} ${signal.count} times${across}. Change the token itself so every use follows?`,
				["Change the token", "Keep as one-offs"],
			)
			if (choice === "Change the token") {
				await applyTokenCorrection(workspacePath, signal.token, signal.hex, signal.places)
			} else if (choice === "Keep as one-offs") {
				await markSignal(workspacePath, key, "dismissed")
			}
			return
		}

		const choice = await host.notify(
			"info",
			`You've asked for this ${signal.count} times: "${signal.instruction}". Make it a standing rule every agent sees?`,
			["Add to the rules", "Not a rule"],
		)
		if (choice === "Add to the rules") {
			await addPromotedRule(workspacePath, signal.instruction, "correction")
			Logger.info(`[design] promoted a repeated instruction into .caret/rules.json`)
		} else if (choice === "Not a rule") {
			await markSignal(workspacePath, key, "dismissed")
		}
	} catch (err) {
		// Offers are opportunistic — a failure here must never break the edit
		// that triggered the look.
		Logger.warn(`[design] correction offer failed: ${err}`)
	}
}

/** Repoints the token, regenerates the theme, and re-binds the recorded places. */
async function applyTokenCorrection(workspacePath: string, token: string, hex: string, places: string[]): Promise<void> {
	const tokens = await readFoundationTokens(workspacePath)
	if (!tokens || !setFoundationTokenValue(tokens, token, hex)) {
		await hostFor(workspacePath).notify("warn", `Couldn't change ${token} — the foundation no longer defines it.`)
		return
	}
	hostFor(workspacePath).noteSelfWrite(path.join(workspacePath, ".caret", "tokens", "foundation.json"))
	await writeFoundationTokens(workspacePath, tokens)
	await writeThemeCss(path.join(workspacePath, ".caret"))

	// Each detached place now carries a literal equal to the token — re-bind it
	// so a later token edit reaches it again. Best-effort per place.
	for (const place of places) {
		const [file, caretId] = place.split("#")
		if (!file || !caretId) continue
		const absolute = path.isAbsolute(file) ? file : path.join(workspacePath, file)
		hostFor(workspacePath).noteSelfWrite(absolute)
		await runExclusive(absolute, () => editJSXColor(absolute, 0, hex, caretId, token)).catch(() => {})
	}
	Logger.info(`[design] correction promoted: ${token} → ${hex} (${places.length} place(s) re-bound)`)
}

/**
 * "Change the token instead": repoints the foundation token at the picked
 * colour, regenerates the theme (one CSS hot update restyles every use), and
 * re-binds the detached element back onto the token class so the page source
 * doesn't keep a redundant arbitrary value that equals the token.
 */
async function handlePromoteToken(payload: PromoteTokenPayload, workspacePath: string): Promise<void> {
	try {
		await captureUndoStep(workspacePath, `promote ${payload.token} to ${payload.hex}`)
		const tokens = await readFoundationTokens(workspacePath)
		if (!tokens || !setFoundationTokenValue(tokens, payload.token, payload.hex)) {
			sendEditResult(workspacePath, {
				kind: "inline",
				success: false,
				error: `Couldn't change ${payload.token} — the foundation no longer defines that token.`,
			})
			return
		}

		hostFor(workspacePath).noteSelfWrite(path.join(workspacePath, ".caret", "tokens", "foundation.json"))
		await writeFoundationTokens(workspacePath, tokens)
		// The desktop watcher also regenerates on foundation.json changes, but the
		// promote must not depend on a watcher being alive (the shell harness has
		// none), and a second identical atomic write is harmless.
		await writeThemeCss(path.join(workspacePath, ".caret"))

		hostFor(workspacePath).noteSelfWrite(payload.filePath)
		const rebound = await runExclusive(payload.filePath, () =>
			editJSXColor(payload.filePath, payload.lineNumber, payload.hex, payload.caretId, payload.token),
		)
		if (!rebound.ok) {
			Logger.warn(`[design] promote-token: token updated but re-bind of ${payload.filePath}:${payload.lineNumber} failed`)
		}

		sendEditResult(workspacePath, {
			kind: "inline",
			success: true,
			boundTo: payload.token,
			editTarget: { filePath: payload.filePath, lineNumber: payload.lineNumber, caretId: payload.caretId },
		})
		Logger.info(`[design] promote-token: ${payload.token} → ${payload.hex}`)
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err)
		Logger.error(`[design] promote-token failed: ${errorMsg}`)
		sendEditResult(workspacePath, { kind: "inline", success: false, error: errorMsg })
	}
}

async function handleImageEdit(payload: InlineEditPayload, workspacePath: string): Promise<{ ok: boolean; reason?: string }> {
	if (!payload.imageData) return { ok: false }

	// Absorbed rule, typed refusal: a computed `src` has no literal to replace.
	if (payload.caretId) {
		const source = await fs.readFile(payload.filePath, "utf-8").catch(() => null)
		if (source !== null) {
			const srcAttr = getIndex(payload.filePath, source).elements.get(payload.caretId)?.attributes.get("src")
			if (srcAttr && srcAttr.value === null) {
				return {
					ok: false,
					reason: "This image's src is computed at runtime, so an inline swap can't reach it. Change the value it computes from, or describe the change to the agent.",
				}
			}
		}
	}

	const assetsDir = path.join(workspacePath, ".caret", "assets")
	await fs.mkdir(assetsDir, { recursive: true })

	const base64Data = payload.imageData.replace(/^data:image\/\w+;base64,/, "")
	const fileName = payload.newValue.replace(/[^a-zA-Z0-9._-]/g, "_")
	const destPath = path.join(assetsDir, fileName)

	await fs.writeFile(destPath, Buffer.from(base64Data, "base64"))

	return { ok: await editJSXImageSrc(payload.filePath, payload.lineNumber, `./assets/${fileName}`, payload.caretId) }
}

async function handlePageFocused(rawFilePath: string, workspacePath: string): Promise<void> {
	try {
		const filePath = await resolveCaretPath(rawFilePath, workspacePath)
		const result = await precomputeAndApply(filePath)
		// The RESOLVED path, never the raw one. The client stores these ranges in a
		// map keyed by file and looks them up with the absolute path the React
		// fiber reports — a payload keyed "pages/home/index.tsx" matches nothing,
		// which left the dynamic-text gate dead: "Edit text" stayed enabled on
		// `{product.name}`, and the user found out only after typing, as a failure.
		hostFor(workspacePath).sendToCanvas({
			source: "caret-host",
			type: "precompute-result",
			payload: { filePath, dynamicRanges: result.dynamicRanges },
		})
		Logger.debug(`[design] page-focused: sent ${result.dynamicRanges.length} dynamic ranges, modified=${result.modified}`)

		// Components render inside the page, so their elements are exactly as
		// clickable — and the map's item content usually lives in one (`<p>
		// {product.name}</p>` in ProductCard, driven by the page's data array).
		// Analyzed read-only: healing is the page pipeline's job, and a silent
		// write to a component from a focus event would be a surprise.
		for (const dir of ["components", "layouts"]) {
			const folder = path.join(workspacePath, ".caret", dir)
			const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => [])
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith(".tsx")) continue
				const componentPath = path.join(folder, entry.name)
				try {
					const source = await fs.readFile(componentPath, "utf-8")
					const ranges = precomputePage(source, componentPath).dynamicRanges
					hostFor(workspacePath).sendToCanvas({
						source: "caret-host",
						type: "precompute-result",
						payload: { filePath: componentPath, dynamicRanges: ranges },
					})
				} catch (err) {
					Logger.warn(`[design] page-focused: could not analyze ${componentPath}: ${err}`)
				}
			}
		}
	} catch (err) {
		Logger.error(`[design] page-focused: precompute failed for ${rawFilePath}:`, err)
	}
}

async function handleFlowEdgeCreate(payload: FlowEdgeCreatePayload, workspacePath: string): Promise<void> {
	try {
		const found = await mutateFlowDefinition(workspacePath, payload.flowId, (flow) => {
			let step = flow.steps.find((s) => s.page === payload.fromPage)
			if (!step) {
				step = { page: payload.fromPage, next: [] }
				flow.steps.push(step)
			}
			if (!step.next.includes(payload.toPage)) {
				step.next.push(payload.toPage)
			}
		})
		if (!found) {
			Logger.error(`[design] Flow not found: ${payload.flowId}`)
			return
		}
		Logger.info(`[design] Flow edge created: ${payload.flowId} ${payload.fromPage} → ${payload.toPage}`)
	} catch (err) {
		Logger.error("[design] Failed to create flow edge:", err)
	}
}

async function handleFlowEdgeDelete(payload: FlowEdgeDeletePayload, workspacePath: string): Promise<void> {
	try {
		const found = await mutateFlowDefinition(workspacePath, payload.flowId, (flow) => {
			const step = flow.steps.find((s) => s.page === payload.fromPage)
			if (!step) return
			if (payload.isError) {
				step.onError = (step.onError || []).filter((p) => p !== payload.toPage)
				if (step.onError.length === 0) delete step.onError
			} else {
				step.next = step.next.filter((p) => p !== payload.toPage)
			}
			if (step.next.length === 0 && !step.onError?.length && !step.label) {
				flow.steps = flow.steps.filter((s) => s !== step)
			}
		})
		if (!found) {
			Logger.error(`[design] Flow not found: ${payload.flowId}`)
			return
		}
		Logger.info(`[design] Flow edge deleted: ${payload.flowId} ${payload.fromPage} → ${payload.toPage}`)
	} catch (err) {
		Logger.error("[design] Failed to delete flow edge:", err)
	}
}

async function handleFlowEdgeUpdate(payload: FlowEdgeUpdatePayload, workspacePath: string): Promise<void> {
	try {
		const found = await mutateFlowDefinition(workspacePath, payload.flowId, (flow) => {
			let step = flow.steps.find((s) => s.page === payload.fromPage)
			if (!step) {
				step = { page: payload.fromPage, next: [] }
				flow.steps.push(step)
			}
			if (payload.isError) {
				const onError = (step.onError || []).filter((p) => p !== payload.oldToPage)
				if (!onError.includes(payload.newToPage)) onError.push(payload.newToPage)
				step.onError = onError
			} else {
				step.next = step.next.filter((p) => p !== payload.oldToPage)
				if (!step.next.includes(payload.newToPage)) step.next.push(payload.newToPage)
			}
		})
		if (!found) {
			Logger.error(`[design] Flow not found: ${payload.flowId}`)
			return
		}
		Logger.info(
			`[design] Flow edge updated: ${payload.flowId} ${payload.fromPage} → ${payload.oldToPage} ⇒ ${payload.newToPage}`,
		)
	} catch (err) {
		Logger.error("[design] Failed to update flow edge:", err)
	}
}
