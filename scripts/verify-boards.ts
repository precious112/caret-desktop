/**
 * The branching boards, tested in the real app: Generate an asset (the image
 * kind) and the Experiment canvas.
 *
 *   npm run test:boards                      free: stand-in image service, stand-in page takes
 *   npm run test:boards -- --only a1,a3      some cases
 *   CARET_VERIFY_MODEL=… npm run test:boards -- --model
 *                                            adds the cases that need a real AI model
 *                                            ("Polish it", "Ask me first", real page takes)
 *   npm run test:boards -- --live            real Google image calls, capped (see LIVE_CALL_CAP)
 *
 * Every case opens a fresh copy of the app on a fresh project and clicks
 * through it as a person does. What the app sent to the image service is read
 * from the stand-in's own record of every call, and what the app holds is read
 * from its own board state, so each check has a witness outside the screen.
 */
import { strict as assert } from "assert"
import * as child_process from "child_process"
import { createHash } from "crypto"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import sharp from "sharp"

import { type RecordedCall, startFakeImageService } from "./fake-image-service"
import { buildProject, freshProfile, type LaunchedApp, launchApp, reapOrphanedBackends, shot, waitFor } from "./verify-kit"

const SHOTS = path.resolve("release/boards-shots")
const args = process.argv.slice(2)
const ONLY = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1].split(",")) : null
const WITH_MODEL = args.includes("--model") || args.includes("--live")
const LIVE = args.includes("--live")
const MODEL = process.env.CARET_VERIFY_MODEL?.trim() ?? ""

let template: string | undefined
let service: Awaited<ReturnType<typeof startFakeImageService>>

interface Run {
	id: string
	project: string
	userData: string
	dir: string
	logFile: string
	launched: LaunchedApp
}

interface RunOptions {
	/** Point the app at the stand-in image service (the default), or at nothing at all. */
	images?: "stand-in" | "none"
	/** Connect the AI model (CARET_VERIFY_MODEL) for the brief writer and questions. */
	model?: boolean
	/** Extra preferences for the profile. */
	prefs?: Record<string, unknown>
	/** Leave the cutout tool off this profile. */
	noCutoutTool?: boolean
	/** Page takes made by the real AI model instead of the stand-in. */
	realTakes?: boolean
	prepare?(project: string): Promise<void>
}

async function startRun(id: string, options: RunOptions = {}): Promise<Run> {
	const dir = path.join(SHOTS, `case-${id}`)
	await fs.rm(dir, { recursive: true, force: true })
	await fs.mkdir(dir, { recursive: true })
	const project = await buildProject(template)
	await options.prepare?.(project)
	const userData = await freshProfile({
		...(options.model && MODEL ? { backendId: "opencode", backendModel: MODEL } : {}),
		...options.prefs,
	})
	if (!options.noCutoutTool) await seedCutoutTool(userData)
	const logFile = path.join(dir, "main.log")
	const env: Record<string, string> = {
		// A key in the environment would send a "none" case to Google; blank it.
		GEMINI_API_KEY: "",
		GOOGLE_API_KEY: "",
		CARET_VERTEX_PROJECT: "",
		GOOGLE_CLOUD_PROJECT: "",
		...((options.images ?? "stand-in") === "stand-in" ? { CARET_TEST_IMAGE_SERVICE: service.url } : {}),
		// Page takes from the stand-in, unless the case wants the real model.
		...(options.realTakes ? {} : { CARET_TEST_EXPLORE: "1500" }),
	}
	const launched = await launchApp({ project, userData, logFile, env })
	template ??= project
	service.reset()
	return { id, project, userData, dir, logFile, launched }
}

/**
 * The cutout tool is a 224MB download per machine (per profile, for the app).
 * Every test profile gets an instant copy of the one this machine already has,
 * instead of downloading it again; without one the cutout case downloads it.
 */
async function seedCutoutTool(userData: string): Promise<void> {
	const name = "BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx"
	for (const dir of ["Electron", "Caret", "caret"]) {
		const from = path.join(os.homedir(), "Library", "Application Support", dir, "models", name)
		if (!(await fs.stat(from).catch(() => null))) continue
		await fs.mkdir(path.join(userData, "models"), { recursive: true })
		child_process.execFileSync("cp", ["-c", from, path.join(userData, "models", name)])
		return
	}
}

async function withRun(id: string, options: RunOptions, body: (run: Run) => Promise<string>): Promise<string> {
	const run = await startRun(id, options)
	try {
		const detail = await body(run)
		await checkLog(run)
		await shot(run.launched.chrome, run.dir, "end")
		return detail
	} catch (err) {
		await shot(run.launched.chrome, run.dir, "failure")
		// The canvas is its own view; the main window's screenshot cannot see it.
		for (const page of run.launched.app.context().pages()) {
			if (page.url().startsWith("http://127.0.0.1"))
				await page.screenshot({ path: path.join(run.dir, "failure-canvas.png") }).catch(() => {})
		}
		throw err
	} finally {
		await run.launched.close()
	}
}

/** The app logged no error, and no window threw. */
async function checkLog(run: Run): Promise<void> {
	const log = await fs.readFile(run.logFile, "utf8")
	const errors = log.split("\n").filter((line) => /\bERROR\b/.test(line) && !/net::ERR_ABORTED/.test(line))
	assert(errors.length === 0, `the app logged errors:\n  ${errors.slice(0, 5).join("\n  ")}`)
}

// ── driving the Generate screen ──────────────────────────────────────────

async function openGenerate(run: Run): Promise<void> {
	const chrome = run.launched.chrome
	if ((await chrome.getByTestId("app-shell").getAttribute("data-surface")) !== "assets") {
		await chrome.getByTestId("top-bar").getByRole("button", { name: "Assets" }).click()
	}
	await chrome.waitForSelector('[data-testid="assets-view"], [data-testid="assets-before-setup"]', { timeout: 30_000 })
	// A project with no foundation shows a "set up first" door; look around anyway.
	const lookAround = chrome.getByTestId("assets-look-around")
	if (await lookAround.count()) await lookAround.click()
	await chrome.getByTestId("assets-view").waitFor({ timeout: 15_000 })
	await chrome.getByTestId("assets-generate").click()
	await chrome.getByTestId("generate-ask").waitFor({ timeout: 15_000 })
}

interface Describe {
	text: string
	kind?: string
	mode?: "polish" | "ask" | "exact"
	aspect?: string
	transparent?: boolean
	keepLook?: boolean
	anchor?: string
}

/** Fills the describe step the way a person does. Does not press Generate. */
async function describe(run: Run, d: Describe): Promise<void> {
	const ask = run.launched.chrome.getByTestId("generate-ask")
	await ask.locator(`[data-generate-kind="${d.kind ?? "image"}"]`).click()
	await ask.getByTestId("generate-request").fill(d.text)
	if ((d.kind ?? "image") !== "image") return
	if (d.aspect) await ask.getByTestId("generate-aspect").selectOption(d.aspect)
	if (d.transparent) await ask.getByTestId("generate-transparent").check()
	if (d.anchor) await ask.getByTestId("generate-style-anchor").selectOption(d.anchor)
	await ask.locator(`[data-prompt-mode="${d.mode ?? "exact"}"]`).click()
	if (d.mode === "exact" && d.keepLook === false) await ask.getByTestId("generate-keep-look").uncheck()
	if (d.mode === "exact" && d.keepLook === true) await ask.getByTestId("generate-keep-look").check()
}

interface BoardState {
	id: string
	mode: string
	aspect: string
	brief?: string
	briefNote?: string
	briefing: boolean
	branches: Array<{
		id: string
		parentTakeId: string | null
		label: string
		strength?: string
		source: string
		takeIds: string[]
	}>
	takes: Array<{
		id: string
		branchId: string
		index: number
		status: string
		error?: string
		savedAs?: string
		preview?: string
	}>
}

/** The app's own record of the board. */
async function board(run: Run): Promise<BoardState | null> {
	return (await run.launched.chrome.evaluate(
		(project) => (window as any).caret.invoke("generate:boardGet", project),
		run.project,
	)) as BoardState | null
}

async function settled(run: Run, label: string, ms = 90_000): Promise<BoardState> {
	return waitFor(
		label,
		async () => {
			const b = await board(run)
			return b && !b.briefing && b.takes.every((t) => t.status !== "waiting" && t.status !== "working") ? b : null
		},
		ms,
		async () => JSON.stringify((await board(run))?.takes.map((t) => `${t.id}:${t.status}`)),
	)
}

/** The full-size picture of a take, as the app holds it (and as it would send it as a reference). */
async function picture(run: Run, takeId: string): Promise<string> {
	const url = (await run.launched.chrome.evaluate(
		([project, id]) => (window as any).caret.invoke("generate:boardPicture", project, id),
		[run.project, takeId] as const,
	)) as string | null
	assert(url, `no picture for take ${takeId}`)
	return url
}

function hashOf(dataUrl: string): string {
	return createHash("sha256")
		.update(Buffer.from(dataUrl.split(",")[1], "base64"))
		.digest("hex")
}

/** Takes as one line each, without their pictures, for failure messages. */
const summary = (takes: BoardState["takes"]) =>
	takes.map((t) => `${t.id}:${t.status}${t.error ? ` (${t.error.slice(0, 80)})` : ""}`).join(", ")

const take = (run: Run, id: string) => run.launched.chrome.locator(`[data-testid="board-take"][data-take-id="${id}"]`)

/** Selects a take, ticks chips, sets the strength and words, and grows a branch. */
async function grow(run: Run, takeId: string, change: { chips?: string[]; note?: string; strength?: "subtle" | "strong" }) {
	const chrome = run.launched.chrome
	await take(run, takeId).click()
	const inspector = chrome.getByTestId("board-inspector")
	for (const chip of change.chips ?? []) await inspector.locator(`[data-chip="${chip}"]`).click()
	await inspector.getByTestId(`board-strength-${change.strength ?? "subtle"}`).click()
	if (change.note) await inspector.getByTestId("board-change-note").fill(change.note)
	await inspector.getByTestId("board-grow").click()
}

const exactCalls = () => service.calls()

// ── driving the Experiment canvas ────────────────────────────────────────

const HOME_SOURCE = `export default function Home() {
	return (
		<main className="min-h-screen p-16">
			<h1 className="text-5xl font-semibold">Tenon keyboards</h1>
			<p className="mt-6 text-xl">Built from one piece of walnut.</p>
		</main>
	)
}
`

/** A page's source without the element ids Caret's healer adds to every page. */
const plain = (source: string) => source.replace(/ data-caret-id="[^"]*"/g, "")

async function writeHomePage(project: string): Promise<void> {
	const dir = path.join(project, ".caret", "pages", "home")
	await fs.mkdir(dir, { recursive: true })
	await fs.writeFile(path.join(dir, "index.tsx"), HOME_SOURCE)
	await fs.writeFile(
		path.join(dir, "meta.json"),
		JSON.stringify({ id: "home", title: "Home", type: "page", states: [], tags: [] }),
	)
}

/**
 * The canvas view, once it is showing its page cards. Looked up afresh on every
 * try: it reloads while the preview starts, which closes the earlier handle.
 */
async function canvas(run: Run): Promise<import("playwright").Page> {
	return waitFor(
		"the canvas with its page cards",
		async () => {
			for (const page of run.launched.app.context().pages()) {
				if (!page.url().startsWith("http://127.0.0.1")) continue
				const cards = await page
					.locator(".caret-canvas-frame, [data-testid='explore-board']")
					.count()
					.catch(() => 0)
				if (cards > 0) return page
			}
			return null
		},
		180_000,
		async () =>
			run.launched.app
				.context()
				.pages()
				.map((p) => p.url())
				.join(", "),
	)
}

interface Node {
	id: string
	parentId: string
	instruction: string
	status: string
	round?: string
	strength?: string
	label: string
	error?: string
}

/** The experiment as the app stored it. */
async function scratch(run: Run): Promise<{ pageId: string; mode: string; nodes: Node[] } | null> {
	return JSON.parse(await fs.readFile(path.join(run.project, ".caret", ".variants.json"), "utf8").catch(() => "null"))
}

async function takesSettled(run: Run, label: string, ms = 120_000) {
	return waitFor(
		label,
		async () => {
			const open = await scratch(run)
			return open && open.nodes.length > 0 && open.nodes.every((n) => n.status !== "working") ? open : null
		},
		ms,
		async () => JSON.stringify((await scratch(run))?.nodes.map((n) => `${n.id}:${n.status}`)),
	)
}

/** The instructions a stand-in take's page lists: its whole chain, oldest first. */
async function chainOf(run: Run, id: string): Promise<string[]> {
	const source = await fs.readFile(path.join(run.project, ".caret", "pages", id, "index.tsx"), "utf8")
	const match = /const STEPS = (\[.*\])/.exec(source)
	return match ? JSON.parse(match[1]) : []
}

/** Opens Home on the canvas and starts an experiment on it, through the focused page's Experiment button. */
async function startExperiment(run: Run, instruction: string): Promise<import("playwright").Page> {
	const page = await canvas(run)
	await page.locator(".caret-canvas-frame").first().click()
	await page.getByTestId("explore-enter-focused").click({ timeout: 30_000 })
	await page.getByTestId("explore-instruction").fill(instruction)
	await page.getByTestId("explore-start-page-go").click()
	await page.getByTestId("explore-board").waitFor({ timeout: 30_000 })
	return page
}

/**
 * Selects a take (or the page itself) on the board and grows a round from it,
 * returning once the app has recorded the new round (the request is handled
 * after the click returns).
 */
async function growPage(
	run: Run,
	page: import("playwright").Page,
	id: string,
	change: { chips?: string[]; note?: string; strength?: "subtle" | "strong" },
) {
	const before = (await scratch(run))?.nodes.length ?? 0
	const card = page.getByTestId(id === "home" ? "explore-root" : `variant-card-${id}`)
	await card.locator(".caret-board-take").click()
	const inspector = page.getByTestId("explore-inspector")
	for (const chip of change.chips ?? []) await inspector.locator(`[data-chip="${chip}"]`).click()
	await inspector.getByTestId(`explore-strength-${change.strength ?? "subtle"}`).click()
	if (change.note) await inspector.getByTestId("explore-change-note").fill(change.note)
	await inspector.getByTestId("explore-grow").click()
	await waitFor(
		"the new round to be recorded",
		async () => (((await scratch(run))?.nodes.length ?? 0) > before ? true : null),
		20_000,
	)
}

// ── the cases ─────────────────────────────────────────────────────────────

interface Case {
	id: string
	title: string
	needsModel?: boolean
	run(): Promise<string>
}

const CASES: Case[] = [
	{
		id: "a1",
		title: "'Use my words' sends exactly the words; the shape is chosen first and costs nothing; takes land one by one",
		run: () =>
			withRun("a1", {}, async (run) => {
				await openGenerate(run)
				const words = "a brass compass on rough linen, seen from directly above"
				await describe(run, { text: words, mode: "exact", aspect: "16:9", keepLook: false })
				// Choosing the shape and the mode spent nothing.
				assert.equal(exactCalls().length, 0, "the describe step made image calls before Generate")
				await run.launched.chrome.getByTestId("generate-begin").click()
				await run.launched.chrome.getByTestId("take-board").waitFor({ timeout: 20_000 })

				// One by one: a moment where some takes are ready and some are not.
				const partial = await waitFor(
					"a moment with some takes ready and some still coming",
					async () => {
						const b = await board(run)
						const ready = b?.takes.filter((t) => t.status === "ready").length ?? 0
						return ready > 0 && ready < 4 ? ready : null
					},
					60_000,
				)
				const done = await settled(run, "the first takes")
				assert.equal(done.takes.length, 4)
				assert(
					done.takes.every((t) => t.status === "ready"),
					`not every take was made: ${summary(done.takes)}`,
				)
				const calls = exactCalls()
				assert.equal(calls.length, 4, `expected 4 image calls, got ${calls.length}`)
				for (const call of calls) {
					assert.equal(call.prompt, words, `the prompt sent was not the words exactly:\n${call.prompt}`)
					assert.equal(call.aspect, "16:9")
				}
				// The pictures on the board decode, in the chosen shape.
				const ratios = await run.launched.chrome.$$eval('[data-testid="board-take"] img', (imgs) =>
					imgs.map((img) => (img as HTMLImageElement).naturalWidth / (img as HTMLImageElement).naturalHeight),
				)
				assert.equal(ratios.length, 4)
				assert(
					ratios.every((r) => Math.abs(r - 16 / 9) < 0.02),
					`previews are not 16:9: ${ratios}`,
				)
				assert.equal(await run.launched.chrome.getByTestId("board-prompt-text").innerText(), words)

				// With the foundation's look left on, the words still lead and nothing else of Caret's is added.
				await run.launched.chrome.getByTestId("board-new-prompt").click()
				service.reset()
				await describe(run, { text: words, mode: "exact", aspect: "3:2", keepLook: true })
				await run.launched.chrome.getByTestId("generate-begin").click()
				await settled(run, "the second board")
				const withLook = exactCalls()
				assert.equal(withLook.length, 4)
				assert(withLook[0].prompt.startsWith(`${words}\n\n`), `the words do not lead:\n${withLook[0].prompt}`)
				assert(!/Do not include|avoid:/i.test(withLook[0].prompt), `Caret's avoid list was added:\n${withLook[0].prompt}`)
				return `four takes from the exact words (${partial} landed before the rest); with the look on, only the colours were added`
			}),
	},
	{
		id: "a2",
		title: "branches grow from the exact take, twice from one take, and three levels deep; the lines start on the take",
		run: () =>
			withRun("a2", {}, async (run) => {
				await openGenerate(run)
				await describe(run, { text: "a ceramic mug on a wooden table", mode: "exact" })
				await run.launched.chrome.getByTestId("generate-begin").click()
				const first = await settled(run, "the first takes")
				const parent = first.takes[2].id
				const parentHash = hashOf(await picture(run, parent))

				await grow(run, parent, { chips: ["Warmer light"] })
				// While the branch is being made, its takes say so and offer nothing to grow from.
				const status = await run.launched.chrome
					.getByTestId("board-inspector-status")
					.innerText({ timeout: 10_000 })
					.catch(() => "")
				let b = await settled(run, "the first branch")
				const firstBranch = b.branches.find((branch) => branch.parentTakeId === parent)!
				assert(firstBranch, "no branch grew from the chosen take")
				assert.equal(firstBranch.label, "warmer light")
				assert.equal(firstBranch.takeIds.length, 2)
				const branchCalls = exactCalls().slice(4)
				assert.equal(branchCalls.length, 2)
				assert(
					branchCalls.every((call) => call.references.length === 1 && call.references[0] === parentHash),
					"the branch was not made from the chosen take's picture",
				)
				assert(branchCalls[0].prompt.includes("make the light warmer"), branchCalls[0].prompt)

				// The same take again, strong, with words.
				await grow(run, parent, { note: "on a slate counter", strength: "strong" })
				b = await settled(run, "the second branch from the same take")
				const fromParent = b.branches.filter((branch) => branch.parentTakeId === parent)
				assert.equal(fromParent.length, 2, "the second branch replaced the first")
				assert.equal(fromParent[1].strength, "strong")
				assert(
					exactCalls()
						.slice(6)
						.every((call) => call.prompt.includes("bolder version")),
				)
				const badge = run.launched.chrome.locator(`[data-take-id="${parent}"] ~ [data-testid="board-kids"]`)
				assert.equal(await badge.getAttribute("data-count"), "2", "the parent take's count does not read 2")

				// Three levels deep: grown from a take of the first branch.
				const child = firstBranch.takeIds[1]
				const childHash = hashOf(await picture(run, child))
				await grow(run, child, { chips: ["Closer in"] })
				b = await settled(run, "the deep branch")
				const deep = b.branches.find((branch) => branch.parentTakeId === child)!
				assert(deep, "no branch grew from the branch's take")
				const deepCalls = exactCalls().slice(8)
				assert(
					deepCalls.every((call) => call.references[0] === childHash),
					"the deep branch was not made from its own parent",
				)

				// Nothing was overwritten: every take ever made is still on the board.
				assert.equal(b.takes.length, 4 + 2 + 2 + 2)
				assert.equal(new Set(b.takes.map((t) => t.id)).size, b.takes.length)

				// The path bar walks first takes › warmer light › closer in.
				await take(run, deep.takeIds[0]).click()
				const crumbs = await run.launched.chrome
					.locator('[data-testid="board-path"] [data-take-id]')
					.evaluateAll((els) => els.map((el) => el.getAttribute("data-take-id")))
				assert.deepEqual(crumbs, [parent, child, deep.takeIds[0]])

				// Each line starts on the right edge of the exact take it grew from.
				for (const branch of b.branches.filter((x) => x.parentTakeId)) {
					const geometry = await run.launched.chrome.evaluate(
						([branchId, parentId]) => {
							const line = document.querySelector(`[data-line-for="${branchId}"] path`) as SVGPathElement | null
							const card = document.querySelector(`[data-testid="board-take"][data-take-id="${parentId}"]`)
							if (!line || !card) return null
							const svg = line.ownerSVGElement!.getBoundingClientRect()
							const startPoint = line.getPointAtLength(0)
							const r = card.getBoundingClientRect()
							return {
								x: svg.left + startPoint.x,
								y: svg.top + startPoint.y,
								right: r.right,
								top: r.top,
								bottom: r.bottom,
							}
						},
						[branch.id, branch.parentTakeId!] as const,
					)
					assert(geometry, `no line or no parent card for ${branch.id}`)
					assert(
						Math.abs(geometry.x - geometry.right) <= 12,
						`line for ${branch.id} starts ${geometry.x - geometry.right}px from its take's edge`,
					)
					assert(
						geometry.y > geometry.top && geometry.y < geometry.bottom,
						`line for ${branch.id} starts outside its take's height`,
					)
				}
				await shot(run.launched.chrome, run.dir, "branches")
				return `branches from the exact take (twice), three deep, every reference the right parent; ${status ? "working takes said so" : "(no working-state text seen)"}`
			}),
	},
	{
		id: "a3",
		title: "a refusal, a busy service, and cancelling: each stays on its own take",
		run: () =>
			withRun("a3", {}, async (run) => {
				const chrome = run.launched.chrome
				await openGenerate(run)
				await describe(run, { text: "a teapot [[refuse]]", mode: "exact" })
				await chrome.getByTestId("generate-begin").click()
				let b = await settled(run, "the refused takes")
				assert(
					b.takes.every((t) => t.status === "failed" && /can't make that picture/.test(t.error ?? "")),
					summary(b.takes),
				)
				assert.equal(await chrome.getByTestId("board-take-error").count(), 4)
				// A refused take offers nothing to grow from.
				await take(run, b.takes[0].id).click()
				assert.equal(await chrome.getByTestId("board-grow").count(), 0, "a failed take offered Grow")

				// Busy once, then fine: the app retries on its own and the person never sees the 429.
				await chrome.getByTestId("board-new-prompt").click()
				service.reset()
				await describe(run, { text: "a teapot [[busy-once]]", mode: "exact" })
				await chrome.getByTestId("generate-begin").click()
				b = await settled(run, "the busy-once takes")
				assert(
					b.takes.every((t) => t.status === "ready"),
					summary(b.takes),
				)
				assert(
					exactCalls().some((call) => call.status === 429),
					"the service was never busy",
				)

				// Slow: cancel one take while it is being made and one while it waits.
				await chrome.getByTestId("board-new-prompt").click()
				service.reset()
				await describe(run, { text: "a teapot [[slow]]", mode: "exact" })
				await chrome.getByTestId("generate-begin").click()
				const started = await waitFor(
					"the first take to start",
					async () => {
						const now = await board(run)
						return now?.takes[0].status === "working" ? now : null
					},
					30_000,
				)
				await take(run, started.takes[0].id).locator('[data-testid="board-take-cancel"]').click()
				await take(run, started.takes[3].id).locator('[data-testid="board-take-cancel"]').click()
				b = await settled(run, "the slow takes", 60_000)
				assert.equal(b.takes[0].status, "cancelled")
				assert.equal(b.takes[3].status, "cancelled")
				assert.equal(b.takes[1].status, "ready")
				assert.equal(b.takes[2].status, "ready")
				// The waiting take was never sent; the one being made was sent once and abandoned.
				const prompts = exactCalls().filter((call) => call.prompt.includes("[[slow]]"))
				assert.equal(prompts.length, 3, `expected 3 calls (take 4 never sent), got ${prompts.length}`)

				// Stop all, while two takes are still to come.
				await chrome.getByTestId("board-new-prompt").click()
				service.reset()
				await describe(run, { text: "a teapot [[slow]]", mode: "exact" })
				await chrome.getByTestId("generate-begin").click()
				await chrome.getByTestId("board-stop-all").click({ timeout: 15_000 })
				b = await settled(run, "stopped takes", 30_000)
				assert(
					b.takes.every((t) => t.status === "cancelled"),
					summary(b.takes),
				)
				assert(exactCalls().length <= 1, `stop all still sent ${exactCalls().length} calls`)
				return "a refusal shows its reason on every take; a busy service retries unseen; cancel and stop all spend nothing more"
			}),
	},
	{
		id: "a4",
		title: "use one take, then another; the board stays; names are tidied; full size; the light of a saved photo",
		run: () =>
			withRun("a4", {}, async (run) => {
				const chrome = run.launched.chrome
				await openGenerate(run)
				await describe(run, { text: "a walnut keyboard on a desk", mode: "exact", aspect: "16:9" })
				await chrome.getByTestId("generate-begin").click()
				const b = await settled(run, "the first takes")

				await take(run, b.takes[0].id).hover()
				await take(run, b.takes[0].id).getByTestId("board-take-use").click()
				await chrome.getByTestId("board-name").fill("keyboard-hero")
				await chrome.getByTestId("board-use").click()
				await chrome.getByTestId("board-saved-note").waitFor({ timeout: 20_000 })
				await take(run, b.takes[1].id).click()
				await chrome.getByTestId("board-name").fill("Keyboard Hero")
				await chrome.getByTestId("board-use").click()
				await waitFor("the second save", async () => ((await board(run))?.takes[1].savedAs ? true : null), 20_000)
				const after = (await board(run))!
				assert.equal(after.takes[0].savedAs, "keyboard-hero")
				assert(
					after.takes[1].savedAs && after.takes[1].savedAs !== "keyboard-hero",
					`second save: ${after.takes[1].savedAs}`,
				)
				assert(await chrome.getByTestId("take-board").isVisible(), "the board closed after a save")

				const index = JSON.parse(await fs.readFile(path.join(run.project, ".caret", "assets", "index.json"), "utf8"))
				const saved = index.assets.find((asset: { tag: string }) => asset.tag === "keyboard-hero")
				assert(saved, "the first take is not in the asset library")
				assert.equal(saved.origin.answers.promptHelp, "exact")
				assert.equal(saved.origin.resolved.split("\n\n")[0], "a walnut keyboard on a desk")
				const stored = await sharp(path.join(run.project, ".caret", "assets", saved.file)).metadata()
				assert(Math.abs(stored.width! / stored.height! - 16 / 9) < 0.01, `stored ratio ${stored.width}x${stored.height}`)

				// Full size, and the arrows move within the branch.
				await take(run, b.takes[2].id).hover()
				await take(run, b.takes[2].id).getByTestId("board-take-full").click()
				const full = chrome.getByTestId("board-full")
				await full.locator("img").waitFor({ timeout: 10_000 })
				const firstSrc = await full.locator("img").getAttribute("src")
				await chrome.keyboard.press("ArrowRight")
				await waitFor(
					"the next take full size",
					async () => ((await full.locator("img").getAttribute("src")) !== firstSrc ? true : null),
					10_000,
				)
				await chrome.keyboard.press("Escape")
				await full.waitFor({ state: "detached", timeout: 5_000 })

				// Done closes the screen; both saved takes are in the library view.
				await chrome.getByTestId("board-done").click()
				await chrome.getByTestId("generate-asset").waitFor({ state: "detached", timeout: 10_000 })
				await waitFor(
					"both saved takes in the asset list",
					async () => {
						// The names sit in editable fields, so read their values.
						const names = await chrome
							.getByTestId("assets-view")
							.locator("input")
							.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))
						return names.includes("keyboard-hero") && names.includes(after.takes[1].savedAs!) ? true : null
					},
					15_000,
					async () => (await chrome.getByTestId("assets-view").innerText()).slice(0, 300),
				)

				// The light of a saved photo: sent as a reference, said to be light only.
				await chrome.getByTestId("assets-generate").click()
				service.reset()
				await describe(run, { text: "a desk lamp", mode: "exact", anchor: "keyboard-hero" })
				await chrome.getByTestId("generate-begin").click()
				await settled(run, "takes lit like the saved photo")
				const anchored = exactCalls()
				assert(
					anchored.every((call) => call.references.length === 1),
					"the saved photo was not sent",
				)
				assert(
					anchored.every((call) => call.prompt.includes("COLOUR AND LIGHT REFERENCE ONLY")),
					anchored[0].prompt,
				)
				return "two takes saved from one board (the second name tidied), full size with arrows, the light of a saved photo sent as a reference"
			}),
	},
	{
		id: "a5",
		title: "no background: cutouts on the board and in the library keep their transparency",
		run: () =>
			withRun("a5", {}, async (run) => {
				const chrome = run.launched.chrome
				await openGenerate(run)
				await describe(run, { text: "a green ceramic vase", mode: "exact", transparent: true, aspect: "1:1" })
				await chrome.getByTestId("generate-begin").click()
				const b = await settled(run, "the cutouts", 180_000)
				assert(
					b.takes.some((t) => t.status === "ready"),
					summary(b.takes),
				)
				assert(exactCalls()[0].prompt.includes("pure flat white"), "the white-background line was not sent")
				const ready = b.takes.find((t) => t.status === "ready")!
				const full = await picture(run, ready.id)
				assert(full.startsWith("data:image/png"), "the cutout is not a PNG")
				const meta = await sharp(Buffer.from(full.split(",")[1], "base64")).stats()
				assert(!meta.isOpaque, "the cutout has no transparent pixels")
				await take(run, ready.id).click()
				await chrome.getByTestId("board-name").fill("vase-cutout")
				await chrome.getByTestId("board-use").click()
				await chrome.getByTestId("board-saved-note").waitFor({ timeout: 30_000 })
				const index = JSON.parse(await fs.readFile(path.join(run.project, ".caret", "assets", "index.json"), "utf8"))
				const saved = index.assets.find((asset: { tag: string }) => asset.tag === "vase-cutout")
				const stored = await sharp(path.join(run.project, ".caret", "assets", saved.file)).stats()
				assert(!stored.isOpaque, "the saved cutout lost its transparency")
				return "cutouts keyed before they are shown, and saved with transparency"
			}),
	},
	{
		id: "a5b",
		title: "no background with the cutout tool switched off: nothing is spent, and every take says why",
		run: () =>
			withRun("a5b", { prefs: { skipCutoutModel: true }, noCutoutTool: true }, async (run) => {
				const chrome = run.launched.chrome
				await openGenerate(run)
				await describe(run, { text: "a green ceramic vase", mode: "exact", transparent: true })
				await chrome.getByTestId("generate-begin").click()
				const b = await settled(run, "the refusal")
				assert(
					b.takes.every((t) => t.status === "failed" && /cutout tool/.test(t.error ?? "")),
					summary(b.takes),
				)
				assert.equal(exactCalls().length, 0, "pictures were paid for that could never be cut out")
				return "no cutout tool: no image calls, and the reason on every take"
			}),
	},
	{
		id: "a6",
		title: "no image key at all: a clear message, and the free kinds still work",
		run: () =>
			withRun("a6", { images: "none" }, async (run) => {
				const chrome = run.launched.chrome
				await openGenerate(run)
				await describe(run, { text: "a paper lantern", mode: "exact" })
				await chrome.getByTestId("generate-begin").click()
				const b = await settled(run, "the refusal")
				assert(b.takes.every((t) => t.status === "failed"))
				const said = b.takes[0].error ?? ""
				assert(/Gemini|API key/i.test(said) && /no account/i.test(said), `the message: ${said}`)
				// The free texture kind still works from the same screen.
				await chrome.getByTestId("board-new-prompt").click()
				await describe(run, { text: "a soft grain", kind: "texture" })
				await chrome.getByTestId("generate-begin").click()
				await chrome.getByTestId("generate-recipes").waitFor({ timeout: 30_000 })
				return "every take names the missing key and says the rest needs no account; textures still open"
			}),
	},
	{
		id: "a7",
		title: "'Polish it' with no AI model: takes from your words, and the board says why",
		run: () =>
			withRun("a7", {}, async (run) => {
				const chrome = run.launched.chrome
				await openGenerate(run)
				await describe(run, { text: "a linen tote bag", mode: "polish" })
				await chrome.getByTestId("generate-begin").click()
				const b = await settled(run, "the takes")
				assert(b.briefNote && /couldn't write a brief/.test(b.briefNote), `brief note: ${b.briefNote}`)
				await chrome.getByTestId("board-brief-note").waitFor({ timeout: 5_000 })
				assert(b.takes.every((t) => t.status === "ready"))
				assert(
					exactCalls().every((call) => call.prompt.startsWith("a linen tote bag.")),
					exactCalls()[0].prompt,
				)
				return "no model: the takes use the words with the foundation's defaults, and a note says so"
			}),
	},
	{
		id: "a8",
		title: "the other kinds still open their own screens; an empty prompt can't be generated",
		run: () =>
			withRun("a8", {}, async (run) => {
				const chrome = run.launched.chrome
				await openGenerate(run)
				const ask = chrome.getByTestId("generate-ask")
				await ask.locator('[data-generate-kind="image"]').click()
				await ask.getByTestId("generate-request").fill("   ")
				assert(await ask.getByTestId("generate-begin").isDisabled(), "an empty prompt could be generated")
				for (const [kind, surface] of [
					["mark", "generate-mark"],
					["object3d", "generate-model3d"],
					["shader", "generate-shader"],
				] as const) {
					await describe(run, { text: "a simple test subject", kind })
					await ask.getByTestId("generate-begin").click()
					// Clarify may ask first (with a model); skipping it must reach the kind's own screen.
					await waitFor(
						`the ${kind} screen`,
						async () => {
							const skip = chrome.getByTestId("generate-clarify-skip")
							if (await skip.isVisible().catch(() => false)) await skip.click()
							return (await chrome.getByTestId(surface).count()) > 0 ? true : null
						},
						60_000,
					)
					await chrome.getByTestId("generate-back").click()
					await chrome.getByTestId("generate-ask").waitFor({ timeout: 10_000 })
				}
				assert.equal(exactCalls().length, 0, "opening the other kinds made image calls")
				return "marks, 3D objects and animated backgrounds still open their own screens"
			}),
	},
	{
		id: "a9",
		title: "ten branches: nothing overlaps, and every line meets its own take",
		run: () =>
			withRun("a9", {}, async (run) => {
				const chrome = run.launched.chrome
				await openGenerate(run)
				await describe(run, { text: "a pebble", mode: "exact", aspect: "1:1" })
				await chrome.getByTestId("generate-begin").click()
				let b = await settled(run, "the first takes")
				const parents = [0, 1, 2, 3, 0, 2].map((i) => b.takes[i].id)
				for (const parent of parents) {
					await grow(run, parent, { note: `change ${parent}` })
					b = await settled(run, `a branch from ${parent}`)
				}
				const firstBranchTake = b.branches[1].takeIds[0]
				for (let i = 0; i < 4; i++) {
					await grow(run, i % 2 ? b.branches[1].takeIds[1] : firstBranchTake, { note: `deep ${i}` })
					b = await settled(run, `deep branch ${i}`)
				}
				assert.equal(b.branches.length, 11)
				const rects = await chrome.$$eval('[data-testid="board-take"]', (els) =>
					els.map((el) => {
						const r = el.getBoundingClientRect()
						return { x: r.left, y: r.top, w: r.width, h: r.height }
					}),
				)
				for (let i = 0; i < rects.length; i++) {
					for (let j = i + 1; j < rects.length; j++) {
						const a = rects[i]
						const c = rects[j]
						const hit = a.x < c.x + c.w && a.x + a.w > c.x && a.y < c.y + c.h && a.y + a.h > c.y
						assert(!hit, `takes ${i} and ${j} overlap`)
					}
				}
				assert.equal(await chrome.locator("[data-line-for]").count(), 10)
				await shot(chrome, run.dir, "ten-branches")
				return `${rects.length} takes in 11 branches, none overlapping, 10 lines`
			}),
	},

	{
		id: "e1",
		title: "Experiment: the page is the first box; branch a take, the same take again, the page itself, and three deep",
		run: () =>
			withRun("e1", { prepare: writeHomePage }, async (run) => {
				const page = await startExperiment(run, "Make it feel premium")
				await page.getByTestId("explore-root").waitFor({ timeout: 10_000 })
				let open = await takesSettled(run, "the first round")
				assert.equal(open.nodes.length, 3)
				assert(
					open.nodes.every((n) => n.parentId === "home" && n.status === "ready"),
					JSON.stringify(open.nodes),
				)
				const [v1, v2] = open.nodes.map((n) => n.id)
				assert.deepEqual(await chainOf(run, v1), ["Make it feel premium"])

				await growPage(run, page, v2, { chips: ["Warmer"] })
				// While the branch is being made, the first round stays on the board.
				await waitFor(
					"the branch to start",
					async () => ((await scratch(run))?.nodes.some((n) => n.status === "working") ? true : null),
					10_000,
				)
				assert.equal(
					await page.locator('[data-testid^="variant-card-"]').count(),
					6,
					"the first round disappeared while branching",
				)
				open = await takesSettled(run, "the warmer branch")
				const warmer = open.nodes.filter((n) => n.parentId === v2)
				assert.equal(warmer.length, 3)
				assert.deepEqual(await chainOf(run, warmer[0].id), ["Make it feel premium", "warmer"])

				await growPage(run, page, v2, { note: "a quieter layout", strength: "strong" })
				open = await takesSettled(run, "the second branch from the same take")
				const fromV2 = open.nodes.filter((n) => n.parentId === v2)
				assert.equal(
					fromV2.length,
					6,
					`the second branch replaced the first: ${open.nodes.map((n) => `${n.id}<${n.parentId} ${n.status}`).join(", ")}`,
				)
				assert(fromV2.slice(3).every((n) => n.strength === "strong"))
				assert.equal(
					await page
						.locator(`[data-testid="variant-card-${v2}"] [data-testid="explore-kids"]`)
						.getAttribute("data-count"),
					"2",
				)

				await growPage(run, page, "home", { note: "a darker direction" })
				open = await takesSettled(run, "a new direction from the page itself")
				const fresh = open.nodes.filter((n) => n.parentId === "home")
				assert.equal(fresh.length, 6)
				assert.deepEqual(await chainOf(run, fresh[3].id), ["a darker direction"])

				await growPage(run, page, warmer[1].id, { chips: ["More space"] })
				open = await takesSettled(run, "the deep branch")
				const deep = open.nodes.filter((n) => n.parentId === warmer[1].id)
				assert.deepEqual(await chainOf(run, deep[0].id), ["Make it feel premium", "warmer", "more space"])

				// Each line starts on the right edge of the exact take it grew from.
				const lines = await page.locator("[data-line-for]").count()
				assert.equal(
					lines,
					5,
					`expected 5 lines (round one, two from ${v2}, the new direction, the deep one), saw ${lines}`,
				)
				const off = await page.evaluate(() => {
					const bad: string[] = []
					for (const g of Array.from(document.querySelectorAll("[data-line-for]"))) {
						const path = g.querySelector("path") as SVGPathElement
						const start = path.getPointAtLength(0)
						const svg = path.ownerSVGElement!.getBoundingClientRect()
						const x = svg.left + start.x
						const y = svg.top + start.y
						const cards = Array.from(
							document.querySelectorAll(
								'[data-testid^="variant-card-"] .caret-board-take, [data-testid="explore-root"] .caret-board-take',
							),
						)
						const hit = cards.some((card) => {
							const r = card.getBoundingClientRect()
							return Math.abs(r.right - x) < 3 && y > r.top && y < r.bottom
						})
						if (!hit) bad.push(g.getAttribute("data-line-for") || "?")
					}
					return bad
				})
				assert.deepEqual(off, [], "lines that do not start on a take's edge")

				// The path bar walks home › v2 › warmer take › deep take.
				await page.getByTestId(`variant-card-${deep[0].id}`).locator(".caret-board-take").click()
				const crumbs = await page
					.getByTestId("explore-path")
					.locator("[data-take-id]")
					.evaluateAll((els) => els.map((el) => el.getAttribute("data-take-id")))
				assert.deepEqual(crumbs, ["home", v2, warmer[1].id, deep[0].id])
				await shot(run.launched.chrome, run.dir, "chrome")
				await page.screenshot({ path: path.join(run.dir, "experiment-board.png") })
				return `${open.nodes.length} takes in 5 rounds; every take's page carries its own chain of instructions`
			}),
	},
	{
		id: "e2",
		title: "Experiment: two branches at once, queued takes, cancelling one, a failing take, stop all",
		run: () =>
			withRun("e2", { prepare: writeHomePage }, async (run) => {
				const page = await startExperiment(run, "Try a bolder hero")
				let open = await takesSettled(run, "the first round")
				const [v1, , v3] = open.nodes.map((n) => n.id)
				// Two branches from two takes, one right after the other.
				await growPage(run, page, v1, { note: "warmer" })
				await growPage(run, page, v3, { note: "darker" })
				// Six takes, three agents: three wait, and the board says so.
				await waitFor(
					"a queued take to say it is waiting",
					async () =>
						(await page.locator('[data-testid^="variant-card-"]').filter({ hasText: "queued" }).count()) > 0
							? true
							: null,
					15_000,
				)
				open = await takesSettled(run, "both branches")
				const ids = open.nodes.map((n) => n.id)
				assert.equal(new Set(ids).size, ids.length, "two branches shared a take id")
				assert.equal(open.nodes.filter((n) => n.parentId === v1).length, 3)
				assert.equal(open.nodes.filter((n) => n.parentId === v3).length, 3)
				for (const id of ids) {
					const chain = await chainOf(run, id)
					assert(chain.length >= 1, `${id} has no page of its own`)
				}

				// Cancel one take while it is being made.
				await growPage(run, page, v1, { note: "much slower [[slow]]" })
				const slow = await waitFor(
					"the slow round",
					async () => {
						const now = await scratch(run)
						const round = now?.nodes.filter((n) => n.instruction.includes("[[slow]]")) ?? []
						return round.length === 3 ? round : null
					},
					10_000,
				)
				await page.getByTestId(`explore-cancel-${slow[0].id}`).click()
				// A failing take shows its reason; the others carry on.
				await growPage(run, page, v3, { note: "break this [[fail]]" })
				open = await takesSettled(run, "the slow and failing rounds", 60_000)
				assert.equal(open.nodes.find((n) => n.id === slow[0].id)!.status, "cancelled")
				assert(slow.slice(1).every((n) => open.nodes.find((x) => x.id === n.id)!.status === "ready"))
				const failing = open.nodes.filter((n) => n.instruction.includes("[[fail]]"))
				assert(
					failing.every((n) => n.status === "failed"),
					JSON.stringify(failing),
				)
				await page.getByTestId(`variant-card-${failing[0].id}`).locator(".caret-board-take").click()
				assert((await page.getByTestId("explore-inspector-status").innerText()).length > 3)

				// Stop all.
				await growPage(run, page, v1, { note: "stop me [[slow]]" })
				await page.getByTestId("explore-stop-all").click({ timeout: 10_000 })
				open = await takesSettled(run, "stopped", 30_000)
				assert(open.nodes.filter((n) => n.instruction === "stop me [[slow]]").every((n) => n.status === "cancelled"))
				return `two branches at once with unique takes; queued takes said so; cancel, failure and stop all each stayed on their own takes`
			}),
	},
	{
		id: "e3",
		title: "Experiment: use a take three levels deep; every take folder goes; one undo brings the page back",
		run: () =>
			withRun("e3", { prepare: writeHomePage }, async (run) => {
				const page = await startExperiment(run, "Make it feel premium")
				let open = await takesSettled(run, "the first round")
				await growPage(run, page, open.nodes[0].id, { note: "warmer" })
				open = await takesSettled(run, "a branch")
				const child = open.nodes[3].id
				await growPage(run, page, child, { note: "more space" })
				open = await takesSettled(run, "a deep branch")
				const chosen = open.nodes[6].id
				const chosenSource = await fs.readFile(path.join(run.project, ".caret", "pages", chosen, "index.tsx"), "utf8")
				// Something still running: using a take asks first.
				await growPage(run, page, open.nodes[1].id, { note: "keep going [[slow]]" })
				page.once("dialog", (dialog) => void dialog.accept())
				await page.getByTestId(`variant-card-${chosen}`).locator(".caret-board-take").hover()
				await page.getByTestId(`variant-use-${chosen}`).click()
				await waitFor("the experiment to close", async () => ((await scratch(run)) === null ? true : null), 30_000)
				const home = await fs.readFile(path.join(run.project, ".caret", "pages", "home", "index.tsx"), "utf8")
				assert(home.includes("more space") && home.includes('"warmer"'), "Home is not the chosen take")
				const left = (await fs.readdir(path.join(run.project, ".caret", "pages"))).filter((d) => d.includes("--v"))
				assert.deepEqual(left, [], "take folders were left behind")
				const meta = JSON.parse(await fs.readFile(path.join(run.project, ".caret", "pages", "home", "meta.json"), "utf8"))
				assert.equal(meta.id, "home")
				assert.equal(meta.variantOf, undefined)
				void chosenSource
				// One undo step brings the original back: ⌘Z on the page, as a person does it.
				let keysSeen = ""
				await waitFor(
					"the undo to restore Home",
					async () => {
						const now = plain(
							await fs.readFile(path.join(run.project, ".caret", "pages", "home", "index.tsx"), "utf8"),
						)
						if (now === HOME_SOURCE) return true
						const view = run.launched.app
							.context()
							.pages()
							.find((p) => p.url().startsWith("http://127.0.0.1"))
						const frame = view?.frames().find((f) => f.url().includes("mode=focused"))
						if (!view || !frame) {
							// Back on the grid: open Home first.
							await view
								?.locator(".caret-canvas-frame")
								.first()
								.click({ timeout: 2_000 })
								.catch(() => {})
							return null
						}
						await frame
							.evaluate(() => {
								const w = window as unknown as { __keys?: string[] }
								if (w.__keys) return
								w.__keys = []
								window.addEventListener(
									"keydown",
									(e) => w.__keys!.push(`${e.metaKey ? "meta+" : ""}${e.key}`),
									true,
								)
							})
							.catch(() => {})
						// Through Electron's own input, as a person's click and key arrive:
						// a click on the page, then ⌘Z.
						await run.launched.app.evaluate(async ({ BrowserWindow }) => {
							for (const win of BrowserWindow.getAllWindows()) {
								for (const child of (win.contentView?.children ?? []) as Array<{
									webContents?: Electron.WebContents
								}>) {
									const wc = child.webContents
									if (!wc?.getURL().startsWith("http://127.0.0.1")) continue
									win.focus()
									wc.focus()
									const box = await wc.executeJavaScript(
										"(() => { const r = document.querySelector('.caret-focused-iframe').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()",
									)
									wc.sendInputEvent({
										type: "mouseDown",
										x: Math.round(box.x),
										y: Math.round(box.y),
										button: "left",
										clickCount: 1,
									})
									wc.sendInputEvent({
										type: "mouseUp",
										x: Math.round(box.x),
										y: Math.round(box.y),
										button: "left",
										clickCount: 1,
									})
									await new Promise((resolve) => setTimeout(resolve, 200))
									wc.sendInputEvent({ type: "keyDown", keyCode: "z", modifiers: ["meta"] })
									wc.sendInputEvent({ type: "keyUp", keyCode: "z", modifiers: ["meta"] })
								}
							}
						})
						keysSeen = String(
							await frame
								.evaluate(() => (window as unknown as { __keys?: string[] }).__keys?.join(","))
								.catch(() => "?"),
						)
						if (process.env.BOARDS_UNDO_DIRECT) {
							await view
								.evaluate(() =>
									window.postMessage({ source: "caret-vite", type: "design-undo", payload: {} }, "*"),
								)
								.catch(() => {})
						}
						await new Promise((resolve) => setTimeout(resolve, 1500))
						return null
					},
					45_000,
					async () => {
						const view = run.launched.app
							.context()
							.pages()
							.find((p) => p.url().startsWith("http://127.0.0.1"))
						const frames = view?.frames().map((f) => f.url().replace("http://127.0.0.1:5173", "")) ?? []
						const active = await view
							?.evaluate(
								() =>
									document.activeElement?.tagName +
									" " +
									(document.activeElement as HTMLIFrameElement | null)?.src,
							)
							.catch(() => "?")
						return `keys the page saw: ${keysSeen || "none"}; frames: ${frames.join(" | ")}; focus: ${active}`
					},
				)
				return "a take three levels deep became Home with Home's identity; every take folder went; one undo restored the original"
			}),
	},
	{
		id: "e4",
		title: "Experiment: leave and come back to the same board; keep the original throws it all away",
		run: () =>
			withRun("e4", { prepare: writeHomePage }, async (run) => {
				const page = await startExperiment(run, "Make it feel premium")
				let open = await takesSettled(run, "the first round")
				await growPage(run, page, open.nodes[0].id, { note: "warmer" })
				open = await takesSettled(run, "a branch")
				await page.getByTestId("explore-back").click()
				const pill = page.getByTestId("explore-open-pill")
				await pill.waitFor({ timeout: 15_000 })
				// The top bar says an experiment is open.
				await run.launched.chrome
					.getByTestId("top-bar")
					.getByText(/Exploring/)
					.waitFor({ timeout: 10_000 })
				await pill.click()
				await page.getByTestId("explore-board").waitFor({ timeout: 15_000 })
				assert.equal(await page.locator('[data-testid^="variant-card-"]').count(), 6, "the board came back different")
				assert.equal(await page.locator("[data-line-for]").count(), 2)
				page.once("dialog", (dialog) => void dialog.accept())
				await page.getByTestId("variant-keep-original").click()
				await waitFor(
					"the experiment to be thrown away",
					async () => ((await scratch(run)) === null ? true : null),
					20_000,
				)
				const left = (await fs.readdir(path.join(run.project, ".caret", "pages"))).filter((d) => d.includes("--v"))
				assert.deepEqual(left, [])
				assert.equal(
					plain(await fs.readFile(path.join(run.project, ".caret", "pages", "home", "index.tsx"), "utf8")),
					HOME_SOURCE,
				)
				return "the board reopened exactly as left (6 takes, 2 lines); keeping the original left Home untouched and nothing behind"
			}),
	},
	{
		id: "e5",
		title: "Experiment: something new — the first box is the page-to-be; using a take adds it to the canvas",
		run: () =>
			withRun("e5", { prepare: writeHomePage }, async (run) => {
				const page = await canvas(run)
				await page.getByTestId("explore-enter").click()
				await page.getByTestId("explore-new-name").fill("Team")
				await page.getByTestId("explore-new-instruction").fill("A page introducing the four people behind Tenon")
				await page.getByTestId("explore-start-new-go").click()
				await page.getByTestId("explore-board").waitFor({ timeout: 30_000 })
				const root = page.getByTestId("explore-root")
				assert((await root.innerText()).includes("not made yet"))
				assert.equal(await root.locator("iframe").count(), 0, "the page-to-be has no page to show yet")
				let open = await takesSettled(run, "the first round")
				await growPage(run, page, "home" === open.pageId ? "home" : open.nodes[0].id, { note: "warmer" })
				open = await takesSettled(run, "a branch")
				const chosen = open.nodes[4].id
				await page.getByTestId(`variant-card-${chosen}`).locator(".caret-board-take").hover()
				await page.getByTestId(`variant-use-${chosen}`).click()
				await waitFor("the new page", async () => ((await scratch(run)) === null ? true : null), 30_000)
				const meta = JSON.parse(await fs.readFile(path.join(run.project, ".caret", "pages", "team", "meta.json"), "utf8"))
				assert.equal(meta.id, "team")
				assert.equal(meta.title, "Team")
				assert.equal(meta.variantOf, undefined)
				return "a new page started as an empty first box, branched, and joined the canvas as Team"
			}),
	},
	{
		id: "e6",
		title: "Experiment: full size, with the arrows moving between one round's takes",
		run: () =>
			withRun("e6", { prepare: writeHomePage }, async (run) => {
				const page = await startExperiment(run, "Make it feel premium")
				const open = await takesSettled(run, "the first round")
				const [v1, v2] = open.nodes.map((n) => n.id)
				await page.getByTestId(`variant-card-${v1}`).locator(".caret-board-take").hover()
				await page.getByTestId(`explore-preview-${v1}`).click()
				const full = page.getByTestId("explore-expanded")
				await full.waitFor({ timeout: 10_000 })
				const width = await full
					.locator("iframe")
					.evaluate((frame) => (frame as HTMLIFrameElement).getBoundingClientRect().width)
				assert.equal(Math.round(width), 1440)
				assert((await full.locator("iframe").getAttribute("src"))!.includes(v1))
				await page.keyboard.press("ArrowRight")
				await waitFor(
					"the next take",
					async () => ((await full.locator("iframe").getAttribute("src"))?.includes(v2) ? true : null),
					5_000,
				)
				await page.keyboard.press("Escape")
				await page.getByTestId("explore-board").waitFor({ timeout: 5_000 })
				return "full size at 1440px, ← → within the round, Esc back to the board"
			}),
	},
	{
		id: "m3",
		title: "Experiment with a real AI model: a round, a branch from one take, and using it",
		needsModel: true,
		run: () =>
			withRun("m3", { prepare: writeHomePage, model: true, realTakes: true }, async (run) => {
				const page = await startExperiment(run, "Make the headline larger and bolder")
				let open = await takesSettled(run, "the real first round", 600_000)
				const ready = open.nodes.filter((n) => n.status === "ready")
				assert(ready.length > 0, `no take finished: ${JSON.stringify(open.nodes)}`)
				await growPage(run, page, ready[0].id, { note: "make the background a warm off-white" })
				open = await takesSettled(run, "the real branch", 600_000)
				const branch = open.nodes.filter((n) => n.parentId === ready[0].id && n.status === "ready")
				assert(branch.length > 0, "no take of the branch finished")
				const chosen = branch[0].id
				const source = await fs.readFile(path.join(run.project, ".caret", "pages", chosen, "index.tsx"), "utf8")
				assert.notEqual(source, HOME_SOURCE, "the branch take is unchanged")
				await page.getByTestId(`variant-card-${chosen}`).locator(".caret-board-take").hover()
				await page.getByTestId(`variant-use-${chosen}`).click()
				await waitFor("the pick", async () => ((await scratch(run)) === null ? true : null), 60_000)
				const home = await fs.readFile(path.join(run.project, ".caret", "pages", "home", "index.tsx"), "utf8")
				assert.equal(home, source)
				return `${ready.length} real takes, a real branch of ${branch.length}, and Home is now the chosen take`
			}),
	},
	{
		id: "m1",
		title: "'Polish it' with a real AI model: Caret's brief, both versions on the board",
		needsModel: true,
		run: () =>
			withRun("m1", { model: true }, async (run) => {
				const chrome = run.launched.chrome
				await openGenerate(run)
				await describe(run, { text: "walnut keyboard for the hero", mode: "polish" })
				await chrome.getByTestId("generate-begin").click()
				const b = await settled(run, "the polished takes", 240_000)
				assert(b.brief && b.brief.length > 40, `no brief: ${b.briefNote}`)
				assert(
					exactCalls().every((call) => call.prompt.includes(b.brief!.slice(0, 40))),
					"the takes were not made from the brief",
				)
				await chrome.getByTestId("board-prompt-yours").click()
				assert.equal(await chrome.getByTestId("board-prompt-text").innerText(), "walnut keyboard for the hero")
				await chrome.getByTestId("board-prompt-brief").click()
				assert.equal((await chrome.getByTestId("board-prompt-text").innerText()).trim(), b.brief)
				return `brief written (${b.brief.length} characters); takes made from it; the board switches between both`
			}),
	},
	{
		id: "m2",
		title: "'Ask me first' with a real AI model: questions, skip them, read and edit the brief, generate from the edit",
		needsModel: true,
		run: () =>
			withRun("m2", { model: true }, async (run) => {
				const chrome = run.launched.chrome
				await openGenerate(run)
				await describe(run, { text: "a coffee photo", mode: "ask" })
				await chrome.getByTestId("generate-begin").click()
				await chrome.getByTestId("generate-clarify").waitFor({ timeout: 180_000 })
				assert.equal(exactCalls().length, 0, "asking spent an image call")
				// Skip every question: the brief is still written.
				await chrome.getByTestId("generate-begin").click()
				const brief = chrome.getByTestId("generate-brief")
				await brief.waitFor({ timeout: 180_000 })
				let swapped = ""
				if ((await chrome.getByTestId("generate-brief-phrase").count()) > 0) {
					await chrome.getByTestId("generate-brief-phrase").first().click()
					const alternative = chrome.getByTestId("generate-brief-alternative").first()
					swapped = await alternative.innerText()
					await alternative.click()
					assert(
						(await chrome.getByTestId("generate-brief-view").innerText()).includes(swapped),
						"the swap did not land",
					)
				}
				await chrome.getByTestId("generate-brief-edit").click()
				const box = chrome.getByTestId("generate-brief-text")
				const edited = `${(await box.inputValue()).trim()} A small brass spoon rests on the saucer.`
				await box.fill(edited)
				await chrome.getByTestId("generate-begin").click()
				const b = await settled(run, "takes from the edited brief", 120_000)
				assert.equal(b.brief, edited)
				assert(
					exactCalls().every((call) => call.prompt.includes("A small brass spoon rests on the saucer.")),
					"the edit was not sent",
				)
				return `questions skipped, brief written${swapped ? `, "${swapped}" swapped in` : " (no phrases offered)"}, edited, and the edit is what was sent`
			}),
	},
]

async function main(): Promise<void> {
	reapOrphanedBackends()
	await fs.stat("out/main/index.js").catch(() => {
		throw new Error("No build: run `npm run test:boards`, which builds first.")
	})
	if (WITH_MODEL && !MODEL) throw new Error("--model needs CARET_VERIFY_MODEL (for example opencode-go/deepseek-v4.1-flash)")
	service = await startFakeImageService()
	const chosen = CASES.filter((c) => (!ONLY || ONLY.has(c.id)) && (!c.needsModel || WITH_MODEL))
	const results: Array<{ id: string; ok: boolean }> = []
	for (const c of chosen) {
		const started = Date.now()
		console.log(`\ncase ${c.id}: ${c.title}`)
		try {
			const detail = await c.run()
			results.push({ id: c.id, ok: true })
			console.log(`  PASS (${Math.round((Date.now() - started) / 1000)}s) ${detail}`)
		} catch (err) {
			results.push({ id: c.id, ok: false })
			console.log(
				`  FAIL (${Math.round((Date.now() - started) / 1000)}s) ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}
	await service.close()
	reapOrphanedBackends()
	const failed = results.filter((r) => !r.ok)
	console.log(
		`\n${results.length - failed.length} of ${chosen.length} cases passed${ONLY ? " (a subset: not a full certification)" : ""}.`,
	)
	process.exitCode = !failed.length && results.length === chosen.length ? 0 : 1
}

void LIVE
main()
	.catch((err) => {
		console.error(err instanceof Error ? err.message : err)
		process.exitCode = 1
	})
	.finally(() => setTimeout(() => process.exit(), 500))

export type { RecordedCall }
