/**
 * The bookmark rule, and the empty-plan rule.
 *
 * A sync that advances the bookmark without having changed anything is the worst
 * failure this system has: the design change is never offered again, so it is
 * dropped rather than retried, and nothing tells anyone. The mirror failure is
 * just as bad — a sync that *did* change the app but is not recorded, so the same
 * work is offered forever.
 *
 * Both hinge on one question, "did the apply write anything", and the answer has
 * to come from **git** rather than from the transcript. Counting `file-changed`
 * events was tried and is wrong: an adapter only emits those for tools whose
 * name it recognises, so a model reaching for any other tool edits the app while
 * Caret sees nothing. These run against a real repository and a real snapshot
 * for exactly that reason.
 *
 * The empty-plan rule is this suite's other charter: a plan turn whose reply is
 * EMPTY must never leave a pending sync armed. The old suite stubbed every plan
 * turn with `text: ""` and still expected the apply to run — which is precisely
 * the bug that shipped an Apply gate with nothing behind it.
 */
import { strict as assert } from "assert"
import * as child_process from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { AgentConversation, RunOutcome, RunRequest, SettledPlan } from "../../agent/conversation"
import { discardSyncPlan, runBackendSync, runSyncApply } from "../sync-backend"
import { readPendingSync, registerPendingSync } from "../sync-completion"
import { captureSyncSnapshot } from "../sync-snapshot"
import { readSyncState, writeSyncState } from "../sync-state"

interface StubOptions {
	/** What the plan turn replies. The happy paths need real text now. */
	planText?: string
	planOk?: boolean
	/** Runs when the apply turn starts, standing in for whatever the agent did. */
	onApply?: () => Promise<void>
	/** What `settledPlan()` reports when the apply half asks. */
	plan?: SettledPlan | null
}

function stubConversation(options: StubOptions) {
	const notes: string[] = []
	const kinds: string[] = []
	const requests: RunRequest[] = []
	let planCleared = false

	const conversation = {
		async run(request: RunRequest): Promise<RunOutcome> {
			kinds.push(request.kind)
			requests.push(request)
			if (request.kind === "sync-apply") await options.onApply?.()
			// Deliberately always reports no files: the decision must not depend on
			// what the transcript happened to notice.
			const reply = request.kind === "sync-plan" ? (options.planText ?? "") : ""
			return {
				ok: request.kind === "sync-plan" ? (options.planOk ?? true) : true,
				sessionId: "ses_stub",
				text: reply,
				closingText: reply,
				filesChanged: [],
			}
		},
		settledPlan(): SettledPlan | null {
			return options.plan ?? null
		},
		clearPlan() {
			planCleared = true
		},
		note(text: string) {
			notes.push(text)
		},
	}

	return {
		conversation: conversation as unknown as AgentConversation,
		notes,
		kinds,
		requests,
		planCleared: () => planCleared,
	}
}

const SETTLED: SettledPlan = { kind: "sync-plan", sessionId: "ses_stub", entryId: "e1", text: "the plan" }

/** A real repository with a committed app file and a pre-sync snapshot. */
async function fixture(): Promise<{ cwd: string; appFile: string }> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "caret-syncbackend-"))
	await fs.mkdir(path.join(cwd, ".caret"), { recursive: true })
	await fs.mkdir(path.join(cwd, "src"), { recursive: true })

	const appFile = path.join(cwd, "src", "App.tsx")
	await fs.writeFile(appFile, "export default function App() { return null }\n")

	const git = (args: string) => child_process.execSync(`git ${args}`, { cwd, stdio: "ignore" })
	git("init -q")
	git("config user.email caret@local")
	git("config user.name Caret")
	git("config commit.gpgSign false")
	git("add -A")
	git('commit -q -m "fixture" --no-verify')

	await writeSyncState(cwd, { lastSyncedCommit: null })
	const snapshot = await captureSyncSnapshot(cwd)
	await registerPendingSync(cwd, {
		syncId: "sync-1",
		commit: "abc123",
		previousBookmark: null,
		preSyncSnapshot: snapshot ?? undefined,
	})

	return { cwd, appFile }
}

describe("runBackendSync (the plan half)", () => {
	it("a completed plan leaves the pending sync armed and runs nothing else", async () => {
		const { cwd } = await fixture()
		const { conversation, kinds } = stubConversation({ planText: "1. Edit src/App.tsx" })

		await runBackendSync(conversation, { cwd, syncId: "sync-1", prompt: "worklist", changedCount: 1 })

		assert.deepEqual(kinds, ["sync-plan"], "something beyond the plan turn ran")
		assert.ok(await readPendingSync(cwd), "the pending record was cleared out from under the review")
		assert.equal((await readSyncState(cwd)).lastSyncedCommit, null)
		await fs.rm(cwd, { recursive: true, force: true })
	})

	it("an empty plan never arms — the field bug, pinned", async () => {
		// `ok: true, text: ""` is exactly the turn that shipped an Apply gate
		// with nothing behind it: tools ran, then silence.
		const { cwd } = await fixture()
		const { conversation, kinds, notes } = stubConversation({ planText: "" })

		await runBackendSync(conversation, { cwd, syncId: "sync-1", prompt: "worklist", changedCount: 1 })

		assert.deepEqual(kinds, ["sync-plan"])
		assert.equal(await readPendingSync(cwd), null, "an empty plan left a pending sync armed")
		assert.equal((await readSyncState(cwd)).lastSyncedCommit, null)
		assert.ok(
			notes.some((note) => note.includes("didn't finish")),
			`the user was not told: ${JSON.stringify(notes)}`,
		)
		await fs.rm(cwd, { recursive: true, force: true })
	})

	it("a failed plan clears the pending sync", async () => {
		const { cwd } = await fixture()
		const { conversation } = stubConversation({ planOk: false, planText: "half a plan" })

		await runBackendSync(conversation, { cwd, syncId: "sync-1", prompt: "worklist", changedCount: 1 })

		assert.equal(await readPendingSync(cwd), null)
		await fs.rm(cwd, { recursive: true, force: true })
	})
})

describe("runSyncApply (the flip's continuation)", () => {
	it("advances the bookmark when the app actually changed on disk", async () => {
		const { cwd, appFile } = await fixture()
		const { conversation, kinds } = stubConversation({
			plan: SETTLED,
			// A tool Caret's event mapping has never heard of would look exactly
			// like this: the file moves, the transcript says nothing.
			onApply: () => fs.writeFile(appFile, "export default function App() { return <h1>Zephyr</h1> }\n"),
		})

		await runSyncApply(conversation, { cwd })

		assert.deepEqual(kinds, ["sync-apply"])
		assert.equal((await readSyncState(cwd)).lastSyncedCommit, "abc123")
		await fs.rm(cwd, { recursive: true, force: true })
	})

	it("leaves the bookmark alone when the apply finished without touching the app", async () => {
		const { cwd } = await fixture()
		const { conversation, notes } = stubConversation({ plan: SETTLED })

		await runSyncApply(conversation, { cwd })

		assert.equal((await readSyncState(cwd)).lastSyncedCommit, null, "an empty apply advanced the bookmark")
		assert.ok(
			notes.some((note) => note.includes("offered again")),
			`the user was not told the sync did not happen: ${JSON.stringify(notes)}`,
		)
		await fs.rm(cwd, { recursive: true, force: true })
	})

	it("ignores changes confined to the design layer", async () => {
		// `.caret/` is the *source* of a sync, not its result. A stray write there
		// must not be mistaken for the app having been brought in line.
		const { cwd } = await fixture()
		const { conversation } = stubConversation({
			plan: SETTLED,
			onApply: () => fs.writeFile(path.join(cwd, ".caret", "scratch.txt"), "written during the apply\n"),
		})

		await runSyncApply(conversation, { cwd })

		assert.equal((await readSyncState(cwd)).lastSyncedCommit, null, "a design-layer write advanced the bookmark")
		await fs.rm(cwd, { recursive: true, force: true })
	})

	it("steering reaches the model's prompt while the chat shows the user's words", async () => {
		const { cwd, appFile } = await fixture()
		const { conversation, requests } = stubConversation({
			plan: SETTLED,
			onApply: () => fs.writeFile(appFile, "changed\n"),
		})

		await runSyncApply(conversation, { cwd, steering: "keep the header untouched" })

		const apply = requests.find((request) => request.kind === "sync-apply")
		assert(apply, "no apply turn ran")
		assert.ok(apply.prompt.includes("planning phase is over"), "the apply prompt lost its framing-revoke opener")
		assert.ok(apply.prompt.includes("keep the header untouched"), "the steering never reached the model")
		assert.equal(apply.displayPrompt, "keep the header untouched", "the chat does not show the user's own words")
		assert.equal(apply.resumeSessionId, "ses_stub", "the apply did not resume the plan's session")
		await fs.rm(cwd, { recursive: true, force: true })
	})

	it("does nothing when the pending record is gone", async () => {
		// Discarded in another surface, rolled back, or a restart raced it: the
		// durable record is the truth, and without it an apply has nothing to
		// record against.
		const { cwd } = await fixture()
		const { conversation, kinds, notes, planCleared } = stubConversation({ plan: SETTLED })
		const { clearPendingSync } = await import("../sync-completion")
		await clearPendingSync(cwd)

		await runSyncApply(conversation, { cwd })

		assert.deepEqual(kinds, [], "an apply ran with no pending sync to record")
		assert.ok(
			notes.some((note) => note.includes("no sync waiting")),
			`nothing told the user: ${JSON.stringify(notes)}`,
		)
		assert.ok(planCleared(), "the stale plan stayed armed")
		await fs.rm(cwd, { recursive: true, force: true })
	})
})

describe("discardSyncPlan", () => {
	it("clears the pending record and the plan, and leaves the bookmark alone", async () => {
		const { cwd } = await fixture()
		const { conversation, notes, planCleared } = stubConversation({ plan: SETTLED })

		await discardSyncPlan(conversation, cwd)

		assert.equal(await readPendingSync(cwd), null, "the pending record survived the discard")
		assert.equal((await readSyncState(cwd)).lastSyncedCommit, null, "a discard advanced the bookmark")
		assert.ok(planCleared(), "the plan card stayed live")
		assert.ok(
			notes.some((note) => note.includes("offered again")),
			`the user was not told what a discard means: ${JSON.stringify(notes)}`,
		)
		await fs.rm(cwd, { recursive: true, force: true })
	})
})
