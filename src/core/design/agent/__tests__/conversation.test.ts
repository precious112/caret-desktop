/**
 * "It finished" is not "it ran".
 *
 * A backend can accept a prompt and end the turn without the model ever
 * having been invoked — OpenCode's agent loop does exactly that when a queued
 * message doesn't look like work, and the resulting `session.idle` is
 * indistinguishable on the wire from a successful empty turn. `run()` used to
 * report that as `ok: true`, which sent the sync layer down its "the model
 * chose to change nothing, use a stronger model" path for a turn no model saw.
 * These pin the boundary: no assistant activity → not a success — unless the
 * user is the one who stopped it.
 */
import { strict as assert } from "assert"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { BackendEvent, CodingBackend, SessionMode } from "../backend"
import { AgentConversation, type ConversationDeps } from "../conversation"

function stubBackend(events: BackendEvent[], onAbort?: () => void): CodingBackend {
	return {
		id: "opencode",
		displayName: "Stub",
		providerName: "Stub",
		async availability() {
			return { ready: true, installed: true, detail: "" }
		},
		async startSession(options: { mode: SessionMode }) {
			return {
				id: "ses_stub",
				mode: options.mode,
				async *send() {
					yield* events
				},
				async respondToPermission() {},
				async abort() {
					onAbort?.()
				},
				async close() {},
			}
		},
		async structured() {
			throw new Error("not used here")
		},
	} as unknown as CodingBackend
}

function deps(backend: CodingBackend): ConversationDeps {
	return {
		projectPath: "/tmp/nowhere",
		resolveBackend: async () => backend,
		model: () => undefined,
		effort: () => undefined,
		appWrites: () => "ask",
		setAppWrites: async () => {},
		systemPrompt: async () => undefined,
		onChange: () => {},
	}
}

const REQUEST = { kind: "chat" as const, title: "Chat", mode: "write" as const, prompt: "hello" }

describe("AgentConversation.run", () => {
	it("fails a turn that ended without any assistant activity", async () => {
		// The exact wire shape of the never-ran apply turn: a real, legitimate
		// done and nothing else.
		const conversation = new AgentConversation(deps(stubBackend([{ type: "done", text: "" }])))

		const outcome = await conversation.run(REQUEST)

		assert.equal(outcome.ok, false, "an empty turn was reported as a success")
	})

	it("fails a turn whose only 'activity' was usage bookkeeping — an empty model step", async () => {
		// Observed on a free alpha model: the loop ran one step, emitted only
		// its token count, and exited. The usage event counted as activity and
		// the user was shown literally nothing.
		const conversation = new AgentConversation(
			deps(
				stubBackend([
					{ type: "usage", inputTokens: 100, outputTokens: 0 },
					{ type: "done", text: "" },
				]),
			),
		)

		const outcome = await conversation.run(REQUEST)

		assert.equal(outcome.ok, false, "a usage-only turn was reported as a success")
		const error = conversation.getState().transcript.entries.find((entry) => entry.kind === "error")
		assert(error && error.kind === "error" && /empty response/.test(error.message), "the error does not say what happened")
	})

	it("notes a turn that did tool work and then said nothing", async () => {
		const conversation = new AgentConversation(
			deps(
				stubBackend([
					{ type: "tool-start", callId: "c1", name: "caret_get_screenshot", summary: "home" },
					{ type: "tool-end", callId: "c1", name: "caret_get_screenshot", ok: true },
					{ type: "done", text: "" },
				]),
			),
		)

		const outcome = await conversation.run(REQUEST)

		assert.equal(outcome.ok, true, "a tool-only turn is still a completed turn")
		const note = conversation.getState().transcript.entries.find((entry) => entry.kind === "note")
		assert(note && note.kind === "note" && /without a reply/.test(note.text), "the silence went unremarked")
	})

	it("keeps a turn with assistant activity a success", async () => {
		const conversation = new AgentConversation(
			deps(
				stubBackend([
					{ type: "text", text: "done deal" },
					{ type: "done", text: "" },
				]),
			),
		)

		const outcome = await conversation.run(REQUEST)

		assert.equal(outcome.ok, true)
		assert.equal(outcome.text, "done deal")
	})

	it("does not blame the backend when the user stopped the turn first", async () => {
		// A Stop pressed before the first token also ends the stream with nothing
		// in it; that is the user's call, not a backend fault.
		let conversation: AgentConversation | null = null
		const backend = stubBackend([{ type: "done", text: "" }])
		const original = backend.startSession.bind(backend)
		backend.startSession = async (options) => {
			const session = await original(options)
			// The user hits Stop the moment the turn opens.
			void conversation?.abort()
			return session
		}
		conversation = new AgentConversation(deps(backend))

		const outcome = await conversation.run(REQUEST)

		assert.equal(outcome.ok, true, "a user-stopped empty turn was reported as a backend fault")
	})

	it("denies promptable permissions on an unattended turn instead of waiting forever", async () => {
		// The variant-take deadlock: the model asks to run `git status`, the
		// ruling is "ask the user", and the surface that would show the prompt is
		// covered by the compare overlay. Unattended turns must answer NO
		// themselves — a question no one can see holds the take open forever.
		const decisions: Array<{ id: string; decision: string }> = []
		const backend = stubBackend([
			{ type: "permission", requestId: "per_1", tool: "bash", path: "git status --short", summary: "Run git status?" },
			{ type: "text", text: "worked around it" },
			{ type: "done", text: "" },
		])
		const original = backend.startSession.bind(backend)
		backend.startSession = async (options) => {
			const session = await original(options)
			session.respondToPermission = async (id: string, decision: string) => {
				decisions.push({ id, decision })
			}
			return session
		}
		const conversation = new AgentConversation(deps(backend))

		const outcome = await conversation.run({ ...REQUEST, kind: "edit", title: "Edit", unattended: true })

		// decide() runs unawaited off the stream; give it a beat to land.
		await new Promise((resolve) => setTimeout(resolve, 50))
		assert.equal(outcome.ok, true)
		assert.deepEqual(decisions, [{ id: "per_1", decision: "deny" }], "the unattended turn did not auto-deny the ask")
	})

	it("a policy deny carries its reason to the model as feedback", async () => {
		// The server formats reject+message as "rejected … with the following
		// feedback: {message}". A bare reject reads as "the user said stop" —
		// one provider route was measured ending the whole turn on it. The
		// reason Caret shows the human must be the reason the model gets.
		const replies: Array<{ decision: string; feedback?: string }> = []
		const backend = stubBackend([
			{ type: "permission", requestId: "per_3", tool: "bash", path: "npm install", summary: "Run npm install?" },
			{ type: "text", text: "carrying on without it" },
			{ type: "done", text: "" },
		])
		const original = backend.startSession.bind(backend)
		backend.startSession = async (options) => {
			const session = await original(options)
			session.respondToPermission = async (_id: string, decision: string, feedback?: string) => {
				replies.push({ decision, feedback })
			}
			return session
		}
		const conversation = new AgentConversation(deps(backend))

		await conversation.run({ kind: "sync-plan", title: "Sync design → app", mode: "read-only", prompt: "plan" })
		await new Promise((resolve) => setTimeout(resolve, 50))

		assert.equal(replies.length, 1)
		assert.equal(replies[0].decision, "deny")
		assert.ok(replies[0].feedback?.includes("allowlist"), `the deny carried no usable feedback: ${replies[0].feedback}`)
	})

	it("tells the user when the agent is refused the same thing twice", async () => {
		const backend = stubBackend([
			{ type: "permission", requestId: "per_4", tool: "bash", path: "npm install", summary: "Run npm install?" },
			{ type: "permission", requestId: "per_5", tool: "bash", path: "npm install", summary: "Run npm install?" },
			{ type: "text", text: "fine, planning without it" },
			{ type: "done", text: "" },
		])
		const conversation = new AgentConversation(deps(backend))

		await conversation.run({ kind: "sync-plan", title: "Sync design → app", mode: "read-only", prompt: "plan" })
		await new Promise((resolve) => setTimeout(resolve, 50))

		const note = conversation
			.getState()
			.transcript.entries.find((entry) => entry.kind === "note" && /refused .* twice/.test(entry.text))
		assert(note, "two refusals of the same command went unremarked to the user")
	})

	it("honours the project's own read-only allowlist from .caret/permissions.json", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "caret-conv-perms-"))
		await fs.mkdir(path.join(dir, ".caret"), { recursive: true })
		await fs.writeFile(path.join(dir, ".caret", "permissions.json"), JSON.stringify({ readOnlyCommands: ["npm ls"] }))
		const replies: string[] = []
		const backend = stubBackend([
			{ type: "permission", requestId: "per_6", tool: "bash", path: "npm ls --depth=1", summary: "Run npm ls?" },
			{ type: "text", text: "the plan" },
			{ type: "done", text: "" },
		])
		const original = backend.startSession.bind(backend)
		backend.startSession = async (options) => {
			const session = await original(options)
			session.respondToPermission = async (_id: string, decision: string) => {
				replies.push(decision)
			}
			return session
		}
		const conversation = new AgentConversation({ ...deps(backend), projectPath: dir })

		await conversation.run({ kind: "sync-plan", title: "Sync design → app", mode: "read-only", prompt: "plan" })
		await new Promise((resolve) => setTimeout(resolve, 50))
		await fs.rm(dir, { recursive: true, force: true })

		assert.deepEqual(replies, ["allow"], "the user's own allowlist entry was not honoured")
	})

	it("leaves the same promptable permission pending on an attended turn", async () => {
		const decisions: string[] = []
		const backend = stubBackend([
			{ type: "permission", requestId: "per_2", tool: "bash", path: "git status", summary: "Run git status?" },
			{ type: "text", text: "waiting politely" },
			{ type: "done", text: "" },
		])
		const original = backend.startSession.bind(backend)
		backend.startSession = async (options) => {
			const session = await original(options)
			session.respondToPermission = async (_id: string, decision: string) => {
				decisions.push(decision)
			}
			return session
		}
		const conversation = new AgentConversation(deps(backend))

		await conversation.run({ ...REQUEST, kind: "edit", title: "Edit" })
		await new Promise((resolve) => setTimeout(resolve, 50))

		assert.deepEqual(decisions, [], "an attended ask was answered without the user")
	})
})

/**
 * The stall watchdog: a dead socket is not a working model.
 *
 * Measured in the field: the pinned server's agent loop logged a step and then
 * nothing, forever — no stream error, no idle. Nothing in that stack times
 * out, so without the watchdog the turn is "Working…" until a human gives up.
 * One automatic retry, then an honest failure.
 */
describe("AgentConversation stall watchdog", () => {
	function hangingAfter(events: BackendEvent[]): AsyncGenerator<BackendEvent> {
		return (async function* () {
			yield* events
			await new Promise<never>(() => {})
		})()
	}

	function stalledBackend(sends: Array<() => AsyncGenerator<BackendEvent>>): { backend: CodingBackend; aborts: () => number } {
		let aborts = 0
		let call = 0
		const backend = {
			id: "opencode",
			displayName: "Stub",
			providerName: "Stub",
			async availability() {
				return { ready: true, installed: true, detail: "" }
			},
			async startSession(options: { mode: SessionMode }) {
				return {
					id: "ses_stub",
					mode: options.mode,
					send() {
						const make = sends[Math.min(call, sends.length - 1)]
						call += 1
						return make()
					},
					async respondToPermission() {},
					async abort() {
						aborts += 1
					},
					async close() {},
				}
			},
		} as unknown as CodingBackend
		return { backend, aborts: () => aborts }
	}

	it("aborts a silent stream, retries once, and the retry can finish the turn", async () => {
		const { backend, aborts } = stalledBackend([
			() => hangingAfter([{ type: "text", text: "half a reply, then the wire died" }]),
			() =>
				hangingAfter([
					{ type: "text", text: " — finished after the retry" },
					{ type: "done", text: "" },
				]),
		])
		const conversation = new AgentConversation({ ...deps(backend), stallMs: 40 })

		const outcome = await conversation.run(REQUEST)

		assert.equal(outcome.ok, true, "a recovered turn was reported as a failure")
		assert.equal(aborts(), 1, "the wedged request was not aborted before the retry")
		assert.ok(outcome.text.includes("finished after the retry"))
		const note = conversation.getState().transcript.entries.find((entry) => entry.kind === "note")
		assert(note && note.kind === "note" && /went silent/.test(note.text), "the retry happened without saying why")
	})

	it("pauses the stall clock while a surfaced ask waits on the user", async () => {
		// Measured in the field: an `npm install` ask sat four minutes with the
		// user away, and the watchdog killed the healthy turn and blamed the
		// provider. A human deciding is not a dead socket — the clock must not
		// run while the question is theirs.
		let answer = () => {}
		const answered = new Promise<void>((resolve) => {
			answer = resolve
		})
		let aborts = 0
		const backend = {
			id: "opencode",
			displayName: "Stub",
			providerName: "Stub",
			async availability() {
				return { ready: true, installed: true, detail: "" }
			},
			async startSession(options: { mode: SessionMode }) {
				return {
					id: "ses_stub",
					mode: options.mode,
					async *send(): AsyncGenerator<BackendEvent> {
						yield {
							type: "permission",
							requestId: "per_wait",
							tool: "bash",
							path: "npm install",
							summary: "Run `npm install`?",
						}
						await answered
						yield { type: "text", text: "installed" }
						yield { type: "done", text: "" }
					},
					async respondToPermission() {
						answer()
					},
					async abort() {
						aborts += 1
					},
					async close() {},
				}
			},
		} as unknown as CodingBackend
		const conversation = new AgentConversation({ ...deps(backend), stallMs: 40 })

		const run = conversation.run(REQUEST)
		// Several full stall windows pass with the ask pending — the user reading.
		await new Promise((resolve) => setTimeout(resolve, 150))
		await conversation.respondToPermission("per_wait", "allow")
		const outcome = await run

		assert.equal(outcome.ok, true, "a turn waiting on the user was reported as a failure")
		assert.equal(aborts, 0, "the watchdog aborted a turn that was waiting on the user")
		assert.ok(outcome.text.includes("installed"), "the answered turn did not finish its work")
	})

	it("a running tool is quiet work, not a stalled provider", async () => {
		// Field-measured: asset generation queues, spaces and retries (quota),
		// so one generate call legitimately runs many silent minutes — and the
		// watchdog killed the healthy turn twice ("the provider went silent").
		let finishTool!: () => void
		const gate = new Promise<void>((resolve) => {
			finishTool = resolve
		})
		const { backend, aborts } = stalledBackend([
			() =>
				(async function* (): AsyncGenerator<BackendEvent> {
					yield { type: "tool-start", callId: "c1", name: "caret_generate_asset", summary: "a sauce bottle" }
					await gate
					yield { type: "tool-end", callId: "c1", name: "caret_generate_asset", ok: true }
					yield { type: "text", text: "bottle generated" }
					yield { type: "done", text: "" }
				})(),
		])
		const conversation = new AgentConversation({ ...deps(backend), stallMs: 40, toolStallMs: 5_000 })

		const run = conversation.run(REQUEST)
		// Several full stall windows pass with the tool running — the queue working.
		await new Promise((resolve) => setTimeout(resolve, 150))
		finishTool()
		const outcome = await run

		assert.equal(outcome.ok, true, "a turn waiting on its own tool was reported as a failure")
		assert.equal(aborts(), 0, "the watchdog aborted a turn whose tool was still working")
		assert.ok(outcome.text.includes("bottle generated"), "the finished turn lost its reply")
	})

	it("a tool that outlives even the tool ceiling still trips the watchdog", async () => {
		// The bound matters: a stream that died mid-tool never delivers the
		// tool-end, and without the ceiling the exemption would hang forever.
		const { backend, aborts } = stalledBackend([
			() =>
				(async function* (): AsyncGenerator<BackendEvent> {
					yield { type: "tool-start", callId: "c1", name: "caret_generate_asset", summary: "a sauce bottle" }
					await new Promise(() => {}) // the wire is dead; tool-end never comes
				})(),
		])
		const conversation = new AgentConversation({ ...deps(backend), stallMs: 30, toolStallMs: 90 })

		const outcome = await conversation.run(REQUEST)

		assert.equal(outcome.ok, false, "a dead-mid-tool stream was reported as a success")
		assert.ok(aborts() >= 1, "the dead stream was never aborted")
	})

	it("fails the turn with its name on it when the stream stalls twice", async () => {
		const { backend, aborts } = stalledBackend([() => hangingAfter([{ type: "text", text: "start" }])])
		const conversation = new AgentConversation({ ...deps(backend), stallMs: 40 })

		const outcome = await conversation.run(REQUEST)

		assert.equal(outcome.ok, false, "a twice-stalled turn was reported as a success")
		assert.equal(aborts(), 2, "each stalled attempt must be aborted server-side")
		const error = conversation.getState().transcript.entries.find((entry) => entry.kind === "error")
		assert(error && error.kind === "error" && /went silent again/.test(error.message), "the failure does not name the stall")
	})

	it("nudges a plan turn that ended after tools with no reply, and the nudge can recover it", async () => {
		// The measured ChatGPT-route failure: one refused tool call ends the
		// whole turn 0.2s later, mid-read, no reply. The nudge asks for the plan
		// directly; the model still holds everything it read.
		const { backend } = stalledBackend([
			() =>
				(async function* (): AsyncGenerator<BackendEvent> {
					yield { type: "tool-start", callId: "c1", name: "bash", summary: "git ls-tree" }
					yield { type: "tool-end", callId: "c1", name: "bash", ok: false }
					yield { type: "done", text: "" }
				})(),
			() =>
				(async function* (): AsyncGenerator<BackendEvent> {
					yield { type: "text", text: "1. Create src/App.tsx from the home page." }
					yield { type: "done", text: "" }
				})(),
		])
		const conversation = new AgentConversation({ ...deps(backend), stallMs: 5_000 })

		const outcome = await conversation.run({
			kind: "sync-plan",
			title: "Sync design → app",
			mode: "read-only",
			prompt: "plan",
		})

		assert.equal(outcome.ok, true, "a nudge-recovered plan turn was reported as a failure")
		assert.equal(outcome.closingText, "1. Create src/App.tsx from the home page.")
		assert(conversation.settledPlan(), "the recovered plan did not settle")
		const note = conversation.getState().transcript.entries.find((entry) => entry.kind === "note")
		assert(note && note.kind === "note" && /asking it to write/.test(note.text), "the nudge happened without saying so")
	})

	it("a stall never settles a plan", async () => {
		const { backend } = stalledBackend([() => hangingAfter([{ type: "text", text: "I'll inventory the routes…" }])])
		const conversation = new AgentConversation({ ...deps(backend), stallMs: 40 })

		const outcome = await conversation.run({
			kind: "sync-plan",
			title: "Sync design → app",
			mode: "read-only",
			prompt: "plan",
		})

		assert.equal(outcome.ok, false)
		assert.equal(conversation.getState().plan, null, "a stalled plan turn left a plan armed")
	})
})

/**
 * The plan-mode contract: the reply IS the deliverable.
 *
 * A read-only turn that read, and possibly thought, and never wrote the plan
 * is a FAILURE — the observed field bug was an Apply gate shipping with
 * literally nothing behind it, because "tools ran, then silence" counted as
 * ok. And only a completed plan-mode turn with a real reply may settle a plan
 * for the Plan→Act flip to execute.
 */
describe("AgentConversation plan mode", () => {
	const PLAN_REQUEST = { kind: "sync-plan" as const, title: "Sync design → app", mode: "read-only" as const, prompt: "plan it" }

	it("fails a read-only turn that did tool work and never wrote the plan", async () => {
		const conversation = new AgentConversation(
			deps(
				stubBackend([
					{ type: "tool-start", callId: "c1", name: "glob", summary: "src/**" },
					{ type: "tool-end", callId: "c1", name: "glob", ok: true },
					{ type: "done", text: "" },
				]),
			),
		)

		const outcome = await conversation.run(PLAN_REQUEST)

		assert.equal(outcome.ok, false, "a plan turn with no plan was reported as a success")
		const error = conversation.getState().transcript.entries.find((entry) => entry.kind === "error")
		assert(
			error && error.kind === "error" && /would not write the plan/.test(error.message),
			"the error does not name the failure",
		)
		assert.equal(conversation.getState().plan, null, "an empty plan settled anyway")
	})

	it("fails a read-only turn whose only text was a preamble before the tool work", async () => {
		// The field case, second edition: "I'll inventory the routes…" then tools
		// for the rest of the turn and no reply at the end. The whole-turn text
		// is NON-empty, which is how the first guard blessed a status sentence
		// as a plan. Only the closing reply counts.
		const conversation = new AgentConversation(
			deps(
				stubBackend([
					{ type: "text", text: "I'll inventory the current application routes without modifying anything." },
					{ type: "tool-start", callId: "c1", name: "glob", summary: "src/**" },
					{ type: "tool-end", callId: "c1", name: "glob", ok: true },
					{ type: "done", text: "" },
				]),
			),
		)

		const outcome = await conversation.run(PLAN_REQUEST)

		assert.equal(outcome.ok, false, "a preamble-only plan turn was reported as a success")
		assert.equal(outcome.closingText.trim(), "")
		assert.equal(conversation.getState().plan, null, "the preamble settled as a plan")
	})

	it("settles the closing reply when a preamble came first", async () => {
		const conversation = new AgentConversation(
			deps(
				stubBackend([
					{ type: "text", text: "I'll look at the routes first." },
					{ type: "tool-start", callId: "c1", name: "glob", summary: "src/**" },
					{ type: "tool-end", callId: "c1", name: "glob", ok: true },
					{ type: "text", text: "1. Change checkout-view.tsx" },
					{ type: "done", text: "" },
				]),
			),
		)

		const outcome = await conversation.run(PLAN_REQUEST)

		assert.equal(outcome.ok, true)
		assert.equal(outcome.closingText, "1. Change checkout-view.tsx")
		const state = conversation.getState()
		const entry = state.transcript.entries.find((e) => e.id === state.plan?.entryId)
		// The card must wrap the reply, not the preamble.
		assert(
			entry && entry.kind === "assistant" && entry.text === "1. Change checkout-view.tsx",
			"the card marks the wrong entry",
		)
	})

	it("fails a read-only turn whose only output was reasoning", async () => {
		// The collapsed-Thinking edge: a reasoning model can put the whole plan
		// in thoughts and reply with nothing. Thinking is visible activity, so
		// the generic empty-response check passes — this rule has to catch it.
		const conversation = new AgentConversation(
			deps(
				stubBackend([
					{ type: "thinking", text: "five paragraphs of internal planning" },
					{ type: "done", text: "" },
				]),
			),
		)

		const outcome = await conversation.run(PLAN_REQUEST)

		assert.equal(outcome.ok, false, "a reasoning-only plan turn was reported as a success")
		assert.equal(conversation.getState().plan, null)
	})

	it("settles a plan off a completed read-only turn and marks its entry", async () => {
		const conversation = new AgentConversation(
			deps(
				stubBackend([
					{ type: "text", text: "1. Change checkout-view.tsx" },
					{ type: "done", text: "" },
				]),
			),
		)

		const outcome = await conversation.run(PLAN_REQUEST)

		assert.equal(outcome.ok, true)
		const state = conversation.getState()
		assert(state.plan, "no plan settled")
		assert.equal(state.plan?.kind, "sync-plan")
		const entry = state.transcript.entries.find((e) => e.id === state.plan?.entryId)
		assert(entry && entry.kind === "assistant" && entry.plan === true, "the plan entry is not marked")
		assert.equal(conversation.settledPlan()?.sessionId, "ses_stub")
	})

	it("sendMessage runs in the conversation's mode, not the last activity's", async () => {
		const modes: SessionMode[] = []
		const backend = stubBackend([
			{ type: "text", text: "a plan" },
			{ type: "done", text: "" },
		])
		const original = backend.startSession.bind(backend)
		backend.startSession = async (options) => {
			modes.push(options.mode)
			return original(options)
		}
		const conversation = new AgentConversation(deps(backend))

		await conversation.run(PLAN_REQUEST)
		// The user flips to Act, then types — the send must run write, even
		// though the current activity was the read-only plan turn.
		conversation.setMode("write")
		await conversation.sendMessage("actually, go ahead differently")

		assert.deepEqual(modes, ["read-only", "write"], "the send inherited the activity's mode instead of the toggle's")
	})

	it("a write-mode turn consumes the settled plan", async () => {
		const conversation = new AgentConversation(
			deps(
				stubBackend([
					{ type: "text", text: "content" },
					{ type: "done", text: "" },
				]),
			),
		)

		await conversation.run(PLAN_REQUEST)
		assert(conversation.settledPlan(), "no plan to consume")
		await conversation.run({ kind: "sync-apply", title: "Sync design → app", mode: "write", prompt: "apply" })

		assert.equal(conversation.settledPlan(), null, "execution left the plan armed")
	})

	it("a failed revision un-arms the plan", async () => {
		// First turn settles a plan; the revision turn ends empty. The safe
		// reading of a broken revision is "there is no approved intent", never
		// "execute the previous version".
		const events: BackendEvent[][] = [
			[
				{ type: "text", text: "the first plan" },
				{ type: "done", text: "" },
			],
			[{ type: "done", text: "" }],
		]
		const backend = stubBackend([])
		backend.startSession = async (options: { mode: SessionMode }) => ({
			id: "ses_stub",
			mode: options.mode,
			async *send() {
				yield* events.shift() ?? []
			},
			async respondToPermission() {},
			async abort() {},
			async close() {},
		})
		const conversation = new AgentConversation(deps(backend))

		await conversation.run(PLAN_REQUEST)
		assert(conversation.settledPlan(), "the first plan did not settle")
		await conversation.run({ ...PLAN_REQUEST, prompt: "revise it" })

		assert.equal(conversation.settledPlan(), null, "a failed revision left the stale plan armed")
	})

	it("settledPlan() is null while a turn streams", async () => {
		// A plan is settled, then a REVISION turn is streaming when the flip
		// lands. The stale plan is still in memory — and must be unreachable,
		// or the flip executes a version the user is mid-way through changing.
		let release: () => void = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let turn = 0
		const backend = stubBackend([])
		backend.startSession = async (options: { mode: SessionMode }) => ({
			id: "ses_stub",
			mode: options.mode,
			async *send(): AsyncGenerator<BackendEvent> {
				turn += 1
				if (turn === 1) {
					yield { type: "text", text: "the first plan" }
					yield { type: "done", text: "" }
					return
				}
				yield { type: "text", text: "revising…" }
				await gate
				yield { type: "done", text: "" }
			},
			async respondToPermission() {},
			async abort() {},
			async close() {},
		})
		const conversation = new AgentConversation(deps(backend))

		await conversation.run(PLAN_REQUEST)
		assert(conversation.settledPlan(), "the first plan did not settle")

		const revision = conversation.run({ ...PLAN_REQUEST, prompt: "revise it" })
		await new Promise((resolve) => setTimeout(resolve, 20))
		assert.equal(conversation.settledPlan(), null, "a flip racing the stream could have executed the stale plan")
		release()
		await revision

		assert(conversation.settledPlan(), "the revision did not settle once the stream ended")
	})
})
