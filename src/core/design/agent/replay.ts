/**
 * Recorded model answers, for tests that run the real app without a model.
 *
 * A live interview costs tokens, takes minutes and answers differently every
 * time, so a test that needs one either skips (and the run still "passes") or
 * cannot be repeated. `RecordingBackend` saves every request Caret sends and
 * every answer it gets back during a live run; `ReplayBackend` gives those same
 * answers back to the real app later, free and identical on every run.
 *
 * Failures are part of the recording too (a provider refusal, a dropped
 * connection, a garbled reply), so a test can drive the error paths a live
 * model only produces by accident.
 *
 * Replay is strict by default: when a recorded call carries a fingerprint of
 * the instructions it was recorded with, a request with different instructions
 * fails loudly instead of being answered with a reply recorded for something
 * else. An answer recorded against other instructions is not evidence.
 */
import { createHash } from "crypto"
import * as fs from "fs"

import {
	type AvailabilityReport,
	BackendError,
	type BackendSession,
	type CodingBackend,
	ProviderRefusalError,
	type StartSessionOptions,
	type StructuredRequest,
	type StructuredResult,
} from "./backend"

/** One request and the answer it got (or the failure it should produce on replay). */
export interface RecordedCall {
	/** What kind of call this is ("interview:area"); absent in recordings of untagged calls. */
	tag?: string
	/** The interview topic the call was about, when it was about one. */
	area?: string | null
	systemPrompt?: string
	prompt?: string
	/** Fingerprint of the system prompt plus the answer format: changes whenever the instructions change. */
	templateHash?: string
	reply?: unknown
	emulated?: boolean
	/** Replay this call as a failure instead of an answer. */
	fault?: "provider-refusal" | "transport" | "malformed"
	message?: string
}

export interface Recording {
	format: number
	recorded?: { model?: string; at?: string; gitSha?: string }
	script?: string
	mode?: string
	description?: string
	calls: RecordedCall[]
}

/** One line of the replay log: which recorded call answered which request. */
export interface ReplayLogEntry {
	index: number
	tag?: string
	area?: string | null
	at: string
}

export class ReplayExhaustedError extends BackendError {
	constructor(detail: string) {
		super(`Replay has no recorded answer left for this request (${detail}).`, false)
		this.name = "ReplayExhaustedError"
	}
}

export class ReplayStaleError extends BackendError {
	constructor(detail: string) {
		super(
			`The recorded answers were made with different instructions (${detail}). ` +
				"Re-record them with npm run test:interview:live -- --save.",
			false,
		)
		this.name = "ReplayStaleError"
	}
}

/** Fingerprint of what the model was told and the answer format it was given. */
export function templateHash(systemPrompt: string | undefined, schema: Record<string, unknown>): string {
	return createHash("sha256")
		.update(`${systemPrompt ?? ""}\n${JSON.stringify(schema)}`)
		.digest("hex")
		.slice(0, 16)
}

/** Replaces the project folder in a request with a fixed marker, so recordings are portable. */
export function normalizeProjectPath(text: string, projectPath: string): string {
	return projectPath ? text.split(projectPath).join("<project>") : text
}

export interface ReplayOptions {
	/** Fail on a fingerprint mismatch (default true). */
	strict?: boolean
	/**
	 * A JSON-lines file listing every answer handed out. Also the cursor: on
	 * start-up the backend skips recorded calls already listed there, so a test
	 * that quits and reopens the app carries on where it stopped.
	 */
	logFile?: string
}

export class ReplayBackend implements CodingBackend {
	readonly id = "opencode" as const
	readonly displayName = "Replay"
	readonly providerName = "Replay"
	private readonly used = new Set<number>()

	constructor(
		private readonly recording: Recording,
		private readonly options: ReplayOptions = {},
	) {
		for (const entry of readLog(options.logFile)) this.used.add(entry.index)
	}

	static fromFile(file: string, options: ReplayOptions = {}): ReplayBackend {
		return new ReplayBackend(JSON.parse(fs.readFileSync(file, "utf8")) as Recording, options)
	}

	/** How many recorded answers have been handed out, including before a restart. */
	get served(): number {
		return this.used.size
	}

	async availability(): Promise<AvailabilityReport> {
		return {
			id: this.id,
			displayName: this.displayName,
			installed: true,
			authenticated: true,
			ready: true,
			detail: "Replaying recorded answers.",
			providerName: this.providerName,
		}
	}

	async startSession(_options: StartSessionOptions): Promise<BackendSession> {
		throw new BackendError("Replay only answers one-off questions; it cannot run a chat session.", false)
	}

	async structured<T>(request: StructuredRequest): Promise<StructuredResult<T>> {
		const trace = request.trace
		const index = this.recording.calls.findIndex(
			(call, i) =>
				!this.used.has(i) &&
				(!trace || ((call.tag ?? null) === trace.tag && (call.area ?? null) === (trace.area ?? null))),
		)
		if (index === -1) {
			throw new ReplayExhaustedError(
				trace ? `${trace.tag}${trace.area ? ` / ${trace.area}` : ""}, ${this.used.size} used` : `${this.used.size} used`,
			)
		}
		const call = this.recording.calls[index]
		if ((this.options.strict ?? true) && call.templateHash) {
			const now = templateHash(request.systemPrompt, request.schema)
			if (now !== call.templateHash) {
				throw new ReplayStaleError(
					`${call.tag ?? "call"} ${call.area ?? ""}: recorded ${call.templateHash}, now ${now}`.trim(),
				)
			}
		}
		this.used.add(index)
		appendLog(this.options.logFile, { index, tag: call.tag, area: call.area ?? null, at: new Date().toISOString() })

		switch (call.fault) {
			case "provider-refusal":
				throw new ProviderRefusalError(call.message ?? "usage limit reached")
			case "transport":
				throw new BackendError(call.message ?? "The connection to the model dropped.", true)
			case "malformed":
				return { value: (call.reply ?? { garbled: true }) as T, emulated: true }
		}
		return { value: call.reply as T, emulated: call.emulated ?? false }
	}
}

/**
 * Wraps a live backend and saves every one-off answer to a recording file as
 * it happens, so a crash mid-run still leaves everything recorded so far.
 */
export class RecordingBackend implements CodingBackend {
	readonly calls: RecordedCall[] = []

	constructor(
		private readonly inner: CodingBackend,
		private readonly file: string,
		private readonly meta: Omit<Recording, "format" | "calls"> = {},
	) {}

	get id() {
		return this.inner.id
	}
	get displayName() {
		return this.inner.displayName
	}
	get providerName() {
		return this.inner.providerName
	}
	availability() {
		return this.inner.availability()
	}
	startSession(options: StartSessionOptions) {
		return this.inner.startSession(options)
	}

	async structured<T>(request: StructuredRequest): Promise<StructuredResult<T>> {
		const base: RecordedCall = {
			tag: request.trace?.tag,
			area: request.trace?.area ?? null,
			systemPrompt: request.systemPrompt,
			prompt: normalizeProjectPath(request.prompt, request.workingDirectory),
			templateHash: templateHash(request.systemPrompt, request.schema),
		}
		try {
			const result = await this.inner.structured<T>(request)
			this.save({ ...base, reply: result.value, emulated: result.emulated })
			return result
		} catch (err) {
			const fault: RecordedCall["fault"] = err instanceof ProviderRefusalError ? "provider-refusal" : "transport"
			const message = err instanceof ProviderRefusalError ? err.providerMessage : String(err)
			this.save({ ...base, fault, message })
			throw err
		}
	}

	private save(call: RecordedCall): void {
		this.calls.push(call)
		const recording: Recording = { format: 2, ...this.meta, calls: this.calls }
		fs.writeFileSync(this.file, `${JSON.stringify(recording, null, 2)}\n`)
	}
}

function readLog(file: string | undefined): ReplayLogEntry[] {
	if (!file || !fs.existsSync(file)) return []
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as ReplayLogEntry)
}

function appendLog(file: string | undefined, entry: ReplayLogEntry): void {
	if (file) fs.appendFileSync(file, `${JSON.stringify(entry)}\n`)
}

/** Every answer a replay handed out, in order. Tests count AI calls with this. */
export function readReplayLog(file: string): ReplayLogEntry[] {
	return readLog(file)
}
