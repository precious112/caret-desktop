/**
 * One project's chat with its backend.
 *
 * This is where Caret owning the loop actually shows up: it starts sessions,
 * decides every permission, keeps the transcript, and hands the renderer a state
 * object rather than a stream of half-interpreted backend events.
 *
 * **One session per activity** — a sync, an edit, a brainstorm — never one
 * endless thread. The history panel then reads as a list of things the user did,
 * which is the only shape in which chat history is worth keeping at all.
 */
import { readFile } from "fs/promises"
import { join } from "path"

import { Logger } from "@/shared/services/Logger"
import { expandReferences, readAssetIndex } from "../assets"
import { emitDesignEvent } from "../telemetry-hooks"
import {
	type BackendEvent,
	type BackendId,
	type BackendSession,
	type CodingBackend,
	NoBackendError,
	type PermissionDecision,
	type ReasoningEffort,
	type SessionMode,
} from "./backend"
import { type AppWritePolicy, rulePermission } from "./permissions"
import {
	addNote,
	addUserMessage,
	applyEvent,
	emptyTranscript,
	markPlanEntry,
	resolvePermission,
	type TranscriptState,
} from "./transcript"

export type ActivityKind = "chat" | "edit" | "sync-plan" | "sync-apply" | "flow-sync"

export interface Activity {
	id: string
	kind: ActivityKind
	title: string
	mode: SessionMode
	sessionId: string
}

/**
 * A plan the user can act on: the reply of the last completed plan-mode turn.
 *
 * "Settled" is the load-bearing word — a plan exists only when its turn is over
 * and its text is non-empty. A turn that read and thought and never replied
 * settles nothing (that turn FAILS, see `run`), and `settledPlan()` returns
 * null while a turn streams, so flipping the Plan/Act toggle mid-stream can
 * only ever change the mode. The user's flip can never execute a plan they
 * did not read.
 */
export interface SettledPlan {
	/** Which continuation the flip runs: "sync-plan" applies the sync, anything else continues generically. */
	kind: ActivityKind
	sessionId: string
	/** The transcript entry that is the live plan card. */
	entryId: string
	text: string
}

export interface ConversationState {
	backendId: BackendId | null
	backendName: string | null
	/** Who serves this backend's models, for ids that do not name a provider. */
	providerName: string | null
	ready: boolean
	/** Why it is not ready, when it is not. */
	blocked: string | null
	activity: Activity | null
	streaming: boolean
	/**
	 * When the backend last said anything at all during the current turn —
	 * a token, a thought, a tool event. The renderer computes the silence from
	 * this on its own clock, which is what lets "Working…" distinguish a model
	 * that is thinking (reasoning deltas keep this fresh) from a provider that
	 * is failing and being silently retried. The pinned server (1.18.23)
	 * documents `session.retry.scheduled` and the mapper consumes it, but the
	 * event has never been observed live — so silence stays the version-proof
	 * signal, refreshed with a transcript note whenever the retry event does
	 * arrive. Null outside a turn.
	 */
	lastEventAt: number | null
	transcript: TranscriptState
	/**
	 * The conversation's Plan/Act position. Sends run in this mode; the composer
	 * toggle reads and flips it. Per-conversation and in-memory on purpose —
	 * plan mode is a stance taken for one conversation, not a preference.
	 */
	mode: SessionMode
	/** The renderer's slice of the settled plan: which entry is the live card. */
	plan: { kind: ActivityKind; entryId: string } | null
	/** Whether app-path writes still prompt in this project. */
	appWrites: AppWritePolicy
	/**
	 * The chosen model and effort, as configured.
	 *
	 * Pushed rather than read by the renderer. The chat panel used to fetch these
	 * from preferences itself, keyed on the backend id — so changing the *model*
	 * never re-ran the fetch and the composer showed a stale value forever. State
	 * the user can change belongs on one path out of main, not two.
	 */
	model: string | null
	effort: string | null
}

export interface ConversationDeps {
	projectPath: string
	/** The configured backend, or null when the user has not chosen one that works. */
	resolveBackend(): Promise<CodingBackend | null>
	model(): string | undefined
	effort(): ReasoningEffort | undefined
	appWrites(): AppWritePolicy
	setAppWrites(policy: AppWritePolicy): Promise<void>
	/** Foundations, authoring rules and the asset index, injected directly. */
	systemPrompt(): Promise<string | undefined>
	onChange(state: ConversationState): void
	/**
	 * Fired after a turn settles, successful or not. The desktop wires the
	 * acceptance checker here — the owned loop is what makes checks ENFORCED
	 * rather than requested, and this is the loop's seam. Never awaited by the
	 * turn itself.
	 */
	onTurnComplete?(outcome: RunOutcome, request: RunRequest): void
	/** Overrides the stall watchdog's threshold. Tests only. */
	stallMs?: number
	/** Overrides the running-tool stall ceiling. Tests only. */
	toolStallMs?: number
}

export interface RunRequest {
	kind: ActivityKind
	title: string
	mode: SessionMode
	/** What the model receives. */
	prompt: string
	/**
	 * What the chat shows instead, when the two differ.
	 *
	 * Caret's own prompts are instruction blocks — the sync worklist is a page of
	 * `<explicit_instructions>` — and pasting one into the transcript as if the
	 * user had typed it makes the chat unreadable at the exact moment they are
	 * trying to follow what is happening.
	 */
	displayPrompt?: string
	images?: string[]
	/** Continue an existing backend session instead of opening a new one. */
	resumeSessionId?: string
	/** Line shown above the turn, in Caret's own voice. */
	note?: string
	/**
	 * Nobody is watching this turn's prompts (a playground take). A permission
	 * that would ASK is denied with a reason instead — an invisible question is
	 * a deadlock, not a safeguard.
	 */
	unattended?: boolean
	/** Tools withheld from the model this turn, in the backend's namespace. See {@link SendInput.disabledTools}. */
	disabledTools?: string[]
	/**
	 * Kind-specific structured context, carried through the turn untouched so
	 * `onTurnComplete` subscribers can read what the task was about (the overlay
	 * verify loop keys on this). Opaque here by design: the conversation never
	 * reads it.
	 */
	context?: Record<string, unknown>
}

export interface RunOutcome {
	ok: boolean
	sessionId: string | null
	/** Everything the assistant said this turn, concatenated. */
	text: string
	/** Only what it said after its last tool call — the turn's actual reply. */
	closingText: string
	filesChanged: string[]
}

/** State pushes are coalesced to this interval so token streaming isn't one IPC per character. */
const PUSH_INTERVAL_MS = 60

/**
 * True silence for this long trips the stall watchdog — when nothing is known
 * to be working. A dead socket emits nothing forever and cannot hide inside it.
 */
const DEFAULT_STALL_MS = 4 * 60_000

/**
 * The higher ceiling while a TOOL is running. A tool emits nothing between
 * tool-start and tool-end, and that silence is Caret's own work, not the
 * provider's health — field-measured: asset generation now queues, spaces and
 * retries (quota), so one turn's generate calls legitimately run many minutes,
 * and the 4-minute watchdog killed healthy turns twice in a row ("the
 * provider went silent"). Bounded rather than exempt, under the MCP layer's
 * own 30-minute tool timeout: a stream that died mid-tool never delivers the
 * tool-end, and this ceiling is what still catches it. 25 minutes because the
 * unified 3D tool is now the longest legitimate call — a Tripo draft and its
 * optimization convert are each allowed 10 minutes on their own.
 */
const TOOL_STALL_MS = 25 * 60_000

/**
 * What the retry says. Generic across modes on purpose: a plan turn should
 * finish its plan, a write turn its edits, and the model — with the whole
 * session still in context — knows which it was doing.
 */
const STALL_CONTINUE_PROMPT =
	"Your previous stream died mid-turn and was cut off — nothing you were told has changed. Pick up exactly where you stopped and finish the turn; if the work was already done, write your reply now."

/**
 * The empty-close recovery for plan turns. Blunt about refusals because a
 * refusal is the measured killer: the turn ends the moment a tool is denied
 * (both provider routes, measured), and the model needs telling that this is
 * survivable. The denied commands are NAMED because the pinned server drops
 * the feedback Caret attaches to the rejection itself — this prompt is the
 * only channel the reasons actually reach the model through until the pin
 * bump.
 */
function buildNudgePrompt(denied: string[]): string {
	const refusals =
		denied.length > 0
			? `These tool calls were refused by plan-mode policy, which only permits reads: ${denied.map((d) => `\`${d}\``).join(", ")}. That is expected — plans read, the apply phase acts. `
			: "If any tool call was refused, that is expected in plan mode — work without it. "
	return `You ended your turn without writing the plan. ${refusals}Do not call any more tools. Using only what you have already read, write the complete plan as your reply now.`
}

/** Resolves "stall" if `promise` doesn't settle within `ms`. Timer never leaks. */
function raceStall<T>(promise: Promise<T>, ms: number): Promise<T | "stall"> {
	return new Promise<T | "stall">((resolve, reject) => {
		const timer = setTimeout(() => resolve("stall"), ms)
		promise.then(
			(value) => {
				clearTimeout(timer)
				resolve(value)
			},
			(err) => {
				clearTimeout(timer)
				reject(err)
			},
		)
	})
}

/**
 * The generic act-on-plan prompt. It opens by revoking the planning framing —
 * the same lesson the sync APPLY_PROMPT carries: the plan turn's "you are
 * planning, writes will be refused" is still in the resumed session's context,
 * and a model told to edit while an earlier instruction forbids it lets the
 * two fight. Withdraw first, then instruct.
 */
const ACT_PROMPT = `The planning phase is over and its restrictions no longer apply — the user has read
your plan and approved it. This turn is in write mode and your edits will be accepted.
Make the changes now, exactly as planned, using your edit tools. Producing another plan,
re-reading what you already read, or asking for confirmation is a failure; if something in
the plan turns out to be wrong once you open the file, say so and stop rather than improvising.`

/** A prompt's first line, sized for a list row. */
function firstLine(text: string): string {
	const line = text.trim().split("\n")[0] ?? ""
	return line.length > 60 ? `${line.slice(0, 57)}…` : line
}

let activityCounter = 0

export class AgentConversation {
	private transcript = emptyTranscript()
	private activity: Activity | null = null
	private session: BackendSession | null = null
	private streaming = false
	private lastEventAt: number | null = null
	private conversationMode: SessionMode = "write"
	private plan: SettledPlan | null = null
	private backendId: BackendId | null = null
	private stopRequested = false
	private backendName: string | null = null
	private providerName: string | null = null
	private blocked: string | null = null
	private pushTimer: NodeJS.Timeout | null = null
	/** Whether the CURRENT turn runs unattended — see {@link RunRequest.unattended}. */
	private unattendedTurn = false
	/** Auto-denial counts for THIS turn, keyed tool:target — see noteRepeatedDenial. */
	private denialsThisTurn = new Map<string, number>()
	private allowlistCache: { at: number; commands: string[] } | null = null

	constructor(private readonly deps: ConversationDeps) {}

	getState(): ConversationState {
		return {
			backendId: this.backendId,
			backendName: this.backendName,
			providerName: this.providerName,
			ready: this.backendId !== null && this.blocked === null,
			blocked: this.blocked,
			activity: this.activity,
			streaming: this.streaming,
			lastEventAt: this.lastEventAt,
			transcript: this.transcript,
			mode: this.conversationMode,
			plan: this.plan ? { kind: this.plan.kind, entryId: this.plan.entryId } : null,
			appWrites: this.deps.appWrites(),
			model: this.deps.model() ?? null,
			effort: this.deps.effort() ?? null,
		}
	}

	/** Clears the transcript and starts a fresh activity next time. */
	reset(): void {
		this.transcript = emptyTranscript()
		this.activity = null
		this.plan = null
		this.conversationMode = "write"
		this.push(true)
	}

	/**
	 * Runs one turn, streaming into the transcript.
	 *
	 * Refuses rather than queues when there is no backend. A design tool that
	 * silently accepts work nothing will ever do is the exact failure the MCP
	 * outbound path had.
	 */
	async run(request: RunRequest): Promise<RunOutcome> {
		const turnStarted = Date.now()
		// Reset before anything async: a Stop pressed while the session is still
		// being opened is aimed at this turn.
		this.stopRequested = false
		this.unattendedTurn = request.unattended === true
		this.denialsThisTurn = new Map()

		if (!this.activity || this.activity.kind !== request.kind || request.resumeSessionId) {
			this.transcript = request.resumeSessionId ? this.transcript : emptyTranscript()
		}

		// **Echo before anything asynchronous.** Opening a session is a real
		// round-trip — an availability probe, an HTTP call, the system-prompt
		// build — and it used to run before the user's own message was even added
		// to the transcript. On a cold backend that was seconds in which pressing
		// Enter changed nothing on screen, which reads as a hang. The first
		// hundred milliseconds decide whether the app feels alive; nothing about
		// them may wait on a network.
		activityCounter += 1
		this.activity = {
			id: `activity-${activityCounter}`,
			kind: request.kind,
			title: request.title,
			mode: request.mode,
			sessionId: request.resumeSessionId ?? "",
		}
		// The turn's mode becomes the conversation's: this is how a sync opens
		// with the toggle already on Plan without the sync module knowing the
		// toggle exists, and how the toggle reads honestly after the apply turn.
		this.conversationMode = request.mode
		// Execution consumes the plan. Callers that continue FROM the plan read
		// `settledPlan()` before running the write turn; clearing here is what
		// makes a consumed plan's card demote to history.
		if (request.mode === "write") this.plan = null
		if (request.note) addNote(this.transcript, request.note)
		addUserMessage(this.transcript, request.displayPrompt ?? request.prompt)
		this.streaming = true
		// The turn's own start counts as the last sign of life, so the silence
		// clock starts honestly even if the very first token never comes.
		this.lastEventAt = Date.now()
		this.push(true)

		// The session title is what the History panel shows, and a list reading
		// "Chat, Chat, Chat" identifies nothing. A chat is named by its opening
		// message — the user's own words are the best available summary of what
		// the conversation was about.
		const sessionTitle =
			request.kind === "chat" ? firstLine(request.displayPrompt ?? request.prompt) || request.title : request.title

		let session: BackendSession
		try {
			const backend = await this.resolve(request.kind)
			session = await backend.startSession({
				workingDirectory: this.deps.projectPath,
				mode: request.mode,
				model: this.deps.model(),
				effort: this.deps.effort(),
				title: sessionTitle,
				resumeSessionId: request.resumeSessionId,
				systemPrompt: await this.deps.systemPrompt(),
			})
		} catch (err) {
			// The echo promised work; a failure to even open the session has to
			// land in the same transcript, not vanish into a rejected promise.
			this.streaming = false
			applyEvent(this.transcript, {
				type: "error",
				message: err instanceof Error ? err.message : String(err),
				recoverable: true,
			})
			this.push(true)
			throw err
		}

		this.session = session
		this.activity = { ...this.activity, sessionId: session.id }

		let text = ""
		let ok = true
		// A turn can end without the model ever having run: the backend accepts
		// the prompt, its own loop finds nothing to do, and a perfectly real idle
		// arrives over an otherwise empty stream. That is a failed turn, not a
		// quiet success — reporting it `ok` is how a broken sync spent days being
		// blamed on the model. `done` alone is not activity — and neither is a
		// usage event: an EMPTY model step still reports its token count, and
		// that bookkeeping once counted as "activity" and let a turn end showing
		// the user literally nothing.
		let sawAnyEvent = false
		let sawVisible = false
		// Text since the last tool event — the turn's CLOSING reply. `text` is
		// everything the model said; this is only what it said after it stopped
		// working, which is the only part that can be a plan. A model that
		// narrates "I'll inventory the routes…" and then runs tools for the rest
		// of the turn has a non-empty `text` and an empty closing reply — and
		// treating that preamble as "the plan" is exactly how a one-sentence
		// status line shipped inside a plan card with "switch to Act to apply"
		// under it.
		let closingText = ""

		// The stall watchdog. A provider connection can die without erroring —
		// measured: the pinned server's agent loop logged step 3 of a sync plan
		// and then nothing, ever; no stream error, no idle. Nothing in that stack
		// has a timeout, so without this the turn shows "Working…" until the user
		// gives up and presses Stop. Every event resets the clock — reasoning
		// deltas keep a genuinely thinking model alive — so tripping requires
		// TRUE silence. One automatic retry (abort the wedged request, tell the
		// model its stream died, let it pick up in the same session), because a
		// dead socket is transport weather, not a decision anyone needs to make;
		// a second stall fails the turn with its name on it.
		const stallMs = this.deps.stallMs ?? DEFAULT_STALL_MS
		const toolStallMs = this.deps.toolStallMs ?? TOOL_STALL_MS
		let stalled = false
		let stallRetried = false
		let nudged = false
		try {
			let input: { text: string; images?: string[]; disabledTools?: string[] } = {
				text: request.prompt,
				images: request.images,
				disabledTools: request.disabledTools,
			}
			while (true) {
				stalled = false
				let lastActivity = Date.now()
				const stream = session.send(input)[Symbol.asyncIterator]()
				// Held across stall laps: when the timer fires while a permission ask
				// is waiting on the user, the SAME next() promise is re-raced —
				// calling next() again mid-flight would double-pull the iterator.
				let stepPromise: ReturnType<typeof stream.next> | null = null
				while (true) {
					stepPromise ??= stream.next()
					const step = await raceStall(stepPromise, stallMs)
					if (step === "stall") {
						// A surfaced ask produces no stream events while the human
						// decides — that is their time, not the provider's. Measured in
						// the field: an `npm install` ask sat four minutes, and the
						// watchdog killed a healthy turn and blamed the stream. The
						// backend holds asks with no timeout; while one is open, so do we.
						if (this.hasPendingAsk()) continue
						// A running tool is Caret's own work — quiet by nature, not a
						// provider death. Higher ceiling rather than exemption: if the
						// stream died mid-tool, the tool-end never arrives, and the
						// ceiling (past the MCP layer's own tool timeout) catches it.
						if (this.hasRunningTool() && Date.now() - lastActivity < toolStallMs) continue
						stalled = true
						break
					}
					stepPromise = null
					if (step.done) break
					const event = step.value
					this.lastEventAt = Date.now()
					lastActivity = Date.now()
					if (event.type !== "done") sawAnyEvent = true
					if (
						event.type === "text" ||
						event.type === "thinking" ||
						event.type === "tool-start" ||
						event.type === "permission"
					) {
						sawVisible = true
					}
					if (event.type === "text") {
						text += event.text
						closingText += event.text
					}
					if (event.type === "tool-start" || event.type === "tool-end") closingText = ""
					if (event.type === "error") ok = false

					applyEvent(this.transcript, event)

					if (event.type === "permission") {
						// Not awaited: the stream has to keep flowing while a decision is
						// made, or a second permission request in the same turn deadlocks
						// behind the first one's prompt.
						void this.decide(session, event)
					}

					this.push(event.type === "done")
					// `done` IS the end of the turn — the adapter returns right
					// after emitting it. Waiting for the iterator to close as well
					// would hand a stream that never closes to the stall timer.
					if (event.type === "done") break
				}

				if (stalled) {
					// Kill the wedged request server-side before anything else — two
					// live prompts on one session is how a retry becomes a duplicate.
					await session.abort().catch(() => {})
					if (this.stopRequested || stallRetried) break
					stallRetried = true
					addNote(
						this.transcript,
						`The provider went silent for ${Math.round(stallMs / 60_000)} minutes — the stream likely died upstream, and the backend does not time out on its own. Retrying the turn.`,
					)
					this.push(true)
					input = { text: STALL_CONTINUE_PROMPT, disabledTools: request.disabledTools }
					continue
				}

				// The turn ended cleanly but a plan turn's deliverable — the closing
				// reply — never came. Ask for it directly, once, before failing.
				// Measured cause on the ChatGPT provider route: one REFUSED tool call
				// ends the whole turn 0.2s later, so any plan turn that trips a
				// refusal dies mid-read. The model still holds everything it read;
				// one "write it now" almost always completes the plan. Auto-correct,
				// not just detect.
				if (
					request.mode === "read-only" &&
					ok &&
					sawVisible &&
					closingText.trim() === "" &&
					!this.stopRequested &&
					!nudged
				) {
					nudged = true
					addNote(this.transcript, "The model stopped without writing the plan — asking it to write it now.")
					this.push(true)
					input = {
						text: buildNudgePrompt([...this.denialsThisTurn.keys()].map((key) => key.slice(key.indexOf(":") + 1))),
						disabledTools: request.disabledTools,
					}
					continue
				}
				break
			}

			if (stalled && !this.stopRequested) {
				ok = false
				applyEvent(this.transcript, {
					type: "error",
					message:
						"The provider went silent again after a retry — the turn is over. Send again, switch model, or try later.",
					recoverable: true,
				})
			}
		} catch (err) {
			ok = false
			applyEvent(this.transcript, {
				type: "error",
				message: err instanceof Error ? err.message : String(err),
				recoverable: true,
			})
		} finally {
			// A user's Stop can also end a turn before its first event; that is
			// their call, not a backend fault.
			if (ok && !sawVisible && !this.stopRequested) {
				ok = false
				applyEvent(this.transcript, {
					type: "error",
					message: sawAnyEvent
						? "The model returned an empty response — it ran, and generated nothing. Send again, or switch model."
						: "The backend accepted the prompt but never ran it — nothing was done. This is a Caret↔backend fault, not the model.",
					recoverable: true,
				})
			}
			// The other half-empty ending: the model did real work (tools ran)
			// and then closed its mouth. In a write turn that can be legitimate —
			// edits without prose — so it stays a muted note. In a plan turn the
			// CLOSING reply is the deliverable: a turn that read, and possibly
			// thought, and possibly narrated its intentions up front, but never
			// wrote the plan at the end is a failure — or a status sentence ships
			// inside a plan card, which is exactly how it shipped once. The
			// reasoning-only case lands here too (thinking sets `sawVisible`);
			// no auto-retry, because recovery is one keypress — every plan-mode
			// send is another plan turn — and a silent re-prompt spends money
			// invisibly.
			if (ok && !this.stopRequested) {
				if (request.mode === "read-only" && sawVisible && closingText.trim() === "") {
					ok = false
					applyEvent(this.transcript, {
						type: "error",
						message:
							"The model would not write the plan, even when asked directly after its tool work. Send again, or switch model.",
						recoverable: true,
					})
				} else if (request.mode === "write" && sawVisible && text.trim() === "") {
					addNote(this.transcript, "The model ended its turn without a reply.")
				}
			}
			// A pending ask cannot outlive its turn, however the turn ended. The
			// `done` event sweeps these; a turn that dies by error or abort never
			// emits one, and a lingering "pending" entry would leave ghost buttons
			// AND permanently pause the stall watchdog for every later turn.
			for (const entry of this.transcript.entries) {
				if (entry.kind === "permission" && entry.status === "pending") {
					entry.status = "denied"
					entry.automatic = "the turn ended before this was answered"
				}
			}
			this.streaming = false
			this.push(true)
		}

		// A completed plan turn settles its CLOSING reply as THE plan; a failed
		// one un-arms whatever was settled before, because the safe reading of a
		// broken revision is "there is no approved intent anymore", never
		// "execute the previous version". The closing reply is always the last
		// assistant entry — text after a tool line starts a fresh entry — so the
		// mark and the measure agree.
		if (request.mode === "read-only") {
			if (ok && closingText.trim() !== "") {
				const entryId = markPlanEntry(this.transcript)
				if (entryId) this.plan = { kind: request.kind, sessionId: session.id, entryId, text: closingText }
			} else {
				this.plan = null
			}
			this.push(true)
		}

		const outcome: RunOutcome = { ok, sessionId: session.id, text, closingText, filesChanged: [...this.transcript.files] }
		emitDesignEvent("agent_turn_completed", {
			kind: request.kind,
			ok,
			duration_s: Math.round((Date.now() - turnStarted) / 1000),
			files_changed: outcome.filesChanged.length,
			unattended: this.unattendedTurn,
		})
		try {
			this.deps.onTurnComplete?.(outcome, request)
		} catch (err) {
			Logger.warn(`[agent] onTurnComplete hook failed: ${err}`)
		}
		return outcome
	}

	/**
	 * Continues the current activity, or opens a brainstorming one.
	 *
	 * `@tag` is resolved here rather than by the caller, so every surface that can
	 * send a chat message gets it — and here rather than left to the model, which
	 * is the rule §4.6 states for the visual editor and holds for the same reason:
	 * an agent that fails to resolve a tag does not error, it invents an asset
	 * that suits the name. The chat still shows what the user typed; only the
	 * model sees the expansion.
	 */
	async sendMessage(text: string, images?: string[]): Promise<RunOutcome> {
		const current = this.activity
		const expansion = expandReferences(text, await readAssetIndex(this.deps.projectPath))
		const prompt =
			expansion.unknown.length > 0
				? `${expansion.text}\n\nThe user referred to ${expansion.unknown
						.map((tag) => `@${tag}`)
						.join(
							", ",
						)}, which ${expansion.unknown.length === 1 ? "is not an asset" : "are not assets"} in this project. Do not invent ${
						expansion.unknown.length === 1 ? "it" : "them"
					} — say the tag does not exist and list what does.`
				: expansion.text

		return this.run({
			kind: current?.kind ?? "chat",
			title: current?.title ?? "Chat",
			// The toggle's mode, not the last activity's. The old inherit meant
			// typing while a sync plan was current silently ran read-only with
			// nothing on screen saying so; now the composer toggle IS the truth.
			mode: this.conversationMode,
			prompt,
			displayPrompt: prompt === text ? undefined : text,
			...(images && images.length > 0 ? { images } : {}),
			resumeSessionId: current?.sessionId,
		})
	}

	async abort(): Promise<void> {
		this.stopRequested = true
		emitDesignEvent("agent_turn_aborted", { kind: this.activity?.kind ?? "chat" })
		await this.session?.abort()
		this.streaming = false
		this.push(true)
	}

	/**
	 * Whether a permission ask is sitting with the user right now. Auto-ruled
	 * asks resolve within milliseconds of arriving, so a pending entry at stall
	 * time is one Caret surfaced — the watchdog's clock pauses on it.
	 */
	private hasPendingAsk(): boolean {
		return this.transcript.entries.some((entry) => entry.kind === "permission" && entry.status === "pending")
	}

	/** A tool the backend is still executing — quiet work, not provider silence. */
	private hasRunningTool(): boolean {
		return this.transcript.entries.some((entry) => entry.kind === "tool" && entry.status === "running")
	}

	/** The user answering a permission prompt Caret chose to surface. */
	async respondToPermission(requestId: string, decision: PermissionDecision): Promise<void> {
		if (decision === "allow-always") await this.deps.setAppWrites("allow")
		resolvePermission(this.transcript, requestId, decision === "deny" ? "denied" : "allowed")
		await this.session?.respondToPermission(
			requestId,
			decision,
			decision === "deny" ? "the user declined this — do not retry it; find another way, or finish without it" : undefined,
		)
		this.push(true)
	}

	/**
	 * The project's own additions to the plan-mode command allowlist, from
	 * `.caret/permissions.json` (`{ "readOnlyCommands": ["npm ls", …] }`).
	 * Read fresh with a short cache: permission events are rare, and a user
	 * editing the file mid-conversation should not need a restart.
	 */
	private async userAllowlist(): Promise<string[]> {
		const now = Date.now()
		if (this.allowlistCache && now - this.allowlistCache.at < 5_000) return this.allowlistCache.commands
		let commands: string[] = []
		try {
			const raw = await readFile(join(this.deps.projectPath, ".caret", "permissions.json"), "utf-8")
			const parsed = JSON.parse(raw) as { readOnlyCommands?: unknown }
			if (Array.isArray(parsed.readOnlyCommands)) {
				commands = parsed.readOnlyCommands.filter((entry): entry is string => typeof entry === "string")
			}
		} catch {
			// No file, or not JSON: the built-in allowlist stands alone.
		}
		this.allowlistCache = { at: now, commands }
		return commands
	}

	/**
	 * A model asking twice for something Caret refused is a model that needs
	 * it. The refusals themselves are already in the transcript line by line;
	 * this note is the step back — it tells the USER the agent is blocked and
	 * names the ways out, instead of letting the pattern scroll past as noise.
	 */
	private noteRepeatedDenial(tool: string, target: string): void {
		const key = `${tool}:${target}`
		const count = (this.denialsThisTurn.get(key) ?? 0) + 1
		this.denialsThisTurn.set(key, count)
		if (count !== 2) return
		addNote(
			this.transcript,
			`The agent has now been refused \`${target || tool}\` twice — it seems to need it. If it is safe, add it to .caret/permissions.json under "readOnlyCommands"; otherwise reply and tell the agent what to use instead.`,
		)
	}

	/**
	 * Flips the Plan/Act position. A pure state change — the decision to
	 * EXECUTE on a flip belongs to the host (AgentService), which is the only
	 * caller that knows which continuation a plan's kind demands.
	 */
	setMode(mode: SessionMode): void {
		this.conversationMode = mode
		this.push(true)
	}

	/**
	 * The settled plan, or null — and null WHILE A TURN STREAMS, uncondition-
	 * ally. This is the guard that makes a Plan→Act flip landing mid-turn a
	 * mode change and nothing else, enforced here in main rather than trusted
	 * to the renderer's timing.
	 */
	settledPlan(): SettledPlan | null {
		return this.streaming ? null : this.plan
	}

	/** Drops the settled plan without running anything. The card demotes to history. */
	clearPlan(): void {
		this.plan = null
		this.push(true)
	}

	/**
	 * The generic Plan→Act continuation for non-sync plans: one write turn in
	 * the same session. The steering text is the user's composer draft at flip
	 * time — their last words on how to proceed — else a canned go-ahead that
	 * revokes the planning framing first, because a model still wearing the
	 * plan instruction will happily produce a second plan instead of edits.
	 */
	async actOnPlan(steering?: string): Promise<RunOutcome | null> {
		const plan = this.settledPlan()
		if (!plan) return null
		const instruction = steering?.trim() || ""
		return this.run({
			kind: plan.kind,
			title: this.activity?.title ?? "Chat",
			mode: "write",
			prompt: instruction
				? `${ACT_PROMPT}\n\nThe user added this instruction when approving — honour it:\n${instruction}`
				: ACT_PROMPT,
			displayPrompt: instruction || "Go ahead — make the changes.",
			resumeSessionId: plan.sessionId,
		})
	}

	/** Re-pushes state after something outside the conversation changed it. */
	touch(): void {
		this.push(true)
	}

	note(text: string): void {
		addNote(this.transcript, text)
		this.push(true)
	}

	/** Rebuilds the transcript from a past session, using the live reducer. */
	async replay(sessionId: string): Promise<boolean> {
		const backend = await this.deps.resolveBackend()
		if (!backend?.readTranscript) return false

		const events = await backend.readTranscript(this.deps.projectPath, sessionId).catch((err) => {
			Logger.warn(`[agent] could not replay ${sessionId}: ${err}`)
			return null
		})
		if (!events) return false

		this.transcript = emptyTranscript()
		for (const event of events) applyEvent(this.transcript, event)
		this.activity = { id: `replay-${sessionId}`, kind: "chat", title: "Earlier session", mode: "write", sessionId }
		this.streaming = false
		this.plan = null
		this.conversationMode = "write"
		this.push(true)
		return true
	}

	async close(): Promise<void> {
		if (this.pushTimer) clearTimeout(this.pushTimer)
		await this.session?.close().catch(() => {})
	}

	/** Refreshes which backend is configured, for the state the chrome renders. */
	async refreshBackend(): Promise<void> {
		try {
			const backend = await this.deps.resolveBackend()
			this.backendId = backend?.id ?? null
			this.backendName = backend?.displayName ?? null
			this.providerName = backend?.providerName ?? null
			this.blocked = backend ? null : new NoBackendError("chat").message
		} catch (err) {
			this.backendId = null
			this.backendName = null
			this.providerName = null
			this.blocked = err instanceof Error ? err.message : String(err)
		}
		this.push(true)
	}

	private async resolve(kind: ActivityKind): Promise<CodingBackend> {
		const backend = await this.deps.resolveBackend()
		if (!backend) {
			await this.refreshBackend()
			throw new NoBackendError(
				kind === "sync-plan" || kind === "sync-apply" ? "sync" : kind === "chat" ? "chat" : "visual-edit",
			)
		}
		this.backendId = backend.id
		this.backendName = backend.displayName
		this.providerName = backend.providerName
		this.blocked = null
		return backend
	}

	/**
	 * Caret's answer to one permission request.
	 *
	 * The ruling is computed here and either applied straight away or turned into
	 * a question. Either way the transcript records what happened and why — a
	 * silent auto-approval is indistinguishable from an agent that was never
	 * checked.
	 */
	private async decide(session: BackendSession, event: Extract<BackendEvent, { type: "permission" }>): Promise<void> {
		const ruling = rulePermission(
			{ action: event.tool, patterns: event.path ? [event.path] : [] },
			{
				projectPath: this.deps.projectPath,
				mode: session.mode,
				appWrites: this.deps.appWrites(),
				extraReadOnlyCommands: await this.userAllowlist(),
			},
		)

		if (ruling.kind === "auto") {
			resolvePermission(this.transcript, event.requestId, ruling.decision === "deny" ? "denied" : "allowed", ruling.reason)
			// The reason rides the deny to the model as feedback. Without it the
			// server sends only "the user rejected permission", which the model
			// reads as "stop" — one route was measured ending the turn on it.
			await session.respondToPermission(
				event.requestId,
				ruling.decision,
				ruling.decision === "deny" ? ruling.reason : undefined,
			)
			if (ruling.decision === "deny") this.noteRepeatedDenial(event.tool, event.path ?? "")
			this.push(true)
			return
		}

		// An unattended turn cannot ask: the surface that would show the prompt
		// is covered (or nobody is at it), and a question no one can see holds
		// the take open forever — observed as a variant deadlocked on
		// `git status`. Denied with the reason on record; the agent works with
		// the tools that need no permission.
		if (this.unattendedTurn) {
			const reason =
				"this take runs unattended — anything that would ask for permission is denied; use your read and edit tools instead"
			resolvePermission(this.transcript, event.requestId, "denied", reason)
			await session.respondToPermission(event.requestId, "deny", reason)
			this.push(true)
			return
		}

		// Left pending: the renderer is showing it and the user answers.
		const entry = this.transcript.entries.find((e) => e.kind === "permission" && e.requestId === event.requestId)
		if (entry && entry.kind === "permission") entry.summary = ruling.summary
		this.push(true)
	}

	/**
	 * Pushes state to the renderer, coalesced.
	 *
	 * Immediate on anything the user is waiting on (a permission, the end of a
	 * turn); throttled for token streaming, which would otherwise be one IPC
	 * message per character.
	 */
	private push(immediate = false): void {
		if (immediate) {
			if (this.pushTimer) {
				clearTimeout(this.pushTimer)
				this.pushTimer = null
			}
			this.deps.onChange(this.getState())
			return
		}

		if (this.pushTimer) return
		this.pushTimer = setTimeout(() => {
			this.pushTimer = null
			this.deps.onChange(this.getState())
		}, PUSH_INTERVAL_MS)
	}
}
