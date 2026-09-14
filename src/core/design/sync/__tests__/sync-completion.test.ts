import { expect } from "chai"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { clearPendingSync, completeSync, readPendingSync, registerPendingSync } from "../sync-completion"
import { readSyncState } from "../sync-state"

/**
 * The bookmark is the thing that stops every sync re-reporting the entire design
 * layer. V1 shipped with only an implicit completion signal, the bookmark got
 * stuck at "never synced", and the bug was invisible until someone noticed a
 * one-page change producing a sixteen-file worklist. These cases exist so that
 * cannot recur silently.
 */
describe("completeSync — reliable, idempotent bookmark advance", () => {
	let cwd: string

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "caret-sync-"))
		await fs.mkdir(path.join(cwd, ".caret"), { recursive: true })
	})

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true }).catch(() => {})
	})

	const register = (syncId: string, commit: string, previousBookmark: string | null = null) =>
		registerPendingSync(cwd, { syncId, commit, previousBookmark, preSyncSnapshot: "snap-abc" })

	it("advances the bookmark for the matching sync and marks the record applied", async () => {
		await register("sync-1", "commit-aaa", null)
		expect((await readSyncState(cwd)).lastSyncedCommit).to.equal(null)

		expect(await completeSync(cwd, "sync-1")).to.equal("advanced")

		expect((await readSyncState(cwd)).lastSyncedCommit).to.equal("commit-aaa")
		const record = await readPendingSync(cwd)
		expect(record?.applied).to.equal(true)
		// The record survives, because rollback still needs the previous bookmark
		// and the snapshot to restore from.
		expect(record?.previousBookmark).to.equal(null)
		expect(record?.preSyncSnapshot).to.equal("snap-abc")
	})

	it("is idempotent — a second call does not advance again", async () => {
		await register("sync-1", "commit-aaa")
		expect(await completeSync(cwd, "sync-1")).to.equal("advanced")
		expect(await completeSync(cwd, "sync-1")).to.equal("already-applied")

		expect((await readSyncState(cwd)).lastSyncedCommit).to.equal("commit-aaa")
		expect(await readPendingSync(cwd)).to.not.equal(null)
	})

	it("refuses a syncId that does not match the pending sync", async () => {
		await register("sync-1", "commit-aaa")
		expect(await completeSync(cwd, "some-other-sync")).to.equal("wrong-sync")

		expect((await readSyncState(cwd)).lastSyncedCommit).to.equal(null)
		expect((await readPendingSync(cwd))?.applied).to.not.equal(true)
	})

	it("reports cleanly when there is no pending sync", async () => {
		expect(await completeSync(cwd, "sync-1")).to.equal("no-pending-sync")
		expect((await readSyncState(cwd)).lastSyncedCommit).to.equal(null)
		expect(await readPendingSync(cwd)).to.equal(null)
	})

	it('completes without a syncId — the manual "mark synced" control', async () => {
		await register("sync-1", "commit-aaa")
		expect(await completeSync(cwd)).to.equal("advanced")
		expect((await readSyncState(cwd)).lastSyncedCommit).to.equal("commit-aaa")
	})

	it("preserves previousBookmark for rollback", async () => {
		await register("sync-2", "commit-bbb", "commit-old")
		await completeSync(cwd, "sync-2")
		expect((await readPendingSync(cwd))?.previousBookmark).to.equal("commit-old")
	})

	it("clearPendingSync removes the record without advancing", async () => {
		await register("sync-1", "commit-aaa")
		await clearPendingSync(cwd)
		expect(await readPendingSync(cwd)).to.equal(null)
		expect((await readSyncState(cwd)).lastSyncedCommit).to.equal(null)
	})
})
