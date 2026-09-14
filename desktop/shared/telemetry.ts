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
	"wizard:start": { event: "wizard_started", props: (args) => ({ mode: enumArg(args[2], ["ai-led", "collaborative"]) }) },
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
}

/** The only event names the renderer may submit over `analytics:event`. */
export const RENDERER_EVENTS: ReadonlySet<string> = new Set(["surface_switched", "renderer_exception"])

/** An argument admitted only when it matches a fixed vocabulary; anything else is named, not sent. */
function enumArg(value: unknown, allowed: readonly string[]): string {
	return typeof value === "string" && allowed.includes(value) ? value : "other"
}

/**
 * Strips user content out of a line bound for an error event.
 *
 * Path removal alone is not enough: Logger lines embed arbitrary payloads —
 * the message router stringifies whole canvas messages into its error line, and
 * agent errors quote provider output — so quoted spans and JSON bodies go too.
 * Quotes and braces are removed before paths so a path inside a quoted span
 * cannot survive by being consumed as part of the span's replacement.
 */
export function scrubText(text: string): string {
	return (
		text
			// JSON-ish bodies, one nesting level deep — enough for stringified payloads.
			.replace(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, "{…}")
			.replace(/"(?:[^"\\]|\\.)*"/g, '"…"')
			.replace(/'[^']*'/g, "'…'")
			// Absolute paths, POSIX and Windows drive-letter forms.
			.replace(/(?:\/(?:Users|home|private|var|tmp|opt|etc)\/|[A-Za-z]:[\\/])[^\s"')\]]*/g, "<path>")
	)
}

/** Scrub plus a hard cap, for event properties with a fixed budget. */
export function scrubAndTruncate(text: string, max = 200): string {
	const scrubbed = scrubText(text)
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
