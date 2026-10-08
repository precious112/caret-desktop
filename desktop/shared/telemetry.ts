/**
 * The telemetry contract, kept pure so it is testable and auditable.
 *
 * Everything privacy-relevant lives in this file on purpose: the channel→event
 * allowlist (a channel absent from the map emits nothing — there is no way to
 * accidentally track a new IPC surface), the scrubber that keeps arbitrary log
 * content out of error events, and the per-session budget that keeps a crash
 * loop from burning the free error-tracking allowance. No electron and no node
 * imports — the renderer shares this module through the same bundler path as
 * `ipc.ts`, and the unit tests load it under plain mocha.
 *
 * The full event table users are shown lives in docs/telemetry.md; a change
 * here must update that document — it is the public contract, not this file.
 */

export interface ChannelEvent {
	event: string
	/** Picks named enum-ish props from the handler's arguments. Never spread raw args. */
	props?: (args: unknown[]) => Record<string, unknown>
}

/**
 * IPC channels that emit a product event, and nothing more than listed here.
 * Absent deliberately: `secrets:*`, `prefs:*`, `agent:send` (prompt-adjacent),
 * `tokens:write`, `canvas:*`, `assets:*` payload channels — anything whose
 * arguments carry user content.
 */
export const CHANNEL_EVENTS: Record<string, ChannelEvent> = {
	// Foundation interview — the onboarding funnel.
	"wizard:start": {
		event: "wizard_started",
		props: (args) => ({ mode: enumArg(args[2], ["ai-led", "collaborative", "from-app"]) }),
	},
	"wizard:answer": { event: "wizard_step", props: () => ({ action: "answer" }) },
	"wizard:back": { event: "wizard_step", props: () => ({ action: "back" }) },
	"wizard:retry": { event: "wizard_step", props: () => ({ action: "retry" }) },
	"wizard:finishNow": { event: "wizard_step", props: () => ({ action: "finish_now" }) },
	"wizard:commit": { event: "wizard_committed" },
	"wizard:abandon": { event: "wizard_abandoned" },

	// Asset generation — one funnel per lane, staged.
	"generate:clarify": { event: "generate_step", props: () => ({ stage: "clarify", lane: "image" }) },
	"generate:refineBrief": { event: "generate_step", props: () => ({ stage: "brief", lane: "image" }) },
	"generate:takes": { event: "generate_step", props: () => ({ stage: "variants", lane: "image" }) },
	"generate:refineTake": { event: "generate_step", props: () => ({ stage: "refine", lane: "image" }) },
	"generate:acceptTake": { event: "generate_accepted", props: () => ({ lane: "image" }) },
	"generate:recipes": { event: "generate_step", props: () => ({ stage: "variants", lane: "recipe" }) },
	"generate:variants": { event: "generate_step", props: () => ({ stage: "refine", lane: "recipe" }) },
	"generate:accept": { event: "generate_accepted", props: () => ({ lane: "recipe" }) },
	"generate:markTargets": { event: "generate_step", props: () => ({ stage: "variants", lane: "mark" }) },
	"generate:markTargetRefine": { event: "generate_step", props: () => ({ stage: "refine", lane: "mark" }) },
	"generate:mark": { event: "generate_step", props: () => ({ stage: "render", lane: "mark" }) },
	"generate:markAccept": { event: "generate_accepted", props: () => ({ lane: "mark" }) },
	"generate:shader": { event: "generate_step", props: () => ({ stage: "variants", lane: "shader" }) },
	"generate:shaderRefine": { event: "generate_step", props: () => ({ stage: "refine", lane: "shader" }) },
	"generate:shaderAccept": { event: "generate_accepted", props: () => ({ lane: "shader" }) },
	"generate:model3d": { event: "generate_step", props: () => ({ stage: "render", lane: "model3d" }) },
	"generate:model3dAccept": { event: "generate_accepted", props: () => ({ lane: "model3d" }) },
	"generate:discard": { event: "generate_abandoned" },

	// Setup and sync.
	"agent:selectBackend": {
		event: "agent_backend_selected",
		props: (args) => ({ backend_id: enumArg(args[0], ["opencode"]) }),
	},
	"sync:rollback": { event: "sync_rolled_back" },
	"import:cancel": { event: "app_import_cancelled" },
}

/** The only event names the renderer may submit over `analytics:event`. */
export const RENDERER_EVENTS: ReadonlySet<string> = new Set(["surface_switched", "renderer_exception", "setup_route_chosen"])

const SURFACES = ["canvas", "foundation", "agent", "assets"] as const
const SETUP_ROUTES = ["from-app", "ai-new-look", "ai-describe", "manual"] as const

/**
 * The properties a renderer product event may carry, rebuilt from fixed
 * vocabulary — the renderer's object is never spread. `renderer_exception`
 * is not handled here: it is scrubbed and sent as an exception, not an event.
 */
export function rendererEventProps(name: string, props: Record<string, unknown> | undefined): Record<string, unknown> {
	if (name === "surface_switched") {
		return {
			surface: enumArg(props?.surface, SURFACES),
			// The automatic landing on Foundation for a project with no design
			// system — without it the funnel only ever saw people LEAVING setup.
			...(props?.initial === true ? { initial: true } : {}),
		}
	}
	if (name === "setup_route_chosen") {
		return { route: enumArg(props?.route, SETUP_ROUTES), has_app_code: props?.hasAppCode === true }
	}
	return {}
}

/** An argument admitted only when it matches a fixed vocabulary; anything else is named, not sent. */
function enumArg(value: unknown, allowed: readonly string[]): string {
	return typeof value === "string" && allowed.includes(value) ? value : "other"
}

/**
 * Folders whose paths may be NAMED in an error, by a fixed token instead of
 * their real location. Caret's own data folder is the useful one: a failure on
 * `<userData>/preferences.json.tmp` says exactly which of Caret's files broke,
 * and the username in front of it is gone. Supplied by the main process, which
 * is the only side that knows these paths.
 */
export interface ScrubContext {
	roots: ReadonlyArray<{
		path: string
		token: string
		/** Keep the part after the root (Caret-owned names) — or only the token, when it may hold user-chosen names. */
		keepRest: boolean
	}>
}

/**
 * Where Caret's OWN code lives inside an install. A stack location ending in
 * one of these is a place in the app, never in the user's files, and its
 * file:line:col is the whole point of a stack trace. Everything before it (the
 * install folder, which carries the username) is dropped — read from the
 * frame's opening `(` or `at `, so an install path with spaces in it
 * ("C:\Users\First Last\…") is consumed whole.
 */
const CODE_LOCATION =
	/(\(|\bat\s+)[^()\n]*?[\\/](out[\\/](?:main|renderer|preload)[\\/][^\s"'()]*|node_modules[\\/][^\s"'()]*|app\.asar[\\/][^\s"'()]*)/g

/**
 * Any other absolute path: a file:// URL, a Windows drive, or a POSIX root.
 * The drive form only counts where a path can START, and the POSIX root not
 * after a word, a colon or a slash — the old single rule also matched the
 * `e:/` inside `file:///…`, which shredded every stack frame from Caret's own
 * code to `fil<path>` (seen in PostHog on a real EXDEV crash: no frame could be
 * located), and would eat `node:internal/fs/promises` the same way.
 */
const ABSOLUTE_PATH =
	/file:\/\/\/?[^\s"'(){}[\]<>,]*|(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'(){}[\]<>,]*|(?<![\w.:/>-])\/(?!\/)[^\s"'(){}[\]<>,]*/g

/** A quoted span is kept only when ALL of it is something this file produced. */
const SANITIZED = /^(?:<[a-zA-Z]+>(?:\/[^\s'"]*)?|(?:out|node_modules|app\.asar)\/[^\s'"]+)$/

/**
 * Relative path fragments left over — e.g. the tail of "/Users/x/My Projects/
 * app/file.tsx" after its space split it. Two or more segments, not one of the
 * kept code locations, not after a scheme or a token.
 */
const LEFTOVER_PATH = /(?<![\w<>/.:-])(?!(?:out|node_modules|app\.asar)\/)[\w.\-]+(?:\/[\w.\-]+)+/g

/** A placeholder followed by words and then more path — one path broken by spaces. */
const PATH_CONTINUATION = /(<path>|<[a-zA-Z]+>\/…)(?:(?:\s+[^\s"'()<>/\\]+)*\s+[^\s"'()<>]*[/\\][^\s"'()<>]*)+/g

function forwardSlashes(value: string): string {
	return value.replace(/\\/g, "/")
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** A root as a pattern: either slash direction, optional file:// prefix, any case. */
function rootPattern(rootPath: string): RegExp {
	const segments = forwardSlashes(rootPath).replace(/\/+$/, "").split("/").filter(Boolean)
	const drive = /^[A-Za-z]:$/.test(segments[0] ?? "")
	const body = segments.map(escapeRegExp).join("[\\\\/]")
	const prefix = drive ? "(?:file:\\/\\/\\/?)?" : "(?:file:\\/\\/)?[\\\\/]"
	return new RegExp(`${prefix}${body}((?:[\\\\/][^\\s"'()<>,]*)?)`, "gi")
}

/**
 * Strips user content out of a line bound for an error event — and keeps what
 * makes an error fixable.
 *
 * Removed, as before: JSON bodies and quoted spans (Logger lines embed whole
 * canvas messages and provider output) and every path into the user's files.
 * Kept, because without them a crash report cannot be acted on: stack frames
 * in Caret's own code with their file:line:col, and — when the main process
 * supplies {@link ScrubContext} — paths inside Caret's own folders, by token.
 *
 * Paths are tokenized BEFORE quoted spans are judged, so a span is only kept
 * when its whole content is a token this function produced
 * (`'<userData>/preferences.json'`); a path inside a span with anything else
 * in it still goes with the span.
 */
export function scrubText(text: string, context?: ScrubContext): string {
	let out = text
		// JSON-ish bodies, one nesting level deep — enough for stringified payloads.
		.replace(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, "{…}")
		.replace(CODE_LOCATION, (_match, lead: string, location: string) => `${lead}${forwardSlashes(location)}`)

	for (const root of context?.roots ?? []) {
		if (!root.path) continue
		out = out.replace(rootPattern(root.path), (_match, rest: string) => {
			if (root.keepRest) return `${root.token}${forwardSlashes(rest)}`
			return rest && rest !== "/" && rest !== "\\" ? `${root.token}/…` : root.token
		})
	}

	return (
		out
			.replace(ABSOLUTE_PATH, (raw) => {
				const trailing = /[.:;]+$/.exec(raw)?.[0] ?? ""
				return `<path>${trailing}`
			})
			// A folder name with spaces splits a path into pieces; words that lead
			// into more path ("Secret Launch App/src/page.tsx") are absorbed into
			// the placeholder before them, so no lone word of a name survives.
			.replace(PATH_CONTINUATION, "$1")
			.replace(/"((?:[^"\\]|\\.)*)"/g, (span, inner: string) => (SANITIZED.test(inner) ? span : '"…"'))
			.replace(/'([^']*)'/g, (span, inner: string) => (SANITIZED.test(inner) ? span : "'…'"))
			// Spaces inside a Windows path end its token, leaving the rest of it
			// ("Last\\project\\file.tsx") behind — any leftover backslash path goes.
			.replace(/[^\s"'()<>]*\\[^\s"'()<>]*/g, "<path>")
			.replace(LEFTOVER_PATH, "<path>")
	)
}

/**
 * The machine-readable half of a Node error: `code` (EXDEV), `syscall`
 * (rename), `errno`. Fixed vocabularies, never content — and often the whole
 * diagnosis, which the message alone (paths scrubbed) cannot carry.
 */
export function errorCodeProps(error: unknown): Record<string, string | number> {
	const props: Record<string, string | number> = {}
	if (!error || typeof error !== "object") return props
	const record = error as Record<string, unknown>
	if (typeof record.code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(record.code)) props.error_code = record.code
	if (typeof record.syscall === "string" && /^[a-z_]{1,24}$/.test(record.syscall)) props.syscall = record.syscall
	if (typeof record.errno === "number" && Number.isInteger(record.errno)) props.errno = record.errno
	return props
}

/** Scrub plus a hard cap, for event properties with a fixed budget. */
export function scrubAndTruncate(text: string, max = 200, context?: ScrubContext): string {
	const scrubbed = scrubText(text, context)
	return scrubbed.length <= max ? scrubbed : `${scrubbed.slice(0, max)}…`
}

/** Stable non-cryptographic hash for dedupe keys (djb2). */
export function hashText(text: string): string {
	let hash = 5381
	for (let index = 0; index < text.length; index++) {
		hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
	}
	return (hash >>> 0).toString(36)
}

export interface SessionBudget {
	/** One send per distinct hash, and a session-wide cap — a crash loop must not burn the month's allowance. */
	allowErrorLine(hash: string): boolean
	allowException(): boolean
}

export function createSessionBudget(limits: { errorLines: number; exceptions: number }): SessionBudget {
	const seenHashes = new Set<string>()
	let errorLines = 0
	let exceptions = 0
	return {
		allowErrorLine(hash: string): boolean {
			if (seenHashes.has(hash) || errorLines >= limits.errorLines) return false
			seenHashes.add(hash)
			errorLines++
			return true
		},
		allowException(): boolean {
			return exceptions++ < limits.exceptions
		},
	}
}
