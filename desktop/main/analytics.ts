/**
 * Anonymous product telemetry — the only file that talks to PostHog.
 *
 * Consent is structural, not checked at send time: when telemetry is off (the
 * pref, `CARET_DISABLE_TELEMETRY`, or no key baked) no client is ever
 * constructed and `capture` is a pure no-op. Dev runs dry-run by default —
 * events go to the Logger instead of production analytics — because the
 * certification harness and every `npm run dev` would otherwise pollute the
 * funnels this exists to measure.
 *
 * A telemetry failure may never surface as an error: it would feed the very
 * error reporting that rides on this channel. Everything here degrades to
 * `Logger.debug` and silence.
 */

import { randomUUID } from "crypto"
import { app } from "electron"
import { PostHog, type PostHogOptions } from "posthog-node"

import { fetch } from "../../src/shared/net"
import { Logger } from "../../src/shared/services/Logger"
import { createSessionBudget, scrubAndTruncate, scrubText } from "../shared/telemetry"
import { getPref, setPref } from "./prefs"

/**
 * A PUBLIC, write-only PostHog project key. Anyone can read it in this repo and
 * anyone can send events with it — it grants no read access to the data, so
 * secrecy would buy nothing. Emptying it disables telemetry entirely.
 */
const POSTHOG_KEY = "phc_khJVFefAzcYWk72Q99kZRjfLGVAGDfzsuh4KkJAF9fE2"
const POSTHOG_HOST = "https://eu.i.posthog.com"

/** Caps chosen against PostHog's free error-tracking allowance; a crash loop stops mattering after this. */
const budget = createSessionBudget({ errorLines: 20, exceptions: 10 })

let client: PostHog | null = null
let distinctId = ""
let dryRun = false
const sessionStart = Date.now()

function telemetryWanted(): boolean {
	if (process.env.CARET_DISABLE_TELEMETRY) return false
	// Every harness and probe launches with NODE_ENV=test; their fresh profiles
	// would otherwise default telemetry ON and land in production analytics.
	if (process.env.NODE_ENV === "test") return false
	return getPref("telemetryEnabled")
}

function commonProps(): Record<string, unknown> {
	return {
		app_version: app.getVersion(),
		platform: process.platform,
		arch: process.arch,
		channel: app.isPackaged ? "packaged" : "dev",
	}
}

/** Call once in main(), after loadPrefs(). Safe to call again after a consent flip. */
export function initAnalytics(): void {
	if (client || dryRun) return
	if (!telemetryWanted()) return

	// Dev runs stay out of production data unless explicitly armed.
	if (process.env.IS_DEV === "true" && !process.env.CARET_TELEMETRY_LIVE) {
		dryRun = true
		Logger.debug("[telemetry] dry-run: events log locally and nothing is sent")
		return
	}
	if (!POSTHOG_KEY) return

	try {
		if (!getPref("telemetryId")) void setPref("telemetryId", randomUUID())
		distinctId = getPref("telemetryId")
		client = new PostHog(POSTHOG_KEY, {
			host: POSTHOG_HOST,
			flushAt: 10,
			flushInterval: 10_000,
			// Proxy-aware fetch per .caretrules/network.md; the shapes line up, the
			// nominal types don't (PostHog declares its own fetch interface).
			fetch: fetch as unknown as PostHogOptions["fetch"],
			// Strictest reading of "anonymous": no IP-derived location at all.
			disableGeoip: true,
		})
	} catch (error) {
		client = null
		Logger.debug(`[telemetry] init failed, staying off: ${error instanceof Error ? error.message : String(error)}`)
	}
}

export function capture(event: string, props?: Record<string, unknown>, set?: Record<string, unknown>): void {
	if (dryRun) {
		Logger.debug(`[telemetry] ${event} ${JSON.stringify(props ?? {})}`)
		return
	}
	if (!client) return
	try {
		client.capture({
			distinctId,
			event,
			properties: { ...commonProps(), ...props, ...(set ? { $set: set } : {}) },
		})
	} catch {
		// Losing an event is the correct failure mode.
	}
}

/** Exceptions ride the same consent and a tighter budget; messages arrive pre-scrubbed or get scrubbed here. */
export function captureError(error: unknown, source: "main" | "renderer"): void {
	if (!budget.allowException()) return
	const err = error instanceof Error ? error : new Error(scrubAndTruncate(String(error)))
	if (dryRun) {
		Logger.debug(`[telemetry] exception (${source}): ${scrubAndTruncate(err.message)}`)
		return
	}
	if (!client) return
	try {
		const clean = new Error(scrubAndTruncate(err.message))
		clean.name = err.name
		clean.stack = err.stack ? scrubText(err.stack) : undefined
		client.captureException(clean, distinctId, { ...commonProps(), source })
	} catch {}
}

/** The Logger.error lane: deduped per message hash, capped per session. */
export function captureErrorLine(hash: string, source: string, message: string): void {
	if (!budget.allowErrorLine(hash)) return
	capture("error_logged", { source, message, message_hash: hash })
}

export function sessionDurationSeconds(): number {
	return Math.round((Date.now() - sessionStart) / 1000)
}

/** Reacts to the Privacy toggle: tears down or arms the client to match the pref. */
export async function setTelemetryEnabled(on: boolean, at: "first_run_notice" | "settings"): Promise<void> {
	if (!on) {
		// One farewell event so the opt-out rate itself is measurable, then quiet.
		capture("telemetry_disabled", { at })
		await setPref("telemetryEnabled", false)
		await shutdownAnalytics(1500)
		client = null
		dryRun = false
		return
	}
	await setPref("telemetryEnabled", true)
	initAnalytics()
}

/** Bounded flush — quit must never hang on a dead network. */
export async function shutdownAnalytics(timeoutMs: number): Promise<void> {
	const current = client
	if (!current) return
	try {
		await Promise.race([
			Promise.resolve(current.shutdown(timeoutMs)),
			new Promise<void>((resolve) => setTimeout(resolve, timeoutMs + 500)),
		])
	} catch {}
}
