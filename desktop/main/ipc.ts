/**
 * The `ipcMain` half of the renderer contract.
 *
 * Every handler is keyed to a project path rather than to "the current project",
 * because several project windows can be open and each has its own renderer.
 * A handler for a project that is not open returns null rather than falling back
 * to whichever one happens to be focused.
 */
import { app, dialog, ipcMain, shell } from "electron"
import * as fs from "fs/promises"
import * as path from "path"

import {
	ASSET_TYPES,
	type AssetRequest,
	assetsDirectory,
	assetUrl,
	type BackendId,
	completeSync,
	countAllTokenUses,
	describeAsset,
	type FoundationTokens,
	findAsset,
	fullLibrary,
	generateTokenScale,
	getBackend,
	LARGE_ASSET_BYTES,
	listPages,
	posterPath,
	probeBackends,
	readAssetIndex,
	readFoundationTokens,
	reindexAssets,
	retagAsset,
	rollbackSync,
	searchGoogleFonts,
	setPoster,
	validateFoundationTokens,
	type WizardAnswer,
	withDerivedScales,
	writeFoundationTokens,
} from "../../src/core/design"
import { Logger } from "../../src/shared/services/Logger"
import type { AssetRequestWire, ComposerImage } from "../shared/ipc"
import { CHANNEL_EVENTS, RENDERER_EVENTS, scrubAndTruncate, scrubText } from "../shared/telemetry"
import { buildAgentClientConfigs } from "./agent-configs"
import { capture, captureError, setTelemetryEnabled } from "./analytics"
import { acceptMark, authorMark, discardMark, holdMark } from "./authored-marks"
import { acceptShader, authorShader, discardShader, holdShader, refineHeldShader, type ShaderOutcome } from "./authored-shaders"
import { resolveNotification } from "./electron-host"
import { acceptModel3d, discardModel3d, generateModel3d } from "./generate-3d"
import {
	acceptRequestTake,
	acceptVariant,
	clarifyAssetRequest,
	discardPending,
	generationQuestions,
	recipeCards,
	recipeVariants,
	refineAssetBrief,
	refineRequestTake,
	requestTakes,
} from "./generate-assets"
import { answerInterviewPrompt, currentPrompt } from "./interview"
import { refreshMenu } from "./menu"
import { forgetRecentProject, getPrefs, setPref, setPrefs } from "./prefs"
import { regenerateRulesFiles } from "./rules/generate"
import { clearSecret, type SecretName, secretStatus, setSecret } from "./secrets"
import { type LaneTask, listTaskModels, setTaskModel, taskModel } from "./task-models"
import {
	abandonWizard,
	answerWizard,
	commitWizard,
	finishWizard,
	resumeWizard,
	retryWizard,
	startWizard,
	wizardBack,
} from "./token-wizard"
import type { DesignInboundMessage } from "./types"
import type { WindowManager } from "./window-manager"

/**
 * Image formats a vision model will actually read, mapped to their MIME types.
 *
 * A narrower list than `ASSET_TYPES` and for a different reason: that one says
 * what Caret can store, this one says what a backend can look at. AVIF and SVG
 * are storable and are not reliably readable, so they are absent here even
 * though the library accepts both.
 */
const ATTACHABLE_IMAGES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
}

/**
 * Entitlement verdicts, remembered for as long as the app runs.
 *
 * Null means the model answered. A string is the provider's refusal. Cleared by
 * a credential change, because that is the one thing that can turn a refusal
 * into an answer without the user going anywhere.
 */
const probedModels = new Map<string, string | null>()

/**
 * Which backend answers a question that is not about a running turn.
 *
 * Listing models and connecting accounts have to work *before* a backend is
 * chosen: connecting an account is the natural first thing a new user does, and
 * gating it behind "Use this" left the Accounts section empty on the screen
 * whose whole purpose is filling it. Everything that spends inference still
 * requires a deliberate choice — this is only for reading the catalogue and
 * writing credentials, both of which belong to the bundled backend regardless.
 */
function catalogueBackend() {
	return getBackend(getPrefs().backendId ?? "opencode")
}

/** ShaderOutcome → the wire, incl. the live fragment and the full knob manifest. */
function shaderOutcomeWire(shader: ShaderOutcome) {
	return {
		ok: true,
		frames: shader.framePngs.map((frame) => `data:image/png;base64,${frame.toString("base64")}`),
		fragment: shader.fragment,
		knobs: shader.uniforms.map((uniform) => ({
			name: uniform.name,
			label: uniform.label,
			type: uniform.type,
			default: uniform.default,
			...(uniform.min !== undefined ? { min: uniform.min } : {}),
			...(uniform.max !== undefined ? { max: uniform.max } : {}),
		})),
		range: shader.range,
		rounds: shader.rounds,
		model: shader.model,
	}
}

const rawHandle = ipcMain.handle.bind(ipcMain)

/**
 * `ipcMain.handle` plus product telemetry. Channels listed in CHANNEL_EVENTS
 * (desktop/shared/telemetry.ts) emit their event with `ok` and duration; every
 * other channel behaves exactly as before and emits nothing — tracking a new
 * surface requires adding it to that allowlist, never the other way round.
 * `ok` reads a result's own `ok: false` when it has one; a throw counts too.
 */
function handle(channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: never[]) => unknown): void {
	const mapped = CHANNEL_EVENTS[channel]
	if (!mapped) {
		rawHandle(channel, listener as Parameters<typeof rawHandle>[1])
		return
	}
	rawHandle(channel, async (event, ...args) => {
		const started = Date.now()
		const emit = (ok: boolean) =>
			capture(mapped.event, {
				...mapped.props?.(args),
				ok,
				duration_s: Math.round((Date.now() - started) / 1000),
			})
		try {
			const result = await (listener as (...a: unknown[]) => unknown)(event, ...args)
			const failed = typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === false
			emit(!failed)
			return result
		} catch (error) {
			emit(false)
			throw error
		}
	})
}

export function registerIpcHandlers(windows: WindowManager): void {
	// ── projects ──────────────────────────────────────────────────────────────

	handle("project:pickFolder", async () => {
		const result = await dialog.showOpenDialog({
			title: "Open a project",
			properties: ["openDirectory", "createDirectory"],
			buttonLabel: "Open",
		})
		return result.canceled ? null : (result.filePaths[0] ?? null)
	})

	handle("project:open", async (_event, projectPath: string) => {
		const window = await windows.open(projectPath)
		return window ? window.getState() : null
	})

	handle("project:close", async (_event, projectPath: string) => {
		await windows.close(projectPath)
	})

	handle("project:recents", () => windows.listRecents())

	handle("project:forgetRecent", async (_event, projectPath: string) => {
		await forgetRecentProject(projectPath)
		refreshMenu()
	})

	handle("project:state", async (_event, projectPath: string) => {
		const window = windows.get(projectPath)
		return window ? window.getState() : null
	})

	// ── tokens and fonts ──────────────────────────────────────────────────────

	handle("tokens:read", (_event, projectPath: string) => readFoundationTokens(projectPath))

	handle("tokens:write", async (_event, projectPath: string, tokens: FoundationTokens) => {
		if (!validateFoundationTokens(tokens)) {
			return { ok: false, error: "Those tokens are missing required fields (vibe, color, typography, spacing, radius)." }
		}
		try {
			// Derivation fills empty ramps and recomputes on-colours, shadows and
			// motion, so a manual edit can never leave the consequences stale.
			const derived = withDerivedScales(tokens)
			// The file's meta survives an editor that doesn't know about it, and a
			// first manual save is itself the commitment.
			const existing = await readFoundationTokens(projectPath)
			derived.meta = {
				committed: true,
				committedAt: new Date().toISOString(),
				source: "manual",
				...existing?.meta,
				...tokens.meta,
			}
			await writeFoundationTokens(projectPath, derived)
			// Rules files carry the foundation into every agent session, so they are
			// stale the instant a token changes.
			await regenerateRulesFiles(projectPath)
			return { ok: true }
		} catch (err) {
			Logger.error("[ipc] tokens:write failed:", err)
			return { ok: false, error: err instanceof Error ? err.message : String(err) }
		}
	})

	handle(
		"tokens:generateScale",
		(_event, type: "color" | "typography" | "spacing" | "radius", seed: string, options?: Record<string, unknown>) =>
			generateTokenScale(type, seed, options),
	)

	handle("tokens:blastRadius", async (_event, projectPath: string) => {
		const tokens = await readFoundationTokens(projectPath)
		return countAllTokenUses(path.join(projectPath, ".caret"), tokens)
	})

	handle("fonts:search", (_event, query: string) =>
		searchGoogleFonts(query, {
			apiKey: getPrefs().googleFontsApiKey,
			cacheFile: path.join(app.getPath("userData"), "google-fonts-catalog.json"),
		}),
	)

	// ── pages ─────────────────────────────────────────────────────────────────

	handle("pages:list", (_event, projectPath: string) => listPages(projectPath))

	// ── assets ────────────────────────────────────────────────────────────────

	handle("assets:list", async (_event, projectPath: string) => {
		const index = await readAssetIndex(projectPath)
		return index.assets.map((asset) => ({
			tag: asset.tag,
			file: asset.file,
			url: assetUrl(asset),
			kind: asset.kind,
			mime: asset.mime,
			width: asset.width,
			height: asset.height,
			bytes: asset.bytes,
			alt: asset.alt,
			description: asset.description,
			origin: asset.origin.type,
			addedAt: asset.addedAt,
			// Served from inside the assets directory, so the same path-confined
			// middleware that serves assets serves posters with no second route.
			posterUrl: asset.poster ? `/caret-assets/.posters/${encodeURIComponent(asset.poster)}` : null,
			// The whole record, not a summary — the library's provenance panel
			// shows exactly what index.json knows, so the two cannot disagree.
			...(asset.origin.type === "generated"
				? {
						generated: {
							lane: asset.origin.lane,
							producer: asset.origin.producer,
							...(asset.origin.recipeId ? { recipeId: asset.origin.recipeId } : {}),
							...(asset.origin.answers ? { answers: asset.origin.answers } : {}),
							...(asset.origin.resolved ? { resolved: asset.origin.resolved } : {}),
							...(asset.origin.postProcessed ? { postProcessed: asset.origin.postProcessed } : {}),
							...(asset.origin.cost ? { cost: asset.origin.cost } : {}),
						},
					}
				: {}),
		}))
	})

	handle("assets:pickFiles", async () => {
		const result = await dialog.showOpenDialog({
			title: "Add assets",
			properties: ["openFile", "multiSelections"],
			filters: [{ name: "Assets", extensions: Object.keys(ASSET_TYPES).map((extension) => extension.slice(1)) }],
		})
		return result.canceled ? [] : result.filePaths
	})

	/**
	 * Copies files in and lets watch-and-heal index them.
	 *
	 * Copying rather than referencing in place: an asset that lives outside the
	 * repo is not versioned with the design and breaks for the next person to
	 * clone it, which defeats the reason `.caret/` exists.
	 */
	handle("assets:add", async (_event, projectPath: string, sourcePaths: string[]) => {
		const directory = assetsDirectory(projectPath)
		await fs.mkdir(directory, { recursive: true })

		const added: string[] = []
		const rejected: Array<{ file: string; reason: string }> = []

		for (const source of sourcePaths) {
			const name = path.basename(source)
			const extension = path.extname(name).toLowerCase()

			if (!ASSET_TYPES[extension]) {
				rejected.push({ file: name, reason: `${extension || "files with no extension"} is not a supported asset type` })
				continue
			}

			try {
				const stat = await fs.stat(source)
				if (stat.size > LARGE_ASSET_BYTES) {
					// Assets live in git with the design. A warning rather than a
					// refusal: it is the user's repository and their call.
					Logger.warn(`[assets] ${name} is ${Math.round(stat.size / 1024 / 1024)}MB — consider Git LFS`)
				}

				// Never silently overwrite: two different photographs called
				// "screenshot.png" is the common case, not the rare one.
				const target = await freeName(directory, name)
				await fs.copyFile(source, path.join(directory, target))
				added.push(target)
			} catch (err) {
				rejected.push({ file: name, reason: err instanceof Error ? err.message : String(err) })
			}
		}

		await reindexAssets(projectPath).catch((err) => Logger.warn(`[assets] reindex after add failed: ${err}`))
		return { added, rejected }
	})

	/**
	 * The same thing, for a drop that carries no file on disk.
	 *
	 * Dragging an image straight out of a browser, a mail client or a preview
	 * pane is ordinary, and none of those give a path — the drop carries bytes
	 * and nothing else. Refusing them would make the drop zone work for Finder
	 * and mysteriously not for anything else.
	 */
	handle("assets:addBytes", async (_event, projectPath: string, files: Array<{ name: string; base64: string }>) => {
		const directory = assetsDirectory(projectPath)
		await fs.mkdir(directory, { recursive: true })

		const added: string[] = []
		const rejected: Array<{ file: string; reason: string }> = []

		for (const file of files) {
			// The name arrives from the renderer, so only its basename is trusted —
			// this handler writes to disk, and "../../.zshrc" is a name.
			const name = path.basename(file.name || "asset")
			const extension = path.extname(name).toLowerCase()

			if (!ASSET_TYPES[extension]) {
				rejected.push({ file: name, reason: `${extension || "files with no extension"} is not a supported asset type` })
				continue
			}

			const bytes = Buffer.from(file.base64, "base64")
			if (bytes.length === 0) {
				rejected.push({ file: name, reason: "arrived empty" })
				continue
			}
			// Bytes cross an IPC boundary as a string, so unlike the copy path this
			// one has a real ceiling. Above it, the file exists on disk somewhere and
			// the picker is the better route.
			if (bytes.length > LARGE_ASSET_BYTES) {
				rejected.push({
					file: name,
					reason: `too large to accept from this kind of drop (${Math.round(bytes.length / 1024 / 1024)}MB) — save it to disk and use Add files`,
				})
				continue
			}

			try {
				const target = await freeName(directory, name)
				await fs.writeFile(path.join(directory, target), bytes)
				added.push(target)
			} catch (err) {
				rejected.push({ file: name, reason: err instanceof Error ? err.message : String(err) })
			}
		}

		await reindexAssets(projectPath).catch((err) => Logger.warn(`[assets] reindex after add failed: ${err}`))
		return { added, rejected }
	})

	handle("assets:retag", async (_event, projectPath: string, from: string, to: string) => {
		const result = await retagAsset(projectPath, from, to)
		if (result.ok) await regenerateRulesFiles(projectPath).catch(() => {})
		return result.ok ? { ok: true } : { ok: false, error: result.reason }
	})

	handle(
		"assets:describe",
		async (_event, projectPath: string, tag: string, fields: { alt?: string; description?: string }) => {
			const result = await describeAsset(projectPath, tag, fields)
			if (result.ok) await regenerateRulesFiles(projectPath).catch(() => {})
			return result.ok ? { ok: true } : { ok: false, error: result.reason }
		},
	)

	handle("assets:setPoster", async (_event, projectPath: string, tag: string, dataUrl: string) => {
		const base64 = dataUrl.startsWith("data:image/png;base64,") ? dataUrl.slice("data:image/png;base64,".length) : null
		// The renderer is the least trusted thing that talks to this process, and
		// this handler writes a file. Only a PNG data URL is accepted, and the
		// name is derived here from the index rather than taken from the caller.
		if (!base64) return { ok: false, error: "A poster must be a PNG data URL." }

		const result = await setPoster(projectPath, tag, Buffer.from(base64, "base64"))
		return result.ok ? { ok: true } : { ok: false, error: result.reason }
	})

	handle("assets:remove", async (_event, projectPath: string, tag: string) => {
		const index = await readAssetIndex(projectPath)
		const entry = findAsset(index, tag)
		if (!entry) return { ok: false, error: `No asset tagged "${tag}".` }

		try {
			await fs.rm(path.join(assetsDirectory(projectPath), entry.file))
			// A poster outlives nothing: it is derived from the file just deleted.
			const poster = posterPath(projectPath, entry)
			if (poster) await fs.rm(poster).catch(() => {})
			await reindexAssets(projectPath)
			await regenerateRulesFiles(projectPath).catch(() => {})
			return { ok: true }
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) }
		}
	})

	// ── generated assets ──────────────────────────────────────────────────────

	handle("secrets:status", (_event, name: string) => secretStatus(name as SecretName))

	handle("secrets:set", async (_event, name: string, value: string) => {
		const result = await setSecret(name as SecretName, value)
		return result.ok ? { ok: true } : { ok: false, error: result.error }
	})

	handle("secrets:clear", (_event, name: string) => clearSecret(name as SecretName))

	handle("generate:questions", () => generationQuestions())

	// The user says what they want; these three are that path. `clarify` decides
	// whether anything more is needed, `takes` produces three of the thing they
	// asked for, `accept` writes the one they pointed at.
	handle("generate:clarify", (_event, projectPath: string, request: AssetRequest) => clarifyAssetRequest(projectPath, request))

	// The rebuild stage sits between clarify and takes: the answers become a
	// polished per-kind brief the user reads and edits before spending anything.
	handle("generate:refineBrief", (_event, projectPath: string, request: AssetRequest) => refineAssetBrief(projectPath, request))

	handle("generate:takes", (_event, projectPath: string, request: AssetRequest, aspect: string) =>
		requestTakes(projectPath, request, aspect),
	)

	handle(
		"generate:acceptTake",
		async (_event, projectPath: string, request: AssetRequest, aspect: string, variant: number, tag: string) => {
			const result = await acceptRequestTake(projectPath, request, aspect, variant, tag)
			if (result.ok) await regenerateRulesFiles(projectPath).catch(() => {})
			return result
		},
	)

	handle(
		"generate:refineTake",
		(
			_event,
			projectPath: string,
			request: AssetRequest,
			aspect: string,
			sourceVariant: number,
			note: string,
			newVariant: number,
		) => refineRequestTake(projectPath, request, aspect, sourceVariant, note, newVariant),
	)

	handle("generate:markTargets", async (_event, projectPath: string, subject: string) => {
		const { markTargetTakes } = await import("./authored-marks")
		const tokens = await readFoundationTokens(projectPath).catch(() => null)
		return markTargetTakes(projectPath, subject, tokens)
	})

	handle(
		"generate:markTargetRefine",
		async (_event, projectPath: string, sourceVariant: number, note: string, newVariant: number) => {
			const { refineMarkTarget } = await import("./authored-marks")
			const tokens = await readFoundationTokens(projectPath).catch(() => null)
			return refineMarkTarget(projectPath, sourceVariant, note, newVariant, tokens)
		},
	)

	handle("generate:mark", async (_event, projectPath: string, subject: string, targetVariant?: number) => {
		const tokens = await readFoundationTokens(projectPath).catch(() => null)
		const window = windows.get(projectPath)

		// The user's picked target is the spec the loop reproduces; a missing
		// hold is a real error, not a silent fall-back to a target they never saw.
		let target: { png: Buffer; mime: string } | undefined
		if (targetVariant !== undefined) {
			const { heldMarkTarget } = await import("./authored-marks")
			const held = heldMarkTarget(projectPath, targetVariant)
			if (!held) return { ok: false, reason: "That target is no longer held — generate target options again." }
			target = held
		}

		const result = await authorMark({
			projectPath,
			brief: subject,
			tokens,
			...(target ? { target } : {}),
			modelOverride: taskModel("mark") || undefined,
			onProgress: (update) =>
				window?.sendToChrome("generate:progress", projectPath, {
					job: "mark",
					stage: update.stage,
					...(update.round !== undefined ? { round: update.round } : {}),
					...(update.previewPng ? { preview: `data:image/png;base64,${update.previewPng.toString("base64")}` } : {}),
				}),
		})

		if (!result.ok) return { ok: false, reason: result.reason, needsAnotherModel: result.needsAnotherModel }

		holdMark(projectPath, { svg: result.svg, subject, rounds: result.rounds, model: result.model })
		return {
			ok: true,
			preview: `data:image/png;base64,${result.previewPng.toString("base64")}`,
			rounds: result.rounds,
			model: result.model,
		}
	})

	handle("generate:markAccept", async (_event, projectPath: string, tag: string) => {
		const result = await acceptMark(projectPath, tag)
		if (result.ok) await regenerateRulesFiles(projectPath).catch(() => {})
		return result.ok ? { ok: true, tag: result.tag } : { ok: false, error: result.error }
	})

	handle("generate:shader", async (_event, projectPath: string, request: AssetRequestWire) => {
		const tokens = await readFoundationTokens(projectPath).catch(() => null)
		const window = windows.get(projectPath)

		const result = await authorShader({
			projectPath,
			request: { kind: "shader", text: request.text, answers: request.answers },
			tokens,
			modelOverride: taskModel("shader") || undefined,
			onProgress: (update) =>
				window?.sendToChrome("generate:progress", projectPath, {
					job: "shader",
					stage: update.stage,
					...(update.round !== undefined ? { round: update.round } : {}),
					...(update.previewPng ? { preview: `data:image/png;base64,${update.previewPng.toString("base64")}` } : {}),
				}),
		})

		if (!result.ok) return { ok: false, reason: result.reason, needsAnotherModel: result.needsAnotherModel }

		holdShader(projectPath, { outcome: result.shader, subject: request.text.trim(), answers: request.answers })
		return shaderOutcomeWire(result.shader)
	})

	handle("generate:shaderRefine", async (_event, projectPath: string, note: string) => {
		const tokens = await readFoundationTokens(projectPath).catch(() => null)
		const window = windows.get(projectPath)
		const result = await refineHeldShader(projectPath, note, tokens, taskModel("shader") || undefined, (update) =>
			window?.sendToChrome("generate:progress", projectPath, {
				job: "shader",
				stage: update.stage,
				...(update.round !== undefined ? { round: update.round } : {}),
				...(update.previewPng ? { preview: `data:image/png;base64,${update.previewPng.toString("base64")}` } : {}),
			}),
		)
		if (!result.ok) return { ok: false, reason: result.reason, needsAnotherModel: result.needsAnotherModel }
		return shaderOutcomeWire(result.shader)
	})

	handle("generate:shaderAccept", async (_event, projectPath: string, tag: string, tuned?: Record<string, number | string>) => {
		const result = await acceptShader(projectPath, tag, tuned)
		if (result.ok) await regenerateRulesFiles(projectPath).catch(() => {})
		return result.ok ? { ok: true, tag: result.tag, componentPath: result.componentPath } : { ok: false, error: result.error }
	})

	handle("generate:model3d", async (_event, projectPath: string, sourceTag: string) => {
		const window = windows.get(projectPath)
		return generateModel3d(projectPath, sourceTag, (update) =>
			window?.sendToChrome("generate:progress", projectPath, {
				job: "model3d",
				stage: update.stage,
				...(update.detail ? { detail: update.detail } : {}),
			}),
		)
	})

	handle("generate:model3dAccept", async (_event, projectPath: string, tag: string) => {
		const result = await acceptModel3d(projectPath, tag)
		if (result.ok) await regenerateRulesFiles(projectPath).catch(() => {})
		return result.ok ? { ok: true, tag: result.tag } : { ok: false, error: result.error }
	})

	handle("generate:taskModels", (_event, task: LaneTask) => listTaskModels(task))

	handle("generate:setTaskModel", (_event, task: LaneTask, model: string) => setTaskModel(task, model))

	// Photographs that were generated and not chosen are held in memory so a pick
	// hands over the picture the user pointed at rather than a fresh one. Closing
	// the picker is the moment they stop being candidates.
	handle("generate:discard", (_event, projectPath: string) => {
		discardPending(projectPath)
		discardMark(projectPath)
		discardModel3d(projectPath)
		discardShader(projectPath)
	})

	handle("generate:recipes", (_event, projectPath: string, answers: Record<string, string>, kind?: string) =>
		recipeCards(projectPath, answers, kind),
	)

	handle(
		"generate:variants",
		(_event, projectPath: string, recipeId: string, answers: Record<string, string>, aspect: string, count: number) =>
			recipeVariants(projectPath, recipeId, answers, aspect, count),
	)

	handle(
		"generate:accept",
		async (
			_event,
			projectPath: string,
			recipeId: string,
			answers: Record<string, string>,
			aspect: string,
			variant: number,
			tag: string,
		) => {
			const result = await acceptVariant(projectPath, recipeId, answers, aspect, variant, tag)
			// A new asset changes the always-on context every agent reads, so the
			// rules files have to follow it in the same breath.
			if (result.ok) await regenerateRulesFiles(projectPath).catch(() => {})
			return result
		},
	)

	// ── sync ──────────────────────────────────────────────────────────────────

	handle("sync:now", async (_event, projectPath: string) => {
		const window = windows.get(projectPath)
		if (!window) return { status: "error", message: "That project isn't open." }
		await window.requestSync()
		return { status: "ok", message: "" }
	})

	handle("sync:rollback", (_event, projectPath: string) => rollbackSync(projectPath))

	handle("sync:markSynced", async (_event, projectPath: string) => {
		const outcome = await completeSync(projectPath)
		const message =
			outcome === "advanced"
				? "Marked as synced. The next sync will only report changes made from here."
				: outcome === "already-applied"
					? "This sync was already recorded."
					: "There's no sync waiting to be recorded."
		return { status: outcome, message }
	})

	// ── agent ─────────────────────────────────────────────────────────────────

	handle("agent:clientConfigs", (_event, projectPath: string) => {
		const window = windows.get(projectPath)
		if (!window) return []
		const mcp = window.getMcpServer()
		return buildAgentClientConfigs(projectPath, mcp.getUrl(), mcp.getToken())
	})

	// ── the coding backend ────────────────────────────────────────────────────

	handle("agent:state", (_event, projectPath: string) => {
		return windows.get(projectPath)?.getAgent().conversation.getState() ?? null
	})

	/**
	 * Fire-and-forget: a turn runs for minutes and streams its progress over
	 * `agent:state`. Making the renderer await it would hang the invoke channel
	 * for the whole turn and give it nothing the event stream has not already
	 * delivered.
	 */
	handle("agent:send", (_event, projectPath: string, text: string, images?: string[]) => {
		const agent = windows.get(projectPath)?.getAgent()
		if (!agent) return
		void agent.conversation.sendMessage(text, images).catch((err) => {
			agent.conversation.note(err instanceof Error ? err.message : String(err))
		})
	})

	/**
	 * Images for the model to look at, read here rather than in the renderer so
	 * the chat panel never needs a path or a file handle.
	 *
	 * Oversized ones are dropped rather than truncated: a data-URL that does not
	 * decode is worse than an absent one, because the turn proceeds as though the
	 * model saw something.
	 */
	handle("chat:pickImages", async () => {
		const result = await dialog.showOpenDialog({
			title: "Attach images",
			properties: ["openFile", "multiSelections"],
			filters: [{ name: "Images", extensions: Object.keys(ATTACHABLE_IMAGES).map((extension) => extension.slice(1)) }],
		})
		if (result.canceled) return []

		const attached: ComposerImage[] = []
		for (const file of result.filePaths) {
			try {
				const bytes = await fs.readFile(file)
				if (bytes.length > LARGE_ASSET_BYTES) {
					Logger.warn(`[chat] ${path.basename(file)} is too large to attach`)
					continue
				}
				const mime = ATTACHABLE_IMAGES[path.extname(file).toLowerCase()]
				if (!mime) continue
				attached.push({ name: path.basename(file), dataUrl: `data:${mime};base64,${bytes.toString("base64")}` })
			} catch (err) {
				Logger.warn(`[chat] could not attach ${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`)
			}
		}
		return attached
	})

	handle("agent:abort", async (_event, projectPath: string) => {
		await windows.get(projectPath)?.getAgent().conversation.abort()
	})

	handle(
		"agent:permission",
		async (_event, projectPath: string, requestId: string, decision: "allow" | "deny" | "allow-always") => {
			await windows.get(projectPath)?.getAgent().conversation.respondToPermission(requestId, decision)
		},
	)

	handle("agent:setMode", (_event, projectPath: string, mode: "read-only" | "write", steering?: string) => {
		return windows.get(projectPath)?.getAgent().setChatMode(mode, steering) ?? { executed: false }
	})

	handle("agent:discardPlan", (_event, projectPath: string) => {
		windows.get(projectPath)?.getAgent().discardPlan()
	})

	handle("agent:reset", (_event, projectPath: string) => {
		windows.get(projectPath)?.getAgent().conversation.reset()
	})

	handle("agent:backends", () => probeBackends())

	handle("agent:selectBackend", async (_event, id: BackendId | null) => {
		await setPref("backendId", id)
		// Every open project re-resolves, so a backend chosen in one window stops
		// the other windows refusing too.
		await Promise.all(windows.list().map((window) => window.getAgent().conversation.refreshBackend()))
	})

	/**
	 * Models grouped by provider, for the chosen backend.
	 *
	 * Empty when the backend cannot enumerate, which the picker renders as "type
	 * an id" rather than as an empty list that looks broken.
	 */
	handle("agent:models", async () => {
		try {
			return (await catalogueBackend().listModels?.()) ?? []
		} catch (err) {
			Logger.warn(`[ipc] could not list models: ${err}`)
			return []
		}
	})

	/**
	 * Subscriptions and sign-ins not yet connected.
	 *
	 * The picker shows these under the models you can already run, because "that
	 * model is behind a sign-in you have not done" and "that model does not exist"
	 * look identical from a list that only shows what works.
	 */
	handle("agent:providerDoors", async () => {
		try {
			return (await catalogueBackend().listProviderDoors?.()) ?? []
		} catch (err) {
			Logger.warn(`[ipc] could not list provider doors: ${err}`)
			return []
		}
	})

	/**
	 * Does this model actually answer?
	 *
	 * A refusal here is the provider's own sentence, handed straight back. Failing
	 * to probe is not a refusal — a network hiccup must not accuse someone's plan
	 * of not covering a model it covers — so an unknown answer reads as fine.
	 */
	handle("agent:probeModel", async (_event, projectPath: string, model: string) => {
		const id = getPrefs().backendId
		if (!id || !model) return null

		// Asked once per model per run of the app. Browsing the picker would
		// otherwise spend a turn on every model somebody tried, and entitlement
		// does not change between two clicks — it changes when a plan does, which
		// is a thing you do somewhere else and come back from.
		const remembered = probedModels.get(model)
		if (remembered !== undefined) return remembered

		try {
			const verdict = (await getBackend(id).probeModel?.(model, projectPath)) ?? null
			probedModels.set(model, verdict)
			return verdict
		} catch (err) {
			// Deliberately not remembered: a network hiccup must not brand a model
			// as refused for the rest of the session.
			Logger.warn(`[ipc] could not probe ${model}: ${err}`)
			return null
		}
	})

	/**
	 * Connects a provider: a key, or the start of the backend's own OAuth.
	 *
	 * The URL is opened here rather than handed to the renderer, because the
	 * renderer must not be able to navigate anything anywhere — and because this
	 * is the same `shell.openExternal` path every other outbound link uses.
	 */
	handle("agent:connectProvider", async (_event, providerId: string, methodId: string, key?: string) => {
		try {
			const challenge = (await catalogueBackend().connectProvider?.(providerId, methodId, key)) ?? null
			probedModels.clear()
			if (challenge) await shell.openExternal(challenge.url)
			return { ok: true as const, challenge }
		} catch (err) {
			// Shown to the user, so it says what the provider said rather than which
			// endpoint refused.
			return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
		}
	})

	handle("agent:completeOauth", async (_event, providerId: string, methodId: string, code: string) => {
		try {
			const ok = (await catalogueBackend().completeOauth?.(providerId, methodId, code)) ?? false
			probedModels.clear()
			return { ok, error: ok ? undefined : "That code was not accepted." }
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) }
		}
	})

	handle("agent:oauthStatus", async (_event, providerId: string) => {
		try {
			const status = (await catalogueBackend().oauthStatus?.(providerId)) ?? { connected: false }
			// A credential just arrived from outside Caret's own call path, so every
			// remembered entitlement verdict may have changed.
			if (status.connected) probedModels.clear()
			return status
		} catch (err) {
			Logger.warn(`[ipc] could not read oauth status for ${providerId}: ${err}`)
			return { connected: false }
		}
	})

	handle("agent:disconnectProvider", async (_event, providerId: string) => {
		try {
			await catalogueBackend().disconnectProvider?.(providerId)
			probedModels.clear()
			return true
		} catch (err) {
			Logger.warn(`[ipc] could not disconnect ${providerId}: ${err}`)
			return false
		}
	})

	handle("agent:sessions", async (_event, projectPath: string) => {
		const id = getPrefs().backendId
		if (!id) return []
		const backend = getBackend(id)
		return (await backend.listSessions?.(projectPath).catch(() => [])) ?? []
	})

	handle("agent:replay", async (_event, projectPath: string, sessionId: string) => {
		return (await windows.get(projectPath)?.getAgent().conversation.replay(sessionId)) ?? false
	})

	handle("agent:deleteSession", async (_event, projectPath: string, sessionId: string) => {
		const id = getPrefs().backendId
		if (!id) return
		await getBackend(id).deleteSession?.(projectPath, sessionId)
	})

	// ── preferences ───────────────────────────────────────────────────────────

	handle("prefs:get", () => getPrefs())

	handle("prefs:set", async (_event, patch: Record<string, unknown>) => {
		const wasEnabled = getPrefs().telemetryEnabled
		await setPrefs(patch)
		// A consent flip must reach the analytics client, not just the JSON file:
		// off tears the client down (after one farewell event), on re-arms it.
		// The notice's "Turn off" sets telemetryNoticeShown in the same patch,
		// which is what distinguishes it from the settings toggle.
		if (typeof patch.telemetryEnabled === "boolean" && patch.telemetryEnabled !== wasEnabled) {
			const at = patch.telemetryNoticeShown === true ? "first_run_notice" : "settings"
			await setTelemetryEnabled(patch.telemetryEnabled, at)
		}
		// The chat composer names the model and effort, and both live here. Without
		// this the panel writes the preference and nothing on screen moves.
		for (const window of windows.list()) window.getAgent().conversation.touch()
	})

	// Renderer-originated telemetry. The event names are validated here because
	// the renderer is the least trusted process able to reach this channel; its
	// free-text fields are scrubbed again on this side for the same reason.
	handle("analytics:event", (_event, name: string, props?: Record<string, unknown>) => {
		if (!RENDERER_EVENTS.has(name)) return
		if (name === "renderer_exception") {
			const error = new Error(scrubAndTruncate(String(props?.message ?? "renderer error")))
			if (typeof props?.stack === "string") error.stack = scrubText(props.stack).slice(0, 4000)
			captureError(error, "renderer")
			return
		}
		const surface = props?.surface
		capture(name, {
			surface:
				typeof surface === "string" && ["canvas", "foundation", "agent", "assets"].includes(surface) ? surface : "other",
		})
	})

	// ── canvas + chrome plumbing ──────────────────────────────────────────────

	handle("canvas:message", async (_event, projectPath: string, message: DesignInboundMessage) => {
		await windows.get(projectPath)?.handleCanvasMessage(message)
	})

	handle("canvas:setBounds", (_event, projectPath: string, insets: { top: number; right: number }) => {
		windows.get(projectPath)?.setChromeInsets(insets)
	})

	handle("canvas:setVisible", (_event, projectPath: string, visible: boolean) => {
		windows.get(projectPath)?.setCanvasVisible(visible)
	})

	handle("notification:respond", (_event, id: string, action: string | null) => {
		resolveNotification(id, action)
	})

	handle("interview:respond", (_event, id: string, answer: string | null) => {
		answerInterviewPrompt(id, answer)
	})

	handle("interview:library", () => fullLibrary())

	handle("interview:pending", () => currentPrompt())

	// The AI-run token wizard — the Foundation surface's default door.
	handle("wizard:resume", (_event, projectPath: string) => resumeWizard(projectPath))
	handle("wizard:start", (_event, projectPath: string, description: string, mode?: "ai-led" | "collaborative") =>
		startWizard(projectPath, description, mode ?? "collaborative"),
	)
	handle("wizard:answer", (_event, projectPath: string, answer: WizardAnswer) => answerWizard(projectPath, answer))
	handle("wizard:finishNow", (_event, projectPath: string) => finishWizard(projectPath))
	handle("wizard:retry", (_event, projectPath: string) => retryWizard(projectPath))
	handle("wizard:back", (_event, projectPath: string) => wizardBack(projectPath))
	handle("wizard:commit", (_event, projectPath: string) => commitWizard(projectPath))
	handle("wizard:abandon", (_event, projectPath: string) => abandonWizard(projectPath))
}

/**
 * A filename that is free in `directory`, suffixing `-2`, `-3`, … as needed.
 *
 * Two unrelated photographs both called `screenshot.png` is the common case when
 * dragging files in, and silently replacing the first one loses an asset a page
 * may already reference.
 */
async function freeName(directory: string, name: string): Promise<string> {
	const extension = path.extname(name)
	const base = name.slice(0, name.length - extension.length)

	for (let suffix = 1; suffix < 1000; suffix++) {
		const candidate = suffix === 1 ? name : `${base}-${suffix}${extension}`
		try {
			await fs.access(path.join(directory, candidate))
		} catch {
			return candidate
		}
	}
	throw new Error(`Could not find a free filename for "${name}".`)
}
