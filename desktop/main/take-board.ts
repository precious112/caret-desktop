/**
 * The take board behind Generate an asset: every take ever made in one sitting,
 * as a tree.
 *
 * The first round is a branch with no parent. Changing a take grows a new
 * branch whose parent is that exact take, made with the take itself as the
 * reference picture. Nothing is ever overwritten: takes have ids of their own,
 * where the old picker numbered them 0 to 3 per round and a second round with
 * the same words replaced the first round's pictures under the same keys.
 *
 * Takes are made one at a time (the image client queues every call in the
 * process) and reported as each one lands, so the board fills in instead of
 * waiting a minute for the slowest. A take can be cancelled while it waits or
 * while it is being made.
 *
 * Saving a take keeps the board: the old picker threw every other take away on
 * the first save. The board goes when the screen closes, or after two hours.
 *
 * Electron-free on purpose. Everything that needs the app (image keying and
 * resizing, the brief writer, the key) arrives as a dependency, so the whole
 * board runs in unit tests against a fake image service.
 */
import {
	ASPECTS,
	type AssetRequest,
	addGeneratedAsset,
	composeExactRequest,
	composeVariants,
	derivePalette,
	describeVariant,
	type FoundationTokens,
	type GeminiConfig,
	GeminiImages,
	type GenerationAnswers,
	NO_RASTER_REASON,
	recipeForRequest,
} from "../../src/core/design"
import { Logger } from "../../src/shared/services/Logger"
import type {
	BoardBranchWire,
	BoardStartWire,
	BoardTakeStatusWire,
	BoardTakeWire,
	BoardWire,
	TakeChangeWire,
	WriteResult,
} from "../shared/ipc"
import { ANCHOR_PREAMBLE } from "./anchor-preamble"

/** First takes per round, and takes per change. Every one is a paid call. */
export const FIRST_TAKES = 4
export const CHANGE_TAKES = 2

/** A board nobody has touched in this long is dropped on the next start. */
const BOARD_TTL_MS = 2 * 60 * 60 * 1000

/** What the board needs from the app. */
export interface BoardDeps {
	config(): GeminiConfig | null
	tokens(projectPath: string): Promise<FoundationTokens | null>
	styleAnchor(projectPath: string, tag: string): Promise<{ bytes: Buffer; mime: string } | undefined>
	/** Keys a photograph made on white into a transparent cutout. */
	cutOut(bytes: Buffer): Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: string }>
	/** The resize and re-encode applied to the one take that is saved. */
	postProcess(
		bytes: Buffer,
		width: number,
		height: number,
		options: { preserveAlpha: boolean },
	): Promise<{ bytes: Buffer; mime: string; extension: string; width: number; height: number; originalBytes: number }>
	/** A small preview for the board, as a data URL. */
	preview(bytes: Buffer, mime: string): Promise<string>
	/**
	 * For a board with no background: waits for the cutout tool, which is
	 * downloaded once per machine, reporting progress. Without this every take
	 * of a first cutout failed after being paid for, because the tool was not
	 * there to cut it out.
	 */
	cutoutReady(onProgress: (label: string) => void): Promise<{ ok: true } | { ok: false; reason: string }>
	/** "Polish it": Caret's brief for the words, or null when it cannot write one. */
	polish(projectPath: string, request: AssetRequest): Promise<{ prompt: string } | null>
	/** Every change to a board, for the screen. */
	emit(projectPath: string, board: BoardWire): void
}

interface TakeRecord {
	id: string
	branchId: string
	index: number
	status: BoardTakeStatusWire
	error?: string
	retryable?: boolean
	bytes?: Buffer
	mime?: string
	/** The prompt as sent, with the chain of changes it came through. */
	resolved?: string
	model?: string
	usage?: { promptTokens: number; outputTokens: number; totalTokens: number }
	preview?: string
	savedAs?: string
	controller: AbortController
}

interface BranchRecord extends BoardBranchWire {}

interface Board {
	id: string
	version: number
	projectPath: string
	request: AssetRequest & { styleAnchor?: string }
	aspect: string
	mode: BoardStartWire["mode"]
	keepFoundationLook: boolean
	brief?: string
	briefNote?: string
	briefing: boolean
	preparing?: string
	surface: string
	branches: BranchRecord[]
	takes: Map<string, TakeRecord>
	nextTake: number
	nextBranch: number
	touchedAt: number
	closed: boolean
}

const boards = new Map<string, Board>()
let boardSeq = 0

/** The words a change chip stands for, as an instruction to the image model. */
const CHIP_INSTRUCTIONS: Record<string, string> = {
	"warmer light": "make the light warmer",
	"cooler light": "make the light cooler",
	"closer in": "move the camera closer to the subject",
	"further back": "move the camera further back",
	"simpler background": "simplify the background",
	"more room for text": "leave more empty space around the subject for a headline",
	"different angle": "show it from a different angle",
}

/** The change as the board labels it: the chips and the words, as the person said them. */
export function changeLabel(change: TakeChangeWire): string {
	const parts = [...change.chips.map((chip) => chip.trim().toLowerCase()), change.note.trim()].filter(Boolean)
	return parts.join(", ") || "a little different"
}

/**
 * The instruction sent with the parent take as the reference picture.
 *
 * Subtle keeps everything the change does not name, which is how the old
 * refine worked and what converges on a nearly-right take. Strong keeps only
 * the subject, for when the take is right about what but wrong about how.
 */
export function changePrompt(change: TakeChangeWire, transparent: boolean): string {
	const what =
		[
			...change.chips.map((chip) => CHIP_INSTRUCTIONS[chip.trim().toLowerCase()] ?? chip.trim()),
			change.note.trim().replace(/\.$/, ""),
		]
			.filter(Boolean)
			.join("; ") || "make a close variation"
	const lines =
		change.strength === "strong"
			? [
					`Use the reference image as the starting point and make a bolder version of it: ${what}.`,
					"Keep the same subject as the reference; the framing, light and setting may change.",
				]
			: [
					`Edit the reference image: ${what}.`,
					"Change only what the instruction names — keep the same subject, style, light and framing as the reference everywhere else.",
				]
	if (transparent) lines.push("The background stays pure flat white (#ffffff) filling every edge of the frame.")
	return lines.join(" ")
}

function sizeOf(aspect: string): { width: number; height: number } {
	const size = ASPECTS[aspect]
	return { width: size?.width ?? 0, height: size?.height ?? 0 }
}

function snapshot(board: Board): BoardWire {
	const { width, height } = sizeOf(board.aspect)
	return {
		id: board.id,
		version: board.version,
		kind: board.request.kind,
		aspect: board.aspect,
		surface: board.surface,
		transparent: board.request.transparent === true,
		mode: board.mode,
		yourWords: board.request.text.trim(),
		...(board.brief ? { brief: board.brief } : {}),
		...(board.briefNote ? { briefNote: board.briefNote } : {}),
		briefing: board.briefing,
		...(board.preparing ? { preparing: board.preparing } : {}),
		branches: board.branches.map((branch) => ({ ...branch, takeIds: [...branch.takeIds] })),
		takes: [...board.takes.values()].map(
			(take): BoardTakeWire => ({
				id: take.id,
				branchId: take.branchId,
				index: take.index,
				status: take.status,
				...(take.preview ? { preview: take.preview } : {}),
				width,
				height,
				...(take.error ? { error: take.error } : {}),
				...(take.retryable ? { retryable: true } : {}),
				...(take.savedAs ? { savedAs: take.savedAs } : {}),
			}),
		),
	}
}

function changed(deps: BoardDeps, board: Board): void {
	if (board.closed) return
	board.version++
	board.touchedAt = Date.now()
	deps.emit(board.projectPath, snapshot(board))
}

function addBranch(board: Board, branch: Omit<BranchRecord, "id" | "takeIds">, count: number): BranchRecord {
	const record: BranchRecord = { ...branch, id: `b${board.nextBranch++}`, takeIds: [] }
	for (let index = 0; index < count; index++) {
		const take: TakeRecord = {
			id: `t${board.nextTake++}`,
			branchId: record.id,
			index,
			status: "waiting",
			controller: new AbortController(),
		}
		board.takes.set(take.id, take)
		record.takeIds.push(take.id)
	}
	board.branches.push(record)
	return record
}

function failAll(board: Board, branch: BranchRecord, reason: string): void {
	for (const id of branch.takeIds) {
		const take = board.takes.get(id)
		if (take && take.status !== "cancelled") Object.assign(take, { status: "failed", error: reason })
	}
}

/** Makes one take and records how it went. Never throws. */
async function makeTake(
	deps: BoardDeps,
	board: Board,
	take: TakeRecord,
	client: GeminiImages,
	call: { prompt: string; avoid: string[]; references?: Array<{ mime: string; base64: string }> },
	chain: string,
): Promise<void> {
	// Status changes under this function while it awaits (a cancel), so it is
	// re-read through a function rather than narrowed once.
	const stopped = (): boolean => take.status === "cancelled" || board.closed
	if (stopped()) return
	const transparent = board.request.transparent === true
	const result = await client.generate({
		prompt: call.prompt,
		avoid: call.avoid,
		aspect: board.aspect,
		...(call.references ? { references: call.references } : {}),
		signal: take.controller.signal,
		onStart: () => {
			if (take.status !== "waiting") return
			take.status = "working"
			changed(deps, board)
		},
	})
	if (stopped()) return
	if (!result.ok) {
		if (result.cancelled) take.status = "cancelled"
		else {
			Logger.warn(`[board] take ${take.id} failed: ${result.reason}`)
			Object.assign(take, { status: "failed", error: result.reason, retryable: result.retryable })
		}
		changed(deps, board)
		return
	}

	let bytes = result.bytes
	let mime = result.mime
	if (transparent) {
		// Keyed before it is shown, so the picture on the board is the finished cutout.
		const keyed = await deps.cutOut(result.bytes)
		if (!keyed.ok) {
			Object.assign(take, { status: "failed", error: keyed.reason })
			changed(deps, board)
			return
		}
		bytes = keyed.bytes
		mime = "image/png"
	}
	if (stopped()) return
	Object.assign(take, {
		status: "ready",
		bytes,
		mime,
		resolved: chain ? `${chain}\n\n${result.resolved}` : result.resolved,
		model: result.model,
		...(result.usage ? { usage: result.usage } : {}),
		preview: await deps.preview(bytes, mime),
	})
	changed(deps, board)
}

/** The first takes' prompts: Caret's composition from the brief or the words, or the words exactly. */
async function firstPrompts(
	deps: BoardDeps,
	board: Board,
): Promise<Array<{ prompt: string; avoid: string[]; references?: Array<{ mime: string; base64: string }> }>> {
	const tokens = await deps.tokens(board.projectPath).catch(() => null)
	const palette = derivePalette(tokens)
	const words = board.brief ?? board.request.text
	const request: AssetRequest = { ...board.request, text: words }
	let calls: Array<{ prompt: string; avoid: string[] }>
	if (board.mode === "exact") {
		const exact = composeExactRequest(board.request, {
			palette,
			aspect: board.aspect,
			keepFoundationLook: board.keepFoundationLook,
		})
		calls = Array.from({ length: FIRST_TAKES }, () => ({ prompt: exact.prompt, avoid: exact.avoid }))
	} else {
		const recipe = recipeForRequest(request)
		calls = composeVariants({ recipe, tokens, aspect: board.aspect, answers: answersOf(board), count: FIRST_TAKES }).map(
			(variant) =>
				variant.request.lane === "raster"
					? { prompt: variant.request.prompt, avoid: variant.request.avoid }
					: { prompt: words, avoid: [] },
		)
	}
	// The anchor is a light-and-grade reference only, and is said to be.
	const anchor =
		board.request.styleAnchor && board.request.kind === "image" && !board.request.transparent
			? await deps.styleAnchor(board.projectPath, board.request.styleAnchor)
			: undefined
	if (!anchor) return calls
	return calls.map((call) => ({
		prompt: `${ANCHOR_PREAMBLE}\n\n${call.prompt}`,
		avoid: call.avoid,
		references: [{ mime: anchor.mime, base64: anchor.bytes.toString("base64") }],
	}))
}

/** What was asked, for provenance: the person's words, their answers, and how the prompt was made. */
function answersOf(board: Board): GenerationAnswers {
	return {
		asked: board.request.text.trim(),
		...(board.request.answers ?? {}),
		promptHelp: board.mode,
	}
}

function pruneBoards(): void {
	const cutoff = Date.now() - BOARD_TTL_MS
	for (const [projectPath, board] of boards) {
		if (board.touchedAt < cutoff) closeBoard(projectPath)
	}
}

/**
 * Starts a board: the first takes, all at once.
 *
 * Returns straight away, with the takes waiting; each change after that
 * (the brief written, a take started, a take landed) arrives through `emit`.
 * A board already open for the project is closed first.
 */
export function startBoard(deps: BoardDeps, projectPath: string, start: BoardStartWire): BoardWire {
	pruneBoards()
	closeBoard(projectPath)
	const request = start.request as AssetRequest & { styleAnchor?: string }
	const aspect = start.aspect || recipeForRequest(request).aspects[0]
	const board: Board = {
		id: `board-${++boardSeq}`,
		version: 0,
		projectPath,
		request,
		aspect,
		mode: start.mode,
		keepFoundationLook: start.keepFoundationLook !== false,
		...(start.mode === "ask" && start.brief?.trim() ? { brief: start.brief.trim() } : {}),
		briefing: start.mode === "polish",
		surface: "#ffffff",
		branches: [],
		takes: new Map(),
		nextTake: 1,
		nextBranch: 1,
		touchedAt: Date.now(),
		closed: false,
	}
	const source = start.mode === "exact" ? "exact" : start.mode === "ask" && board.brief ? "brief" : "yours"
	const first = addBranch(board, { parentTakeId: null, label: "First takes", source }, FIRST_TAKES)
	boards.set(projectPath, board)

	void (async () => {
		const tokens = await deps.tokens(projectPath).catch(() => null)
		board.surface = derivePalette(tokens).surface
		const config = deps.config()
		if (!config) {
			board.briefing = false
			failAll(board, first, NO_RASTER_REASON)
			changed(deps, board)
			return
		}
		if (board.request.transparent) {
			board.preparing = "Getting the cutout tool ready…"
			changed(deps, board)
			const ready = await deps
				.cutoutReady((label) => {
					board.preparing = `Getting the cutout tool ready (${label}). Nothing is spent until it is.`
					changed(deps, board)
				})
				.catch((err) => ({ ok: false as const, reason: String(err) }))
			if (board.closed) return
			board.preparing = undefined
			if (!ready.ok) {
				board.briefing = false
				failAll(board, first, ready.reason)
				changed(deps, board)
				return
			}
		}
		if (board.mode === "polish") {
			const brief = await deps.polish(projectPath, request).catch(() => null)
			if (board.closed) return
			board.briefing = false
			if (brief?.prompt.trim()) {
				board.brief = brief.prompt.trim()
				first.source = "brief"
			} else {
				board.briefNote =
					"Caret couldn't write a brief (is an AI model connected in Backend?), so these takes use your words with your foundation's defaults."
			}
		}
		changed(deps, board)
		const calls = await firstPrompts(deps, board)
		const client = new GeminiImages(config)
		await Promise.all(
			first.takeIds.map((id, index) => {
				const take = board.takes.get(id)
				return take ? makeTake(deps, board, take, client, calls[index], "") : undefined
			}),
		)
	})().catch((err) => Logger.error(`[board] first takes failed: ${err}`))

	return snapshot(board)
}

/**
 * Grows a branch from one take: the take is sent as the reference picture,
 * with the change as the instruction. Refused (with a reason) for a take that
 * is not ready; the board is returned unchanged then.
 */
export function branchTake(
	deps: BoardDeps,
	projectPath: string,
	takeId: string,
	change: TakeChangeWire,
): { ok: true; board: BoardWire } | { ok: false; error: string } {
	const board = boards.get(projectPath)
	if (!board) return { ok: false, error: "This board was closed. Generate again to start a new one." }
	const parent = board.takes.get(takeId)
	if (!parent?.bytes || parent.status !== "ready") {
		return { ok: false, error: "That take isn't ready, so nothing can grow from it yet." }
	}
	const config = deps.config()
	if (!config) return { ok: false, error: NO_RASTER_REASON }

	const transparent = board.request.transparent === true
	const parentBranch = board.branches.find((branch) => branch.id === parent.branchId)
	const branch = addBranch(
		board,
		{
			parentTakeId: parent.id,
			label: changeLabel(change),
			strength: change.strength,
			source: parentBranch?.source ?? "yours",
		},
		CHANGE_TAKES,
	)
	changed(deps, board)
	const prompt = changePrompt(change, transparent)
	const chain = `${parent.resolved ?? ""}\n\n[changed from take ${parent.id}]`.trim()
	const client = new GeminiImages(config)
	const references = [{ mime: parent.mime ?? "image/png", base64: parent.bytes.toString("base64") }]
	void Promise.all(
		branch.takeIds.map((id) => {
			const take = board.takes.get(id)
			return take ? makeTake(deps, board, take, client, { prompt, avoid: [], references }, chain) : undefined
		}),
	).catch((err) => Logger.error(`[board] branch failed: ${err}`))
	return { ok: true, board: snapshot(board) }
}

/** Cancels takes that are waiting or being made: the named ones, or every one. */
export function cancelTakes(deps: BoardDeps, projectPath: string, takeIds?: string[]): BoardWire | null {
	const board = boards.get(projectPath)
	if (!board) return null
	let any = false
	for (const take of board.takes.values()) {
		if (takeIds && !takeIds.includes(take.id)) continue
		if (take.status !== "waiting" && take.status !== "working") continue
		take.status = "cancelled"
		take.controller.abort()
		any = true
	}
	if (any) changed(deps, board)
	return snapshot(board)
}

/** The full-size picture of one take, for the full-size view. */
export function takePicture(projectPath: string, takeId: string): string | null {
	const take = boards.get(projectPath)?.takes.get(takeId)
	if (!take?.bytes) return null
	return `data:${take.mime ?? "image/png"};base64,${take.bytes.toString("base64")}`
}

export function boardSnapshot(projectPath: string): BoardWire | null {
	const board = boards.get(projectPath)
	return board ? snapshot(board) : null
}

/**
 * Saves one take to the asset library. The board stays open, so another take
 * can be saved too. A take saved twice is saved twice: the library gives the
 * second copy its own name.
 */
export async function saveTake(
	deps: BoardDeps,
	projectPath: string,
	takeId: string,
	tag: string,
): Promise<WriteResult & { tag?: string }> {
	const board = boards.get(projectPath)
	const take = board?.takes.get(takeId)
	if (!board || !take) {
		return {
			ok: false,
			error: "That take is no longer held. Generate again and pick one; asking again would make a different picture.",
		}
	}
	if (!take.bytes || take.status !== "ready") return { ok: false, error: "That take isn't ready yet." }

	const tokens = await deps.tokens(projectPath).catch(() => null)
	const palette = derivePalette(tokens)
	const recipe = recipeForRequest(board.request)
	const composed = composeVariants({ recipe, tokens, aspect: board.aspect, answers: answersOf(board), count: 1 })[0]
	const { width, height } = sizeOf(board.aspect)
	const transparent = board.request.transparent === true
	const processed = await deps.postProcess(take.bytes, width || composed.width, height || composed.height, {
		preserveAlpha: transparent,
	})
	const used = [...board.takes.values()].filter((other) => other.usage)
	const result = await addGeneratedAsset({
		projectPath,
		tag: tag.trim() || "asset",
		extension: processed.extension,
		bytes: processed.bytes,
		description: describeVariant(recipe, composed, palette),
		alt: "",
		origin: {
			type: "generated",
			lane: "raster",
			producer: take.model ?? "unknown",
			recipeId: recipe.id,
			answers: { ...answersOf(board), ...(board.brief ? { brief: board.brief } : {}) },
			resolved: take.resolved ?? "",
			...(take.usage
				? {
						cost: {
							unit: "tokens" as const,
							amount: take.usage.totalTokens,
							round: {
								calls: used.length,
								amount: used.reduce((sum, other) => sum + (other.usage?.totalTokens ?? 0), 0),
							},
							note: "as metered by the provider's own usage report; the round is every take on this board",
						},
					}
				: {}),
			postProcessed: {
				from: { bytes: processed.originalBytes, mime: take.mime ?? "image/png" },
				to: { bytes: processed.bytes.length, mime: processed.mime, width: processed.width, height: processed.height },
			},
		},
	})
	if (!result.ok) return { ok: false, error: result.reason }
	take.savedAs = result.entry.tag
	changed(deps, board)
	return { ok: true, tag: result.entry.tag }
}

/** Cancels everything still running and forgets the board. */
export function closeBoard(projectPath: string): void {
	const board = boards.get(projectPath)
	if (!board) return
	board.closed = true
	for (const take of board.takes.values()) take.controller.abort()
	boards.delete(projectPath)
}
