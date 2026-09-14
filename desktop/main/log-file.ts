/**
 * Writes the Logger stream to disk — independent of telemetry, always on.
 *
 * Until now the app had no log file at all: the menu's "Show Logs Folder"
 * opened a directory nothing wrote to, and a packaged user's crash report was
 * whatever they remembered seeing. This subscriber captures everything from
 * the first line of main() — lines logged before the logs directory is
 * resolvable (the crash handlers install pre-ready) buffer in memory and
 * flush on attach.
 */
import { app } from "electron"
import * as fsp from "fs/promises"
import * as path from "path"

import { Logger } from "../../src/shared/services/Logger"

const MAX_BUFFERED_LINES = 500
const ROTATE_BYTES = 5 * 1024 * 1024
const ROTATE_CHECK_EVERY = 200

export function startFileLog(): void {
	let target: string | null = null
	let buffer: string[] | null = []
	// Serialized appends: a promise chain keeps concurrent log lines from
	// interleaving mid-line. Failures are swallowed — a full disk must not
	// take down logging's other subscribers, let alone the app.
	let queue: Promise<void> = Promise.resolve()
	let writesSinceCheck = 0

	const write = (line: string): void => {
		const stamped = `${new Date().toISOString()} ${line}\n`
		if (!target) {
			if (buffer && buffer.length < MAX_BUFFERED_LINES) buffer.push(stamped)
			return
		}
		const file = target
		queue = queue
			.then(async () => {
				if (writesSinceCheck++ >= ROTATE_CHECK_EVERY) {
					writesSinceCheck = 0
					await rotateIfLarge(file)
				}
				await fsp.appendFile(file, stamped, "utf-8")
			})
			.catch(() => {})
	}

	Logger.subscribe(write)

	void app.whenReady().then(async () => {
		try {
			const dir = app.getPath("logs")
			await fsp.mkdir(dir, { recursive: true })
			const file = path.join(dir, "main.log")
			await rotateIfLarge(file)
			target = file
			const pending = buffer ?? []
			buffer = null
			if (pending.length > 0) {
				queue = queue.then(() => fsp.appendFile(file, pending.join(""), "utf-8")).catch(() => {})
			}
		} catch {
			buffer = null
		}
	})
}

/** One live file plus one predecessor is enough for a bug report. */
async function rotateIfLarge(file: string): Promise<void> {
	try {
		const stat = await fsp.stat(file)
		if (stat.size > ROTATE_BYTES) await fsp.rename(file, file.replace(/\.log$/, ".old.log"))
	} catch {
		// Missing file: nothing to rotate.
	}
}
