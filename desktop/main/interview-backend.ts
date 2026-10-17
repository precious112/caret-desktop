/**
 * The test switch for the interview's model.
 *
 * `CARET_INTERVIEW_REPLAY=<recording.json>` makes the interview take its model
 * answers from a recording (scripts/verify-interview.ts uses this to run the
 * real app with no model). `CARET_INTERVIEW_REPLAY_LOG=<file>` is where replay
 * lists every answer it hands out. `CARET_INTERVIEW_RECORD=<file>` keeps the
 * real model and saves every request and answer.
 *
 * Never active in an installed build: the switch is read only when the app is
 * not packaged, so a stray environment variable on a user's machine does
 * nothing. Only the interview reads it; chat and everything else are untouched.
 */
import type { CodingBackend } from "../../src/core/design/agent/backend"
import { RecordingBackend, ReplayBackend } from "../../src/core/design/agent/replay"
import { Logger } from "../../src/shared/services/Logger"

export type InterviewBackendOverride =
	| { kind: "replay"; file: string; logFile?: string }
	| { kind: "record"; file: string }
	| null

export function interviewBackendOverride(env: NodeJS.ProcessEnv, isPackaged: boolean): InterviewBackendOverride {
	if (isPackaged) return null
	const replay = env.CARET_INTERVIEW_REPLAY?.trim()
	const record = env.CARET_INTERVIEW_RECORD?.trim()
	if (replay && record) {
		throw new Error("CARET_INTERVIEW_REPLAY and CARET_INTERVIEW_RECORD are both set; use one.")
	}
	if (replay) return { kind: "replay", file: replay, logFile: env.CARET_INTERVIEW_REPLAY_LOG?.trim() || undefined }
	if (record) return { kind: "record", file: record }
	return null
}

let replay: ReplayBackend | null = null
let announced = false

/** The replay backend for this run, created once so its place in the recording carries across turns. */
export function replayBackend(override: { file: string; logFile?: string }): ReplayBackend {
	if (!announced) {
		// The test harness looks for this line: no banner means replay was not in use.
		Logger.warn(`[interview] REPLAY backend from ${override.file}`)
		announced = true
	}
	replay ??= ReplayBackend.fromFile(override.file, { logFile: override.logFile })
	return replay
}

const recorders = new WeakMap<CodingBackend, RecordingBackend>()

/** The live backend, wrapped so every interview call is saved to the recording file. */
export function recordingBackend(inner: CodingBackend, file: string): RecordingBackend {
	let recorder = recorders.get(inner)
	if (!recorder) {
		Logger.warn(`[interview] RECORDING model answers to ${file}`)
		recorder = new RecordingBackend(inner, file)
		recorders.set(inner, recorder)
	}
	return recorder
}
