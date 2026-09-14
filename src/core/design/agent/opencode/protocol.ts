/**
 * The OpenCode server's wire shapes, pinned from the running binary.
 *
 * These were read off `GET /doc` on the pinned server (see
 * {@link PINNED_OPENCODE_VERSION}), **not** from `@opencode-ai/sdk`. That is
 * deliberate. The published SDK at the identical version number disagrees with
 * the binary it ships beside: the server emits `permission.asked` /
 * `permission.replied` where the SDK's generated types declare
 * `permission.updated`, and the SDK's prompt body has no `format` field even
 * though the route accepts one. Generating a client off the live document and
 * transcribing the parts Caret uses keeps one source of truth — the server that
 * is actually running — instead of two that drift.
 *
 * The SDK's server launcher is unusable here regardless: it spawns `opencode`
 * from `PATH`, which is the one thing this phase forbids.
 *
 * Only the fields Caret reads are declared. Everything else is passed through
 * untouched or ignored.
 */

/** `POST /session` */
export interface OpencodeSession {
	id: string
	title?: string
	time?: { created: number; updated: number }
}

export type OpencodeToolStatus = "pending" | "running" | "completed" | "error"

export interface OpencodeToolState {
	status: OpencodeToolStatus
	input?: Record<string, unknown>
	output?: string
	error?: string
	title?: string
	metadata?: Record<string, unknown>
}

export type OpencodePart =
	| { type: "text"; id: string; messageID: string; text: string; synthetic?: boolean }
	| { type: "reasoning"; id: string; messageID: string; text: string }
	| { type: "tool"; id: string; messageID: string; tool: string; callID: string; state: OpencodeToolState }
	| { type: "step-finish"; id: string; messageID: string; cost?: number; tokens?: OpencodeTokens }
	| { type: string; id: string; messageID: string; [key: string]: unknown }

export interface OpencodeTokens {
	input?: number
	output?: number
	reasoning?: number
	total?: number
	cache?: { read?: number; write?: number }
}

export interface OpencodeAssistantMessage {
	id: string
	sessionID: string
	role: "assistant"
	cost?: number
	tokens?: OpencodeTokens
	error?: { name: string; data?: { message?: string } }
}

/** `POST /session/{id}/message` */
export interface OpencodePromptResponse {
	info: OpencodeAssistantMessage
	parts: OpencodePart[]
}

/**
 * `GET /event` (SSE).
 *
 * The union below is only the members Caret maps onto a {@link BackendEvent};
 * the server emits ~90 types and the rest are dropped on purpose.
 */
export type OpencodeEvent =
	| { type: "message.part.updated"; properties: { sessionID: string; part: OpencodePart } }
	// How a part actually GROWS. `message.part.updated` fires only at a part's
	// creation (empty) and completion (the whole text); every token in between
	// arrives here, as an append to `field` (`"text"` for text and reasoning
	// alike). A mapper that only reads `updated` shows nothing until a part
	// finishes — which for a five-minute reasoning part is the whole turn.
	| {
			type: "message.part.delta"
			properties: { sessionID: string; messageID: string; partID: string; field: string; delta: string }
	  }
	// Announces a message's existence and role, always before its parts. The
	// mapper leans on that ordering to tell the assistant's parts from the echo
	// of the user's own prompt.
	| { type: "message.updated"; properties: { sessionID: string; info?: { id?: string; role?: string } } }
	// Emitted continuously while a run is live (`{"status":{"type":"busy"}}`).
	// Ignored: `session.idle` is the turn boundary. Listed so nobody mistakes it
	// for an undocumented completion signal — the pinned binary emits both.
	| { type: "session.status"; properties: { sessionID: string; status?: { type?: string } } }
	// Documented by the pinned server (1.18.23) but never yet observed live —
	// a real provider failure cannot be forced on demand. Broadcast when a
	// failed provider stream is scheduled for retry; the bundled client half
	// of this very binary consumes it, and the shape mirrors that client's
	// reads (attempt, at, error.message). The log tailer stays as
	// belt-and-braces until a live retry note is seen in the field.
	| {
			type: "session.retry.scheduled"
			properties: {
				sessionID?: string
				assistantMessageID?: string
				attempt?: number
				at?: number
				error?: { name?: string; message?: string; data?: { message?: string } }
			}
	  }
	| { type: "session.idle"; properties: { sessionID: string } }
	| { type: "session.error"; properties: { sessionID?: string; error?: { name?: string; data?: { message?: string } } } }
	| { type: "file.edited"; properties: { file: string } }
	| { type: "permission.asked"; properties: OpencodePermissionAsked }
	| { type: "permission.replied"; properties: { sessionID: string; requestID: string; reply: OpencodePermissionReply } }
	| { type: string; properties?: Record<string, unknown> }

export interface OpencodePermissionAsked {
	id: string
	sessionID: string
	/** The action being asked about, e.g. `edit`, `bash`, `webfetch`. */
	permission: string
	/** What it applies to — file paths for `edit`, the command for `bash`. */
	patterns: string[]
	metadata: Record<string, unknown>
	always: string[]
	tool?: { messageID: string; callID: string }
}

export type OpencodePermissionReply = "once" | "always" | "reject"

/** `GET /session/{id}/diff` */
export interface OpencodeFileDiff {
	file?: string
	patch?: string
	additions: number
	deletions: number
	status?: "added" | "deleted" | "modified"
}

/**
 * Structured output, as the server actually delivers it.
 *
 * `format: { type: "json_schema", schema }` makes the server force a tool call
 * named `StructuredOutput` whose `state.input` **is** the object. There is no
 * text part carrying the JSON, so parsing the reply text finds nothing.
 */
export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput"

export interface OpencodeConfig {
	model?: string
	small_model?: string
	instructions?: string[]
	permission?: Record<string, unknown>
	agent?: Record<string, unknown>
	provider?: Record<string, unknown>
	logLevel?: "DEBUG" | "INFO" | "WARN" | "ERROR"
	[key: string]: unknown
}

export interface OpencodeProviderInfo {
	id: string
	name?: string
	models: Record<string, { name?: string; cost?: { input?: number; output?: number } }>
}

/** `GET /config/providers` — only the providers this machine is signed in to. */
export interface OpencodeProvidersResponse {
	providers: OpencodeProviderInfo[]
	default: Record<string, string>
}

/** Only the fields the picker reads. A model carries about twenty more. */
export interface OpencodeCatalogueModel {
	id: string
	name?: string
	status?: string
	/** ISO date. Newest first is how a provider's headline models are found. */
	release_date?: string
	cost?: { input?: number; output?: number }
	limit?: { context?: number; output?: number }
	capabilities?: {
		input?: { image?: boolean }
		output?: { text?: boolean }
		/** False for image, video and speech models, which cannot run an agent. */
		toolcall?: boolean
		attachment?: boolean
	}
}

export interface OpencodeCatalogueProvider {
	id: string
	name?: string
	/** `api` for OpenCode's own plans, `custom` for everything from the catalogue. */
	source?: string
	/** Environment variables that would authenticate it, e.g. `["KIMI_API_KEY"]`. */
	env?: string[]
	models: Record<string, OpencodeCatalogueModel>
}

/**
 * `GET /provider` — the whole catalogue, plus who you are signed in to.
 *
 * Distinct from `/config/providers`, which lists only the connected ones. This
 * is the endpoint that lets Caret show a door to a subscription you have not
 * connected yet, instead of pretending the provider does not exist. It is
 * several megabytes, so it is cached — see `catalogue()`.
 */
export interface OpencodeCatalogueResponse {
	all: OpencodeCatalogueProvider[]
	/** Provider ids with a working credential. */
	connected: string[]
	default: Record<string, string>
}

/**
 * `GET /provider/auth` — how to sign in, per provider, in the server's own words.
 *
 * Keyed by provider id. Absent means the only way in is an environment variable
 * or a config file, which is why Anthropic does not appear: it prohibits
 * subscription sign-in outside its own tools, so an API key is all there is.
 */
export type OpencodeProviderAuthResponse = Record<string, Array<{ type: "oauth" | "api"; label: string }>>
