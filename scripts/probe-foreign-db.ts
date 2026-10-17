/**
 * Does the bundled server boot when the user's own OpenCode is a different
 * version?
 *
 * The field failure: a user installed OpenCode 2.x, which migrated the shared
 * `~/.local/share/opencode/opencode.db` to a schema with `session_v2` and no
 * `session` table, and Caret's pinned 1.18 exited on boot with "Database is
 * not empty and has no session table". This plants exactly that database in a
 * throwaway data home, boots the server the way Caret does, and asserts it came
 * up on its own database — after carrying the foreign one over and refusing
 * it, which is the hardest path through `boot()`. The user's file must be left
 * as it was.
 *
 *   npx tsx scripts/probe-foreign-db.ts
 *
 * Needs a Node with `node:sqlite` (22.13+) to write the planted database.
 */

import { DatabaseSync } from "node:sqlite"
import { strict as assert } from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { CARET_SERVER_CONFIG } from "../src/core/design/agent/opencode"
import { bundledOpencodeDir, sharedOpencodeDir } from "../src/core/design/agent/opencode/data-home"
import { opencodeLogPath } from "../src/core/design/agent/opencode/log-tail"
import { ensureOpencodeServer, stopOpencodeServer } from "../src/core/design/agent/opencode/server"

function tables(file: string): string[] {
	const db = new DatabaseSync(file, { readOnly: true })
	try {
		const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
		return rows.map((row) => row.name)
	} finally {
		db.close()
	}
}

async function main() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "caret-foreign-db-"))
	process.env.XDG_DATA_HOME = root
	try {
		// What OpenCode 2.x leaves behind: populated, and no `session` table.
		const shared = path.join(sharedOpencodeDir(), "opencode.db")
		fs.mkdirSync(path.dirname(shared), { recursive: true })
		const foreign = new DatabaseSync(shared)
		foreign.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY); INSERT INTO session_v2 VALUES ('ses_from_v2');")
		foreign.close()

		const server = await ensureOpencodeServer(CARET_SERVER_CONFIG)
		console.log(`booted at ${server.url}`)

		const ours = path.join(bundledOpencodeDir(), "opencode.db")
		assert.ok(tables(ours).includes("session"), "the bundled server should be on a database it created")
		assert.deepEqual(tables(shared), ["session_v2"], "the user's own database must be left alone")
		assert.ok(opencodeLogPath().startsWith(bundledOpencodeDir()), "the log tail should follow the bundled server")
		console.log("PASS — a foreign shared database no longer stops the bundled server")
	} finally {
		await stopOpencodeServer()
		fs.rmSync(root, { recursive: true, force: true })
	}
}

main().catch((err) => {
	console.error(`FAIL — ${err instanceof Error ? err.message : err}`)
	process.exit(1)
})
