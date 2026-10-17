/**
 * The AI interview, tested in the real Caret app the way a person uses it.
 *
 * Each case opens the built app on a fresh project with a fresh profile,
 * starts the interview from the Foundation tab, and clicks through it by
 * following one of the shared scripts (src/core/design/interview/testing/
 * scripts.ts): picks, typed values, Skip, None, Back, "Just finish it". The
 * model's answers come from recordings of real runs, played back word for
 * word, so a case is free and gives the same result every time.
 *
 * After every screen it checks, against the app's own saved progress
 * (`.caret/.interview.json`) read through the same code the app uses:
 *   - the question is about the topic that comes next, and none comes twice;
 *   - every Covering row and every So far line shows what was settled;
 *   - the options are within the topic's limits, with no overused default.
 * At the end it checks the saved foundation (`foundation.json`) field by
 * field against the answers, that every recorded answer was used, and that
 * the app's log has no unexpected errors.
 *
 * Nothing is ever skipped: a missing build, a missing recording or an
 * unexpected screen is a failure, and the run fails unless every case ran.
 *
 *   npm run test:interview                                    every case, with the logic tests
 *   npx tsx scripts/verify-interview.ts --only 1,5            some cases (not a certification)
 *   CARET_VERIFY_MODEL=opencode-go/deepseek-v4.1-flash \
 *     npm run test:interview:live -- --save                    a live model; saves new recordings
 *
 * The live run checks what recordings can't: that a real model, with today's
 * instructions, still gives answers the interview can use. Run it whenever the
 * instructions to the model change (the recorded tests then refuse the old
 * recordings, naming the line that changed).
 */
import * as child_process from "child_process"
import * as fs from "fs/promises"
import * as path from "path"

import type { Page } from "playwright"

import type { RecordedCall, Recording } from "../src/core/design/agent/replay"
import { closeMatch, parseHex } from "../src/core/design/defaults/colour"
import { AREAS, type AreaId } from "../src/core/design/interview/areas"
import { flaggedOptions, userChoicesFrom } from "../src/core/design/interview/defaults"
import { describeApp } from "../src/core/design/interview/describe-app"
import { finalizeProposal } from "../src/core/design/interview/finalize"
import { type SessionScratch, viewOf } from "../src/core/design/interview/session"
import { deriveState } from "../src/core/design/interview/state"
import { BRAND, type InterviewScript, SCRIPTS, type ScriptStep } from "../src/core/design/interview/testing/scripts"
import {
	assert,
	buildProject,
	callMcpTool,
	freshProfile,
	type LaunchedApp,
	launchApp,
	openDescribe,
	readDiscovery,
	reapOrphanedBackends,
	shot,
	waitFor,
} from "./verify-kit"

const SHOTS = path.resolve("release/interview-shots")
const FIXTURES = path.resolve("test-fixtures/interview")

const args = process.argv.slice(2)
const ONLY = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1].split(",")) : null
/** With a live model instead of recordings: the cases that need no planted failure. */
const LIVE = args.includes("--live")
/** After a live run that passed, save its recordings as the new test recordings. */
const SAVE = args.includes("--save")
const LIVE_CASES = new Set(["1", "2", "6", "7"])
const LIVE_MODEL = process.env.CARET_VERIFY_MODEL?.trim() ?? ""

// ── one case's world ────────────────────────────────────────────────────────

interface Run {
	id: string
	/** A live model is answering (and being recorded) instead of a recording. */
	live: boolean
	project: string
	userData: string
	dir: string
	logFile: string
	replayLog: string
	/** The recording being played back; null with a live model or with no model at all. */
	recording: Recording | null
	env: Record<string, string>
	launched: LaunchedApp
	/** Everything the case noticed that a user would call a bug. */
	problems: string[]
	turns: string[]
	/** ERROR lines this case expects in the app log (a refusal it injected). */
	expectedErrors: RegExp[]
}

let template: string | undefined
/** Each case's project folder, for saving live recordings with what they were made from. */
const projects = new Map<string, string>()

async function readRecording(name: string): Promise<Recording> {
	const raw = await fs.readFile(path.join(FIXTURES, `${name}.json`), "utf8").catch(() => "")
	assert(raw, `No recording test-fixtures/interview/${name}.json. Record it with scripts/record-interview.ts.`)
	return JSON.parse(raw) as Recording
}

/**
 * A fresh project and profile, and the app launched on them. The model is a
 * recording (the default), a live model being recorded (`--live`), or none
 * at all (`recording: null` outside live mode).
 */
async function startRun(id: string, recording: Recording | null, options: { sampleApp?: boolean } = {}): Promise<Run> {
	const dir = path.join(SHOTS, `case-${id}`)
	await fs.rm(dir, { recursive: true, force: true })
	await fs.mkdir(dir, { recursive: true })
	const project = await buildProject(template, options)
	const recordingFile = path.join(dir, "recording.json")
	const replayLog = path.join(dir, "replay.log")
	let env: Record<string, string> = {}
	let userData: string
	if (LIVE) {
		userData = await freshProfile({ backendId: "opencode", backendModel: LIVE_MODEL })
		env = { CARET_INTERVIEW_RECORD: recordingFile }
	} else {
		userData = await freshProfile()
		if (recording) {
			await fs.writeFile(recordingFile, JSON.stringify(recording, null, 2))
			env = { CARET_INTERVIEW_REPLAY: recordingFile, CARET_INTERVIEW_REPLAY_LOG: replayLog }
		}
	}
	const logFile = path.join(dir, "main.log")
	const launched = await launchApp({ project, userData, logFile, env })
	template ??= project
	projects.set(id, project)
	return {
		id,
		live: LIVE,
		project,
		userData,
		dir,
		logFile,
		replayLog,
		recording: LIVE ? null : recording,
		env,
		launched,
		problems: [],
		turns: [],
		expectedErrors: [],
	}
}

async function relaunch(run: Run): Promise<void> {
	await run.launched.close()
	run.launched = await launchApp({ project: run.project, userData: run.userData, logFile: run.logFile, env: run.env })
}

async function served(run: Run): Promise<number> {
	return (await fs.readFile(run.replayLog, "utf8").catch(() => "")).split("\n").filter((l) => l.trim()).length
}

async function readProgress(project: string): Promise<SessionScratch | null> {
	try {
		return JSON.parse(await fs.readFile(path.join(project, ".caret", ".interview.json"), "utf8"))
	} catch {
		return null
	}
}

// ── what is on screen ───────────────────────────────────────────────────────

type Screen =
	| { kind: "opening"; progress: SessionScratch }
	| { kind: "question"; progress: SessionScratch; area: AreaId }
	| { kind: "finish"; progress: SessionScratch }
	| { kind: "error"; text: string }

/**
 * Waits for the next settled screen. The error screen stays up while "Try
 * again" runs, so it counts only when still there on the next check.
 */
async function nextScreen(run: Run, label: string, timeoutMs = 4 * 60_000): Promise<Screen> {
	const chrome = run.launched.chrome
	let errorSeen = false
	let seen = "nothing yet"
	return waitFor(
		label,
		async () => {
			if (await chrome.getByTestId("wizard-error").count()) {
				if (!errorSeen) {
					errorSeen = true
					return null
				}
				const text = await chrome
					.getByTestId("wizard-error")
					.first()
					.textContent({ timeout: 1000 })
					.catch(() => null)
				return text === null ? null : ({ kind: "error", text: text.trim() } as Screen)
			}
			errorSeen = false
			if (await chrome.getByTestId("wizard-thinking").count()) return null
			const progress = await readProgress(run.project)
			seen = progress
				? `saved progress says "${progress.pending}", ${progress.record.answers.length} answers`
				: "no saved progress"
			if (!progress) return null
			if (progress.pending === "opening" && (await chrome.getByTestId("wizard-opening").count())) {
				return { kind: "opening", progress } as Screen
			}
			if (progress.pending === "finish" && (await chrome.getByTestId("wizard-finish").count())) {
				return { kind: "finish", progress } as Screen
			}
			const area = progress.pending
			if (area && area !== "opening" && area !== "finish") {
				const shown = await chrome.locator(`[data-testid="wizard-question"][data-area="${area}"]`).count()
				if (shown) return { kind: "question", progress, area } as Screen
			}
			return null
		},
		timeoutMs,
		async () =>
			`${seen}; on screen: ${await onScreen(chrome)}; app log ends: ${(await fs.readFile(run.logFile, "utf8").catch(() => "")).split("\n").slice(-4).join(" | ")}`,
	)
}

/** Which interview screen is showing, for a failure message. */
async function onScreen(chrome: Page): Promise<string> {
	for (const id of [
		"wizard-error",
		"wizard-opening",
		"wizard-finish",
		"wizard-thinking",
		"foundation-entry",
		"design-system-view",
	]) {
		if (await chrome.getByTestId(id).count()) return id
	}
	const area = await chrome
		.locator('[data-testid="wizard-question"]')
		.getAttribute("data-area", { timeout: 500 })
		.catch(() => null)
	return area ? `the question about ${area}` : "nothing recognised"
}

/**
 * What a person would check on every screen, against the app's own saved
 * progress read through the code the app itself uses.
 */
async function checkScreen(run: Run, screen: Screen): Promise<void> {
	if (screen.kind === "error") return
	const chrome = run.launched.chrome
	const record = screen.progress.record
	const state = deriveState(record)

	const answered = record.answers.map((a) => a.area)
	const twice = answered.filter((a, i) => answered.indexOf(a) !== i)
	if (twice.length) run.problems.push(`topics answered twice: ${[...new Set(twice)].join(", ")}`)

	if (screen.kind === "opening" && record.mode === "from-app") {
		const lines = await chrome.getByTestId("wizard-statement").allTextContents()
		const unsourced = lines.filter((line) => !/From \S/.test(line))
		if (!lines.length) run.problems.push("reading an app, the opening screen shows nothing found")
		if (unsourced.length) run.problems.push(`${unsourced.length} opening line(s) don't say which file they came from`)
	}

	if (screen.kind === "question") {
		if (screen.area !== state.next)
			run.problems.push(`the question is about ${screen.area}, but the next topic is ${state.next}`)
		if (answered.includes(screen.area)) run.problems.push(`${screen.area} is asked again after it was answered`)
		const question = screen.progress.questions[screen.area]
		assert(question, `no saved question for ${screen.area}`)
		const real = question.options.filter((o) => !("none" in (o.value as object)))
		const [min, max] = AREAS[screen.area].optionCount
		if (real.length < min || real.length > max) {
			run.problems.push(`${screen.area} shows ${real.length} options; it allows ${min} to ${max}`)
		}
		const flagged = flaggedOptions(screen.area, question.options, userChoicesFrom(record))
		if (flagged.length) run.problems.push(`${screen.area} shows overused defaults: ${flagged.join(", ")}`)
		const onScreen = await chrome.locator('[data-testid="wizard-question"] [data-testid="wizard-option"]').count()
		if (onScreen !== question.options.length) {
			run.problems.push(`${screen.area}: ${onScreen} options on screen, ${question.options.length} in the saved question`)
		}
		// "Just finish it" is offered once anything is settled: an answer, or a line agreed on the opening screen.
		const settledSomething = record.answers.length > 0 || (record.opening?.statements.length ?? 0) > 0
		const offered = (await chrome.getByTestId("wizard-finish-now").count()) > 0
		if (offered !== settledSomething) {
			run.problems.push(
				`"Just finish it" is ${offered ? "offered" : "missing"} on ${screen.area}, with ${settledSomething ? "something" : "nothing"} settled`,
			)
		}
		const position = (await chrome.getByTestId("wizard-position").textContent())?.trim() ?? ""
		const expected = `Question ${state.position.index} of ${state.position.total}`
		if (!position.startsWith(expected)) run.problems.push(`the counter says "${position}", expected "${expected}"`)
	}

	for (const row of state.coverage) {
		const done = await chrome.locator(`[data-testid="wizard-coverage"] [data-area="${row.area}"]`).getAttribute("data-done")
		if (done !== String(row.done)) {
			run.problems.push(
				`Covering shows ${row.area} as ${done === "true" ? "done" : "open"}; it is ${row.done ? "done" : "open"}`,
			)
		}
	}
	const rows = await chrome
		.locator('[data-testid="wizard-so-far"] [data-area]')
		.evaluateAll((els) => els.map((el) => [el.getAttribute("data-area"), (el.textContent ?? "").replace(/\s+/g, "")]))
	const wanted = state.soFar.map((row) => [row.area, `${row.term}${row.text}`.replace(/\s+/g, "")])
	if (JSON.stringify(rows) !== JSON.stringify(wanted)) {
		run.problems.push(`So far shows ${JSON.stringify(rows)}; the answers say ${JSON.stringify(wanted)}`)
	}
	// Every word of every line must be visible, not cut off with "…".
	const cut = await chrome
		.locator('[data-testid="wizard-so-far"] [data-area] *')
		.evaluateAll((els) =>
			els
				.filter((el) => el.scrollWidth > el.clientWidth + 1)
				.map((el) => `${el.closest("[data-area]")?.getAttribute("data-area")}: "${el.textContent}"`),
		)
	for (const line of new Set(cut)) run.problems.push(`So far cuts off ${line}`)
}

// ── acting like a person ────────────────────────────────────────────────────

const continueButton = (chrome: Page) => chrome.getByTestId("wizard-continue")

async function pressContinue(chrome: Page, what: string): Promise<void> {
	await waitFor(`Continue to be possible (${what})`, async () => continueButton(chrome).isEnabled(), 10_000)
	await continueButton(chrome).click()
}

async function answerOpening(run: Run, script: InterviewScript): Promise<void> {
	const chrome = run.launched.chrome
	const corrected: string[] = []
	for (const [area, note] of Object.entries(script.correct ?? {})) {
		const line = chrome.locator(`[data-testid="wizard-statement"][data-area="${area}"]`)
		if (!(await line.count())) continue
		await line.getByTestId("wizard-not-quite").click()
		await line.getByTestId("wizard-correction").fill(note as string)
		corrected.push(area)
	}
	run.turns.push(`opening: ${corrected.length ? `corrected ${corrected.join(", ")}` : "all agreed"}`)
	await pressContinue(chrome, "opening")
}

/** Something a person does on a question before answering it, that must not change the answer. */
type Gesture = (chrome: Page, question: NonNullable<SessionScratch["questions"][AreaId]>) => Promise<void>

/** Answers the question on screen the way the script says, by clicking and typing. */
async function answerQuestion(
	run: Run,
	screen: Extract<Screen, { kind: "question" }>,
	step: ScriptStep | undefined,
	gesture?: Gesture,
): Promise<void> {
	const chrome = run.launched.chrome
	const question = screen.progress.questions[screen.area]
	assert(question, `no saved question for ${screen.area}`)
	const option = (id: string) =>
		chrome.locator(`[data-testid="wizard-question"] [data-testid="wizard-option"][data-option-id="${id}"]`)
	if (gesture) await gesture(chrome, question)
	let said: string
	if (!step) {
		said = "kept the recommendation"
		await pressContinue(chrome, screen.area)
	} else if ("skip" in step) {
		said = "Skip"
		await chrome.getByTestId("wizard-skip").click()
	} else if ("none" in step) {
		said = "None"
		await option(`${screen.area}-none`).click()
		await pressContinue(chrome, screen.area)
	} else if ("option" in step) {
		const real = question.options.filter((o) => !("none" in (o.value as object)))
		const chosen = real[Math.min(step.option, real.length - 1)]
		said = `picked "${chosen.label}"`
		await option(chosen.id).click()
		await pressContinue(chrome, screen.area)
	} else {
		const raw = step.own
		if (raw.kind === "hex") {
			await chrome.getByTestId("wizard-hex").fill(raw.hex)
			said = `typed ${raw.hex}`
		} else if (raw.kind === "font") {
			await chrome.getByTestId("wizard-font-search").fill(raw.family.slice(0, 10))
			await chrome.locator('[data-testid="wizard-font-result"]', { hasText: raw.family }).first().click({ timeout: 15_000 })
			said = `searched and picked ${raw.family}`
		} else if (raw.kind === "size") {
			await chrome.getByTestId("wizard-own-px").fill(raw.px)
			await chrome.getByTestId("wizard-own-ratio").fill(raw.ratio)
			said = `typed ${raw.px}px ×${raw.ratio}`
		} else {
			for (const key of ["success", "warning", "error", "info"] as const) {
				await chrome.getByTestId(`wizard-own-${key}`).fill(raw[key])
			}
			said = "typed four status colours"
		}
		await pressContinue(chrome, screen.area)
	}
	run.turns.push(`${screen.area}: ${said}`)
}

/** Types 22px (Caret can't store it), checks it is refused with a reason, then clears it. */
const typeTooBigThenClear: Gesture = async (chrome) => {
	await chrome.getByTestId("wizard-own-px").fill("22")
	const reason = chrome.getByTestId("wizard-own-value-reason")
	await reason.waitFor({ timeout: 5000 })
	const said = (await reason.textContent()) ?? ""
	assert(/12 to 20px/.test(said), `22px was refused without the reason: "${said}"`)
	assert(!(await continueButton(chrome).isEnabled()), "Continue stayed possible with 22px typed")
	await chrome.getByTestId("wizard-own-px").fill("")
}

/** Types a colour of its own, then clicks the first card: the card must be the answer. */
const typeThenPickCard: Gesture = async (chrome, question) => {
	await chrome.getByTestId("wizard-hex").fill("#123456")
	const first = question.options.find((o) => !("none" in (o.value as object)))
	assert(first, "no option to click")
	const card = chrome.locator(`[data-testid="wizard-question"] [data-testid="wizard-option"][data-option-id="${first.id}"]`)
	await card.click()
	assert((await card.getAttribute("data-selected")) === "true", "clicking a card after typing a colour did not select the card")
	assert((await chrome.getByTestId("wizard-hex").inputValue()) === "", "clicking a card left the typed colour in place")
}

/**
 * Runs a script through the real screen, checking every screen. Stops at the
 * finish, the error screen, or after `stopAfter` answers.
 */
async function runScript(
	run: Run,
	script: InterviewScript,
	options: { gestures?: Partial<Record<AreaId, Gesture>>; stopAfter?: number } = {},
): Promise<Screen> {
	let backDone = false
	let backPending = false
	let finished = false
	for (let turn = 0; turn < 40; turn++) {
		const screen = await nextScreen(run, `the screen after ${run.turns.length} steps`)
		await checkScreen(run, screen)
		if (screen.kind === "finish" || screen.kind === "error") return screen
		await shot(run.launched.chrome, run.dir, `step-${String(turn + 1).padStart(2, "0")}`)
		if (screen.kind === "opening") {
			await answerOpening(run, script)
			continue
		}
		if (options.stopAfter !== undefined && screen.progress.record.answers.length >= options.stopAfter) return screen
		if (script.finishAt === screen.area && !finished) {
			finished = true
			run.turns.push(`${screen.area}: pressed Just finish it`)
			await run.launched.chrome.getByTestId("wizard-finish-now").click()
			continue
		}
		const step = backPending ? script.backStep : script.steps?.[screen.area]
		const gesture = backPending ? undefined : options.gestures?.[screen.area]
		backPending = false
		await answerQuestion(run, screen, step, gesture)
		if (script.backAfter === screen.area && !backDone) {
			backDone = true
			backPending = true
			const back = await nextScreen(run, `the question after ${screen.area}`)
			await checkScreen(run, back)
			run.turns.push("pressed Back")
			await run.launched.chrome.getByTestId("wizard-back").click()
		}
	}
	throw new Error(`the script "${script.name}" did not reach the finish`)
}

async function startInterview(run: Run, script: InterviewScript): Promise<void> {
	const chrome = run.launched.chrome
	if (script.mode === "from-app") {
		await chrome.waitForSelector('[data-testid="foundation-route-from-app"]', { timeout: 30_000 })
		await chrome.click('[data-testid="foundation-route-from-app"]')
		return
	}
	await openDescribe(chrome, script.description)
	await chrome.click('[data-testid="foundation-mode-collaborative"]')
}

/** Saves a foundation the way an outside agent (for example the chat) does, and waits for it to land. */
async function agentSavesFoundation(run: Run): Promise<void> {
	const discovery = await waitFor("the MCP address", () => readDiscovery(run.project), 60_000)
	const said = await callMcpTool(discovery, "commit_foundation", {
		candidateId: "editorial-instrument+mono-accent+editorial-open",
		tags: ["editorial"],
	})
	assert(!said.includes('"isError":true'), `saving a foundation through the agent tools failed: ${said.slice(0, 300)}`)
	await waitFor("the foundation to be saved", async () => {
		const raw = await fs.readFile(path.join(run.project, ".caret", "tokens", "foundation.json"), "utf8").catch(() => "")
		return /"committed":\s*true/.test(raw)
	})
}

/** Which Foundation screen the tab settles on (a saved interview loads a moment after the tab opens). */
async function foundationSettlesOn(chrome: Page): Promise<string | null> {
	const which = async () => {
		for (const id of [
			"design-system-view",
			"wizard-question",
			"wizard-opening",
			"wizard-error",
			"wizard",
			"foundation-entry",
			"token-editor",
		]) {
			if (await chrome.getByTestId(id).count()) return id
		}
		return null
	}
	await waitFor("the Foundation tab", which, 30_000)
	await chrome.waitForTimeout(4000)
	return which()
}

/** Presses "Use these foundations" and checks the saved foundation against the finish, field by field. */
async function commitAndCheck(run: Run, end: Extract<Screen, { kind: "finish" }>): Promise<Record<string, any>> {
	const view = viewOf(end.progress)
	assert(view?.phase === "finish", "the saved progress has no finish")
	const expected = finalizeProposal(view.proposal, end.progress.record.description).tokens
	const file = path.join(run.project, ".caret", "tokens", "foundation.json")
	const before = await fs.readFile(file, "utf8").catch(() => "")
	await shot(run.launched.chrome, run.dir, "finish")
	await run.launched.chrome.getByTestId("wizard-commit").click()
	const tokens = await waitFor(
		"the foundation to be saved",
		async () => {
			const raw = await fs.readFile(file, "utf8").catch(() => "")
			return raw && raw !== before ? JSON.parse(raw) : null
		},
		30_000,
	)
	const fields: Array<[string, unknown, unknown]> = [
		["brand colour", tokens.color?.brand?.seed, expected.color.brand.seed],
		["supporting colour", tokens.color?.secondary?.seed, expected.color.secondary?.seed],
		["accent colour", tokens.color?.accent?.seed, expected.color.accent?.seed],
		["light or dark", tokens.color?.surface, expected.color.surface],
		["greys", tokens.color?.neutral?.character, expected.color.neutral.character],
		["status colours", JSON.stringify(tokens.color?.semantic), JSON.stringify(expected.color.semantic)],
		["heading font", tokens.typography?.displayFamily, expected.typography.displayFamily],
		["body font", tokens.typography?.fontFamily, expected.typography.fontFamily],
		["body size", tokens.typography?.baseSize, expected.typography.baseSize],
		["size step", tokens.typography?.scaleRatio, expected.typography.scaleRatio],
		["spacing", tokens.spacing?.baseUnit, expected.spacing.baseUnit],
		["corners", tokens.radius?.character, expected.radius.character],
		["depth", tokens.elevation?.character, expected.elevation?.character],
	]
	for (const [name, saved, answered] of fields) {
		if (saved !== answered) {
			run.problems.push(`the saved ${name} is ${JSON.stringify(saved)}; the answers say ${JSON.stringify(answered)}`)
		}
	}
	const source = end.progress.record.mode === "from-app" ? "wizard-from-app" : "wizard-collaborative"
	if (tokens.meta?.source !== source) run.problems.push(`saved with source ${tokens.meta?.source}, not ${source}`)
	if (tokens.meta?.decisions?.length !== 12) run.problems.push(`saved with ${tokens.meta?.decisions?.length} decisions, not 12`)
	await waitFor("the interview progress to be cleared", async () => !(await readProgress(run.project)), 10_000)
	return tokens
}

/** Every recorded answer used, none missing; no unexpected error in the app log. */
async function checkEnd(run: Run): Promise<void> {
	const log = await fs.readFile(run.logFile, "utf8")
	if (run.recording) {
		const used = await served(run)
		if (used !== run.recording.calls.length) {
			run.problems.push(`the app asked the model ${used} times; the recording has ${run.recording.calls.length} answers`)
		}
		if (!log.includes("[interview] REPLAY backend")) {
			run.problems.push("the app did not use the recording (no REPLAY line in its log)")
		}
	}
	if (run.live && !log.includes("[interview] RECORDING model answers")) {
		run.problems.push("the live run was not recorded (no RECORDING line in the app log)")
	}
	for (const line of log.split("\n").filter((l) => /\bERROR\b/.test(l))) {
		if (!run.expectedErrors.some((pattern) => pattern.test(line))) {
			run.problems.push(`unexpected error in the app log: ${line.slice(0, 200)}`)
		}
	}
}

function finish(run: Run): string {
	if (run.problems.length) {
		const counts = new Map<string, number>()
		for (const p of run.problems) counts.set(p, (counts.get(p) ?? 0) + 1)
		const lines = [...counts].map(([p, n]) => `\n      - ${p}${n > 1 ? ` (on ${n} screens)` : ""}`)
		throw new Error(`${lines.join("")}\n    steps:\n      ${run.turns.join("\n      ")}`)
	}
	return `${run.turns.length} steps`
}

// ── recordings with failures added ──────────────────────────────────────────

/**
 * The recording with extra replies placed before the first call about `area`.
 * When a reply makes Caret ask again, the retry carries the reason, so the
 * recorded call that follows is matched on its instructions only.
 */
function withInserted(base: Recording, area: string, extra: RecordedCall[], retried: boolean): Recording {
	const at = base.calls.findIndex((c) => c.tag === "interview:area" && c.area === area)
	assert(at !== -1, `the recording has no question about ${area}`)
	const calls = structuredClone(base.calls)
	if (retried) delete calls[at].prompt
	return {
		...base,
		calls: [...calls.slice(0, at), ...extra.map((c) => ({ tag: "interview:area", area, ...c })), ...calls.slice(at)],
	}
}

// ── the cases ───────────────────────────────────────────────────────────────

interface Case {
	id: string
	title: string
	run(): Promise<string>
}

async function withRun(
	id: string,
	recording: Recording | null,
	body: (run: Run) => Promise<void>,
	options: { sampleApp?: boolean } = {},
): Promise<string> {
	const run = await startRun(id, recording, options)
	try {
		await body(run)
		await checkEnd(run)
		return finish(run)
	} finally {
		await run.launched.close()
	}
}

const refusalAt = (base: Recording, area: string) =>
	withInserted(base, area, [{ fault: "provider-refusal", message: "usage limit reached" }], false)

const CASES: Case[] = [
	{
		id: "1",
		title: "a whole interview, accepting the recommendations and typing the brand colour; 22px is refused with a reason",
		run: async () =>
			withRun("1", await readRecording("straight"), async (run) => {
				const script = SCRIPTS.straight
				await startInterview(run, script)
				const end = await runScript(run, script, { gestures: { "type-scale": typeTooBigThenClear } })
				assert(
					end.kind === "finish",
					`the interview ended on the ${end.kind} screen${end.kind === "error" ? `: ${end.text}` : ""}`,
				)
				const tokens = await commitAndCheck(run, end)
				if (tokens.color?.brand?.seed !== BRAND) {
					run.problems.push(`the typed brand ${BRAND} was saved as ${tokens.color?.brand?.seed}`)
				}
			}),
	},
	{
		id: "2",
		title: "every way to answer: correct a line, Skip, search a font, own sizes, None, a typed colour replaced by a card, Back",
		run: async () =>
			withRun("2", await readRecording("escapes"), async (run) => {
				const script = SCRIPTS.escapes
				await startInterview(run, script)
				const end = await runScript(run, script, { gestures: { "accent-color": typeThenPickCard } })
				assert(
					end.kind === "finish",
					`the interview ended on the ${end.kind} screen${end.kind === "error" ? `: ${end.text}` : ""}`,
				)
				const record = end.progress.record
				const accent = record.answers.find((a) => a.area === "accent-color")
				if (accent?.via !== "skip") {
					run.problems.push(
						`after Back, the accent should be the skipped recommendation; it is ${JSON.stringify(accent)}`,
					)
				}
				if (deriveState(record).areas.radius.via === "opening") {
					run.problems.push("corners were corrected on the opening screen but never asked")
				}
				const tokens = await commitAndCheck(run, end)
				if (tokens.typography?.fontFamily !== "Libre Baskerville") {
					run.problems.push(`the searched body font was saved as ${tokens.typography?.fontFamily}`)
				}
				if (tokens.typography?.baseSize !== 18 || tokens.typography?.scaleRatio !== 1.2) {
					run.problems.push(
						`own sizes 18px ×1.2 were saved as ${tokens.typography?.baseSize}px ×${tokens.typography?.scaleRatio}`,
					)
				}
				if (tokens.color?.secondary) {
					run.problems.push(`"None" was chosen for the supporting colour, but ${tokens.color.secondary.seed} was saved`)
				}
			}),
	},
	{
		id: "3",
		title: "the model misbehaves: a garbled reply, and a reply of only overused fonts; you never see either",
		run: async () => {
			let recording = await readRecording("straight")
			recording = withInserted(
				recording,
				"display-type",
				[
					{
						reply: {
							question: "Headings?",
							options: [
								{ value: { family: "Inter" }, label: "Inter", reason: "r" },
								{ value: { family: "Space Grotesk" }, label: "Space Grotesk", reason: "r" },
								{ value: { family: "Geist" }, label: "Geist", reason: "r" },
							],
							recommended: 0,
						},
						emulated: true,
					},
				],
				true,
			)
			recording = withInserted(recording, "brand-color", [{ fault: "malformed" }], true)
			return withRun("3", recording, async (run) => {
				const script = SCRIPTS.straight
				await startInterview(run, script)
				const end = await runScript(run, script)
				assert(end.kind === "finish", `the user saw the ${end.kind} screen${end.kind === "error" ? `: ${end.text}` : ""}`)
				const log = await fs.readFile(run.logFile, "utf8")
				if (!/display-type attempt 1\/3 rejected[^\n]*overused AI default/.test(log)) {
					run.problems.push("the overused fonts were not caught and sent back")
				}
				if (!/brand-color attempt 1\/3 rejected/.test(log))
					run.problems.push("the garbled reply was not caught and sent back")
				await commitAndCheck(run, end)
			})
		},
	},
	{
		id: "4",
		title: "the provider refuses: the error screen, then Try again carries on to the end",
		run: async () =>
			withRun("4", refusalAt(await readRecording("straight"), "secondary-color"), async (run) => {
				run.expectedErrors.push(/turn failed at secondary-color/)
				const script = SCRIPTS.straight
				await startInterview(run, script)
				const stopped = await runScript(run, script)
				assert(stopped.kind === "error", `expected the error screen after the refusal, got the ${stopped.kind} screen`)
				if (!/usage limit reached/.test(stopped.text))
					run.problems.push(`the error screen doesn't say why: "${stopped.text}"`)
				await shot(run.launched.chrome, run.dir, "error")
				await run.launched.chrome.getByRole("button", { name: "Try again" }).click()
				const end = await runScript(run, script)
				assert(end.kind === "finish", `after Try again the interview ended on the ${end.kind} screen`)
				await commitAndCheck(run, end)
			}),
	},
	{
		id: "5",
		title: "quit and reopen Caret: on the error screen, and in the middle of a question",
		run: async () =>
			withRun("5", refusalAt(await readRecording("straight"), "secondary-color"), async (run) => {
				run.expectedErrors.push(/turn failed at secondary-color/)
				const script = SCRIPTS.straight
				await startInterview(run, script)
				const stopped = await runScript(run, script)
				assert(stopped.kind === "error", `expected the error screen, got the ${stopped.kind} screen`)
				const answers = (await readProgress(run.project))?.record.answers.length ?? 0
				await relaunch(run)
				const reopened = await nextScreen(run, "the screen after reopening on the error", 60_000)
				await shot(run.launched.chrome, run.dir, "reopened-on-error")
				if (reopened.kind !== "error")
					run.problems.push(`after reopening, Caret showed the ${reopened.kind} screen, not the error`)
				const kept = (await readProgress(run.project))?.record.answers.length ?? 0
				if (kept !== answers) run.problems.push(`after reopening, ${kept} answers are saved, not ${answers}`)
				if (reopened.kind !== "error") return
				await run.launched.chrome.getByRole("button", { name: "Try again" }).click()
				const question = await nextScreen(run, "the question after Try again")
				assert(question.kind === "question", `Try again led to the ${question.kind} screen`)
				const calls = await served(run)
				await relaunch(run)
				const again = await nextScreen(run, "the screen after reopening mid-question")
				if (again.kind !== "question" || again.area !== question.area) {
					run.problems.push(
						`reopening mid-question showed ${again.kind === "question" ? again.area : again.kind}, not ${question.area}`,
					)
				}
				if ((await served(run)) !== calls)
					run.problems.push("reopening asked the model again instead of showing the saved question")
				const end = await runScript(run, script)
				assert(end.kind === "finish", `the interview ended on the ${end.kind} screen`)
				await commitAndCheck(run, end)
			}),
	},
	{
		id: "6",
		title: '"Just finish it" partway: one model call fills in the rest',
		run: async () =>
			withRun("6", await readRecording("finish-early"), async (run) => {
				const script = SCRIPTS["finish-early"]
				await startInterview(run, script)
				const end = await runScript(run, script)
				assert(end.kind === "finish", `the interview ended on the ${end.kind} screen`)
				const filled = end.progress.record.answers.filter((a) => a.via === "finish-now").map((a) => a.area)
				if (!filled.length) run.problems.push("nothing was filled in by Just finish it")
				if (filled.includes("display-type"))
					run.problems.push("Just finish it replaced an answer the user had already given")
				await commitAndCheck(run, end)
			}),
	},
	{
		id: "7",
		title: '"Use what my app already has" on a sample Next.js and Tailwind app: values read from its code, one corrected',
		run: async () =>
			withRun(
				"7",
				await readRecording("from-app"),
				async (run) => {
					const script = SCRIPTS["from-app"]
					await startInterview(run, script)
					const end = await runScript(run, script)
					assert(
						end.kind === "finish",
						`the interview ended on the ${end.kind} screen${end.kind === "error" ? `: ${end.text}` : ""}`,
					)
					const state = deriveState(end.progress.record)
					const fromCode = Object.values(state.areas).filter((a) => a.via === "opening")
					if (!fromCode.length) run.problems.push("nothing was taken from the app's code")
					if (fromCode.some((a) => !a.source))
						run.problems.push("a value taken from the app's code doesn't say which file")
					if (state.areas["brand-color"].via === "opening")
						run.problems.push("the corrected brand colour was not asked again")
					const tokens = await commitAndCheck(run, end)
					if (tokens.color?.brand?.seed !== "#3730a3") {
						run.problems.push(
							`the brand typed after the correction (#3730a3) was saved as ${tokens.color?.brand?.seed}`,
						)
					}
					// The app's darker indigo is #3730a3 too: typing it as the brand must
					// not leave the foundation with the same colour twice.
					const brand = parseHex(tokens.color?.brand?.seed ?? "")
					for (const [name, seed] of [
						["supporting colour", tokens.color?.secondary?.seed],
						["accent colour", tokens.color?.accent?.seed],
					] as const) {
						const other = seed ? parseHex(seed) : null
						if (brand && other && closeMatch(brand, other) !== null) {
							run.problems.push(`the saved ${name} ${seed} is the same as the brand ${tokens.color.brand.seed}`)
						}
					}
				},
				{ sampleApp: true },
			),
	},
	{
		id: "8",
		title: 're-running the interview over a saved foundation, an error, then "Set tokens by hand": the interview is gone for good',
		run: async () => {
			const full = refusalAt(await readRecording("straight"), "type-scale")
			// The case leaves at the refusal, so the recording ends there.
			const refusal = full.calls.findIndex((c) => c.fault === "provider-refusal")
			const recording = { ...full, calls: full.calls.slice(0, refusal + 1) }
			return withRun("8", recording, async (run) => {
				run.expectedErrors.push(/turn failed at type-scale/)
				const chrome = run.launched.chrome
				await agentSavesFoundation(run)
				// The open Foundation tab switches to the saved design system by itself.
				// Its top-bar button toggles the tab, so clicking it here would leave.
				await chrome.waitForSelector('[data-testid="design-system-view"]', { timeout: 30_000 })
				await chrome.click('[data-testid="ds-rerun"]')
				await startInterview(run, SCRIPTS.straight)
				const stopped = await runScript(run, SCRIPTS.straight)
				assert(stopped.kind === "error", `expected the error screen, got the ${stopped.kind} screen`)
				await chrome.getByRole("button", { name: "Set tokens by hand" }).click()
				await waitFor("the hand editor", async () => (await chrome.locator("textarea").count()) > 0, 20_000)
				await waitFor("the interview to be thrown away", async () => !(await readProgress(run.project)), 10_000)
				run.turns.push('pressed "Set tokens by hand"')
				await chrome.getByTestId("top-bar").getByRole("button", { name: "Assets" }).click()
				await chrome.getByTestId("top-bar").getByRole("button", { name: "Foundation" }).click()
				const landed = await foundationSettlesOn(chrome)
				await shot(chrome, run.dir, "foundation-after-set-by-hand")
				if (landed !== "design-system-view")
					run.problems.push(`after "Set tokens by hand", the Foundation tab showed "${landed}"`)
				if (await readProgress(run.project)) run.problems.push("the interview is saved again")
			})
		},
	},
	{
		id: "9",
		title: "a foundation saved another way (by an agent) clears the half-finished interview",
		run: async () => {
			// The case stops after two answers, so only the calls it reaches are expected.
			const full = await readRecording("straight")
			const recording = { ...full, calls: full.calls.slice(0, 4) }
			return withRun("9", recording, async (run) => {
				const script = SCRIPTS.straight
				await startInterview(run, script)
				await runScript(run, script, { stopAfter: 2 })
				const chrome = run.launched.chrome
				await chrome.getByTestId("top-bar").getByRole("button", { name: "Assets" }).click()
				await agentSavesFoundation(run)
				await chrome.waitForTimeout(1500)
				await chrome.getByTestId("top-bar").getByRole("button", { name: "Foundation" }).click()
				const landed = await foundationSettlesOn(chrome)
				await shot(chrome, run.dir, "foundation-after-agent-save")
				if (landed !== "design-system-view") {
					run.problems.push(`after an agent saved a foundation, the Foundation tab showed "${landed}" instead of it`)
				}
				if (await readProgress(run.project)) run.problems.push("the half-finished interview is still saved")
			})
		},
	},
]

// Cases 10 and 11 go last: they end early by design.
CASES.push(
	{
		id: "10",
		title: "no model connected: the connect screen says so, and its way out works",
		run: async () =>
			withRun("10", null, async (run) => {
				const chrome = run.launched.chrome
				await startInterview(run, SCRIPTS.straight)
				await chrome.waitForSelector('[data-testid="wizard-needs-backend"]', { timeout: 60_000 })
				await shot(chrome, run.dir, "needs-backend")
				await chrome.click('[data-testid="wizard-needs-backend-manual"]')
				await waitFor("the hand editor", async () => (await chrome.locator("textarea").count()) > 0, 20_000)
				if (await readProgress(run.project)) run.problems.push("an interview was saved although no model ever ran")
				run.turns.push("connect screen, then Set it by hand")
			}),
	},
	{
		id: "11",
		title: "a check on the tests themselves: a recording made with different instructions fails loudly, never passes",
		run: async () => {
			const recording = structuredClone(await readRecording("straight"))
			const target = recording.calls.find((c) => c.tag === "interview:area" && c.area === "display-type")
			assert(target, "the recording has no heading font question")
			target.templateHash = "0000000000000000"
			return withRun("11", recording, async (run) => {
				run.expectedErrors.push(/turn failed at display-type/)
				const script = SCRIPTS.straight
				await startInterview(run, script)
				const end = await runScript(run, script)
				if (end.kind !== "error") {
					run.problems.push(`an out-of-date recording was used without complaint (ended on the ${end.kind} screen)`)
					return
				}
				if (!/different instructions/.test(end.text))
					run.problems.push(`the failure doesn't say the recording is out of date: "${end.text}"`)
				// The planted fault was never answered: the recording's later calls are unused on purpose.
				run.recording = null
			})
		},
	},
)

// ── main ────────────────────────────────────────────────────────────────────

async function preflight(): Promise<void> {
	const bundle = await fs.readFile(path.resolve("out/main/index.js"), "utf8").catch(() => "")
	assert(bundle, "No built app at out/main/index.js. Run npm run build first.")
	assert(bundle.includes("CARET_INTERVIEW_REPLAY"), "The built app has no replay switch. Run npm run build first.")
	assert(bundle.includes("wizard:openingAnswer"), "The built app is the old interview. Run npm run build first.")
	if (LIVE) assert(LIVE_MODEL, "A live run needs CARET_VERIFY_MODEL, for example opencode-go/deepseek-v4.1-flash.")
}

/** Which script each live case runs, for saving its recording under that script's name. */
const SCRIPT_OF_CASE: Record<string, string> = { "1": "straight", "2": "escapes", "6": "finish-early", "7": "from-app" }

/** Saves the live cases' recordings as the test recordings, with what they were made from. */
async function saveRecordings(): Promise<void> {
	const gitSha = child_process.execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim()
	for (const [id, name] of Object.entries(SCRIPT_OF_CASE)) {
		const made = path.join(SHOTS, `case-${id}`, "recording.json")
		const recording = JSON.parse(await fs.readFile(made, "utf8")) as Recording
		const script = SCRIPTS[name]
		const project = projects.get(id)
		const saved: Recording = {
			...recording,
			format: 2,
			recorded: { model: LIVE_MODEL, at: new Date().toISOString(), gitSha },
			script: name,
			mode: script.mode,
			description: script.mode === "from-app" && project ? await describeApp(project) : script.description,
		}
		await fs.writeFile(path.join(FIXTURES, `${name}.json`), `${JSON.stringify(saved, null, 2)}\n`)
		console.log(`saved ${saved.calls.length} model calls to test-fixtures/interview/${name}.json`)
	}
}

async function main(): Promise<void> {
	reapOrphanedBackends()
	await preflight()
	const chosen = CASES.filter((c) => (!ONLY || ONLY.has(c.id)) && (!LIVE || LIVE_CASES.has(c.id)))
	const results: Array<{ id: string; ok: boolean }> = []
	console.log(LIVE ? `Live run with ${LIVE_MODEL}: the model's answers are recorded.` : "Recorded model answers.")
	for (const c of chosen) {
		const started = Date.now()
		console.log(`\ncase ${c.id}: ${c.title}`)
		try {
			const detail = await c.run()
			results.push({ id: c.id, ok: true })
			console.log(`  PASS (${Math.round((Date.now() - started) / 1000)}s) ${detail}`)
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err)
			results.push({ id: c.id, ok: false })
			console.log(
				`  FAIL (${Math.round((Date.now() - started) / 1000)}s)${detail.startsWith("\n") ? detail : ` ${detail}`}`,
			)
		}
	}
	reapOrphanedBackends()
	const failed = results.filter((r) => !r.ok)
	console.log(
		`\n${results.length - failed.length} of ${chosen.length} cases passed${ONLY ? " (a subset: not a full certification)" : ""}.`,
	)
	if (results.length !== chosen.length) console.log("Not every case ran.")
	let ok = !failed.length && results.length === chosen.length
	if (LIVE && SAVE) {
		if (!ok || ONLY) {
			console.log("Recordings NOT saved: only a full live run where every case passed is saved.")
		} else {
			await saveRecordings()
			console.log("\nChecking everything against the new recordings:")
			const logic = child_process.spawnSync("npx", ["mocha", "--config", ".mocharc.interview.json"], { stdio: "inherit" })
			const app = child_process.spawnSync("npx", ["tsx", "scripts/verify-interview.ts"], { stdio: "inherit" })
			ok = logic.status === 0 && app.status === 0
			console.log(
				`\nwith the new recordings: logic tests ${logic.status === 0 ? "PASS" : "FAIL"}, real-app tests ${app.status === 0 ? "PASS" : "FAIL"}`,
			)
		}
	}
	process.exitCode = ok ? 0 : 1
}

main()
	.catch((err) => {
		console.error(err instanceof Error ? err.message : err)
		process.exitCode = 1
	})
	.finally(() => setTimeout(() => process.exit(), 500))
