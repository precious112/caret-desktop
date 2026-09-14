import { expect } from "chai"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { completeSync, readPendingSync } from "../sync-completion"
import { runSync } from "../sync-orchestrator"
import { readSyncState } from "../sync-state"

/**
 * The outside-Caret sync contract: an external agent calls `start_sync` over
 * MCP and must get the worklist BACK — not have the work silently routed to a
 * bundled backend it may not even have connected. This held only on paper for
 * a while: the tool existed, but `runSync` hardcoded the backend audience and
 * the hand-off prompt variant was unreachable. These tests are what keep the
 * user's "Caret purely for design, my own agent for the app" workflow alive.
 */
describe("runSync with the mcp audience (external agent hand-off)", () => {
	let cwd: string

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "caret-mcp-sync-"))
		await fs.mkdir(path.join(cwd, ".caret", "pages", "home"), { recursive: true })
		await fs.writeFile(
			path.join(cwd, ".caret", "pages", "home", "index.tsx"),
			"export default function Home() { return null }\n",
		)
	})

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true })
	})

	it("hands the worklist prompt back to the caller, with no backend connected at all", async () => {
		// No registered project services — bridgeFor() is the NullBridge. The
		// backend path would refuse with "no-agent"; the mcp path must not.
		const result = await runSync(cwd, { audience: "mcp", autoFix: true })

		expect(result.status).to.equal("started")
		expect(result.prompt, "the caller must receive the worklist").to.be.a("string")
		expect(result.prompt).to.include("report_sync_mapping")
		expect(result.prompt).to.include(`complete_sync`)
		expect(result.prompt).to.include(result.syncId ?? "MISSING")
		// The shared rules ride the hand-off variant too — parity of guidance.
		expect(result.prompt).to.include("AUTHORITY IS SPLIT")
		expect(result.prompt).to.include("PAGE COVERAGE")
		// And none of the backend-only plan ceremony leaks into it.
		expect(result.prompt).to.not.include("RIGHT NOW YOU ARE PLANNING")
	})

	it("registers the pending sync so complete_sync can advance the bookmark", async () => {
		const result = await runSync(cwd, { audience: "mcp", autoFix: true })

		const pending = await readPendingSync(cwd)
		expect(pending?.syncId).to.equal(result.syncId)
		expect(pending?.applied).to.equal(false)

		const outcome = await completeSync(cwd, result.syncId)
		expect(outcome).to.equal("advanced")
		const { lastSyncedCommit } = await readSyncState(cwd)
		expect(lastSyncedCommit, "the bookmark must advance to the synced commit").to.be.a("string")
	})

	it("keeps the backend audience refusing without a backend, unchanged", async () => {
		const result = await runSync(cwd, { autoFix: true })
		expect(result.status).to.equal("no-agent")
		expect(result.prompt).to.equal(undefined)
	})
})
