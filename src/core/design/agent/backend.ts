/**
 * The coding-backend seam.
 *
 * Caret owns the loop for everything that starts in Caret's window — sync, AI
 * edits, the overlay editor, the foundation interview. MCP cannot carry that
 * direction (it is client-initiated), so those features run on an agent Caret
 * drives itself, behind this interface.
 *
 * All adapters conform to this. Anything a backend emits that does not map onto
 * {@link BackendEvent} is dropped rather than passed through half-understood — a
 * half-understood event in a chat transcript reads as a bug in Caret.
 *
 * Running with **no** backend is a supported state. Every feature that needs one
 * refuses with {@link NoBackendError}, which names the fix.
 */

/**
 * One backend, and the seam is still worth having.
 *
 * Caret shipped adapters for the Claude, Codex and Kimi CLIs and has now removed
 * all three, because wrapping a vendor's own agent loop was the wrong place to
 * spend: each one arrived with a different permission story, a different
 * structured-output dialect, its own way of dropping images, and its own
 * approval gate in front of Caret's tools — four rewrites of work OpenCode had
 * already done. What the user actually wanted from those adapters was their
 * *subscriptions*, and the bundled backend reaches those directly as providers:
 * ChatGPT Plus/Pro/Go, Kimi For Coding, the Z.AI and Zhipu coding plans, Copilot.
 * Anthropic is the exception and cannot be fixed here — it prohibits
 * subscription use outside its own tools, so Claude arrives by API key.
 *
 * The interface stays because it is what keeps the design core host-free and
 * testable, and because Caret hosting its own inference would arrive through it.
 * A union of one is honest; a second member has to earn its keep.
 */
export type BackendId = "opencode"

/** What a session is allowed to do. Enforced by Caret, not by backend config. */
export type SessionMode = "read-only" | "write"

/**
 * How hard the model should think.
 *
 * Named in the vocabulary the backends themselves use rather than Caret's own,
 * because every one of them already has a spelling for this and inventing a
 * fifth would mean a mapping table that is wrong for somebody. Backends without
 * the concept ignore it — see each adapter.
 */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh"

/**
 * A model, and who serves it.
 *
 * The distinction is not pedantry. A *backend* is the agent loop Caret drives.
 * A *provider* is who serves the weights, and one backend reaches many: the
 * bundled OpenCode sees its own Go and Zen plans, a ChatGPT subscription, Kimi
 * For Coding, the GLM coding plans, and anything reachable by key — which differ
 * in whether they cost money and in whose money it is. Collapsing the two is how
 * a backend's name ends up displayed where a model's belongs.
 */
export interface ModelOption {
	/** What Caret persists and sends, in the backend's own namespace. */
	id: string
	/** What the user reads, without the provider prefix. */
	label: string
	/**
	 * Nothing to pay per token.
	 *
	 * Two different situations wear this flag and the picker must not conflate
	 * them: a genuinely free tier, and a subscription already paid for. See
	 * {@link ModelGroup.subscription} — that is the one that says which.
	 */
	free?: boolean
	/** Context window in tokens, when the provider states one. */
	contextTokens?: number
	/**
	 * Whether the model accepts images.
	 *
	 * Load-bearing rather than decorative: the overlay editor sends screenshots,
	 * and a model that cannot see them does not fail — it invents what it "saw".
	 */
	seesImages?: boolean
}

export interface ModelGroup {
	providerId: string
	providerName: string
	models: ModelOption[]
	/**
	 * A plan rather than a meter — a ChatGPT sign-in, Kimi For Coding, a GLM
	 * coding plan. Its models report no per-token cost because there is none to
	 * report, which is *not* the same as free, and telling a user "no cost" about
	 * a quota they are burning would be a lie by omission.
	 */
	subscription?: boolean
}

/**
 * A provider that could be connected, and the ways in.
 *
 * Caret shows these because "the model you want lives behind a sign-in you have
 * not done" is a different state from "that model does not exist", and only one
 * of them is worth a button.
 */
export interface ProviderDoor {
	id: string
	name: string
	/** In the backend's own words — it owns these flows, Caret only offers them. */
	methods: ProviderAuthMethod[]
	/** True when this is a plan somebody may already be paying for. */
	subscription: boolean
	/** What connecting it would put within reach, for the row's one line. */
	sample: string[]
}

export interface ProviderAuthMethod {
	/** Opaque to the UI: hand it back to {@link CodingBackend.connectProvider}. */
	id: string
	kind: "oauth" | "api-key"
	label: string
}

/**
 * What the user has to do next to finish signing in.
 *
 * Returned by an OAuth start. Caret opens the URL and then either waits — the
 * backend's own loopback listener finishes it — or asks for the code the page
 * shows, which is what a headless flow needs.
 */
export interface OauthChallenge {
	url: string
	instructions?: string
	/** True when the user must paste something back. False means: just wait. */
	needsCode: boolean
}

export interface StartSessionOptions {
	workingDirectory: string
	/** `read-only` is the plan phase: the agent may read anything and write nothing. */
	mode: SessionMode
	/** Backend's own model namespace. Omitted means the backend's default. */
	model?: string
	/** Omitted means the backend's default, which is not always "some". */
	effort?: ReasoningEffort
	resumeSessionId?: string
	title?: string
	/** Prepended to the backend's own system prompt (foundations, rules, assets). */
	systemPrompt?: string
}

export type PermissionDecision = "allow" | "deny" | "allow-always"

export interface SendInput {
	text: string
	/** Data URLs. The overlay editor sends screenshots this way. */
	images?: string[]
	/**
	 * Tool names the backend must not offer the model THIS turn (the backend's
	 * own namespace, e.g. `caret_get_screenshot`). Playground takes bar the
	 * screenshot tool: the human is watching the page render live, so a
	 * screenshot spends minutes verifying what is already on screen.
	 */
	disabledTools?: string[]
}

export type BackendEvent =
	/**
	 * Replay only. A live turn never emits this — the caller already knows what it
	 * sent — but rehydrating an old session has to put the user's own turns back
	 * or the transcript reads as the agent talking to itself.
	 */
	| { type: "user-message"; text: string }
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "tool-start"; callId: string; name: string; summary: string }
	| { type: "tool-end"; callId: string; name: string; ok: boolean; summary?: string }
	| { type: "file-changed"; path: string }
	| { type: "permission"; requestId: string; tool: string; path?: string; summary: string }
	/**
	 * The backend settled a permission by a path that never went through Caret —
	 * its own config allowed it, a timeout rejected it. Without this, the ask
	 * stays on screen as live buttons while the agent visibly moves on: a ghost
	 * request nobody can act on.
	 */
	| { type: "permission-resolved"; requestId: string; allowed: boolean }
	| { type: "usage"; inputTokens?: number; outputTokens?: number; costUsd?: number }
	/**
	 * The backend's provider call failed and the backend is retrying on its
	 * own. Not an error: the turn is still alive, and marking it failed would
	 * be wrong. What it is, is the difference between "thinking" and "banging
	 * on a dead door" — a user watched Working… for seven minutes while the
	 * provider said "Endpoint is unavailable" twice where only a log could
	 * hear it.
	 */
	| { type: "retry"; attempt?: number; message?: string }
	| { type: "done"; text: string }
	| { type: "error"; message: string; recoverable: boolean }

export interface BackendSession {
	readonly id: string
	readonly mode: SessionMode
	/** Streams normalised events until the turn finishes. */
	send(input: SendInput): AsyncIterable<BackendEvent>
	/**
	 * `feedback` rides a deny to the MODEL, not the transcript: the server
	 * formats it as "rejected … with the following feedback: {feedback}". A bare
	 * rejection reads as "the user doesn't want this, stop" — one provider route
	 * was measured ending the whole turn on it — while a reason teaches the
	 * model what to do instead.
	 */
	respondToPermission(requestId: string, decision: PermissionDecision, feedback?: string): Promise<void>
	/** Idempotent. */
	abort(): Promise<void>
	close(): Promise<void>
}

export interface StructuredRequest {
	/** Where the work happens — the backend may still read the project. */
	workingDirectory: string
	prompt: string
	/** JSON Schema. Enums in it are the anti-slop floor: a model cannot answer outside them. */
	schema: Record<string, unknown>
	model?: string
	effort?: ReasoningEffort
	systemPrompt?: string
}

export interface StructuredResult<T> {
	value: T
	/**
	 * True when the backend has no native schema-constrained mode and the result
	 * came from prompt-and-parse. Callers must treat their own post-validation as
	 * load-bearing in that case — schema-valid is a weaker guarantee here.
	 */
	emulated: boolean
}

/** Why a backend can or cannot be used, in terms the setup screen can render. */
export interface AvailabilityReport {
	id: BackendId
	displayName: string
	/** The executable/SDK is present. */
	installed: boolean
	/** Credentials are present and usable. */
	authenticated: boolean
	/** Installed and authenticated — the only state in which sessions start. */
	ready: boolean
	/** One line the user reads. Never a stack trace. */
	detail: string
	providerName: string
	/** What to do about it, when it is not ready. */
	remedy?: { label: string; command?: string; url?: string }
}

export interface CodingBackend {
	readonly id: BackendId
	readonly displayName: string
	/**
	 * Who serves this backend's models when their ids do not say so themselves.
	 * OpenCode's ids are already `provider/model`.
	 */
	readonly providerName: string
	/**
	 * **Every backend here raises a permission request per action and obeys the
	 * answer.** That is not a detail, it is what makes the per-project "ask before
	 * app writes" toggle mean what it says, and what makes a read-only plan phase
	 * a guarantee rather than a hope.
	 *
	 * Caret used to carry a `permissionModel` field because two removed adapters
	 * could only be confined by a sandbox chosen before the turn, and the UI had
	 * to admit it could not ask per file. Any future backend like that has to
	 * bring that honesty surface back with it — silently accepting one would turn
	 * a promise the UI makes into a lie.
	 */
	availability(): Promise<AvailabilityReport>
	startSession(options: StartSessionOptions): Promise<BackendSession>
	/** One-shot, JSON-schema-constrained. Carries the interview and recipe narrowing. */
	structured<T>(request: StructuredRequest): Promise<StructuredResult<T>>
	/**
	 * Models this backend can reach, grouped by provider.
	 *
	 * Optional, and a made-up list is worse than none: absent means the UI asks
	 * the user to type an id rather than showing models that may not exist.
	 */
	listModels?(): Promise<ModelGroup[]>
	/**
	 * Providers worth offering that this machine is not signed in to.
	 *
	 * Separate from {@link listModels} because they answer different questions:
	 * that one is "what can I run right now", this is "what would connecting get
	 * me". Optional, because a backend that cannot enumerate its providers should
	 * offer no doors rather than invented ones.
	 */
	listProviderDoors?(): Promise<ProviderDoor[]>
	/**
	 * One trivial round-trip, to find out whether a model will actually answer.
	 *
	 * Entitlement is invisible in a catalogue: a plan lists models it will refuse,
	 * and the refusal arrives minutes later inside a turn the user thought was
	 * working. This is the same lesson the verify suites learned from a model
	 * advertised as free that answered `[404] unavailable for free`. Resolves with
	 * the provider's own words when it refuses, or null when it answers.
	 */
	probeModel?(model: string, workingDirectory: string): Promise<string | null>
	/**
	 * Connects a provider, by key or by starting the backend's own OAuth.
	 *
	 * **Caret never implements a vendor's sign-in.** It asks the backend to run the
	 * flow the backend already runs for its own users, and opens the URL it hands
	 * back. That is the difference between offering someone a door and forging
	 * their key: the credential is issued to the tool the vendor sanctioned, and
	 * Caret does not see it.
	 *
	 * Resolves null when the provider is connected outright (a key), or with what
	 * the user has to do next.
	 */
	connectProvider?(providerId: string, methodId: string, key?: string): Promise<OauthChallenge | null>
	/** Finishes a flow that asked for a code. */
	completeOauth?(providerId: string, methodId: string, code: string): Promise<boolean>
	/**
	 * Where a browser sign-in stands. Polled by the panel, because the flow
	 * finishes in a browser Caret is not part of: `connected` when the
	 * credential landed, `failure` with the reason when it will never land.
	 */
	oauthStatus?(providerId: string): Promise<{ connected: boolean; failure?: string }>
	/** Forgets a credential. The provider stays offered; it just stops being connected. */
	disconnectProvider?(providerId: string): Promise<void>
	/** Sessions previously run in this project, newest first. */
	listSessions?(workingDirectory: string): Promise<BackendSessionSummary[]>
	/** Deletes one past session and its transcript, permanently. */
	deleteSession?(workingDirectory: string, sessionId: string): Promise<void>
	/**
	 * An old session replayed as the same events a live one emits, so the chat is
	 * rebuilt by the reducer that built it the first time rather than by a second
	 * implementation that can disagree with it.
	 */
	readTranscript?(workingDirectory: string, sessionId: string): Promise<BackendEvent[]>
	/** Releases any process or connection the adapter is holding. */
	dispose?(): Promise<void>
}

export interface BackendSessionSummary {
	id: string
	title: string
	updatedAt: number
}

/** Features that need a backend, for the refusal message. */
export type BackendFeature = "sync" | "visual-edit" | "flow-sync" | "interview" | "chat"

const NO_BACKEND_MESSAGE: Record<BackendFeature, string> = {
	sync: "Syncing the design into your app needs a coding backend. Open Settings → Backend to use the one bundled with Caret, or connect the agent you already pay for.",
	"visual-edit":
		"Describing a change in words needs a coding backend. Open Settings → Backend to set one up. Direct edits — text, colour, images — keep working without it.",
	"flow-sync":
		"Updating page navigation to match the flow needs a coding backend. Open Settings → Backend to set one up. The flow file itself has been updated either way.",
	interview:
		"The interview runs without a backend — it just loses the reasoning behind each recommendation. Open Settings → Backend to get it back.",
	chat: "Chat needs a coding backend. Open Settings → Backend to use the one bundled with Caret, or connect the agent you already pay for.",
}

/**
 * No backend is configured, or the configured one is not ready.
 *
 * The message names the fix per feature. "No backend configured" on its own
 * tells nobody what to do, and pointing at MCP would be actively wrong: an
 * external agent connected over MCP enables none of these, because MCP cannot
 * carry work outwards.
 */
export class NoBackendError extends Error {
	constructor(
		readonly feature: BackendFeature,
		detail?: string,
	) {
		super(detail ? `${NO_BACKEND_MESSAGE[feature]} (${detail})` : NO_BACKEND_MESSAGE[feature])
		this.name = "NoBackendError"
	}
}

/** A backend refused, or died mid-turn. Distinct from "there is no backend". */
export class BackendError extends Error {
	constructor(
		message: string,
		readonly recoverable = true,
	) {
		super(message)
		this.name = "BackendError"
	}
}

/** The model answered, but not with something the schema allows. */
export class StructuredOutputError extends BackendError {
	constructor(detail: string) {
		super(`The model did not produce a valid answer: ${detail}`, true)
		this.name = "StructuredOutputError"
	}
}
