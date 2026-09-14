/**
 * The provider's words reach the user, from the only place the pinned server
 * puts them. A user watched "Working…" for seven minutes while the log said
 * "Endpoint is unavailable" twice; this file is why that cannot recur.
 */
import { strict as assert } from "assert"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { parseStreamError, watchStreamErrors } from "../log-tail"

// Tonight's actual line, verbatim shape.
const REAL_LINE =
	'timestamp=2026-08-23T23:48:32.219Z level=ERROR run=6519dacf message="stream error" providerID=opencode-go modelID=ox-alpha-free session.id=ses_abc123 small=false agent=build mode=primary error.error="AI_APICallError: Error from provider (Console Go): Upstream request failed: Endpoint is unavailable."'

describe("parseStreamError", () => {
	it("extracts the provider's words from a real line, prefixes stripped", () => {
		assert.equal(parseStreamError(REAL_LINE, "ses_abc123"), "Upstream request failed: Endpoint is unavailable.")
	})

	it("ignores another session's error and non-error lines", () => {
		assert.equal(parseStreamError(REAL_LINE, "ses_other"), null)
		assert.equal(
			parseStreamError("timestamp=x level=INFO message=stream providerID=y session.id=ses_abc123", "ses_abc123"),
			null,
		)
	})

	it("never returns an empty message for a matching line", () => {
		const bare = 'level=ERROR message="stream error" session.id=ses_abc123 error.error=""'
		assert.equal(parseStreamError(bare, "ses_abc123"), "the provider stream failed")
	})
})

describe("watchStreamErrors", () => {
	let dir: string
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "caret-log-tail-"))
	})
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	function waitFor(check: () => boolean, ms: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const started = Date.now()
			const timer = setInterval(() => {
				if (check()) {
					clearInterval(timer)
					resolve()
				} else if (Date.now() - started > ms) {
					clearInterval(timer)
					reject(new Error("timed out"))
				}
			}, 10)
		})
	}

	it("reports only errors written after it started watching, and only this session's", async () => {
		const logPath = path.join(dir, "opencode.log")
		// History from before the turn must not be replayed as fresh failures.
		await fs.writeFile(logPath, `${REAL_LINE}\n`)

		const seen: string[] = []
		const watch = watchStreamErrors({ sessionId: "ses_abc123", onError: (m) => seen.push(m), logPath, pollMs: 25 })
		try {
			await new Promise((resolve) => setTimeout(resolve, 80))
			assert.deepEqual(seen, [], "old lines were replayed")

			await fs.appendFile(logPath, "level=INFO message=loop session.id=ses_abc123\n")
			await fs.appendFile(logPath, `${REAL_LINE.replace("ses_abc123", "ses_other")}\n`)
			await fs.appendFile(logPath, `${REAL_LINE}\n`)
			await waitFor(() => seen.length > 0, 2000)
			assert.deepEqual(seen, ["Upstream request failed: Endpoint is unavailable."])
		} finally {
			watch.stop()
		}
	})

	it("survives rotation — a shrunken file starts over instead of misreading", async () => {
		const logPath = path.join(dir, "opencode.log")
		await fs.writeFile(logPath, "old content that is longer than the rotated file\n")

		const seen: string[] = []
		const watch = watchStreamErrors({ sessionId: "ses_abc123", onError: (m) => seen.push(m), logPath, pollMs: 25 })
		try {
			await new Promise((resolve) => setTimeout(resolve, 80))
			await fs.writeFile(logPath, "fresh\n")
			await new Promise((resolve) => setTimeout(resolve, 80))
			await fs.appendFile(logPath, `${REAL_LINE}\n`)
			await waitFor(() => seen.length > 0, 2000)
			assert.equal(seen[0], "Upstream request failed: Endpoint is unavailable.")
		} finally {
			watch.stop()
		}
	})

	it("a missing file is not an error, and a late-created one is picked up", async () => {
		const logPath = path.join(dir, "not-yet.log")
		const seen: string[] = []
		const watch = watchStreamErrors({ sessionId: "ses_abc123", onError: (m) => seen.push(m), logPath, pollMs: 25 })
		try {
			await new Promise((resolve) => setTimeout(resolve, 80))
			await fs.writeFile(logPath, "")
			await new Promise((resolve) => setTimeout(resolve, 80))
			await fs.appendFile(logPath, `${REAL_LINE}\n`)
			await waitFor(() => seen.length > 0, 2000)
			assert.equal(seen.length, 1)
		} finally {
			watch.stop()
		}
	})
})
