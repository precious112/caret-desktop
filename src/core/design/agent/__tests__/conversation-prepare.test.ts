/**
 * The Design pass runs inside a chat turn, between the echo of the user's
 * message and the session: these pin that seam. The user's words are what
 * the chat shows; the plan travels in that turn's system text; a pass that
 * fails or is stopped ends the turn there, and never falls through to a build
 * without it.
 */
import { strict as assert } from "assert"

import type { BackendEvent, CodingBackend, SessionMode, StartSessionOptions } from "../backend"
import { AgentConversation, type ConversationDeps, type PrepareApi } from "../conversation"

function backend(events: BackendEvent[], started: StartSessionOptions[], sent: string[]): CodingBackend {
	return {
		id: "opencode",
		displayName: "Stub",
		providerName: "Stub",
		async availability() {
			return { ready: true, installed: true, detail: "" }
		},
		async startSession(options: StartSessionOptions & { mode: SessionMode }) {
			started.push(options)
			return {
				id: "ses_stub",
				mode: options.mode,
				async *send(input: { text: string }) {
					sent.push(input.text)
					yield* events
				},
				async respondToPermission() {},
				async abort() {},
				async close() {},
			}
		},
		async structured() {
			throw new Error("not used here")
		},
	} as unknown as CodingBackend
}

const REPLY: BackendEvent[] = [
	{ type: "text", text: "Built." },
	{ type: "done", text: "Built." },
]

function setup(designPass: (prompt: string, api: PrepareApi) => Promise<{ system?: string } | null>) {
	const started: StartSessionOptions[] = []
	const sent: string[] = []
	const deps: ConversationDeps = {
		projectPath: "/tmp/nowhere",
		resolveBackend: async () => backend(REPLY, started, sent),
		model: () => undefined,
		effort: () => undefined,
		appWrites: () => "ask",
		setAppWrites: async () => {},
		systemPrompt: async () => "PRECEDENCE",
		onChange: () => {},
		designPassOn: () => true,
		designPass,
	}
	return { conversation: new AgentConversation(deps), started, sent }
}

describe("the Design pass inside a chat turn", () => {
	it("keeps the user's words as the prompt and puts the plan in this turn's system text", async () => {
		const { conversation, started, sent } = setup(async (_prompt, api) => {
			api.progress("plan", "active")
			api.progress("plan", "done")
			return { system: "THE APPROVED PLAN" }
		})
		const outcome = await conversation.sendMessage("Make a landing page")
		assert.equal(outcome.ok, true)
		assert.deepEqual(sent, ["Make a landing page"])
		assert.equal(started[0].systemPrompt, "PRECEDENCE\n\nTHE APPROVED PLAN")

		const entries = conversation.getState().transcript.entries
		assert.equal(entries[0].kind, "user")
		const pass = entries.find((e) => e.kind === "design-pass")
		assert.ok(pass && pass.kind === "design-pass")
		assert.deepEqual(
			pass.steps.map((s) => `${s.step}:${s.state}`),
			["plan:done", "check:pending", "polish:pending", "build:done"],
		)
	})

	it("runs the turn untouched when the message is not page work", async () => {
		const { conversation, started } = setup(async () => null)
		await conversation.sendMessage("Make the button blue")
		assert.equal(started[0].systemPrompt, "PRECEDENCE")
		assert.ok(!conversation.getState().transcript.entries.some((e) => e.kind === "design-pass"))
	})

	it("ends the turn with the pass's error, and never opens a session to build without it", async () => {
		const { conversation, started } = setup(async (_prompt, api) => {
			api.progress("plan", "active")
			throw new Error("The Design pass stopped: the plan came back unusable.")
		})
		const outcome = await conversation.sendMessage("Make a landing page")
		assert.equal(outcome.ok, false)
		assert.equal(started.length, 0)
		const entries = conversation.getState().transcript.entries
		const error = entries.find((e) => e.kind === "error")
		assert.ok(error && error.kind === "error" && error.message.includes("plan came back unusable"))
		const pass = entries.find((e) => e.kind === "design-pass")
		assert.ok(pass && pass.kind === "design-pass" && pass.steps[0].state === "failed")
		assert.equal(conversation.getState().streaming, false)
	})

	it("stops when the user presses Stop during the pass, quietly", async () => {
		let release: () => void = () => {}
		const { conversation, started } = setup(
			(_prompt, api) =>
				new Promise((_resolve, reject) => {
					api.progress("check", "active")
					api.signal.addEventListener("abort", () => reject(new Error("Stopped.")))
					release = () => void conversation.abort()
				}),
		)
		const turn = conversation.sendMessage("Make a landing page")
		await new Promise((resolve) => setTimeout(resolve, 10))
		release()
		const outcome = await turn
		assert.equal(outcome.ok, false)
		assert.equal(started.length, 0)
		assert.ok(!conversation.getState().transcript.entries.some((e) => e.kind === "error"), "a stop is not an error")
	})

	it("never prepares a plan-mode turn", async () => {
		let prepared = 0
		const { conversation } = setup(async () => {
			prepared += 1
			return null
		})
		conversation.setMode("read-only")
		await conversation.sendMessage("Make a landing page")
		assert.equal(prepared, 0)
	})
})
