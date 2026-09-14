/**
 * The bundled server's log, read back as the events it never broadcasts.
 *
 * The pinned server (1.18.23) documents `session.retry.scheduled`, but the
 * event has never been observed live, and 1.18.11 in the field retried a
 * failed provider stream in silence: its LLM runtime's onError only wrote a
 * log line. That log line has everything a user was owed — the session, the
 * provider, and the provider's own words:
 *
 *   timestamp=… level=ERROR … message="stream error" … session.id=ses_x …
 *   error.error="AI_APICallError: Error from provider (Console Go): Upstream
 *   request failed: Endpoint is unavailable."
 *
 * A user watched "Working…" for seven minutes while that line was written
 * twice. So Caret tails the file and turns matching lines into the same
 * retry events a newer server would have sent. The format is a contract with
 * a PINNED binary — this whole file exists only until the pin bump makes the
 * real event arrive, and should be deleted then (verify live, per the rules).
 */
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

/**
 * Shared by every instance the binary runs — the server appends, we follow.
 *
 * Mirrors the pinned binary's own resolution, read from its bundle: a pure XDG
 * fallback chain with NO platform branch — `XDG_DATA_HOME || ~/.local/share`,
 * Windows included (homedir there is %USERPROFILE%). Honouring XDG_DATA_HOME
 * matters because the server inherits our environment and writes wherever it
 * points; a tail on the unset-default would silently follow nothing.
 */
export function opencodeLogPath(): string {
	const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
	return path.join(dataHome, "opencode", "log", "opencode.log")
}

/**
 * The provider's words out of one log line, or null when the line is not this
 * session's stream error. Error-class and relay prefixes are stripped —
 * "AI_APICallError: Error from provider (Console Go): Upstream request
 * failed: Endpoint is unavailable." becomes "Upstream request failed:
 * Endpoint is unavailable." — because the transcript note already says who
 * errored; the words that matter are what it said.
 */
export function parseStreamError(line: string, sessionId: string): string | null {
	if (!line.includes('message="stream error"')) return null
	if (!line.includes(`session.id=${sessionId}`)) return null
	const raw = /error\.error="([^"]*)"/.exec(line)?.[1] ?? ""
	const message = raw
		.replace(/^[A-Za-z_]+Error:\s*/, "")
		.replace(/^Error from provider \([^)]*\):\s*/, "")
		.trim()
	return message || "the provider stream failed"
}

export interface StreamErrorWatch {
	stop(): void
}

/**
 * Follows the log from its current end, reporting this session's stream
 * errors as they are written. Polling rather than fs.watch: the file is
 * appended by another process, rotation must reset cleanly (size shrinking
 * means start over), and a 1.5s cadence is far inside the ~4 minutes a
 * failing stream takes to error. Every failure mode is fail-soft — a missing
 * or unreadable log yields no reports, never a broken turn.
 */
export function watchStreamErrors(options: {
	sessionId: string
	onError(message: string): void
	logPath?: string
	pollMs?: number
}): StreamErrorWatch {
	const logPath = options.logPath ?? opencodeLogPath()
	const pollMs = options.pollMs ?? 1500
	let offset: number | null = null
	let remainder = ""
	let stopped = false

	const poll = async () => {
		try {
			const stat = await fs.stat(logPath)
			if (offset === null || stat.size < offset) {
				// First sight, or the file rotated: only lines written from here
				// on belong to this turn.
				offset = stat.size
				remainder = ""
				return
			}
			if (stat.size === offset) return

			const handle = await fs.open(logPath, "r")
			try {
				const length = stat.size - offset
				const buffer = Buffer.alloc(length)
				await handle.read(buffer, 0, length, offset)
				offset = stat.size

				const chunk = remainder + buffer.toString("utf-8")
				const lines = chunk.split("\n")
				remainder = lines.pop() ?? ""
				for (const line of lines) {
					const message = parseStreamError(line, options.sessionId)
					if (message) options.onError(message)
				}
			} finally {
				await handle.close()
			}
		} catch {
			// Missing file, permissions, a torn read — none of it may hurt the
			// turn. The next poll tries again.
		}
	}

	const timer = setInterval(() => {
		if (!stopped) void poll()
	}, pollMs)
	void poll()

	return {
		stop() {
			stopped = true
			clearInterval(timer)
		},
	}
}
