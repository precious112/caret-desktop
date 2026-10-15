/**
 * The AI interview, tested in the real Caret app the way a person uses it.
 *
 * Each test case opens the built app on a fresh project with a fresh profile,
 * starts the interview from the Foundation tab, and clicks through it: picks
 * options, types its own values, skips, goes back. The model's answers come
 * from a recording of a real run (see src/core/design/agent/replay.ts), so a
 * case is free, gives the same result every time, and needs no model.
 *
 * After every question the case checks what a person would notice, against
 * the app's own files:
 *   - the question is not about a topic that was already settled;
 *   - the topic just answered is ticked in the Covering list;
 *   - "So far" shows the brand colour that was actually chosen.
 * At the end it checks the saved foundation (`.caret/tokens/foundation.json`)
 * against what was answered, and reads the app's log.
 *
 * Nothing here is ever skipped. A missing build, a missing recording or an
 * unexpected screen is a failure, and the run fails unless every case ran.
 *
 *   npm run build && npx tsx scripts/verify-interview.ts            all cases, recorded answers
 *   npx tsx scripts/verify-interview.ts --only 1,5                  some cases
 *   CARET_VERIFY_MODEL=opencode-go/deepseek-v4.1-flash \
 *     npx tsx scripts/verify-interview.ts --record                  re-record the answers with a live model
 */
import * as child_process from "child_process"
import * as fs from "fs/promises"
import * as path from "path"

import type { Page } from "playwright"

import type { RecordedCall, Recording } from "../src/core/design/agent/replay"
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
const RECORDING = path.resolve("test-fixtures/interview/legacy-straight.json")
const BRAND = "#28a4f0"
const DESCRIPTION =
	"Argus is an open-source monitoring tool for servers and applications, with an AI investigator built in. " +
	"You run it on your own infrastructure with one Docker command, then add its SDK to your apps. It watches " +
	"metrics, containers and processes, and when something looks wrong it investigates: it correlates metrics, " +
	"logs and events and explains the likely root cause in plain language. Free and MIT licensed; your data " +
	"never leaves your servers. The landing page should send people to the GitHub repo and the docs."

const args = process.argv.slice(2)
const ONLY = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1].split(",")) : null
const RECORD = args.includes("--record")

// ── the interview progress file ─────────────────────────────────────────────

/** What Caret saves after every answer, so you can quit and come back (`.caret/.interview.json`). */
interface Progress {
	description: string
	mode?: string
	history: Array<{ question: Question; answer: Answer }>
	pending?: Question
	proposal?: Record<string, unknown>
}
interface Question {
	id: string
	kind: string
	question: string
	covers?: string[]
	options?: Array<{ id: string; label: string; hex?: string }>
	recommendedId?: string
}
interface Answer {
	value: string
	label?: string
	skipped?: boolean
	wasOther?: boolean
	data?: { hex?: string; family?: string; px?: number; ratio?: number; none?: boolean }
}

async function readProgress(project: string): Promise<Progress | null> {
	try {
		return JSON.parse(await fs.readFile(path.join(project, ".caret", ".interview.json"), "utf8"))
	} catch {
		return null
	}
}

const areaOf = (q: Question | undefined): string | undefined => (q?.covers?.length === 1 ? q.covers[0] : undefined)

// ── one test case's world ───────────────────────────────────────────────────

interface Run {
	project: string
	userData: string
	dir: string
	logFile: string
	replayLog: string
	recording: string
	env: Record<string, string>
	launched: LaunchedApp
	/** Everything the case noticed that a user would call a bug. */
	problems: string[]
	/** One line per question, for the report. */
	turns: string[]
	/** The brand colour "So far" must show from now on, once it is settled. */
	brand?: string
}

let template: string | undefined

async function startRun(id: string, recording: Recording | null, extraPrefs: Record<string, unknown> = {}): Promise<Run> {
	const dir = path.join(SHOTS, `case-${id}`)
	await fs.rm(dir, { recursive: true, force: true })
	await fs.mkdir(dir, { recursive: true })
	const project = await buildProject(template)
	const userData = await freshProfile(extraPrefs)
	const recordingFile = path.join(dir, "recording.json")
	const replayLog = path.join(dir, "replay.log")
	const env: Record<string, string> = {}
	if (recording) {
		await fs.writeFile(recordingFile, JSON.stringify(withSpareFinish(recording), null, 2))
		env.CARET_INTERVIEW_REPLAY = recordingFile
		env.CARET_INTERVIEW_REPLAY_LOG = replayLog
	} else {
		env.CARET_INTERVIEW_RECORD = recordingFile
	}
	const logFile = path.join(dir, "main.log")
	const launched = await launchApp({ project, userData, logFile, env })
	template ??= project
	return { project, userData, dir, logFile, replayLog, recording: recordingFile, env, launched, problems: [], turns: [] }
}

/** Quits Caret and opens it again on the same project and profile, as a person reopening the app would. */
async function relaunch(run: Run): Promise<void> {
	await run.launched.close()
	run.launched = await launchApp({ project: run.project, userData: run.userData, logFile: run.logFile, env: run.env })
}

async function servedCount(run: Run): Promise<number> {
	try {
		return (await fs.readFile(run.replayLog, "utf8")).split("\n").filter((line) => line.trim()).length
	} catch {
		return 0
	}
}

async function logText(run: Run): Promise<string> {
	return fs.readFile(run.logFile, "utf8").catch(() => "")
}

// ── driving the screen ──────────────────────────────────────────────────────

type Screen =
	| { kind: "question"; progress: Progress; q: Question }
	| { kind: "finish"; progress: Progress }
	| { kind: "error"; text: string }

/** Waits for the next settled screen: a question, the finish, or the error screen. */
async function nextScreen(run: Run, answered: number): Promise<Screen> {
	const chrome = run.launched.chrome
	let seen = "nothing yet"
	// The error screen stays up while "Try again" runs, so one sighting is not
	// enough: it counts only when it is still there on the next check, and its
	// text is read without waiting (it may be replaced at any moment).
	let errorSeen = false
	return waitFor(
		`the screen after answer ${answered}`,
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
				if (text !== null) return { kind: "error", text: text.trim() } as Screen
				return null
			}
			errorSeen = false
			if (await chrome.getByTestId("wizard-thinking").count()) return null
			const progress = await readProgress(run.project)
			seen = progress
				? `saved ${progress.history.length} answers, question on screen: ${progress.pending?.id ?? "none"}`
				: "no progress file"
			if (!progress || progress.history.length !== answered) return null
			if (progress.proposal && (await chrome.getByTestId("wizard-finish").count()))
				return { kind: "finish", progress } as Screen
			if (progress.pending && (await chrome.getByTestId("wizard-question").count())) {
				return { kind: "question", progress, q: progress.pending } as Screen
			}
			return null
		},
		4 * 60_000,
		async () => `${seen}; app log ends: ${(await logText(run)).split("\n").slice(-4).join(" | ")}`,
	)
}

/** What to do on a question. Anything not listed means "accept what is selected". */
type Action =
	| { do: "accept" }
	| { do: "skip" }
	| { do: "option"; index: number }
	| { do: "none" }
	| { do: "hex"; hex: string }
	| { do: "font-search"; query: string; pick: string }
	| { do: "own"; px?: string; ratio?: string }
	| { do: "own-then-clear"; px: string }
	| { do: "own-then-reclick"; px: string }
	| { do: "not-quite"; index: number; note: string }

const continueButton = (chrome: Page) => chrome.getByTestId("wizard-continue")

async function act(run: Run, q: Question, action: Action): Promise<string> {
	const chrome = run.launched.chrome
	const options = chrome.locator('[data-testid="wizard-question"] [data-testid="wizard-option"]')
	switch (action.do) {
		case "skip":
			await chrome.getByTestId("wizard-skip").click()
			return "skipped"
		case "option": {
			const count = await options.count()
			assert(count > action.index, `${q.id} shows ${count} options; the case wanted option ${action.index + 1}`)
			await options.nth(action.index).click()
			break
		}
		case "none": {
			const none = (q.options ?? []).findIndex((o) => !o.hex)
			if (none === -1) return accept(run, q, "accept (this question offered no None option)")
			await options.nth(none).click()
			break
		}
		case "hex":
			await chrome.fill('[data-testid="wizard-hex"]', action.hex)
			await chrome.press('[data-testid="wizard-hex"]', "Enter")
			break
		case "font-search": {
			await chrome.fill('[data-testid="wizard-font-search"]', action.query)
			const hit = chrome.locator('[data-testid="wizard-font-other"] button', { hasText: action.pick }).first()
			await hit.waitFor({ timeout: 15_000 })
			await hit.click()
			break
		}
		case "own": {
			const box = chrome.getByTestId("wizard-own-value")
			const inputs = box.locator("input")
			assert(await inputs.count(), `${q.id}: no box for your own value`)
			if (action.px !== undefined) await inputs.nth(0).fill(action.px)
			if (action.ratio !== undefined) await inputs.nth(1).fill(action.ratio)
			// A value the design system can't store may be refused on screen with a
			// reason. That is correct; saving something else without saying so is not.
			await chrome.waitForTimeout(300)
			if (!(await continueButton(chrome).isEnabled())) {
				const reason = ((await box.textContent()) ?? "").replace(/\s+/g, " ").trim()
				for (let i = 0; i < (await inputs.count()); i++) await inputs.nth(i).fill("")
				return accept(run, q, `own value refused on screen ("${reason.slice(0, 80)}"), then the selected card`)
			}
			break
		}
		case "own-then-clear": {
			const input = chrome.locator('[data-testid="wizard-own-value"] input').first()
			assert(await input.count(), `${q.id}: no box for your own value`)
			await input.fill(action.px)
			await input.fill("")
			break
		}
		case "own-then-reclick": {
			const input = chrome.locator('[data-testid="wizard-own-value"] input').first()
			assert(await input.count(), `${q.id}: no box for your own value`)
			await input.fill(action.px)
			const selected = chrome.locator(
				'[data-testid="wizard-question"] [data-testid="wizard-option"][data-selected="true"], [data-testid="wizard-scale"] button[class*="caret-accent"]',
			)
			assert(await selected.count(), `${q.id}: no selected card to click again`)
			await selected.first().click()
			break
		}
		case "not-quite": {
			const buttons = chrome.locator('[data-testid="wizard-assumptions"] button', { hasText: "Not quite" })
			assert((await buttons.count()) > action.index, `${q.id}: no statement ${action.index + 1} to correct`)
			await buttons.nth(action.index).click()
			await chrome.locator('[data-testid="wizard-assumptions"] input').first().fill(action.note)
			break
		}
	}
	return accept(run, q, action.do)
}

/** Fills whatever a question needs before Continue is possible, then presses Continue. */
async function accept(run: Run, q: Question, said: string): Promise<string> {
	const chrome = run.launched.chrome
	if (!(await continueButton(chrome).isEnabled())) {
		if (q.kind === "chips") await chrome.locator('[data-testid="wizard-chips"] > button').first().click()
		if (q.kind === "text") await chrome.fill('[data-testid="wizard-text"]', "Plain and precise.")
	}
	await waitFor(`Continue to become possible on ${q.id}`, async () => continueButton(chrome).isEnabled(), 10_000)
	await continueButton(chrome).click()
	return said
}

/**
 * Checks a person would make after each answer: no topic twice, the answered
 * topic ticked, and "So far" showing the brand colour that was chosen.
 */
async function checkTurn(run: Run, progress: Progress, current: Question | undefined): Promise<void> {
	const chrome = run.launched.chrome
	const settled = progress.history.flatMap((qa) => qa.question.covers ?? [])
	for (const area of current?.covers ?? []) {
		if (settled.includes(area)) run.problems.push(`"${current?.id}" asks about "${area}", which was already settled`)
	}
	const last = progress.history.at(-1)?.question
	const lastArea = areaOf(last)
	if (lastArea && current) {
		const done = await chrome.locator(`[data-testid="wizard-coverage"] [data-area="${lastArea}"]`).getAttribute("data-done")
		if (done !== "true") run.problems.push(`after answering "${last?.id}", "${lastArea}" is not ticked in Covering`)
	}
	if (run.brand && current) {
		const row = chrome.locator('[data-testid="wizard-so-far"] [data-term="Colour"]')
		const text = (await row.count()) ? ((await row.textContent()) ?? "").toLowerCase() : "(no Colour line)"
		if (!text.includes(run.brand))
			run.problems.push(`"So far" shows ${text.trim()} after the brand colour was settled as ${run.brand}`)
	}
}

/** The brand colour an answer settles: the typed hex, the picked swatch, or the recommendation when skipped. */
function brandFrom(q: Question, a: Answer): string | undefined {
	if (a.skipped) return q.options?.find((o) => o.id === q.recommendedId)?.hex?.toLowerCase()
	return (a.data?.hex ?? q.options?.find((o) => o.id === a.value)?.hex)?.toLowerCase()
}

/**
 * Runs the interview until it finishes (or `stopAfter` answers), choosing
 * each action with `decide`. Returns the last screen.
 */
async function interview(
	run: Run,
	decide: (q: Question, answered: number) => Action | undefined,
	options: { stopAfter?: number; startAnswered?: number } = {},
): Promise<Screen> {
	let answered = options.startAnswered ?? 0
	for (;;) {
		const screen = await nextScreen(run, answered)
		if (screen.kind !== "question") return screen
		await checkTurn(run, screen.progress, screen.q)
		if (options.stopAfter !== undefined && answered >= options.stopAfter) return screen
		const action = decide(screen.q, answered) ?? { do: "accept" }
		await shot(run.launched.chrome, run.dir, `q${String(answered + 1).padStart(2, "0")}`)
		const said = await act(run, screen.q, action)
		run.turns.push(`${answered + 1}. ${screen.q.kind} ${JSON.stringify(screen.q.covers ?? [])} → ${said}`)
		answered++
		if (areaOf(screen.q) === "brand-color") {
			const after = await waitFor("the saved brand answer", async () => {
				const p = await readProgress(run.project)
				return p && p.history.length >= answered ? p : null
			})
			run.brand = brandFrom(screen.q, after.history[answered - 1].answer)
		}
		assert(answered <= 24, `no finish after ${answered} answers`)
	}
}

/** Presses "Try again" on the error screen and waits for the error screen to go. */
async function tryAgain(run: Run): Promise<void> {
	const chrome = run.launched.chrome
	await chrome.getByRole("button", { name: "Try again" }).click()
	await chrome.getByTestId("wizard-error").waitFor({ state: "detached", timeout: 4 * 60_000 })
}

async function startInterview(run: Run): Promise<void> {
	await openDescribe(run.launched.chrome, DESCRIPTION)
	await run.launched.chrome.click('[data-testid="foundation-mode-collaborative"]')
}

/** Presses "Use these foundations" and returns the saved foundation file. */
async function commit(run: Run): Promise<Record<string, any>> {
	const file = path.join(run.project, ".caret", "tokens", "foundation.json")
	const before = await fs.readFile(file, "utf8").catch(() => "")
	await shot(run.launched.chrome, run.dir, "finish")
	await run.launched.chrome.click('[data-testid="wizard-commit"]')
	return waitFor(
		"the foundation to be saved",
		async () => {
			const raw = await fs.readFile(file, "utf8").catch(() => "")
			return raw && raw !== before ? JSON.parse(raw) : null
		},
		30_000,
	)
}

/** The saved foundation must carry the fonts that were picked. */
function checkFonts(run: Run, progress: Progress, tokens: Record<string, any>): void {
	for (const qa of progress.history) {
		const family = qa.answer.data?.family
		if (!family) continue
		const area = areaOf(qa.question)
		const saved = area === "display-type" ? tokens.typography?.displayFamily : tokens.typography?.fontFamily
		if (area && saved !== family) run.problems.push(`${area} was answered ${family}, but the saved foundation says ${saved}`)
	}
}

// ── recordings with failures added ──────────────────────────────────────────

/**
 * How many questions had been answered when a recorded call was made. Today's
 * interview states it in every request ("— 3 question(s) asked").
 */
function askedWhen(call: RecordedCall): number {
	const match = /(\d+) question\(s\) asked/.exec(call.prompt ?? "")
	return match ? Number(match[1]) : 0
}

/** The recording with extra calls placed just before the first call made after `answered` answers. */
function withInserted(base: Recording, answered: number, calls: RecordedCall[]): Recording {
	const at = base.calls.findIndex((call) => askedWhen(call) === answered)
	assert(at !== -1, `the recording never reaches ${answered} answers`)
	return { ...base, calls: [...base.calls.slice(0, at), ...calls, ...base.calls.slice(at)] }
}

/** The recording with the calls made after `answered` answers repeated, for a person going Back and answering again. */
function withRepeated(base: Recording, answered: number): Recording {
	const group = base.calls.filter((call) => askedWhen(call) === answered)
	const last = base.calls.map((call) => askedWhen(call) === answered).lastIndexOf(true)
	assert(group.length, `the recording never reaches ${answered} answers`)
	return { ...base, calls: [...base.calls.slice(0, last + 1), ...group, ...base.calls.slice(last + 1)] }
}

/**
 * The recording with two spare copies of its finish. A case that answers
 * differently from the recorded run (types its own size, picks another font)
 * makes Caret check the model's finish against those answers and ask again,
 * as it would ask a live model. A live model would answer; the spares are
 * that answer.
 */
function withSpareFinish(base: Recording): Recording {
	const last = Math.max(...base.calls.map(askedWhen))
	return withRepeated(withRepeated(base, last), last)
}

/** The recorded reply that asked about `area`, as a model re-asking it would send it. */
function reaskOf(base: Recording, area: string): RecordedCall {
	// The last one asked about it is the one that was accepted and shown.
	const call = base.calls
		.filter((c) => {
			const reply = c.reply as { action?: string; question?: Question } | undefined
			return reply?.action === "ask" && areaOf(reply.question) === area
		})
		.at(-1)
	assert(call, `the recording has no question about ${area} to repeat`)
	const reply = structuredClone(call.reply) as { question: Question }
	reply.question.id = `${reply.question.id}-again`
	return { reply, emulated: true }
}

// ── the cases ───────────────────────────────────────────────────────────────

interface Case {
	id: string
	title: string
	run(base: Recording): Promise<string>
}

const CASES: Case[] = [
	{
		id: "1",
		title: "a whole interview, accepting the recommendations, typing the brand colour and an own body size",
		async run(base) {
			const run = await startRun("1", base)
			try {
				await startInterview(run)
				let typedSize = false
				const end = await interview(run, (q) => {
					const area = areaOf(q)
					if (area === "brand-color") return { do: "hex", hex: BRAND }
					if (area === "type-scale" && !typedSize) {
						typedSize = true
						return { do: "own", px: "22", ratio: "1.25" }
					}
					return undefined
				})
				assert(
					end.kind === "finish",
					`the interview ended on the ${end.kind} screen: ${end.kind === "error" ? end.text : ""}`,
				)
				const tokens = await commit(run)
				if (String(tokens.color?.brand?.seed).toLowerCase() !== BRAND) {
					run.problems.push(
						`the brand colour was typed as ${BRAND}, but the saved foundation says ${tokens.color?.brand?.seed}`,
					)
				}
				checkFonts(run, end.progress, tokens)
				// Typing 22px must either be refused on screen or saved as 22px. Saving
				// something else without saying so is the bug.
				const sizeAnswer = end.progress.history.find((qa) => areaOf(qa.question) === "type-scale")?.answer
				if (sizeAnswer?.data?.px === 22 && tokens.typography?.baseSize !== 22) {
					run.problems.push(
						`22px body text was typed and accepted, but the saved foundation says ${tokens.typography?.baseSize}px`,
					)
				}
				return finish(run)
			} finally {
				await run.launched.close()
			}
		},
	},
	{
		id: "2",
		title: "every way to answer: correct a statement, skip the brand, search a font, clear and re-click own values, None, Back",
		async run(base) {
			// Going Back and answering again makes the app ask the model again, so the
			// recording repeats the reply that comes after the answer being changed.
			// Back from the status colours to the accent colour, which is answered differently.
			const backAt = 7
			const run = await startRun("2", withRepeated(base, backAt + 1))
			try {
				await startInterview(run)
				let wentBack = false
				let corrected = false
				const decide = (q: Question): Action | undefined => {
					const area = areaOf(q)
					if (q.kind === "assumptions" && !corrected) {
						corrected = true
						return { do: "not-quite", index: 0, note: "Corners are square, not rounded." }
					}
					if (area === "brand-color") return { do: "skip" }
					if (area === "body-type") return { do: "font-search", query: "Libre Bask", pick: "Libre Baskerville" }
					if (area === "type-scale") return { do: "own-then-clear", px: "22" }
					if (area === "spacing") return { do: "own-then-reclick", px: "6" }
					if (area === "secondary-color") return { do: "none" }
					return undefined
				}
				let screen = await interview(run, decide, { stopAfter: backAt + 1 })
				if (screen.kind === "question" && !wentBack) {
					wentBack = true
					const before = screen.progress.history[backAt]
					await run.launched.chrome.getByTestId("wizard-back").click()
					const back = await nextScreen(run, backAt)
					assert(back.kind === "question", "Back did not show the previous question")
					if (back.q.id !== before.question.id) {
						run.problems.push(`Back showed "${back.q.id}", not the question answered last ("${before.question.id}")`)
					}
					run.turns.push(`   Back to "${back.q.id}", answered differently`)
					const optionCount = back.q.options?.length ?? 0
					await act(run, back.q, optionCount > 1 ? { do: "option", index: optionCount - 1 } : { do: "accept" })
					screen = await interview(run, decide, { startAnswered: backAt + 1 })
				}
				assert(
					screen.kind === "finish",
					`the interview ended on the ${screen.kind} screen: ${screen.kind === "error" ? screen.text : ""}`,
				)
				const history = screen.progress.history
				const areas = history.map((qa) => areaOf(qa.question)).filter(Boolean)
				const twice = areas.filter((a, i) => areas.indexOf(a) !== i)
				if (twice.length) run.problems.push(`after going Back, these topics are saved twice: ${twice.join(", ")}`)
				const size = history.find((qa) => areaOf(qa.question) === "type-scale")?.answer
				if (size?.wasOther || size?.data?.px === 22) {
					run.problems.push(
						`an own body size of 22px was typed and then cleared, but the saved answer still uses it ("${size.label ?? size.value}")`,
					)
				}
				const spacing = history.find((qa) => areaOf(qa.question) === "spacing")?.answer
				if (spacing?.wasOther || spacing?.data?.px === 6) {
					run.problems.push(
						`6px spacing was typed and then the selected card was clicked again, but the saved answer still uses 6px ("${spacing.label ?? spacing.value}")`,
					)
				}
				const tokens = await commit(run)
				checkFonts(run, screen.progress, tokens)
				if (run.brand && String(tokens.color?.brand?.seed).toLowerCase() !== run.brand) {
					run.problems.push(
						`the brand question was skipped, so its recommendation ${run.brand} stands, but the saved foundation says ${tokens.color?.brand?.seed}`,
					)
				}
				return finish(run)
			} finally {
				await run.launched.close()
			}
		},
	},
	{
		id: "3",
		title: "the model misbehaves mid-interview (a garbled reply, then a reply that keeps re-asking a settled topic)",
		async run(base) {
			const settledEarly = base.calls
				.map((c) => (c.reply as { action?: string; question?: Question })?.question)
				.map((q) => areaOf(q))
				.find(Boolean)
			assert(settledEarly, "the recording has no single-topic question to re-ask")
			let recording = withInserted(base, 3, [{ fault: "malformed" }])
			// A stubborn model: five replies in a row asking about a topic already answered.
			recording = withInserted(
				recording,
				6,
				Array.from({ length: 5 }, () => reaskOf(base, settledEarly)),
			)
			const run = await startRun("3", recording)
			try {
				await startInterview(run)
				const end = await interview(run, (q) => (areaOf(q) === "brand-color" ? { do: "hex", hex: BRAND } : undefined))
				if (end.kind === "error") run.problems.push(`the user was shown the error screen: ${end.text.slice(0, 160)}`)
				const log = await logText(run)
				if (!/rejected/.test(log))
					run.problems.push("the garbled reply was not caught and retried (no rejection in the app log)")
				if (end.kind === "finish") await commit(run)
				return finish(run)
			} finally {
				await run.launched.close()
			}
		},
	},
	{
		id: "4",
		title: "the model's provider refuses: the error screen, then Try again carries on",
		async run(base) {
			const run = await startRun(
				"4",
				withInserted(base, 3, [{ fault: "provider-refusal", message: "usage limit reached" }]),
			)
			try {
				await startInterview(run)
				const decide = (q: Question) => (areaOf(q) === "brand-color" ? ({ do: "hex", hex: BRAND } as Action) : undefined)
				const first = await interview(run, decide)
				assert(first.kind === "error", `expected the error screen after the refusal, got the ${first.kind} screen`)
				await shot(run.launched.chrome, run.dir, "error")
				await tryAgain(run)
				const end = await interview(run, decide, { startAnswered: 3 })
				assert(end.kind === "finish", `after Try again the interview ended on the ${end.kind} screen`)
				const tokens = await commit(run)
				checkFonts(run, end.progress, tokens)
				return finish(run)
			} finally {
				await run.launched.close()
			}
		},
	},
	{
		id: "5",
		title: "quit and reopen Caret: on the error screen, and in the middle of a question",
		async run(base) {
			const run = await startRun(
				"5",
				withInserted(base, 3, [{ fault: "provider-refusal", message: "usage limit reached" }]),
			)
			try {
				await startInterview(run)
				const first = await interview(run, () => undefined)
				assert(first.kind === "error", `expected the error screen after the refusal, got the ${first.kind} screen`)
				await relaunch(run)
				const chrome = run.launched.chrome
				const which = async () => {
					for (const id of ["wizard-error", "wizard-question", "foundation-entry", "design-system-view"]) {
						if (await chrome.getByTestId(id).count()) return id
					}
					return null
				}
				await waitFor("a screen after reopening", which, 60_000)
				// A saved interview loads a moment after the tab opens; judge the screen it settles on.
				await chrome.waitForTimeout(4000)
				const landed = await which()
				await shot(chrome, run.dir, "after-reopen-on-error")
				const progress = await readProgress(run.project)
				if (landed !== "wizard-error") {
					run.problems.push(
						`after reopening Caret on the error screen, it showed "${landed}" instead; saved answers: ${progress?.history.length ?? 0} of 3`,
					)
					return finish(run)
				}
				if ((progress?.history.length ?? 0) !== 3)
					run.problems.push(`after reopening, ${progress?.history.length ?? 0} answers are saved, not 3`)
				await tryAgain(run)
				const question = await nextScreen(run, 3)
				assert(question.kind === "question", `Try again led to the ${question.kind} screen`)
				const calls = await servedCount(run)
				await relaunch(run)
				const again = await nextScreen(run, 3)
				if (again.kind !== "question" || again.q.id !== question.q.id) {
					run.problems.push(`quitting mid-question and reopening did not bring back the same question`)
				}
				if ((await servedCount(run)) !== calls)
					run.problems.push("reopening asked the model again instead of showing the saved question")
				return finish(run)
			} finally {
				await run.launched.close()
			}
		},
	},
	{
		id: "9",
		title: "a foundation saved another way (by an agent) clears the half-finished interview",
		async run(base) {
			const run = await startRun("9", base)
			try {
				await startInterview(run)
				await interview(run, () => undefined, { stopAfter: 2 })
				const chrome = run.launched.chrome
				// Leave the interview, as a person switching to the chat would.
				await chrome.getByTestId("top-bar").getByRole("button", { name: "Assets" }).click()
				const discovery = await waitFor("the MCP address", () => readDiscovery(run.project), 60_000)
				const said = await callMcpTool(discovery, "commit_foundation", {
					candidateId: "editorial-instrument+mono-accent+editorial-open",
					tags: ["editorial"],
				})
				assert(
					!said.includes('"isError":true'),
					`saving a foundation through the agent tools failed: ${said.slice(0, 300)}`,
				)
				await waitFor("the foundation to be saved", async () => {
					const raw = await fs
						.readFile(path.join(run.project, ".caret", "tokens", "foundation.json"), "utf8")
						.catch(() => "")
					return raw.includes('"committed": true') || raw.includes('"committed":true')
				})
				await chrome.waitForTimeout(1500)
				await chrome.getByTestId("top-bar").getByRole("button", { name: "Foundation" }).click()
				const which = async () => {
					for (const id of ["design-system-view", "wizard-question", "wizard", "foundation-entry"]) {
						if (await chrome.getByTestId(id).count()) return id
					}
					return null
				}
				await waitFor("the Foundation tab", which, 30_000)
				// The tab can show one screen and switch a moment later when a saved
				// interview loads, so judge the screen it settles on.
				await chrome.waitForTimeout(4000)
				const landed = await which()
				await shot(chrome, run.dir, "foundation-after-agent-save")
				if (landed !== "design-system-view") {
					run.problems.push(
						`after a foundation was saved, the Foundation tab showed "${landed}" (the old half-finished interview) instead of the saved design system`,
					)
				}
				return finish(run)
			} finally {
				await run.launched.close()
			}
		},
	},
]

function finish(run: Run): string {
	if (run.problems.length) {
		// The same problem seen on several questions is reported once, with a count.
		const counts = new Map<string, number>()
		for (const p of run.problems) counts.set(p, (counts.get(p) ?? 0) + 1)
		const lines = [...counts].map(([p, n]) => `\n      - ${p}${n > 1 ? ` (on ${n} questions)` : ""}`)
		throw new Error(`${lines.join("")}\n    turns:\n      ${run.turns.join("\n      ")}`)
	}
	return `${run.turns.length} questions answered`
}

// ── recording a live run ────────────────────────────────────────────────────

async function record(): Promise<void> {
	const model = process.env.CARET_VERIFY_MODEL?.trim()
	assert(model, "Set CARET_VERIFY_MODEL (for example opencode-go/deepseek-v4.1-flash) to record.")
	const run = await startRun("record", null, { backendId: "opencode", backendModel: model })
	try {
		await startInterview(run)
		const end = await interview(run, (q) => (areaOf(q) === "brand-color" ? { do: "hex", hex: BRAND } : undefined))
		assert(end.kind === "finish", `the live interview ended on the ${end.kind} screen`)
		const recording = JSON.parse(await fs.readFile(run.recording, "utf8")) as Recording
		const gitSha = child_process.execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim()
		const saved: Recording = {
			...recording,
			format: 1,
			recorded: { model, at: new Date().toISOString(), gitSha },
			script: "straight",
			mode: "collaborative",
			description: DESCRIPTION,
		}
		await fs.mkdir(path.dirname(RECORDING), { recursive: true })
		await fs.writeFile(RECORDING, `${JSON.stringify(saved, null, 2)}\n`)
		console.log(`recorded ${saved.calls.length} model calls (${run.turns.length} questions) to ${RECORDING}`)
		if (run.problems.length) console.log(`problems seen while recording:\n- ${run.problems.join("\n- ")}`)
	} finally {
		await run.launched.close()
		reapOrphanedBackends()
	}
}

// ── main ────────────────────────────────────────────────────────────────────

async function preflight(): Promise<Recording> {
	const bundle = await fs.readFile(path.resolve("out/main/index.js"), "utf8").catch(() => "")
	assert(bundle, "No built app at out/main/index.js. Run npm run build first.")
	assert(bundle.includes("CARET_INTERVIEW_REPLAY"), "The built app has no replay switch. Run npm run build first.")
	const raw = await fs.readFile(RECORDING, "utf8").catch(() => "")
	assert(
		raw,
		`No recording at ${RECORDING}. Record one with CARET_VERIFY_MODEL=... npx tsx scripts/verify-interview.ts --record`,
	)
	return JSON.parse(raw) as Recording
}

async function main(): Promise<void> {
	reapOrphanedBackends()
	if (RECORD) return record()
	const base = await preflight()
	const chosen = CASES.filter((c) => !ONLY || ONLY.has(c.id))
	const results: Array<{ id: string; title: string; ok: boolean; detail: string }> = []
	for (const c of chosen) {
		const started = Date.now()
		console.log(`\ncase ${c.id}: ${c.title}`)
		try {
			const detail = await c.run(base)
			results.push({ id: c.id, title: c.title, ok: true, detail })
			console.log(`  PASS (${Math.round((Date.now() - started) / 1000)}s) ${detail}`)
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err)
			results.push({ id: c.id, title: c.title, ok: false, detail })
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
	process.exitCode = failed.length || results.length !== chosen.length ? 1 : 0
}

main()
	.catch((err) => {
		console.error(err instanceof Error ? err.message : err)
		process.exitCode = 1
	})
	.finally(() => setTimeout(() => process.exit(), 500))
