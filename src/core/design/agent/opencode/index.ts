/**
 * The OpenCode adapter — the reference implementation of {@link CodingBackend}.
 *
 * Ships bundled and pinned so that connecting a provider is the *only* step —
 * there is never an install to do first. It still needs one: a key, a
 * subscription, or whatever the backend itself offers. Everything here is
 * written against the shapes in
 * `protocol.ts`, which were pinned from the running binary's own OpenAPI
 * document rather than from the published SDK (see that file for why).
 *
 * Caret answers every permission request itself — see `../permissions.ts`. The
 * server config below asks about *everything* that touches the world so that
 * nothing is ever decided behind Caret's back; the `plan` agent on read-only
 * sessions is a second line, not the boundary.
 */
import { Logger } from "@/shared/services/Logger"
import {
	type AvailabilityReport,
	BackendError,
	type BackendEvent,
	type BackendSession,
	type BackendSessionSummary,
	type CodingBackend,
	type ModelGroup,
	type OauthChallenge,
	type PermissionDecision,
	type ProviderDoor,
	type SendInput,
	type StartSessionOptions,
	StructuredOutputError,
	type StructuredRequest,
	type StructuredResult,
} from "../backend"
import { EventQueue } from "../stream-utils"
import { resolveOpencodeBinary } from "./binary"
import { openEventStream, request } from "./http"
import { watchStreamErrors } from "./log-tail"
import type {
	OpencodeCatalogueModel,
	OpencodeCatalogueResponse,
	OpencodeConfig,
	OpencodeEvent,
	OpencodeFileDiff,
	OpencodePart,
	OpencodePermissionReply,
	OpencodePromptResponse,
	OpencodeProviderAuthResponse,
	OpencodeProvidersResponse,
	OpencodeSession,
	OpencodeToolState,
} from "./protocol"
import { STRUCTURED_OUTPUT_TOOL } from "./protocol"
import { ensureOpencodeServer, type RunningServer, stopOpencodeServer } from "./server"

/**
 * Passed inline via `OPENCODE_CONFIG_CONTENT`.
 *
 * Caret never writes `~/.config/opencode/*`. The user's own config and
 * credentials are still read by the binary, so an existing signed-in account is
 * picked up without a second login; this only layers Caret's requirements on
 * top.
 */
const CARET_SERVER_CONFIG: OpencodeConfig = {
	// Everything that can change the world asks. Reads do not — a plan phase that
	// prompted on every file read would be unusable, and reading is not the risk.
	permission: {
		edit: "ask",
		bash: "ask",
		webfetch: "ask",
		external_directory: "ask",
	},
	logLevel: "WARN",
}

const DECISION_TO_REPLY: Record<PermissionDecision, OpencodePermissionReply> = {
	allow: "once",
	"allow-always": "always",
	deny: "reject",
}

/** Tools whose input names a file Caret should show in the change list. */
const FILE_TOOLS = new Set(["edit", "write", "patch", "multiedit"])

/**
 * Providers whose models cost nothing per token because a plan already paid.
 *
 * The distinction the picker turns on: these report `cost: 0` the way a season
 * ticket reports no fare. Showing them as "no cost" beside a genuinely free tier
 * would invite someone to spend a monthly quota believing it was free.
 */
const SUBSCRIPTION_PROVIDERS = new Set([
	"openai",
	"github-copilot",
	"gitlab",
	"kimi-for-coding",
	"zai-coding-plan",
	"zhipuai-coding-plan",
	"poe",
	"xai",
])

/**
 * The sign-ins Caret offers, in the order it offers them.
 *
 * A shortlist of a very long catalogue, chosen on one test: a plan a developer
 * plausibly already pays for, or a key they already have. Anthropic is here for
 * its key alone — it prohibits subscription use outside its own tools, so the
 * Pro/Max sign-in other providers offer does not exist for it and Caret must not
 * imply otherwise.
 */
const OFFERED_PROVIDERS = [
	"openai",
	"kimi-for-coding",
	"zai-coding-plan",
	"zhipuai-coding-plan",
	"github-copilot",
	"anthropic",
	"opencode",
	"opencode-go",
	"google",
	"xai",
]

/** Long enough to be worth caching, short enough that a new sign-in shows up. */
const CATALOGUE_TTL_MS = 30_000

/**
 * The human sentence buried in a transport error, or an honest stand-in.
 *
 * Errors from the server carry their real reason inside a JSON body — often
 * nested, as `{ data: { message } }`. Anything else is machine noise, and
 * quoting noise at a user is worse than admitting Caret does not know: at least
 * the second is true.
 */
export function sentenceIn(raw: string, fallback = "the provider would not accept this model"): string {
	const start = raw.indexOf("{")
	if (start >= 0) {
		try {
			const body = JSON.parse(raw.slice(start)) as { message?: unknown; data?: { message?: unknown } }
			const message = body.data?.message ?? body.message
			if (typeof message === "string" && message.trim()) return message.trim()
		} catch {
			// Not JSON, or truncated. Fall through to the stand-in.
		}
	}
	return fallback
}

/**
 * The models of a provider that could actually run a turn, newest first.
 *
 * A catalogue is not a shortlist: it carries image generators, speech models and
 * embedders alongside the coding models, and none of those can hold a tool call.
 * `release_date` is how the headline model is found without Caret keeping its own
 * opinion about which one that is.
 */
function agentic(models: Record<string, OpencodeCatalogueModel>): OpencodeCatalogueModel[] {
	return Object.values(models)
		.filter(
			(model) =>
				model.status !== "deprecated" &&
				model.capabilities?.toolcall !== false &&
				model.capabilities?.output?.text !== false,
		)
		.sort((a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? ""))
}

export class OpencodeBackend implements CodingBackend {
	readonly id = "opencode" as const
	readonly providerName = "OpenCode"
	readonly displayName = "OpenCode (bundled)"

	private catalogueCache: { value: OpencodeCatalogueResponse; at: number } | null = null

	/** Browser sign-ins that ended badly, in words the panel can show. */
	private oauthFailures = new Map<string, string>()

	async availability(): Promise<AvailabilityReport> {
		const base = {
			id: this.id,
			displayName: this.displayName,
			providerName: this.providerName,
		} as const

		const binary = resolveOpencodeBinary()
		if (!binary) {
			return {
				...base,
				installed: false,
				authenticated: false,
				ready: false,
				detail: "The bundled backend is missing from this build.",
				remedy: { label: "Reinstall Caret", url: "https://github.com/precious112/caret/releases" },
			}
		}

		try {
			const server = await this.server()
			const providers = await request<OpencodeProvidersResponse>(server, "/config/providers")
			const names = providers.providers.map((p) => p.name ?? p.id)

			if (names.length === 0) {
				return {
					...base,
					installed: true,
					authenticated: false,
					ready: false,
					detail: "No model provider is reachable. Add your own API key, or sign in to OpenCode.",
					remedy: { label: "OpenCode sign-in", url: "https://opencode.ai/docs/providers" },
				}
			}

			return {
				...base,
				installed: true,
				authenticated: true,
				ready: true,
				detail: `Ready — ${names.join(", ")}.`,
			}
		} catch (err) {
			return {
				...base,
				installed: true,
				authenticated: false,
				ready: false,
				detail: err instanceof Error ? err.message : String(err),
			}
		}
	}

	async startSession(options: StartSessionOptions): Promise<BackendSession> {
		const server = await this.server()

		let id = options.resumeSessionId
		if (!id) {
			const created = await request<OpencodeSession>(server, "/session", {
				method: "POST",
				query: { directory: options.workingDirectory },
				body: { title: options.title ?? "Caret" },
			})
			id = created.id
		}

		return new OpencodeSessionHandle(server, id, options)
	}

	/**
	 * One-shot with a JSON Schema.
	 *
	 * Native first: the server forces a `StructuredOutput` tool call whose input
	 * *is* the object, so nothing is parsed out of prose and an id outside the
	 * schema's enum never reaches Caret.
	 *
	 * Falls back to prompt-and-parse, flagged `emulated`, because the native path
	 * is a **model** capability rather than a server one — a reasoning model that
	 * cannot be given a forced tool choice, or a provider whose speculative
	 * decoding has no grammar support, both fail at the provider with a message
	 * only that provider understands. Both were observed on the bundled backend's
	 * own free models. Degrading to a weaker guarantee beats a caller that works
	 * on some models and not others, and the flag is how the caller knows its own
	 * post-validation just became load-bearing.
	 */
	async structured<T>(req: StructuredRequest): Promise<StructuredResult<T>> {
		try {
			return { value: await this.promptForJson<T>(req, true), emulated: false }
		} catch (err) {
			Logger.warn(`[backend] native structured output failed, emulating: ${err}`)
			return { value: await this.promptForJson<T>(req, false), emulated: true }
		}
	}

	private async promptForJson<T>(req: StructuredRequest, native: boolean): Promise<T> {
		const server = await this.server()
		const created = await request<OpencodeSession>(server, "/session", {
			method: "POST",
			query: { directory: req.workingDirectory },
			body: { title: "Caret — structured" },
		})

		try {
			const response = await request<OpencodePromptResponse>(server, `/session/${created.id}/message`, {
				method: "POST",
				query: { directory: req.workingDirectory },
				body: {
					parts: [{ type: "text", text: native ? req.prompt : emulationPrompt(req) }],
					...(req.systemPrompt ? { system: req.systemPrompt } : {}),
					...(modelRef(req.model, req.effort) ?? {}),
					...(native ? { format: { type: "json_schema", schema: req.schema } } : {}),
					// The model is answering a question, not doing work. Every tool it
					// could reach for here is a way to spend minutes and get it wrong.
					tools: { bash: false, edit: false, write: false, webfetch: false },
				},
			})

			if (response.info.error) {
				throw new StructuredOutputError(response.info.error.data?.message ?? response.info.error.name)
			}

			if (native) {
				const part = response.parts.find((p) => p.type === "tool" && p.tool === STRUCTURED_OUTPUT_TOOL)
				const value = part && "state" in part ? (part.state as OpencodeToolState).input : undefined
				if (!value) throw new StructuredOutputError("it returned no structured answer at all")
				return value as T
			}

			const text = response.parts
				.filter((p): p is Extract<OpencodePart, { type: "text" }> => p.type === "text")
				.map((p) => p.text)
				.join("")
			return parseJsonAnswer<T>(text)
		} finally {
			await request(server, `/session/${created.id}`, {
				method: "DELETE",
				query: { directory: req.workingDirectory },
			}).catch(() => {})
		}
	}

	/**
	 * Every provider this machine is signed in to, with its models.
	 *
	 * Ids carry the provider (`opencode-go/gpt-5.6-luna`) because that is what the
	 * prompt route wants, and because it is the only way the free tier and the
	 * paid one stay distinguishable once a model is chosen.
	 *
	 * Read from the full catalogue rather than `/config/providers`, which knows
	 * the same providers but not the things the picker has to show: a context
	 * window, and whether the model can see an image.
	 */
	async listModels(): Promise<ModelGroup[]> {
		const catalogue = await this.catalogue()
		const connected = new Set(catalogue.connected)

		return catalogue.all
			.filter((provider) => connected.has(provider.id))
			.map((provider) => ({
				providerId: provider.id,
				providerName: provider.name ?? provider.id,
				subscription: SUBSCRIPTION_PROVIDERS.has(provider.id),
				models: Object.entries(provider.models ?? {})
					.filter(([, model]) => model.status !== "deprecated")
					.map(([id, model]) => ({
						id: `${provider.id}/${id}`,
						label: model.name ?? id,
						free: model.cost?.input === 0 && model.cost?.output === 0,
						contextTokens: model.limit?.context,
						seesImages: model.capabilities?.input?.image === true,
					}))
					.sort((a, b) => a.label.localeCompare(b.label)),
			}))
			.filter((group) => group.models.length > 0)
	}

	/**
	 * The subscriptions and sign-ins worth offering, minus the ones already done.
	 *
	 * Curated, and it has to be: the catalogue holds nearly two hundred providers,
	 * and a picker that lists all of them is a directory rather than an offer.
	 * What earns a place is a plan a developer plausibly already pays for. The
	 * rest stay reachable the way they always were — an environment variable, or
	 * OpenCode's own `auth login`.
	 *
	 * Auth methods come from the server rather than from Caret's imagination, so a
	 * flow that changes upstream changes here without a release. A provider the
	 * server has no method for is still offered when a key can reach it, because
	 * `env` names the variable that would.
	 */
	async listProviderDoors(): Promise<ProviderDoor[]> {
		const server = await this.server()
		const [catalogue, methodsByProvider] = await Promise.all([
			this.catalogue(),
			request<OpencodeProviderAuthResponse>(server, "/provider/auth").catch(() => ({}) as OpencodeProviderAuthResponse),
		])

		const connected = new Set(catalogue.connected)
		const doors: ProviderDoor[] = []

		for (const id of OFFERED_PROVIDERS) {
			if (connected.has(id)) continue
			const provider = catalogue.all.find((candidate) => candidate.id === id)
			if (!provider) continue

			// The id is the method's position in the server's own list, which is what
			// its authorize endpoint takes. Opaque on the way out and on the way
			// back, so the UI never learns what it means.
			const methods = (methodsByProvider[id] ?? []).map((method, index) => ({
				id: String(index),
				kind: method.type === "oauth" ? ("oauth" as const) : ("api-key" as const),
				label: method.label,
			}))
			// No published method does not mean no way in: these providers all take
			// a key, and `env` is the server telling us which one.
			if (methods.length === 0 && (provider.env?.length ?? 0) > 0) {
				methods.push({ id: "key", kind: "api-key", label: "Enter your key" })
			}
			if (methods.length === 0) continue

			doors.push({
				id,
				name: provider.name ?? id,
				methods,
				subscription: SUBSCRIPTION_PROVIDERS.has(id),
				// Three names, so the row says what it is for rather than only who
				// runs it — "Kimi For Coding" means nothing until you see `k3`. Newest
				// first, and only models that can actually drive an agent: taking
				// whatever came first in the object offered OpenAI as "GPT-4o,
				// gpt-image-1.5, GPT-5.3 Chat", two of which cannot run a turn.
				sample: agentic(provider.models ?? {})
					.slice(0, 3)
					.map((model) => model.name ?? model.id),
			})
		}

		return doors
	}

	/**
	 * Connects a provider — a key stored, or the server's own OAuth started.
	 *
	 * The key goes straight to the server rather than into Caret's own keychain,
	 * and that is deliberate: it is the server that has to present it on every
	 * request, so a copy in Caret would be a second place for a credential to
	 * leak from and a second place for it to go stale.
	 */
	async connectProvider(providerId: string, methodId: string, key?: string): Promise<OauthChallenge | null> {
		const server = await this.server()

		if (key !== undefined) {
			await request(server, `/auth/${providerId}`, { method: "PUT", body: { type: "api", key } })
			await this.reloadCredentials()
			return null
		}

		const started = await request<{ url: string; method?: string; instructions?: string }>(
			server,
			`/provider/${providerId}/oauth/authorize`,
			{ method: "POST", body: { method: Number(methodId) || 0 } },
		)

		this.oauthFailures.delete(providerId)
		const needsCode = started.method === "code"

		// **`authorize` only STARTS the flow — `callback` is what finishes it.**
		// Learned from a real sign-in that looked perfect and stored nothing: the
		// browser showed "Authorization successful", the loopback listener
		// exchanged the code, and the tokens went to a promise nobody was
		// awaiting. The server's own handler (read from the binary) holds the
		// pending flow and, for an `auto` method, `callback()` — called with no
		// code — is the await that collects the tokens and persists them. So for
		// auto flows the finish is kicked off here, unawaited: it blocks for as
		// long as the person takes in their browser, and the panel watches
		// {@link oauthStatus} for the outcome.
		if (!needsCode) void this.finishAutoOauth(providerId, Number(methodId) || 0)

		return {
			url: started.url,
			instructions: started.instructions,
			needsCode,
		}
	}

	async completeOauth(providerId: string, methodId: string, code: string): Promise<boolean> {
		const server = await this.server()
		const ok = await request<boolean>(server, `/provider/${providerId}/oauth/callback`, {
			method: "POST",
			body: { method: Number(methodId) || 0, code },
		})
		await this.reloadCredentials()
		return ok !== false
	}

	/**
	 * Where a browser sign-in stands: finished, failed, or still in the browser.
	 *
	 * The panel polls this instead of the model list because the list sits
	 * behind the catalogue cache, and because "it failed" and "it has not
	 * happened yet" render differently — one is a message, the other a spinner.
	 */
	async oauthStatus(providerId: string): Promise<{ connected: boolean; failure?: string }> {
		const failure = this.oauthFailures.get(providerId)
		if (failure) return { connected: false, failure }
		const catalogue = await this.catalogue()
		return { connected: catalogue.connected.includes(providerId) }
	}

	/**
	 * Collects and persists an `auto` OAuth — the server-side await.
	 *
	 * Runs for minutes by design: the server holds this request open until the
	 * loopback listener (or a device-code poll) completes, up to its own
	 * five-minute window. Success persists the credential server-side, so the
	 * only thing left is making the running instance notice it.
	 */
	private async finishAutoOauth(providerId: string, method: number): Promise<void> {
		try {
			const server = await this.server()
			const ok = await request<boolean>(server, `/provider/${providerId}/oauth/callback`, {
				method: "POST",
				body: { method },
			})
			if (ok === false) throw new BackendError("the provider did not accept the sign-in")
			await this.reloadCredentials()
			Logger.info(`[backend] ${providerId} connected by browser sign-in`)
		} catch (err) {
			const raw = err instanceof Error ? err.message : String(err)
			this.oauthFailures.set(providerId, sentenceIn(raw, "the sign-in did not complete"))
			Logger.warn(`[backend] ${providerId} browser sign-in did not complete: ${raw}`)
		}
	}

	async disconnectProvider(providerId: string): Promise<void> {
		const server = await this.server()
		await request(server, `/auth/${providerId}`, { method: "DELETE" })
		await this.reloadCredentials()
	}

	/**
	 * Makes the server notice a credential that just changed.
	 *
	 * **Writing the credential is not enough, and this is the trap the feature
	 * fell into first.** The server answers `/provider` and `/config/providers`
	 * from a list it builds once, on the first request that needs it, and a later
	 * `PUT /auth/:id` does not invalidate it — measured: connect a provider and it
	 * is still absent three seconds later, still absent after a fresh fetch, and
	 * present the moment the process restarts. So "Connect" would have appeared to
	 * do nothing at all, and the only clue would have been that it worked
	 * tomorrow.
	 *
	 * `POST /instance/dispose` is the invalidation. Sessions live in the server's
	 * own database rather than in that instance, so history survives; a turn
	 * streaming at this exact moment would not, which is a trade worth making for
	 * an act nobody performs mid-conversation.
	 */
	private async reloadCredentials(): Promise<void> {
		this.forgetCatalogue()
		const server = await this.server()
		await request(server, "/instance/dispose", { method: "POST" }).catch((err) => {
			// Not fatal, but the user is about to think their sign-in failed.
			Logger.warn(`[backend] credentials changed but the instance would not reload: ${err}`)
		})
	}

	/**
	 * Ask a model one trivial question, and report what it says if it refuses.
	 *
	 * Tools are all switched off: this is about whether the model answers at all,
	 * and a probe that could run a command would be a probe that could do damage.
	 */
	async probeModel(model: string, workingDirectory: string): Promise<string | null> {
		const slash = model.indexOf("/")
		if (slash <= 0) return null

		const server = await this.server()
		const session = await request<OpencodeSession>(server, "/session", {
			method: "POST",
			body: { title: "Caret: model check" },
			query: { directory: workingDirectory },
		})

		try {
			const response = await request<{ info?: { error?: { data?: { message?: string }; name?: string } } }>(
				server,
				`/session/${session.id}/message`,
				{
					method: "POST",
					query: { directory: workingDirectory },
					body: {
						parts: [{ type: "text", text: "Reply with the single word: ok" }],
						model: { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) },
						tools: { bash: false, edit: false, write: false, webfetch: false },
					},
				},
			)

			const error = response.info?.error
			if (!error) return null
			// The provider's own sentence, not Caret's guess at what it meant.
			return error.data?.message ?? error.name ?? "the provider refused this model"
		} catch (err) {
			// A refusal can also arrive as a transport error, and what `request`
			// throws is addressed to a developer: a method, a path, a status code
			// and a JSON body. Handing that to the composer would put
			// `POST /session/ses_…/message (500)` in front of somebody who asked for
			// a model. The sentence inside it is the only part they can act on.
			return sentenceIn(err instanceof Error ? err.message : String(err))
		} finally {
			await request(server, `/session/${session.id}`, { method: "DELETE", query: { directory: workingDirectory } }).catch(
				() => {},
			)
		}
	}

	/**
	 * The provider catalogue, cached.
	 *
	 * Several megabytes of JSON that changes only when the server refreshes its
	 * copy of the model registry, so re-fetching it every time the picker opens
	 * would be pure latency. Short enough that connecting a provider in the other
	 * tab shows up without a restart.
	 */
	private async catalogue(): Promise<OpencodeCatalogueResponse> {
		const now = Date.now()
		if (this.catalogueCache && now - this.catalogueCache.at < CATALOGUE_TTL_MS) return this.catalogueCache.value

		const server = await this.server()
		const value = await request<OpencodeCatalogueResponse>(server, "/provider")
		this.catalogueCache = { value, at: now }
		return value
	}

	/** Dropped when a credential changes, so a fresh sign-in is visible at once. */
	forgetCatalogue(): void {
		this.catalogueCache = null
	}

	async listSessions(workingDirectory: string): Promise<BackendSessionSummary[]> {
		const server = await this.server()
		const sessions = await request<OpencodeSession[]>(server, "/session", { query: { directory: workingDirectory } })
		return sessions
			.map((session) => ({
				id: session.id,
				title: session.title ?? "Untitled",
				updatedAt: session.time?.updated ?? session.time?.created ?? 0,
			}))
			.sort((a, b) => b.updatedAt - a.updatedAt)
	}

	async deleteSession(workingDirectory: string, sessionId: string): Promise<void> {
		const server = await this.server()
		await request(server, `/session/${sessionId}`, {
			method: "DELETE",
			query: { directory: workingDirectory },
		})
	}

	/**
	 * An old session as the events a live one would have emitted.
	 *
	 * Replaying through the same reducer that built the transcript live is the
	 * point: a history panel with its own parser is a second implementation that
	 * will eventually disagree with the first about what happened.
	 */
	async readTranscript(workingDirectory: string, sessionId: string): Promise<BackendEvent[]> {
		const server = await this.server()
		const messages = await request<Array<{ info: { id: string; role: string }; parts: OpencodePart[] }>>(
			server,
			`/session/${sessionId}/message`,
			{ query: { directory: workingDirectory } },
		)

		const events: BackendEvent[] = []
		for (const message of messages) {
			if (message.info.role === "user") {
				const text = message.parts
					.filter((part): part is Extract<OpencodePart, { type: "text" }> => part.type === "text")
					.map((part) => part.text)
					.join("")
				if (text.trim()) events.push({ type: "user-message", text })
				continue
			}

			// Assistant parts are already terminal here, so the live mapper's
			// suffix bookkeeping is exactly right: nothing was emitted before. The
			// message is announced first, as the live bus would have — the mapper
			// only maps parts of messages it has seen declared as the assistant's.
			const mapper = new EventMapper(sessionId)
			events.push(
				...mapper.map({
					type: "message.updated",
					properties: { sessionID: sessionId, info: { id: message.info.id, role: "assistant" } },
				}),
			)
			for (const part of message.parts) {
				events.push(...mapper.map({ type: "message.part.updated", properties: { sessionID: sessionId, part } }))
			}
		}
		return events
	}

	async dispose(): Promise<void> {
		await stopOpencodeServer()
	}

	private server(): Promise<RunningServer> {
		return ensureOpencodeServer({
			...CARET_SERVER_CONFIG,
			...serverConfigExtra,
			permission: { ...CARET_SERVER_CONFIG.permission, ...serverConfigExtra.permission },
		})
	}
}

/**
 * Host-supplied additions to the spawn config, merged over Caret's own.
 *
 * The desktop registers its MCP stdio bridge here — a concern the core cannot
 * own, because the bridge's path is an Electron userData detail. It also names
 * the bridge's mutating tools as permission keys, which is why `permission`
 * merges by key instead of shallowly: a host adding one gate must not silently
 * drop the core's `edit`/`bash` asks, which are the boundary everything else
 * stands on. Registered before the first session; the server spawns once per
 * process, so anything registered after it boots waits for the next launch.
 */
let serverConfigExtra: Partial<OpencodeConfig> = {}

export function extendOpencodeServerConfig(extra: Partial<OpencodeConfig>): void {
	serverConfigExtra = {
		...serverConfigExtra,
		...extra,
		permission: { ...serverConfigExtra.permission, ...extra.permission },
	}
}

/** The emulated path's instruction. Deliberately blunt — it is read by weaker models. */
function emulationPrompt(req: StructuredRequest): string {
	return [
		req.prompt,
		"",
		"Reply with a single JSON object and nothing else — no prose, no explanation, no code fence.",
		"It must satisfy this JSON Schema exactly, including every `enum`:",
		JSON.stringify(req.schema),
	].join("\n")
}

/**
 * Pulls the object out of a reply that may be wrapped in a fence or padded with
 * a sentence. Balanced-brace scanning rather than a regex: the values contain
 * prose that itself contains braces.
 */
function parseJsonAnswer<T>(text: string): T {
	const start = text.indexOf("{")
	if (start === -1) throw new StructuredOutputError("it answered with no JSON at all")

	let depth = 0
	let inString = false
	let escaped = false

	for (let index = start; index < text.length; index++) {
		const character = text[index]
		if (escaped) {
			escaped = false
			continue
		}
		if (character === "\\") {
			escaped = true
			continue
		}
		if (character === '"') inString = !inString
		if (inString) continue
		if (character === "{") depth++
		if (character === "}" && --depth === 0) {
			try {
				return JSON.parse(text.slice(start, index + 1)) as T
			} catch (err) {
				throw new StructuredOutputError(`its JSON did not parse (${err})`)
			}
		}
	}
	throw new StructuredOutputError("its JSON was cut off before it closed")
}

/**
 * `provider/model` split into the shape the prompt route wants, effort riding
 * along as the server's `variant`.
 *
 * `variant` is a TOP-LEVEL body field beside `model`, not a field inside it —
 * a variant tucked into the model ref is silently stripped and the session
 * records `"default"` (measured; the route schema in the binary lists them as
 * sibling body keys). Variants are synthesized by the server per model from
 * its capabilities (`GET /provider` shows the ladder — e.g.
 * `none,low,medium,high,xhigh,max`), and one the model does not offer is
 * ignored gracefully: recorded, matched to nothing, the turn runs at the
 * model's default (measured with a nonsense variant — no error). That makes
 * pass-through safe, with one translation: the ladders have no `minimal`, and
 * a miss means *default*, which measured near `high` — the opposite of what
 * was asked. So `minimal` becomes `low`, the lowest rung every ladder carries.
 *
 * Exported for its tests only.
 */
export function modelRef(
	model: string | undefined,
	effort?: string,
): { model: { providerID: string; modelID: string }; variant?: string } | null {
	if (!model) return null
	const slash = model.indexOf("/")
	if (slash <= 0) return null
	const variant = effort === "minimal" ? "low" : effort
	return {
		model: { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) },
		...(variant ? { variant } : {}),
	}
}

class OpencodeSessionHandle implements BackendSession {
	private aborted = false

	constructor(
		private readonly server: RunningServer,
		readonly id: string,
		private readonly options: StartSessionOptions,
	) {}

	get mode() {
		return this.options.mode
	}

	/**
	 * Streams one turn.
	 *
	 * The event subscription opens *before* the prompt is posted. The other order
	 * has a window in which a fast tool call or an immediate permission request
	 * happens before anyone is listening, and the turn then appears to hang.
	 */
	async *send(input: SendInput): AsyncIterable<BackendEvent> {
		const controller = new AbortController()
		// `directory` is not optional in practice: the server keeps one instance —
		// and one event bus — per directory, so a subscription without it listens
		// to the server process's own working directory and never sees a single
		// event from this project's session.
		const events = await openEventStream<OpencodeEvent>(this.server, "/event", controller.signal, {
			directory: this.options.workingDirectory,
		})

		// The message id is the server's to assign, never Caret's. A client id was
		// tried here (`msg_caret_<uuid>`) to recognise the user's own message on
		// the bus, and it broke resumed sessions entirely: the server's agent loop
		// orders its queue by message id, ids it generates are ascending, and a
		// foreign id sorting *before* the previous turn's assistant messages looks
		// like already-processed history — the loop enters, finds "nothing newer",
		// and exits without ever running the model. An id sorting *after* them is
		// the mirror failure: the same prompt looks perpetually unprocessed and is
		// re-run forever. The mapper recognises the user's message by role instead.
		const mapper = new EventMapper(this.id)

		// The bus and the server's own log feed one queue. The pinned server
		// retries a failed provider stream without emitting anything (see
		// log-tail.ts), so the tailer reads the log line the server DOES write
		// and synthesizes the `session.retry.scheduled` event a newer server
		// would have sent — one mapping path either way, and the tailer deletes
		// cleanly when the pin bump makes the real event arrive.
		const queue = new EventQueue<OpencodeEvent>()
		const pump = (async () => {
			try {
				for await (const event of events) queue.push(event)
			} catch {
				// The abort in finally lands here; the queue just closes.
			} finally {
				queue.close()
			}
		})()
		let retriesSeen = 0
		const tail = watchStreamErrors({
			sessionId: this.id,
			onError: (message) => {
				retriesSeen += 1
				queue.push({
					type: "session.retry.scheduled",
					properties: { sessionID: this.id, attempt: retriesSeen, error: { message } },
				})
			},
		})

		try {
			await request(this.server, `/session/${this.id}/prompt_async`, {
				method: "POST",
				query: { directory: this.options.workingDirectory },
				body: {
					parts: [
						{ type: "text", text: input.text },
						...(input.images ?? []).map((url, index) => ({
							type: "file" as const,
							mime: mimeOfDataUrl(url),
							filename: `screenshot-${index + 1}.png`,
							url,
						})),
					],
					...(this.options.systemPrompt ? { system: this.options.systemPrompt } : {}),
					...(modelRef(this.options.model, this.options.effort) ?? {}),
					// Same per-prompt `tools` map the structured path uses on /message:
					// false removes the tool from this turn entirely.
					...(input.disabledTools?.length
						? { tools: Object.fromEntries(input.disabledTools.map((tool) => [tool, false])) }
						: {}),
					// The Plan agent is a second line of defence, never the boundary:
					// upstream subagents have been reported not to inherit it.
					...(this.options.mode === "read-only" ? { agent: "plan" } : {}),
				},
			})

			for await (const event of queue) {
				for (const mapped of mapper.map(event)) {
					yield mapped
					if (mapped.type === "done") return
				}
			}
		} finally {
			tail.stop()
			controller.abort()
			await pump.catch(() => {})
		}
	}

	async respondToPermission(requestId: string, decision: PermissionDecision, feedback?: string): Promise<void> {
		// Two generations of this endpoint exist. The V2 route
		// (`/permission/{id}/reply`, body `{reply, message?}`) is the one whose
		// reject handler is a CORRECTION — feedback reaches the model's tool
		// result and the loop can continue. The legacy route
		// (`/session/{id}/permissions/{id}`) treats a reject as a thrown error:
		// the turn dies 0.2s later, unasked, and any feedback is dropped
		// (both measured). Try V2 first; fall back when it is not mounted.
		const reply = DECISION_TO_REPLY[decision]
		const message = decision === "deny" && feedback ? { message: feedback } : {}
		try {
			await request(this.server, `/permission/${requestId}/reply`, {
				method: "POST",
				query: { directory: this.options.workingDirectory },
				body: { reply, ...message },
			})
			return
		} catch (err) {
			Logger.info(`[backend] v2 permission reply unavailable (${err}) — using the legacy route`)
		}
		await request(this.server, `/session/${this.id}/permissions/${requestId}`, {
			method: "POST",
			query: { directory: this.options.workingDirectory },
			body: { response: reply, ...message },
		}).catch((err) => {
			// A permission that has already been answered (by a timeout, or by the
			// turn ending) is not worth failing the whole turn over.
			Logger.warn(`[backend] permission reply for ${requestId} was refused: ${err}`)
		})
	}

	async abort(): Promise<void> {
		if (this.aborted) return
		this.aborted = true
		await request(this.server, `/session/${this.id}/abort`, {
			method: "POST",
			query: { directory: this.options.workingDirectory },
		}).catch(() => {})
	}

	async close(): Promise<void> {
		await this.abort()
	}

	/** Backend-side diff, used only to enrich Caret's own snapshot diff. */
	async diff(): Promise<OpencodeFileDiff[]> {
		return request<OpencodeFileDiff[]>(this.server, `/session/${this.id}/diff`, {
			query: { directory: this.options.workingDirectory },
		}).catch(() => [])
	}
}

/**
 * Server events → {@link BackendEvent}.
 *
 * Stateful because the stream is two-voiced (measured on the pinned server):
 * `message.part.updated` fires at a part's creation (empty) and completion (the
 * whole text), and every token in between arrives as a `message.part.delta`
 * append. Both must be handled — deltas are the only live signal (a reasoning
 * part can grow for minutes before its completing `updated`, and a cancelled
 * turn never gets one), while the completing re-send is the catch-up if any
 * delta was missed. Emitting only the suffix beyond what was already emitted
 * keeps the two voices from double-speaking, and stays idempotent when the same
 * part is re-sent after a tool call.
 *
 * Parts are mapped only for messages the bus has announced as `role:
 * "assistant"` — the server emits `message.updated` before any of a message's
 * parts. The user's own prompt comes back over the same bus, and without this
 * the chat opens every turn by replaying it as if the model had said it.
 * Default-exclude, by role: anything not announced as the assistant's stays
 * off-screen, and no assumption is made about anyone's id scheme (see `send()`
 * for how a Caret-assigned id broke the server's queue ordering).
 *
 * Exported for its tests only.
 */
export class EventMapper {
	private emittedLength = new Map<string, number>()
	private toolStarted = new Set<string>()
	private toolFinished = new Set<string>()
	private assistantMessages = new Set<string>()
	/**
	 * What kind of stream each part id carries, learned from its creating
	 * `part.updated`. Deltas name neither a type nor a role, so this map is also
	 * the delta gate: a part that never passed the assistant-role check above
	 * never gets an entry, and its deltas stay off-screen (the user's own prompt
	 * streams over the same bus).
	 */
	private partKinds = new Map<string, "text" | "thinking">()

	constructor(private readonly sessionId: string) {}

	*map(event: OpencodeEvent): Iterable<BackendEvent> {
		return yield* this.mapEvent(event)
	}

	private *mapEvent(event: OpencodeEvent): Iterable<BackendEvent> {
		switch (event.type) {
			case "message.updated": {
				const properties = event.properties as { sessionID: string; info?: { id?: string; role?: string } }
				if (properties.sessionID !== this.sessionId) return
				const info = properties.info
				if (info?.role === "assistant" && info.id) this.assistantMessages.add(info.id)
				return
			}

			case "message.part.updated": {
				const properties = event.properties as { sessionID: string; part: OpencodePart }
				if (properties.sessionID !== this.sessionId) return
				if (!this.assistantMessages.has(properties.part.messageID)) return
				yield* this.mapPart(properties.part)
				return
			}

			case "message.part.delta": {
				const properties = event.properties as { sessionID: string; partID: string; field: string; delta: string }
				if (properties.sessionID !== this.sessionId) return
				if (properties.field !== "text" || !properties.delta) return
				const kind = this.partKinds.get(properties.partID)
				if (!kind) return
				this.emittedLength.set(
					properties.partID,
					(this.emittedLength.get(properties.partID) ?? 0) + properties.delta.length,
				)
				yield { type: kind, text: properties.delta }
				return
			}

			case "permission.asked": {
				const permission = event.properties as {
					id: string
					sessionID: string
					permission: string
					patterns: string[]
				}
				if (permission.sessionID !== this.sessionId) return
				yield {
					type: "permission",
					requestId: permission.id,
					tool: permission.permission,
					path: permission.patterns?.[0],
					summary: permission.patterns?.length
						? `${permission.permission}: ${permission.patterns.join(", ")}`
						: permission.permission,
				}
				return
			}

			case "permission.replied": {
				const replied = event.properties as { sessionID: string; requestID: string; reply: string }
				if (replied.sessionID !== this.sessionId) return
				yield { type: "permission-resolved", requestId: replied.requestID, allowed: replied.reply !== "reject" }
				return
			}

			case "session.retry.scheduled": {
				// Armed for the future: the pinned server never emits this (see
				// protocol.ts), but the first one that does turns seven silent
				// minutes into "the provider errored — retrying" in the chat.
				const retry = event.properties as {
					sessionID?: string
					attempt?: number
					error?: { name?: string; message?: string; data?: { message?: string } }
				}
				if (retry.sessionID && retry.sessionID !== this.sessionId) return
				yield {
					type: "retry",
					...(retry.attempt !== undefined ? { attempt: retry.attempt } : {}),
					...(retry.error ? { message: retry.error.data?.message ?? retry.error.message ?? retry.error.name } : {}),
				}
				return
			}

			case "session.error": {
				const properties = event.properties as {
					sessionID?: string
					error?: { name?: string; data?: { message?: string } }
				}
				if (properties.sessionID && properties.sessionID !== this.sessionId) return
				const message = properties.error?.data?.message ?? properties.error?.name ?? "the backend reported an error"
				// An aborted turn is the user pressing stop, not a failure.
				if (properties.error?.name === "MessageAbortedError") {
					yield { type: "done", text: "" }
					return
				}
				yield { type: "error", message, recoverable: true }
				yield { type: "done", text: "" }
				return
			}

			case "session.idle": {
				const properties = event.properties as { sessionID: string }
				if (properties.sessionID !== this.sessionId) return
				yield { type: "done", text: "" }
				return
			}
		}
	}

	private *mapPart(part: OpencodePart): Iterable<BackendEvent> {
		if (part.type === "text" || part.type === "reasoning") {
			// Registered before the length check on purpose: the creating
			// `part.updated` is empty, and it is what entitles the deltas to stream.
			this.partKinds.set(part.id, part.type === "text" ? "text" : "thinking")
			const text = (part as { text?: string }).text ?? ""
			const already = this.emittedLength.get(part.id) ?? 0
			if (text.length <= already) return
			this.emittedLength.set(part.id, text.length)
			yield { type: part.type === "text" ? "text" : "thinking", text: text.slice(already) }
			return
		}

		if (part.type === "tool") {
			const tool = part as { id: string; tool: string; callID: string; state: OpencodeToolState }
			const finished = tool.state.status === "completed" || tool.state.status === "error"

			if (!this.toolStarted.has(tool.callID)) {
				this.toolStarted.add(tool.callID)
				yield { type: "tool-start", callId: tool.callID, name: tool.tool, summary: describeTool(tool.tool, tool.state) }
			}

			if (finished && !this.toolFinished.has(tool.callID)) {
				this.toolFinished.add(tool.callID)
				if (tool.state.status === "completed") {
					for (const path of filePathsOf(tool.tool, tool.state)) yield { type: "file-changed", path }
				}
				yield {
					type: "tool-end",
					callId: tool.callID,
					name: tool.tool,
					ok: tool.state.status === "completed",
					summary: tool.state.status === "error" ? tool.state.error : tool.state.title,
				}
			}
			return
		}

		if (part.type === "step-finish") {
			const step = part as { cost?: number; tokens?: { input?: number; output?: number } }
			yield {
				type: "usage",
				inputTokens: step.tokens?.input,
				outputTokens: step.tokens?.output,
				costUsd: step.cost,
			}
		}
	}
}

/**
 * File changes are derived from the editing tools' own inputs rather than from
 * the server's `file.edited` event, which carries no session id — with two
 * projects open there would be no way to say whose change it was.
 */
function filePathOf(tool: string, state: OpencodeToolState): string | undefined {
	if (!FILE_TOOLS.has(tool)) return undefined
	const input = state.input ?? {}
	const candidate = input.filePath ?? input.file_path ?? input.path ?? input.file
	return typeof candidate === "string" ? candidate : undefined
}

/**
 * Every file a completed tool call touched.
 *
 * `apply_patch` carries its paths inside the patch text, not in a filePath
 * field — which made every apply_patch turn report `filesChanged: []`, and
 * everything keyed on it (the design-checks enforcement loop, the overlay
 * verify loop) silently skip exactly the turns where the model did real work.
 */
function filePathsOf(tool: string, state: OpencodeToolState): string[] {
	if (tool === "apply_patch") {
		const text = state.input?.patchText
		if (typeof text !== "string") return []
		return [...text.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((match) => match[1].trim())
	}
	const single = filePathOf(tool, state)
	return single ? [single] : []
}

function describeTool(tool: string, state: OpencodeToolState): string {
	if (state.title) return state.title
	const path = filePathOf(tool, state)
	if (path) return path
	const command = state.input?.command
	return typeof command === "string" ? command : tool
}

function mimeOfDataUrl(url: string): string {
	const match = url.match(/^data:([^;,]+)/)
	return match ? match[1] : "image/png"
}

export { CARET_SERVER_CONFIG }
