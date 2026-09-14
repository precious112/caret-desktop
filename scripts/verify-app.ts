/**
 * App-level certification: launches the real Electron binary and drives it.
 *
 * `verify:design-shell` proves the generated canvas works. This proves the
 * *application* works — that a project opens, Vite boots, the canvas mounts as a
 * native view, the MCP server answers with auth enforced, rules files get
 * written, and an edit from the canvas reaches disk.
 *
 * The decisive assertions are on disk and over HTTP, not on pixels. "The user
 * changed a colour" only matters if the file now contains exactly that.
 *
 * Usage:
 *   npm run verify:app             # full run
 *   npm run verify:app -- --keep   # keep the fixture project for inspection
 */
import * as child_process from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { type ElectronApplication, _electron as electron, type Page } from "playwright"

import { ensureCaretDirectoryExists } from "../src/core/design/scaffold"
import { NO_MODEL_REASON, resolveVerifyModel, solidPng } from "./verify-support"

const KEEP = process.argv.includes("--keep")

/**
 * `--paid` (or CARET_VERIFY_PAID=1) runs the scenarios that spend real money —
 * the Gemini photograph and cutout, the Tripo 3D build, the Claude mark loop.
 *
 * Off by default, deliberately: those lanes were certified live when they
 * landed, and re-buying that certainty on every routine run after an unrelated
 * phase is money spent to learn nothing. Off is not the same as passed — the
 * report says exactly what was excluded, and a full certification of the paid
 * surface is one flag away. Turn it on when a paid lane's own code changed.
 */
const PAID = process.argv.includes("--paid") || process.env.CARET_VERIFY_PAID === "1"

/**
 * `--only ee,gg` runs just those scenarios, by the letter before the dot.
 *
 * Not a way to certify anything — a partial run is reported as such and can
 * never say CERTIFIED. It exists because iterating on one scenario otherwise
 * costs a full suite, and a suite that is expensive to fix is a suite that
 * stays broken. Setup, launch and teardown still run in full, so a scenario
 * that depends on an earlier one must be named alongside it.
 */
const ONLY = (() => {
	const index = process.argv.indexOf("--only")
	if (index === -1) return null
	return new Set(
		(process.argv[index + 1] ?? "")
			.split(",")
			.map((name) => name.trim())
			.filter(Boolean),
	)
})()
const SHOTS = path.resolve("release/verify-shots")

interface ScenarioResult {
	name: string
	passed: boolean
	/** Neither passed nor failed: there was no model this suite may spend. */
	skipped?: boolean
	/** Skipped because paid lanes are off by default, not for missing credentials. */
	paidOff?: boolean
	detail: string
}

const results: ScenarioResult[] = []
let app: ElectronApplication | null = null
let fixture = ""
let userData = ""

function log(message: string): void {
	console.log(`[verify-app] ${message}`)
}

/**
 * Records a scenario as neither passed nor failed.
 *
 * Used only when there is no model the suite is allowed to spend. A Caret with
 * no credentials is a supported state, so failing here would report "broken"
 * for behaviour that is exactly as designed — but calling it a pass would claim
 * a certification that never ran.
 */
function skip(name: string, reason: string): void {
	results.push({ name, passed: true, skipped: true, detail: `SKIPPED — ${reason}` })
	log(`SKIP ${name} — ${reason}`)
}

/**
 * Records a paid scenario as deliberately not run.
 *
 * Distinct from `skip` because the two absences mean different things: a
 * credential skip says "this machine cannot", this says "this run chose not to
 * spend". The lane was certified live when it landed; `--paid` re-certifies it.
 */
function skipPaid(name: string): void {
	if (ONLY && !ONLY.has(name.split(".")[0])) return
	results.push({
		name,
		passed: true,
		skipped: true,
		paidOff: true,
		detail: "PAID LANE, off by default — certified live when it landed; pass --paid to re-certify",
	})
	log(`SKIP ${name} — paid lane, off by default (--paid to run)`)
}

/**
 * Thrown by a scenario that cannot reach a verdict for a reason that is not
 * Caret's fault — in practice, a model that did not do the work it was asked to.
 *
 * The distinction is the whole point. "This model could not manage it" and
 * "Caret is broken" are different claims, and a suite that reports the first as
 * the second is a suite whose red gets ignored.
 */
class Inconclusive extends Error {}

/**
 * When the app process went away, if it did.
 *
 * Playwright reports a dead app as "Target page, context or browser has been
 * closed" on whatever call happened to be next — so the scenario that *reports*
 * the failure is rarely the one that caused it, and every scenario after it
 * fails the same opaque way. Recording the moment of death turns that into a
 * pointer at the right place in `main.log`.
 */
let appDiedAt: string | null = null

async function scenario(name: string, run: () => Promise<string>): Promise<void> {
	if (ONLY && !ONLY.has(name.split(".")[0])) return
	try {
		const detail = await run()
		results.push({ name, passed: true, detail })
		log(`PASS ${name}`)
	} catch (err) {
		if (err instanceof Inconclusive) {
			skip(name, err.message)
			return
		}
		let detail = err instanceof Error ? err.message : String(err)
		if (appDiedAt && /has been closed/.test(detail)) {
			detail = `the app exited at ${appDiedAt} — this scenario only found the corpse. See release/verify-shots/main.log around that time.`
		}
		results.push({ name, passed: false, detail })
		log(`FAIL ${name} — ${detail}`)
	}
}

/**
 * Captures a surface so the run produces something a human can look at.
 *
 * Automated assertions cover behaviour; they say nothing about whether a screen
 * is legible or laid out sanely. These are for the eyes.
 */
async function shot(page: Page, name: string): Promise<void> {
	await fs.mkdir(SHOTS, { recursive: true })
	await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

/**
 * Opens the chat sidebar if it is not already open — never a blind toggle.
 *
 * The Chat button toggles. cc clicked it assuming "closed" and was right for
 * months — until the chat-docked consent change made ca leave the sidebar
 * OPEN, and fifteen scenarios later cc's click closed it and starved waiting
 * for content. A scenario must establish the state it needs, not inherit it.
 */
async function ensureChatOpen(page: Page): Promise<void> {
	if ((await page.locator('[data-testid="chat-transcript"]').count()) > 0) return
	await page.getByTestId("top-bar").getByRole("button", { name: "Chat" }).click()
	await page.waitForSelector('[data-testid="chat-transcript"]', { timeout: 10_000 })
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message)
}

/**
 * Polls until `check` returns a truthy value, or the deadline passes.
 *
 * `diagnose` runs only on timeout, to say what the world looked like when it
 * gave up. Worth having on anything slow: "timed out" alone costs a re-run to
 * turn into a cause.
 */
/**
 * Lands the chrome on the design-system view, whatever surface it is on now.
 *
 * The top-bar Foundation button is a TOGGLE, so blind clicks are how two
 * scenarios in a row end up racing each other's surface: the token editor's
 * save flips to canvas on a 1200ms timer, and a click fired while that timer
 * is in flight toggles the surface away a moment before it settles. Settle
 * first, look at what is actually on screen, then click only what is needed.
 */
async function openDesignSystem(chrome: import("playwright").Page): Promise<void> {
	// Let any in-flight surface transition (the editor's save timer, a commit's
	// onDone) finish before reading the surface.
	await chrome.waitForTimeout(1_500)
	if (await chrome.getByTestId("design-system-view").count()) return
	const onFoundation = await chrome.evaluate(() =>
		Boolean(
			document.querySelector(
				'[data-testid="token-editor"], [data-testid="foundation-describe"], [data-testid="wizard"], [data-testid="wizard-needs-backend"]',
			),
		),
	)
	// A non-overview foundation mode only resets by leaving and re-entering —
	// a fresh mount on a committed project opens on the DS view.
	if (onFoundation) await chrome.click('[data-testid="top-bar"] >> text=Foundation')
	await chrome.click('[data-testid="top-bar"] >> text=Foundation')
	await chrome.waitForSelector('[data-testid="design-system-view"]', { timeout: 20_000 })
}

async function waitFor<T>(
	label: string,
	check: () => Promise<T | null>,
	timeoutMs = 120_000,
	diagnose?: () => Promise<string>,
): Promise<T> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const value = await check()
		if (value) return value
		await new Promise((resolve) => setTimeout(resolve, 500))
	}
	const detail = diagnose ? await diagnose().catch((err) => `(diagnosis failed: ${err})`) : ""
	throw new Error(`Timed out waiting for ${label}${detail ? ` — ${detail}` : ""}`)
}

const PAGE_SOURCE = `export default function Home() {
  return (
    <div className="min-h-screen bg-zinc-950 p-12">
      <h1 data-caret-id="hero-title" className="text-5xl font-bold text-white">Welcome</h1>
      <p data-caret-id="hero-subtitle" className="mt-4 text-lg text-zinc-400">Built with Caret</p>
    </div>
  )
}
`

/**
 * The fixture's "app" — the thing a sync translates *into*.
 *
 * Deliberately a near-copy of the design page, so the one assertion that matters
 * (did the app follow the design) does not depend on a small free model being
 * good at architecture.
 */
const APP_SOURCE = `export default function App() {
  return (
    <div className="min-h-screen bg-zinc-950 p-12">
      <h1 className="text-5xl font-bold text-white">Welcome</h1>
      <p className="mt-4 text-lg text-zinc-400">Built with Caret</p>
    </div>
  )
}
`

/**
 * A page with no caret-ids and an inline style — both things the watch-and-heal
 * codemod is supposed to fix without anyone asking it to.
 */
const UNHEALED_SOURCE = `export default function About() {
  return (
    <div className="min-h-screen bg-zinc-900 p-12">
      <h1 style={{ color: "red" }} className="text-4xl font-bold">About us</h1>
      <p className="mt-4 text-zinc-400">We make things.</p>
    </div>
  )
}
`

async function buildFixture(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "caret-app-"))
	await ensureCaretDirectoryExists(dir)

	await fs.mkdir(path.join(dir, "src"), { recursive: true })
	await fs.writeFile(path.join(dir, "src", "App.tsx"), APP_SOURCE)

	const pageDir = path.join(dir, ".caret", "pages", "home")
	await fs.mkdir(pageDir, { recursive: true })
	await fs.writeFile(path.join(pageDir, "index.tsx"), PAGE_SOURCE)
	await fs.writeFile(
		path.join(pageDir, "meta.json"),
		JSON.stringify({ id: "home", title: "Home", type: "page", states: ["default"], tags: ["landing"] }, null, 2),
	)

	// A git repo with a commit, so the sync preflight has something to bookmark.
	const git = (args: string) => child_process.execSync(`git ${args}`, { cwd: dir, stdio: "ignore" })
	git("init -q")
	git("config user.email caret@local")
	git("config user.name Caret")
	git("config commit.gpgSign false")
	git("add -A")
	git('commit -q -m "fixture" --no-verify')

	return dir
}

/** Every file under `directory`, concatenated — a whole-tree fingerprint. */
async function readTree(directory: string): Promise<string> {
	const entries = await fs.readdir(directory, { withFileTypes: true, recursive: true })
	const files = entries.filter((entry) => entry.isFile()).sort((a, b) => (a.name < b.name ? -1 : 1))
	const parts = await Promise.all(
		files.map(async (entry) => {
			const full = path.join(entry.parentPath ?? directory, entry.name)
			return `${full}\n${await fs.readFile(full, "utf-8").catch(() => "")}`
		}),
	)
	return parts.join("\n")
}

/** Reads the per-project MCP discovery file the app writes on open. */
async function readDiscovery(projectPath: string): Promise<{ url: string; token: string } | null> {
	try {
		return JSON.parse(await fs.readFile(path.join(projectPath, ".caret", ".mcp.json"), "utf-8"))
	} catch {
		return null
	}
}

async function callMcp(url: string, token: string | null, body: unknown): Promise<Response> {
	// Hard timeout: a wedged MCP session otherwise leaves fetch awaiting
	// response headers FOREVER, and no scenario-level waitFor deadline can
	// interrupt an await that never settles — a full run hung 20+ minutes
	// inside bs exactly this way.
	return fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
		// 90s, not 30: a screenshot call renders a whole page before replying.
		// The point of the deadline is to stop an infinite hang, not to police
		// how long legitimate work takes.
		signal: AbortSignal.timeout(90_000),
	})
}

/**
 * What a tool actually said, out of an MCP reply.
 *
 * Assertions here search the raw body, which is fine — but a *failure message*
 * built from it prints SSE framing and nothing else, because `event: message`
 * is the first four hundred characters of every streamed reply. One run's whole
 * diagnosis was the string "event: message". This digs the tool's own text out
 * so a refusal reports its reason.
 */
function mcpSaid(body: string): string {
	const payloads = body.includes("data:")
		? body
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trim())
		: [body]

	const said: string[] = []
	for (const payload of payloads) {
		try {
			const parsed = JSON.parse(payload)
			const content = parsed?.result?.content
			if (Array.isArray(content)) {
				for (const part of content) if (typeof part?.text === "string") said.push(part.text)
			}
			if (parsed?.error?.message) said.push(String(parsed.error.message))
		} catch {
			// Not JSON — a keep-alive or a framing line. Nothing to report.
		}
	}
	return said.length > 0 ? said.join(" | ").replace(/\s+/g, " ").slice(0, 500) : body.replace(/\s+/g, " ").slice(0, 300)
}

/**
 * MCP requires the client to confirm initialization before the server will
 * answer anything else. Skipping it makes every later call look like the server
 * is missing tools it actually has.
 */
const INITIALIZED_NOTIFICATION = { jsonrpc: "2.0", method: "notifications/initialized" }

async function openMcpSession(url: string, token: string): Promise<void> {
	await callMcp(url, token, INITIALIZE)
	await callMcp(url, token, INITIALIZED_NOTIFICATION)
}

const INITIALIZE = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "caret-verify", version: "0.1.0" },
	},
}

async function main(): Promise<void> {
	// A run that starts after a crashed one inherits its orphans — and every one
	// is an agent loop polling a provider while this suite tries to measure a
	// clean app. Reap first, reap again in cleanup.
	reapOrphanedBackends()

	fixture = await buildFixture()
	log(`fixture at ${fixture}`)

	// A throwaway profile. Without it the run reads and writes the developer's own
	// preferences, so "cold launch with no backend configured" would be true only
	// on a machine that had never configured one — and selecting a backend here
	// would silently change theirs.
	userData = await fs.mkdtemp(path.join(os.tmpdir(), "caret-profile-"))

	// The first-run telemetry notice is gated on this pref alone —
	// CARET_DISABLE_TELEMETRY below silences the analytics client but not the
	// disclosure. Left unseeded, the notice sits at bottom-centre for the whole
	// run and eats clicks in every scenario that has the chat sidebar open
	// (it cost o, bo, ff and ii in one run). Prefs merge over defaults, so
	// seeding just this key changes nothing else.
	await fs.writeFile(path.join(userData, "preferences.json"), JSON.stringify({ telemetryNoticeShown: true }))

	app = await electron.launch({
		args: [path.resolve("out/main/index.js"), `--user-data-dir=${userData}`, fixture],
		// CARET_DISABLE_TELEMETRY: the fresh profile means telemetry defaults ON,
		// and every certification run would otherwise land in production analytics.
		env: { ...process.env, CARET_VERIFY_PROJECT: fixture, NODE_ENV: "test", CARET_DISABLE_TELEMETRY: "1" },
	})

	// Main-process output, kept.
	//
	// Playwright reports a dead app as "target page, context or browser has been
	// closed" and says nothing about why — which turns a crash into a mystery. The
	// reason is always in main's own log.
	await fs.mkdir(SHOTS, { recursive: true })
	const mainLog = await fs.open(path.join(SHOTS, "main.log"), "w")
	app.process().stdout?.on("data", (chunk) => void mainLog.write(chunk))
	app.process().stderr?.on("data", (chunk) => void mainLog.write(chunk))

	// The app dying mid-suite is otherwise invisible until the next call fails
	// with a message that names neither the time nor the reason.
	app.on("close", () => {
		if (!appDiedAt) {
			appDiedAt = new Date().toLocaleTimeString()
			void mainLog.write(`\n[verify-app] the app process exited at ${appDiedAt}\n`)
		}
	})

	// Three runs died with every Playwright handle reporting "Target page …
	// closed" while the process stayed up — so window-level lifecycle is logged
	// too, to catch *which* surface died and when, in main.log's own timeline.
	app.on("window", (page) => {
		const short = page.url().slice(0, 80)
		void mainLog.write(`[verify-app] window appeared: ${short}\n`)
		page.on("close", () => {
			const stamp = new Date().toLocaleTimeString()
			if (!appDiedAt && short.startsWith("file:")) appDiedAt = stamp
			void mainLog.write(`[verify-app] window CLOSED at ${stamp}: ${short}\n`)
		})
		page.on("crash", () => void mainLog.write(`[verify-app] window RENDERER CRASHED: ${short}\n`))
	})

	await scenario("a. app launches and the window is named after the project", async () => {
		const window = await app!.firstWindow({ timeout: 60_000 })
		assert(window, "no window appeared")

		// The *OS* window title, not `document.title` — that is what appears in the
		// dock and the Window menu, and it is what has to carry the project name so
		// several open projects are distinguishable.
		const expected = `${path.basename(fixture)} — Caret`
		const title = await waitFor(
			"the window title",
			async () => {
				const current = await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle() ?? "")
				return current === expected ? current : null
			},
			30_000,
		)
		return `OS window title: ${title}`
	})

	// The window LOOKS stuck during long model waits, and at least one full run
	// died to a mid-suite window close (stamped 2:02:08 in main.log, inside bs's
	// checker render). Say what the window is, in the title a human reads before
	// closing it. Best-effort: the chrome may retitle on navigation.
	await app!
		.evaluate(({ BrowserWindow }) => {
			const win = BrowserWindow.getAllWindows()[0]
			win?.setTitle(`⚠ CERTIFICATION RUN — do not close — ${win.getTitle()}`)
		})
		.catch(() => {})

	const discovery = await scenario("b. MCP discovery file is written with a token", async () => {
		const record = await waitFor("the MCP discovery file", () => readDiscovery(fixture), 60_000)
		assert(record.url.startsWith("http://127.0.0.1:"), `expected a loopback URL, got ${record.url}`)
		assert(record.token.length >= 32, "token is too short to be a credential")
		const mode = (await fs.stat(path.join(fixture, ".caret", ".mcp.json"))).mode & 0o777
		assert(mode === 0o600, `discovery file should be owner-only, got ${mode.toString(8)}`)
		return `${record.url}, token ${record.token.length} chars, mode 0600`
	}).then(() => readDiscovery(fixture))

	await scenario("c. MCP refuses an unauthenticated request", async () => {
		assert(discovery, "no discovery record")
		const response = await callMcp(discovery.url, null, INITIALIZE)
		assert(response.status === 401, `expected 401, got ${response.status}`)
		return "unauthenticated request → 401"
	})

	await scenario("d. MCP refuses a request carrying a browser Origin", async () => {
		assert(discovery, "no discovery record")
		const response = await fetch(discovery.url, {
			method: "POST",
			signal: AbortSignal.timeout(30_000),
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: `Bearer ${discovery.token}`,
				origin: "https://evil.example",
			},
			body: JSON.stringify(INITIALIZE),
		})
		assert(response.status === 403, `expected 403, got ${response.status}`)
		return "cross-origin request with a valid token → 403 (DNS-rebinding closed)"
	})

	await scenario("e. MCP accepts an authenticated request and lists the tools", async () => {
		assert(discovery, "no discovery record")
		const response = await callMcp(discovery.url, discovery.token, INITIALIZE)
		assert(response.ok, `initialize failed with ${response.status}`)
		const text = await response.text()
		assert(text.includes("caret"), "server did not identify itself")
		return "initialize accepted"
	})

	await scenario("f. rules files are generated with the foundation in them", async () => {
		const agents = await waitFor(
			"AGENTS.md",
			async () => {
				try {
					return await fs.readFile(path.join(fixture, "AGENTS.md"), "utf-8")
				} catch {
					return null
				}
			},
			60_000,
		)
		assert(agents.includes("BEGIN CARET DESIGN LAYER"), "generated block marker missing")
		assert(agents.includes("data-caret-id"), "authoring rules missing from the rules file")
		const claude = await fs.readFile(path.join(fixture, "CLAUDE.md"), "utf-8")
		assert(claude.includes("BEGIN CARET DESIGN LAYER"), "CLAUDE.md not generated")
		const cursor = await fs.readFile(path.join(fixture, ".cursor", "rules", "caret-design-layer.mdc"), "utf-8")
		assert(cursor.startsWith("---"), "Cursor rule is missing its frontmatter")
		return "AGENTS.md, CLAUDE.md and .cursor/rules all written"
	})

	await scenario("g. a user block in a rules file survives regeneration", async () => {
		const target = path.join(fixture, "AGENTS.md")
		const original = await fs.readFile(target, "utf-8")
		await fs.writeFile(target, `# My own instructions\n\nDo not touch this.\n\n${original}`)

		// Touch the tokens to trigger regeneration.
		const tokensPath = path.join(fixture, ".caret", "tokens", "foundation.json")
		const tokens = JSON.parse(await fs.readFile(tokensPath, "utf-8"))
		tokens.color.brand.seed = "#ff6b6b"
		await fs.writeFile(tokensPath, JSON.stringify(tokens, null, 2))

		const updated = await waitFor(
			"the regenerated rules file",
			async () => {
				const text = await fs.readFile(target, "utf-8")
				return text.includes("#ff6b6b") ? text : null
			},
			30_000,
		)
		assert(updated.includes("Do not touch this."), "the user's own content was overwritten")
		return "user content preserved, Caret's block updated to the new brand colour"
	})

	await scenario("h. watch-and-heal fixes an externally written page", async () => {
		const pageDir = path.join(fixture, ".caret", "pages", "about")
		await fs.mkdir(pageDir, { recursive: true })
		const target = path.join(pageDir, "index.tsx")
		await fs.writeFile(target, UNHEALED_SOURCE)
		await fs.writeFile(
			path.join(pageDir, "meta.json"),
			JSON.stringify({ id: "about", title: "About", type: "page", states: ["default"], tags: ["marketing"] }, null, 2),
		)

		const healed = await waitFor(
			"the healed page",
			async () => {
				const text = await fs.readFile(target, "utf-8")
				return text.includes("data-caret-id") ? text : null
			},
			30_000,
		)
		assert(!healed.includes("style={{"), "the inline style was not converted to a Tailwind class")
		return "caret-ids stamped and the inline style converted, with no MCP tool involved"
	})

	await scenario("i. healing is idempotent — a second pass writes nothing", async () => {
		const target = path.join(fixture, ".caret", "pages", "about", "index.tsx")
		const before = await fs.readFile(target, "utf-8")
		const stat = await fs.stat(target)

		// Rewrite identical content to trigger the watcher without changing anything.
		await fs.writeFile(target, before)
		await new Promise((resolve) => setTimeout(resolve, 2500))

		const after = await fs.readFile(target, "utf-8")
		assert(after === before, "a second heal changed the file — the codemod is not idempotent")
		return `content stable (${stat.size} bytes), no write-HMR-heal loop`
	})

	await scenario("j. the edit-provenance log records who changed what", async () => {
		const raw = await fs.readFile(path.join(fixture, ".caret", ".provenance.jsonl"), "utf-8")
		const records = raw
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line))
		assert(records.length > 0, "no provenance recorded")
		assert(
			records.some((r) => r.actor === "external"),
			"external writes were not attributed",
		)
		assert(
			records.some((r) => r.actor === "caret" && r.action === "heal"),
			"the heal itself was not recorded",
		)
		return `${records.length} record(s), actors: ${[...new Set(records.map((r) => r.actor))].join(", ")}`
	})

	await scenario("l. the interview tools and prompt are exposed over MCP", async () => {
		assert(discovery, "no discovery record")

		// A fresh MCP session, then list what the server offers. The interview is
		// worthless if an agent cannot discover it.
		await openMcpSession(discovery.url, discovery.token)
		const toolsResponse = await callMcp(discovery.url, discovery.token, {
			jsonrpc: "2.0",
			id: 2,
			method: "tools/list",
			params: {},
		})
		const toolsText = await toolsResponse.text()
		for (const tool of ["present_question", "present_options", "commit_foundation", "generate_asset"]) {
			assert(toolsText.includes(tool), `${tool} is not exposed. Server said: ${toolsText.slice(0, 400)}`)
		}

		const promptsResponse = await callMcp(discovery.url, discovery.token, {
			jsonrpc: "2.0",
			id: 3,
			method: "prompts/list",
			params: {},
		})
		const promptsText = await promptsResponse.text()
		assert(
			promptsText.includes("foundation_interview"),
			`the interview prompt is not exposed. Server said: ${promptsText.slice(0, 400)}`,
		)

		return "present_question, present_options, commit_foundation + foundation_interview prompt"
	})

	await scenario("m. committing a foundation writes tokens and regenerates the rules", async () => {
		assert(discovery, "no discovery record")
		await openMcpSession(discovery.url, discovery.token)

		// The candidate id is composite — typeface+palette+shape — and only ids the
		// curated library recognises are accepted. This is the anti-slop mechanism,
		// so it is worth asserting that a made-up one is refused.
		const bogus = await callMcp(discovery.url, discovery.token, {
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: { name: "commit_foundation", arguments: { candidateId: "my-own-invention", tags: [] } },
		})
		const bogusText = await bogus.text()
		assert(
			bogusText.includes("not a candidate"),
			`an invented candidate id was not refused. Server said: ${bogusText.slice(0, 400)}`,
		)

		// A combination Caret never offered must be refused even though all three
		// ids are individually real — curating ingredients is not curating designs.
		const mismatched = await callMcp(discovery.url, discovery.token, {
			jsonrpc: "2.0",
			id: 6,
			method: "tools/call",
			params: {
				name: "commit_foundation",
				arguments: { candidateId: "editorial-instrument+deep-technical+pill-expressive", tags: [] },
			},
		})
		const mismatchedText = await mismatched.text()
		assert(
			mismatchedText.includes("not a candidate"),
			`an unapproved combination of real ids was accepted: ${mismatchedText.slice(0, 300)}`,
		)

		const real = await callMcp(discovery.url, discovery.token, {
			jsonrpc: "2.0",
			id: 5,
			method: "tools/call",
			params: {
				name: "commit_foundation",
				arguments: { candidateId: "editorial-instrument+mono-accent+editorial-open", tags: ["editorial", "calm"] },
			},
		})
		// MCP returns 200 for a *tool* error too, so the HTTP status proves nothing.
		// The body has to be checked or a silently failing tool reads as a pass.
		const realText = await real.text()
		assert(real.ok, `commit_foundation failed with ${real.status}`)
		assert(!realText.includes('"isError":true'), `commit_foundation errored: ${realText.slice(0, 500)}`)

		// Poll rather than read once. The tool call returns as soon as the write is
		// issued, so a single read races it — and a certification that passes or
		// fails depending on timing is worse than no certification at all.
		const tokens = await waitFor(
			"the committed foundation",
			async () => {
				const parsed = JSON.parse(await fs.readFile(path.join(fixture, ".caret", "tokens", "foundation.json"), "utf-8"))
				return parsed.radius?.character === "sharp" ? parsed : null
			},
			30_000,
		)
		assert(tokens.typography.fontFamily === "Inter", `expected the pairing's body face, got ${tokens.typography.fontFamily}`)
		assert(tokens.typography.baseSize === 17, `expected the preset's base size, got ${tokens.typography.baseSize}`)
		assert(Object.keys(tokens.color.brand.scale).length === 11, "the brand scale was not derived")

		const rules = await waitFor(
			"the regenerated rules",
			async () => {
				const text = await fs.readFile(path.join(fixture, "AGENTS.md"), "utf-8")
				return text.includes(tokens.color.brand.seed) ? text : null
			},
			30_000,
		)
		assert(rules.includes("Inter"), "the committed typeface did not reach the rules files")

		return `committed "Editorial · Almost monochrome"; invented ids and unapproved combinations refused`
	})

	// ── UI ────────────────────────────────────────────────────────────────────
	// Everything above asserts on files and HTTP. None of it renders a single
	// pixel, so none of it would notice the renderer throwing on mount. These do.

	const chrome = await app.firstWindow()

	// The chrome is not usable at first paint: the top bar renders only after
	// project state lands, which follows the design session's boot — and on a
	// cold fixture that includes installing `.caret` dependencies, which can
	// take longer than any single click's timeout. In a full run fifty
	// scenarios have passed before anything clicks the chrome; in an `--only`
	// subset the first UI scenario races that boot and loses (cc failed
	// exactly this way, twice, on two different builds). Gate once, here, so
	// every scenario after this line starts from a mounted chrome.
	await chrome.waitForSelector('[data-testid="top-bar"]', { timeout: 120_000 })

	// Collected for the whole run, not just for mount. A React error thrown at any
	// point unmounts the tree, and every scenario after it then fails as "selector
	// not found" — which reads as a missing feature rather than a crash. Whatever
	// the renderer throws is reported by the scenario that trips over it.
	const rendererErrors: string[] = []
	chrome.on("pageerror", (err) => rendererErrors.push(err.message))
	chrome.on("console", (message) => {
		if (message.type() === "error") rendererErrors.push(`console: ${message.text()}`)
	})

	await scenario("n. the chrome renders and shows the project", async () => {
		// A renderer that threw during mount leaves an empty #root and every later
		// scenario times out with a confusing message, so check that first.
		const failures = rendererErrors

		await chrome.waitForSelector('[data-testid="top-bar"]', { timeout: 60_000 })
		await shot(chrome, "01-chrome")

		assert(failures.length === 0, `renderer threw during mount: ${failures.join("; ")}`)
		const barText = await chrome.textContent('[data-testid="top-bar"]')
		assert(barText?.includes(path.basename(fixture)), `top bar does not name the project: ${barText}`)
		return `top bar rendered: ${barText?.trim().slice(0, 60)}`
	})

	await scenario("cb. a second project is reachable from inside the first", async () => {
		// Being stuck in whatever project you opened first was the whole complaint,
		// and there were two reasons for it: nothing in the window offered a way
		// out, and the application menu's "Open Recent" was a snapshot taken at
		// startup — on a fresh profile it read "No Recent Projects" forever, however
		// many projects had been opened since.

		// The affordance that did not exist: the window says which project it is,
		// and that is the control.
		const switcher = chrome.getByTestId("project-switcher")
		await switcher.waitFor({ timeout: 30_000 })
		assert((await switcher.innerText()).includes(path.basename(fixture)), "the top bar does not name the project you are in")
		await switcher.click()
		const menu = chrome.getByTestId("project-switcher-menu")
		await menu.waitFor({ timeout: 15_000 })
		assert((await menu.getByTestId("project-open-other").count()) === 1, "no way to open another project")
		await chrome.keyboard.press("Escape")

		// Opening a second project, the way the menu item does it. A bare directory
		// is enough: the window is what is being tested, not the design layer.
		const second = await fs.mkdtemp(path.join(os.tmpdir(), "caret-second-"))
		const opened = await chrome.evaluate(
			async (target) => Boolean(await (window as any).caret.invoke("project:open", target)),
			second,
		)
		assert(opened, "opening a second project returned nothing")

		const windowCount = await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
		assert(windowCount >= 2, `a second project did not get its own window (${windowCount} open)`)

		// And the menu can now see it. This is the frozen-snapshot bug: before the
		// fix this submenu held one disabled "No Recent Projects" entry for the
		// life of the process.
		const recentLabels: string[] = await app!.evaluate(({ Menu }) => {
			const file = Menu.getApplicationMenu()?.items.find((item: any) => item.label === "File")
			const recent = (file as any)?.submenu?.items.find((item: any) => item.label === "Open Recent")
			return ((recent as any)?.submenu?.items ?? []).map((item: any) => String(item.label))
		})
		assert(
			!recentLabels.includes("No Recent Projects"),
			`the recents menu is still the startup snapshot: ${JSON.stringify(recentLabels)}`,
		)
		assert(
			recentLabels.some((label) => label.includes(path.basename(second))),
			`the project just opened is not in the recents menu: ${JSON.stringify(recentLabels)}`,
		)

		// Closed again so its Vite server and MCP endpoint do not outlive the
		// scenario and contend with everything after it.
		await app!.evaluate(async ({ BrowserWindow }, target: string) => {
			for (const win of BrowserWindow.getAllWindows()) {
				if (win.getTitle().includes(target)) win.destroy()
			}
		}, path.basename(second))
		await fs.rm(second, { recursive: true, force: true }).catch(() => {})

		return `the top bar names the project and offers a way out; a second project opened in its own window and reached the recents menu (${recentLabels.length} entries)`
	})

	await scenario("o. the design-system view shows the committed foundation, and the editor round-trips it", async () => {
		// `m` committed a foundation, so Foundation must show the design-system
		// view — the surface that did not exist when commit meant "dropped onto
		// the canvas". From there, "Edit everything by hand" is the token editor,
		// whose data layer was rewired from gRPC to IPC; nothing else in this
		// suite would notice if it threw on mount or saved the wrong shape.
		//
		// The fixture booted UNCOMMITTED, so the app auto-opened Foundation onto
		// the entry screen — and `m`'s commit must flip that mounted screen over
		// to the DS view once the watcher's debounced push lands. Wait for the
		// flip BEFORE touching the top-bar button: it is a toggle, and clicking
		// while the push is still in flight toggles the surface away a moment
		// before the flip would have shown (a race this scenario lost twice).
		const flipped = await chrome
			.waitForSelector('[data-testid="design-system-view"]', { timeout: 20_000 })
			.then(() => true)
			.catch(() => false)
		if (!flipped) {
			// Not on the Foundation surface at all (an --only subset with a
			// different history) — navigate there.
			await chrome.click('[data-testid="top-bar"] >> text=Foundation')
		}
		await waitFor(
			"the design-system view",
			async () => ((await chrome.getByTestId("design-system-view").count()) ? true : null),
			20_000,
			async () => {
				const ids = await chrome.evaluate(() =>
					[...document.querySelectorAll("[data-testid]")].map((el) => el.getAttribute("data-testid")).join(", "),
				)
				return `on screen instead: ${ids.slice(0, 400)}`
			},
		)
		await shot(chrome, "02-design-system-view")
		await chrome.click('[data-testid="ds-edit-by-hand"]')

		// The editor's first step is the vibe description.
		const textarea = chrome.locator("textarea").first()
		await textarea.waitFor({ timeout: 20_000 })
		await textarea.fill("Certification run — set by the token editor")
		await shot(chrome, "02b-token-editor")

		// Walk to the review step and save. The step count is the wizard's, so
		// clicking Next until Save appears is more durable than a fixed number.
		for (let i = 0; i < 9; i++) {
			const save = chrome.locator("button", { hasText: /^Save/ })
			if (await save.count()) break
			const next = chrome.locator("button", { hasText: /^(Next|Continue)/ }).first()
			if (!(await next.count())) break
			await next.click()
			await chrome.waitForTimeout(150)
		}

		await shot(chrome, "03-token-editor-review")
		const save = chrome.locator("button", { hasText: /^Save/ })
		assert(await save.count(), "the wizard never reached a Save step")
		await save.first().click()

		const tokens = await waitFor(
			"the tokens the editor saved",
			async () => {
				const parsed = JSON.parse(await fs.readFile(path.join(fixture, ".caret", "tokens", "foundation.json"), "utf-8"))
				return parsed.vibe?.description?.includes("Certification run") ? parsed : null
			},
			30_000,
		)
		// The round-trip guarantees: fields the editor does not own must survive
		// its save (`surface` was silently dropped for months), the committed
		// marker must ride through, and the derivation pass must have filled
		// what the draft leaves empty.
		assert(
			tokens.color.surface === "light" || tokens.color.surface === "dark",
			"color.surface was dropped by the editor's save",
		)
		assert(tokens.meta?.committed === true, "meta.committed did not survive the editor's save")
		assert(Object.keys(tokens.color.neutral?.scale ?? {}).length > 0, "the neutral scale was not derived on save")
		assert(tokens.color.on?.brand, "on-colours were not derived on save")
		return `DS view rendered; editor wrote vibe: "${tokens.vibe.description.slice(0, 40)}…" and kept surface/meta`
	})

	await scenario("p. an agent's question is answerable in the UI and reaches the tool call", async () => {
		assert(discovery, "no discovery record")
		await openMcpSession(discovery.url, discovery.token)

		// present_question blocks until a human answers, so the call is fired
		// WITHOUT awaiting, answered through the real UI, and only then awaited.
		// This is the one scenario that exercises the whole loop: agent → main →
		// renderer → user → back to the still-open tool call.
		const pending = callMcp(discovery.url, discovery.token, {
			jsonrpc: "2.0",
			id: 10,
			method: "tools/call",
			params: {
				name: "present_question",
				arguments: {
					question: "What are you building?",
					choices: ["A tool people work in all day", "Something people read"],
					step: 1,
					total: 2,
				},
			},
		})

		// Deliberately NOT navigating to the interview first. An agent's question
		// has to reach the user wherever they are; if this needed a manual click,
		// a question asked while they were on the canvas would go unanswered.
		await chrome.waitForSelector('[data-testid="interview-question"]', { timeout: 30_000 })
		await shot(chrome, "04-interview-question")

		const questionText = await chrome.textContent('[data-testid="interview-question"]')
		assert(questionText?.includes("What are you building?"), `question not rendered: ${questionText}`)

		await chrome.locator('[data-testid="interview-choice"]', { hasText: "Something people read" }).click()

		const answered = await pending.then((r) => r.text())
		assert(answered.includes("Something people read"), `the answer never reached the agent: ${answered.slice(0, 300)}`)
		return "question rendered, clicked, and the answer reached the waiting tool call"
	})

	await scenario("q. specimens render and picking one returns a candidate id", async () => {
		assert(discovery, "no discovery record")
		await openMcpSession(discovery.url, discovery.token)

		const pending = callMcp(discovery.url, discovery.token, {
			jsonrpc: "2.0",
			id: 11,
			method: "tools/call",
			params: { name: "present_options", arguments: { tags: ["editorial", "calm"], count: 3 } },
		})

		await chrome.waitForSelector('[data-testid="interview-options"]', { timeout: 30_000 })
		const cards = chrome.locator('[data-testid="interview-candidate"]')
		await cards.first().waitFor({ timeout: 20_000 })

		// Fonts are fetched from Google Fonts; give them a beat so the screenshot
		// shows real specimens rather than the fallback face.
		await chrome.waitForTimeout(1500)
		await shot(chrome, "05-interview-specimens")

		const count = await cards.count()
		if (count !== 3) {
			const dump = await chrome.evaluate(() => {
				const node = document.querySelector('[data-testid="interview-options"]')
				return {
					optionsPresent: Boolean(node),
					optionsHtml: node ? node.outerHTML.slice(0, 600) : null,
					bodyText: document.body.innerText.slice(0, 400),
				}
			})
			throw new Error(`expected 3 specimens, got ${count}. DOM: ${JSON.stringify(dump)}`)
		}

		// A specimen has to actually render the typeface it is offering — a card
		// showing the fallback is worse than useless, because the user picks on it.
		//
		// `getComputedStyle().fontFamily` is NOT sufficient: it returns the declared
		// family whether or not the file ever loaded. This suite asserted on that
		// string and passed for weeks while the chrome's CSP silently blocked
		// fonts.googleapis.com and every specimen rendered in the system face.
		// `document.fonts.check` is the only assertion that distinguishes them.
		const family = await cards
			.first()
			.locator("p")
			.first()
			.evaluate((el) => getComputedStyle(el).fontFamily)
		assert(!/^(ui-|system-ui|-apple)/.test(family), `specimen declared a system face: ${family}`)

		const declared = family.split(",")[0].replace(/["']/g, "").trim()
		const loaded = await waitFor(
			`the ${declared} webfont to load`,
			async () => {
				const ok = await chrome.evaluate(
					(name) => document.fonts.check(`16px "${name}"`) && document.fonts.status === "loaded",
					declared,
				)
				return ok ? true : null
			},
			30_000,
		).catch(() => false)
		assert(loaded, `"${declared}" never loaded — the specimen is rendering a fallback, so the user picks on a lie`)

		await cards.first().click()
		const picked = await pending.then((r) => r.text())
		assert(picked.includes("candidateId"), `no candidate id came back: ${picked.slice(0, 300)}`)
		return `3 specimens rendered in ${family.split(",")[0]}; pick returned a candidate id`
	})

	await scenario("r. the canvas mounts in the window and renders the design pages", async () => {
		// The canvas is a WebContentsView, not a Playwright page, so it is reached
		// through the main process. This is the first thing in the suite that
		// proves the canvas actually runs inside the app rather than in a browser.
		const result = await waitFor(
			"the canvas to render pages",
			async () =>
				app!.evaluate(async ({ BrowserWindow }) => {
					const win = BrowserWindow.getAllWindows()[0]
					const views = (win?.contentView?.children ?? []) as any[]
					const canvas = views.find((v) => v.webContents && !v.webContents.isDestroyed())
					if (!canvas) return null
					const url = canvas.webContents.getURL()
					if (!url.startsWith("http://127.0.0.1")) return null
					const frames = await canvas.webContents
						.executeJavaScript("document.querySelectorAll('iframe').length")
						.catch(() => 0)
					return frames > 0 ? { url, frames } : null
				}),
			120_000,
		)
		await shot(chrome, "06-canvas")
		return `canvas at ${result.url} rendering ${result.frames} page frame(s)`
	})

	await scenario("t. get_screenshot returns real pixels of a real page", async () => {
		// This tool had no coverage anywhere and did not work: it captured through a
		// WebContentsView that was never attached to a window, so it had no
		// compositor surface and always returned an empty image.
		assert(discovery, "no discovery record")
		await openMcpSession(discovery.url, discovery.token)

		const raw = await waitFor(
			"get_screenshot to return an image",
			async () => {
				const response = await callMcp(discovery!.url, discovery!.token, {
					jsonrpc: "2.0",
					id: 20,
					method: "tools/call",
					params: { name: "get_screenshot", arguments: { pageId: "home" } },
				})
				const text = await response.text()
				return text.includes('"type":"image"') ? text : null
			},
			120_000,
		)

		// A base64 blob that decodes to a PNG of the right size, not merely a
		// non-empty string — an all-white 1x1 would satisfy a laxer assertion.
		const data = /"data":"([^"]+)"/.exec(raw)?.[1] ?? ""
		const buffer = Buffer.from(data, "base64")
		assert(buffer.length > 5000, `screenshot is too small to be a rendered page: ${buffer.length} bytes`)
		assert(buffer.subarray(1, 4).toString() === "PNG", "screenshot is not a PNG")
		const width = buffer.readUInt32BE(16)
		const height = buffer.readUInt32BE(20)
		assert(width >= 1440 && height >= 900, `captured at ${width}x${height}, expected at least 1440x900`)

		await fs.writeFile(path.join(SHOTS, "07-get-screenshot.png"), buffer)
		return `${width}x${height} PNG, ${Math.round(buffer.length / 1024)}KB`
	})

	await scenario("u. get_screenshot refuses a missing page with a usable reason", async () => {
		// The old failure message named the canvas for every possible cause, which
		// is how a broken capture read as "the canvas is not running" while Vite was
		// demonstrably serving. A refusal an agent cannot act on is a dead end.
		assert(discovery, "no discovery record")
		await openMcpSession(discovery.url, discovery.token)

		const response = await callMcp(discovery.url, discovery.token, {
			jsonrpc: "2.0",
			id: 21,
			method: "tools/call",
			params: { name: "get_screenshot", arguments: { pageId: "no-such-page" } },
		})
		const text = await response.text()
		assert(text.includes("no-such-page"), `the refusal does not name the page: ${text.slice(0, 300)}`)
		assert(!/is the canvas running/i.test(text), "the refusal still blames the canvas for an unrelated cause")
		return "names the page and the actual cause"
	})

	await scenario("u2. a screenshot with a hole in it says so", async () => {
		// A frame whose image failed to load looks like clean evidence that the
		// image "isn't rendering" — an agent burned a real turn debugging an SVG
		// that rendered fine on the canvas, because the capture raced the asset
		// and reported nothing. The capture may proceed; the caution may not be
		// omitted.
		const pageDir = path.join(fixture, ".caret", "pages", "broken-img")
		await fs.mkdir(pageDir, { recursive: true })
		await fs.writeFile(
			path.join(pageDir, "index.tsx"),
			`export default function BrokenImg() {\n` +
				`\treturn (\n` +
				`\t\t<div data-caret-id="bi-root" style={{ padding: 40 }}>\n` +
				`\t\t\t<h1 data-caret-id="bi-title">A page with a missing picture</h1>\n` +
				`\t\t\t<img alt="missing" data-caret-id="bi-img" src="/caret-assets/does-not-exist.png" width={200} />\n` +
				`\t\t</div>\n` +
				`\t)\n` +
				`}\n`,
		)

		assert(discovery, "no discovery record")
		const shotText = await waitFor(
			"the screenshot to carry the broken-image caution",
			async () => {
				const response = await callMcp(discovery!.url, discovery!.token, {
					jsonrpc: "2.0",
					id: 61,
					method: "tools/call",
					params: { name: "get_screenshot", arguments: { pageId: "broken-img" } },
				})
				const text = await response.text()
				// The page itself needs a beat to become routable after the write;
				// retry until the screenshot succeeds at all.
				return text.includes("captured just now") ? text : null
			},
			60_000,
		)
		assert(
			/CAUTION/.test(shotText) && shotText.includes("does-not-exist.png"),
			`the screenshot did not name its hole: ${mcpSaid(shotText).slice(0, 300)}`,
		)

		await fs.rm(pageDir, { recursive: true, force: true })
		return "the capture succeeded and named the image that failed to load"
	})

	await scenario("v. an asset dropped into .caret/assets is indexed with no tool involved", async () => {
		// Dragging a file into the folder has to work as well as using the UI, for
		// the same reason an agent's own Edit tool has to work on pages: the
		// reliable path cannot be the one that depends on everyone choosing it.
		await fs.writeFile(path.join(fixture, ".caret", "assets", "Hero Shot@2x.png"), solidPng(240, 135, [20, 24, 33]))

		const entry = await waitFor(
			"the asset index",
			async () => {
				try {
					const raw = await fs.readFile(path.join(fixture, ".caret", "assets", "index.json"), "utf-8")
					const index = JSON.parse(raw)
					return index.assets?.find((a: any) => a.tag === "hero-shot-2x") ?? null
				} catch {
					return null
				}
			},
			60_000,
		)

		assert(entry.width === 240 && entry.height === 135, `dimensions were not probed: ${entry.width}x${entry.height}`)
		assert(entry.kind === "image", `wrong kind: ${entry.kind}`)
		assert(entry.origin?.type === "discovered", `wrong origin: ${JSON.stringify(entry.origin)}`)
		return `tag "${entry.tag}" derived from the filename, ${entry.width}x${entry.height} probed from the header`
	})

	await scenario("w. the asset index reaches the always-on rules files", async () => {
		// Behind a tool it would be ignored — an agent that must choose to
		// enumerate assets emits a placeholder instead. This is the delivery
		// mechanism, so it is the thing worth asserting.
		const rules = await waitFor(
			"AGENTS.md to carry the asset",
			async () => {
				const text = await fs.readFile(path.join(fixture, "AGENTS.md"), "utf-8").catch(() => "")
				return text.includes("@hero-shot-2x") ? text : null
			},
			60_000,
		)
		assert(rules.includes("/caret-assets/"), "the rules file names the asset but not how to reference it")
		return "AGENTS.md carries the tag, the path and the size"
	})

	await scenario("x. an agent can list assets and receive the actual pixels", async () => {
		assert(discovery, "no discovery record")
		await openMcpSession(discovery.url, discovery.token)

		const listed = await (
			await callMcp(discovery.url, discovery.token, {
				jsonrpc: "2.0",
				id: 30,
				method: "tools/call",
				params: { name: "list_assets", arguments: {} },
			})
		).text()
		assert(listed.includes("hero-shot-2x"), `list_assets did not report the asset: ${listed.slice(0, 300)}`)

		const fetched = await (
			await callMcp(discovery.url, discovery.token, {
				jsonrpc: "2.0",
				id: 31,
				method: "tools/call",
				params: { name: "get_asset", arguments: { tag: "@hero-shot-2x" } },
			})
		).text()

		assert(fetched.includes('"type":"image"'), `get_asset returned no image content: ${fetched.slice(0, 300)}`)
		const data = /"data":"([^"]+)"/.exec(fetched)?.[1] ?? ""
		const decoded = Buffer.from(data, "base64")
		assert(decoded.subarray(1, 4).toString() === "PNG", "get_asset returned something that is not the PNG")
		assert(decoded.readUInt32BE(16) === 240, `wrong image returned: width ${decoded.readUInt32BE(16)}`)
		return "the leading @ is tolerated, and the bytes returned are the file on disk"
	})

	await scenario("y. get_asset refuses an unknown tag and names what does exist", async () => {
		assert(discovery, "no discovery record")
		await openMcpSession(discovery.url, discovery.token)

		const response = await (
			await callMcp(discovery.url, discovery.token, {
				jsonrpc: "2.0",
				id: 32,
				method: "tools/call",
				params: { name: "get_asset", arguments: { tag: "hero-shoot" } },
			})
		).text()

		assert(response.includes("hero-shoot"), `the refusal does not name the tag asked for: ${response.slice(0, 300)}`)
		assert(response.includes("hero-shot-2x"), "the refusal does not name the assets that do exist")
		return "a typo gets the list of real tags rather than a bare failure"
	})

	await scenario("z. assets are served to the canvas, and traversal is refused", async () => {
		// The index can be perfect and the page still show a broken image if the
		// URL it records does not resolve. This is the leg between the two.
		const base = await waitFor(
			"the design server's URL",
			async () =>
				app!.evaluate(({ BrowserWindow }) => {
					const win = BrowserWindow.getAllWindows()[0]
					const views = (win?.contentView?.children ?? []) as any[]
					const url = views.find((v) => v.webContents && !v.webContents.isDestroyed())?.webContents.getURL() ?? ""
					return url.startsWith("http://127.0.0.1") ? new URL(url).origin : null
				}),
			60_000,
		)

		const served = await fetch(`${base}/caret-assets/${encodeURIComponent("Hero Shot@2x.png")}`, {
			signal: AbortSignal.timeout(30_000),
		})
		assert(served.ok, `serving the asset failed with ${served.status}`)
		assert(served.headers.get("content-type") === "image/png", `wrong content type: ${served.headers.get("content-type")}`)
		const bytes = Buffer.from(await served.arrayBuffer())
		assert(bytes.subarray(1, 4).toString() === "PNG" && bytes.readUInt32BE(16) === 240, "served the wrong bytes")

		// `.caret/assets/` is a directory anything can write to and the middleware
		// takes a path from the URL, so the confinement check is load-bearing —
		// and it has to survive encoding, since %2e%2e is still traversal.
		const escaped = await fetch(`${base}/caret-assets/%2e%2e%2f%2e%2e%2fpackage.json`, {
			signal: AbortSignal.timeout(30_000),
		})
		assert(escaped.status === 403 || escaped.status === 404, `traversal was not refused: ${escaped.status}`)
		return `${bytes.length} bytes served as image/png; encoded traversal → ${escaped.status}`
	})

	await scenario("aa. the asset library renders, previews and writes a description", async () => {
		await chrome.getByTestId("top-bar").getByRole("button", { name: "Assets" }).click()

		const surface = await waitFor(
			"the shell to show the assets surface",
			async () => {
				const current = await chrome.getByTestId("app-shell").getAttribute("data-surface")
				return current === "assets" ? current : null
			},
			30_000,
		).catch(async () => {
			const shellPresent = (await chrome.locator('[data-testid="app-shell"]').count()) > 0
			const stuck = shellPresent ? await chrome.getByTestId("app-shell").getAttribute("data-surface") : "no shell"
			const body = (await chrome.evaluate(() => document.body.innerText).catch(() => "")).slice(0, 200)
			throw new Error(
				`clicking Assets left the shell on "${stuck}". Renderer errors: ${rendererErrors.join(" | ") || "none"}. Body: ${body}`,
			)
		})
		assert(surface === "assets", "the shell did not switch surfaces")
		await chrome.waitForSelector('[data-testid="assets-view"]', { timeout: 30_000 })

		const row = chrome.locator('[data-testid="asset-row"]').first()
		await row.waitFor({ timeout: 30_000 })

		// The chrome is not served by Vite, so a relative /caret-assets/ src would
		// resolve against the wrong origin and fail silently as a broken image.
		// naturalWidth is the only assertion that distinguishes "rendered" from
		// "an <img> element exists".
		const previewWidth = await waitFor(
			"the thumbnail to decode",
			async () => {
				const width = await row.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)
				return width > 0 ? width : null
			},
			30_000,
		)
		assert(previewWidth === 240, `the preview decoded at ${previewWidth}px, expected the real asset`)

		const description = row.getByTestId("asset-description")
		await description.fill("wide, dark, empty space top-left")
		await description.blur()

		// On disk is what counts — and then in the rules file, since that is the
		// only path by which a description reaches an agent.
		await waitFor(
			"the description to be written",
			async () => {
				const raw = await fs.readFile(path.join(fixture, ".caret", "assets", "index.json"), "utf-8").catch(() => "")
				return raw.includes("empty space top-left") ? true : null
			},
			30_000,
		)
		await waitFor(
			"the description to reach AGENTS.md",
			async () => {
				const rules = await fs.readFile(path.join(fixture, "AGENTS.md"), "utf-8").catch(() => "")
				return rules.includes("empty space top-left") ? true : null
			},
			30_000,
		)

		await shot(chrome, "08-assets")
		return "preview decoded from the design server; description written and carried into the rules"
	})

	await scenario("bb. the library refuses a bad tag in the UI without losing the asset", async () => {
		const tagField = chrome.locator('[data-testid="asset-row"]').first().getByTestId("asset-tag")
		await tagField.fill("Not A Tag")
		await tagField.blur()

		// The refusal has to restore the real tag, not leave the field showing a
		// name that does not exist — the next thing the user does is type @ and
		// expect it to be there.
		await waitFor(
			"the tag to be restored",
			async () => ((await tagField.inputValue()) === "hero-shot-2x" ? true : null),
			15_000,
		)

		const raw = await fs.readFile(path.join(fixture, ".caret", "assets", "index.json"), "utf-8")
		assert(raw.includes('"hero-shot-2x"'), "the asset lost its tag on a refused rename")
		assert(!raw.includes("Not A Tag"), "a malformed tag was written")

		return "malformed tag refused, field restored, index untouched"
	})

	await scenario("bc. a file dropped on the library is added, listed and removable", async () => {
		// The real gesture, not a harness-supplied `assets:add`. A drop from a
		// browser or a mail client carries bytes and no path, which is also all a
		// synthetic DataTransfer can carry — and until this landed, the drop
		// handler read the `File.path` Electron removed in v32 and did nothing at
		// all, silently, for every drop.
		const png = solidPng(120, 60, [200, 40, 90]).toString("base64")

		const view = chrome.getByTestId("assets-view")
		await view.waitFor({ timeout: 15_000 })
		await view.evaluate((element, data) => {
			const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
			const file = new File([bytes], "dropped-mark.png", { type: "image/png" })
			const transfer = new DataTransfer()
			transfer.items.add(file)
			element.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }))
		}, png)

		await waitFor(
			"the dropped file to reach the index",
			async () => {
				const raw = await fs.readFile(path.join(fixture, ".caret", "assets", "index.json"), "utf-8").catch(() => "")
				return raw.includes('"dropped-mark"') ? true : null
			},
			30_000,
		)

		const row = chrome.locator('[data-testid="asset-row"]:has([data-testid="asset-tag"][value="dropped-mark"])')
		await row.waitFor({ timeout: 30_000 })
		const width = await waitFor(
			"the dropped file's thumbnail to decode",
			async () => {
				const value = await row.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)
				return value > 0 ? value : null
			},
			30_000,
		)
		assert(width === 120, `the dropped asset's preview decoded at ${width}px`)

		// Removing is the other half of the library nobody had driven: it deletes a
		// file, so a wrong one is not recoverable from the UI.
		await row.getByRole("button", { name: "Remove" }).click()
		await waitFor(
			"the asset to leave the index",
			async () => {
				const raw = await fs.readFile(path.join(fixture, ".caret", "assets", "index.json"), "utf-8").catch(() => "")
				return raw.includes('"dropped-mark"') ? null : true
			},
			30_000,
		)
		const onDisk = await fs
			.stat(path.join(fixture, ".caret", "assets", "dropped-mark.png"))
			.then(() => true)
			.catch(() => false)
		assert(!onDisk, "Remove left the file behind")

		return "dropped with no path on disk, indexed, previewed, then removed from the index and the disk"
	})

	await scenario("bd. a video shows a frame, not a broken image", async () => {
		// Kinds differ in exactly one place — the library thumbnail — and a video
		// rendered through an <img> is a broken icon rather than a poster. This
		// asserts the dispatch and the URL; the extracted poster frame itself needs
		// a decodable video, which this fixture has no way to produce.
		await fs.writeFile(path.join(fixture, ".caret", "assets", "reel.mp4"), Buffer.from("not a decodable video"))

		const row = chrome.locator('[data-testid="asset-row"]:has([data-testid="asset-tag"][value="reel"])')
		await row.waitFor({ timeout: 30_000 })
		const video = row.getByTestId("asset-video")
		await video.waitFor({ timeout: 15_000 })
		const src = await video.getAttribute("src")
		assert(src?.includes("/caret-assets/reel.mp4"), `the video element points at ${src}`)
		assert(src?.includes("#t="), "the video opens on frame zero, which is blank in most footage")

		assert((await row.locator("img").count()) === 0, "a video was rendered through an <img>")

		await fs.rm(path.join(fixture, ".caret", "assets", "reel.mp4"))
		return "video indexed by the healer and shown as a seeked frame, not an image"
	})

	await scenario("bg. the user says what they want, and generation starts from that", async () => {
		// This scenario used to assert the opposite: that nobody was ever asked to
		// describe what they wanted. That rule shipped a generator whose subjects
		// were a six-item array, so asking for a paperclip returned a ceramic vase.
		// What it checks now is that the request is the user's, that it reaches the
		// pipeline, and that a real file with real provenance comes out the far end.
		// Reaching the surface rather than inheriting it. The top-bar button is a
		// *toggle*, so clicking it blindly would close the very view this needs.
		if ((await chrome.getByTestId("app-shell").getAttribute("data-surface")) !== "assets") {
			await chrome.getByTestId("top-bar").getByRole("button", { name: "Assets" }).click()
		}
		await chrome.waitForSelector('[data-testid="assets-view"]', { timeout: 30_000 })
		if ((await chrome.getByTestId("generate-asset").count()) > 0) {
			await chrome.getByTestId("generate-asset").getByText("Cancel").click()
		}
		await chrome.getByTestId("assets-generate").click()
		const panel = chrome.getByTestId("generate-asset")
		await panel.waitFor({ timeout: 15_000 })

		const ask = panel.getByTestId("generate-ask")
		await ask.waitFor({ timeout: 15_000 })
		// The thing whose absence was the old bug: somewhere to say what it is.
		assert((await ask.locator("textarea").count()) === 1, "there is nowhere to say what the asset is")
		for (const kind of ["image", "texture", "mark", "object3d"]) {
			assert((await ask.locator(`[data-generate-kind="${kind}"]`).count()) === 1, `the "${kind}" kind cannot be chosen`)
		}

		// The free lane, so this runs on any machine: a texture has no subject to
		// name, so it keeps its recipe cards and their sliders.
		await ask.locator('[data-generate-kind="texture"]').click()
		await ask.getByTestId("generate-request").fill("a soft grain wash behind a headline")
		await ask.getByTestId("generate-begin").click()

		const recipes = panel.getByTestId("generate-recipes")
		await recipes.waitFor({ timeout: 20_000 })
		const cardCount = await recipes.locator("[data-generate-recipe]").count()
		assert(cardCount > 0, "the texture lane offered nothing at all")
		// Picking "a texture" rules out the paid lane, so a photograph recipe here
		// would be offering something the user already said they did not want.
		assert(
			(await recipes.locator('[data-generate-recipe="workbench"]').count()) === 0,
			"a photograph recipe was offered under the texture kind",
		)

		// The specimen has to be the recipe rendered against this project, which
		// means it has to actually decode — an <img> with a broken data URL is
		// indistinguishable from a considered preview until you check.
		const specimenWidth = await waitFor(
			"a recipe specimen to decode",
			async () => {
				const width = await recipes
					.locator("[data-generate-recipe] img")
					.first()
					.evaluate((img: HTMLImageElement) => img.naturalWidth)
				return width > 0 ? width : null
			},
			20_000,
		)
		assert(specimenWidth > 0, "the recipe cards showed nothing")
		await shot(chrome, "20-generate-recipes")

		await recipes.locator("[data-generate-recipe]").first().click()

		const variants = panel.getByTestId("generate-variants")
		await variants.waitFor({ timeout: 20_000 })
		const variantCount = await variants.locator("[data-generate-variant]").count()
		assert(variantCount >= 4, `only ${variantCount} variants were offered`)

		// Variants that are all the same picture would make the pick screen
		// theatre. Comparing the rendered data URLs is the cheapest honest check.
		const previews = await variants
			.locator("[data-generate-variant] img")
			.evaluateAll((images) => (images as HTMLImageElement[]).map((image) => image.src.slice(-64)))
		assert(new Set(previews).size === previews.length, "the variants were not all different")
		await shot(chrome, "21-generate-variants")

		await variants.locator('[data-generate-variant="2"]').click()
		// Picking a take SELECTS it; "Use this one" is what advances to naming —
		// the second step arrived with the refine feature, which needs a chosen
		// take to send back as the reference.
		await panel.getByTestId("generate-use-take").click()

		const name = panel.getByTestId("generate-name")
		await name.waitFor({ timeout: 15_000 })
		const proposed = await name.getByTestId("generate-tag").inputValue()
		assert(proposed.length > 0, "the name field opened empty")
		await name.getByTestId("generate-tag").fill("hero-wash")
		await name.getByTestId("generate-save").click()

		// Waits for the *completed* entry, not the first sight of the tag:
		// addGeneratedAsset writes twice (the reindex lands the entry, a second
		// locked write adds description and origin), and polling between the two
		// reads a half-written record that the very next write completes.
		const raw = await waitFor(
			"the generated asset to reach the index with its provenance",
			async () => {
				const text = await fs.readFile(path.join(fixture, ".caret", "assets", "index.json"), "utf-8").catch(() => "")
				if (!text.includes('"hero-wash"')) return null
				const found = (JSON.parse(text) as { assets: Array<Record<string, any>> }).assets.find(
					(asset) => asset.tag === "hero-wash",
				)
				return found?.description && found?.origin?.type === "generated" ? text : null
			},
			30_000,
		)

		const entry = (JSON.parse(raw) as { assets: Array<Record<string, unknown>> }).assets.find(
			(asset) => asset.tag === "hero-wash",
		)
		assert(Boolean(entry), "the generated asset is not in the index")
		assert(entry?.kind === "vector", `the generated asset was indexed as ${entry?.kind}`)
		// The description is the load-bearing field of the asset layer, and a
		// generated asset has nobody to write one. Composed, never left empty.
		assert(String(entry?.description ?? "").length > 20, `the generated asset's description was "${entry?.description}"`)

		const origin = entry?.origin as Record<string, unknown> | undefined
		assert(origin?.type === "generated", `origin was ${JSON.stringify(origin)}`)
		assert(origin?.lane === "generator", "the lane was not recorded")
		assert(Boolean(origin?.recipeId), "the recipe that produced it was not recorded")
		// Provenance has to be complete enough to reproduce the file, which means
		// the answers and the resolved request, not a prose summary of them.
		assert(Boolean(origin?.answers), "the answers were not recorded")
		assert(String(origin?.resolved ?? "").includes("generatorId"), "the resolved request was not recorded")

		// And it is an asset like any other: served by the design server, and in
		// the always-on context every agent reads.
		const origin_ = await waitFor(
			"the design server's URL",
			async () =>
				app!.evaluate(({ BrowserWindow }) => {
					const win = BrowserWindow.getAllWindows()[0]
					const views = (win?.contentView?.children ?? []) as any[]
					const url = views.find((v) => v.webContents && !v.webContents.isDestroyed())?.webContents.getURL() ?? ""
					return url.startsWith("http://127.0.0.1") ? new URL(url).origin : null
				}),
			60_000,
		)
		const served = await fetch(`${origin_}/caret-assets/${String(entry?.file)}`, { signal: AbortSignal.timeout(30_000) })
		assert(served.ok, `the generated asset was not served: ${served.status}`)
		assert((served.headers.get("content-type") ?? "").includes("svg"), `served as ${served.headers.get("content-type")}`)
		const rules = await fs.readFile(path.join(fixture, "AGENTS.md"), "utf-8").catch(() => "")
		assert(rules.includes("hero-wash"), "the generated asset never reached the rules files")

		// And the record is readable where the asset lives, not only in JSON: the
		// "generated" chip opens the whole thing — lane, producer, recipe, answers,
		// cost, the resolved request. Provenance the plan calls "complete and
		// honest" is not honest while reading it means opening index.json.
		const chip = chrome.getByTestId("asset-generated-chip").first()
		await chip.waitFor({ timeout: 15_000 })
		await chip.click()
		const provenance = chrome.getByTestId("asset-provenance")
		await provenance.waitFor({ timeout: 15_000 })
		const shown = await provenance.innerText()
		assert(shown.includes("generated by code"), `the panel does not say which lane produced it: ${shown.slice(0, 200)}`)
		assert(shown.includes("Recipe"), "the panel does not name the recipe")
		// The free lane's cost line has to say it was free — an empty cost row
		// would read as "not recorded", which is a different fact.
		assert(shown.includes("computed locally"), "the panel does not say the generator lane cost nothing")
		assert(shown.includes("generatorId"), "the resolved request is not in the panel")
		await shot(chrome, "23-asset-provenance")
		await chip.click()

		return `4 kinds offered and a field to describe the asset; ${cardCount} texture recipes, ${variantCount} distinct variants, saved as @hero-wash with reproducible provenance, record readable behind the chip`
	})

	await scenario("bh. the paid lane is offered honestly and refuses without credentials", async () => {
		// The lane that costs money is the one whose *absence* has to be handled
		// well: three of the four need no account, so "generation needs a key"
		// would be a lie that hides most of the feature. The catalogue is shown
		// whole and the unavailable entry says what is missing.
		// Reaching the surface rather than inheriting it. The top-bar button is a
		// *toggle*, so clicking it blindly would close the very view this needs.
		if ((await chrome.getByTestId("app-shell").getAttribute("data-surface")) !== "assets") {
			await chrome.getByTestId("top-bar").getByRole("button", { name: "Assets" }).click()
		}
		await chrome.waitForSelector('[data-testid="assets-view"]', { timeout: 30_000 })
		if ((await chrome.getByTestId("generate-asset").count()) > 0) {
			await chrome.getByTestId("generate-asset").getByText("Cancel").click()
		}
		await chrome.getByTestId("assets-generate").click()
		const panel = chrome.getByTestId("generate-asset")
		await panel.waitFor({ timeout: 15_000 })

		const configured = Boolean(
			process.env.GEMINI_API_KEY || process.env.CARET_VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT,
		)

		// Every kind is offered whether or not this machine can pay for it. Hiding
		// the paid ones would teach the user nothing about what exists or what it
		// would take to have it.
		const ask = panel.getByTestId("generate-ask")
		await ask.waitFor({ timeout: 15_000 })
		for (const kind of ["image", "texture", "mark", "object3d"]) {
			assert((await ask.locator(`[data-generate-kind="${kind}"]`).count()) === 1, `the "${kind}" kind was hidden`)
		}

		await ask.locator('[data-generate-kind="image"]').click()
		await ask.getByTestId("generate-request").fill("a stainless steel ruler on a plain surface")
		await ask.getByTestId("generate-begin").click()

		// The refusal arrives where the user actually hits it — on the take screen,
		// after asking for something — rather than as a greyed-out card they never
		// selected. It has to say the rest still works, or a missing key reads as
		// the whole feature being locked behind a payment.
		let refusal = ""
		if (!configured) {
			refusal = await waitFor(
				"the paid lane to refuse honestly",
				async () => {
					const said = await panel
						.getByTestId("generate-variants")
						.innerText()
						.catch(() => "")
					return said.includes("key") ? said : null
				},
				90_000,
			)
			assert(/needs no account|no account/i.test(refusal), `the refusal says: ${refusal.replace(/\n/g, " ")}`)
			assert(/Gemini|API key/i.test(refusal), "the refusal does not name what is missing")
		}

		await panel.getByText("Cancel").click()

		return configured
			? "every kind offered and the image lane runnable — credentials present in this environment"
			: "every kind offered; asking for an image refused by naming the key it needs and saying the free lanes still work"
	})

	await scenario("ca. the agent generates an asset from the chat, on the user's consent", async () => {
		assert(discovery, "no discovery record")
		await openMcpSession(discovery.url, discovery.token)

		// Chat generation ships OFF: the shipped default must answer instantly
		// with the Assets-tab redirect — no consent card, nothing spent.
		const declined = await callMcp(discovery.url, discovery.token, {
			jsonrpc: "2.0",
			id: 96,
			method: "tools/call",
			params: {
				name: "generate_asset",
				arguments: { kind: "texture", what: "a fine grain overlay", why: "Checking the shipped default." },
			},
		}).then((response) => response.text())
		assert(
			declined.includes("Assets tab"),
			`the shipped default did not redirect to the Assets tab: ${declined.slice(0, 300)}`,
		)

		// The rest of the scenario certifies the capability BEHIND the switch,
		// so it turns the switch on for its own run and back off at the end.
		await chrome.evaluate(() => (window as any).caret.invoke("prefs:set", { chatAssetGeneration: true }))

		// The chat path: the agent needs something the project does not have and
		// makes it with a tool, without navigating to any surface. It proposes
		// first — the image and 3D lanes spend the user's own credits, and an agent
		// deciding to spend them mid-conversation is the thing this must not do.
		// Driven on the free texture lane so it runs on any machine.
		const pending = callMcp(discovery.url, discovery.token, {
			jsonrpc: "2.0",
			id: 97,
			method: "tools/call",
			params: {
				name: "generate_asset",
				arguments: {
					kind: "texture",
					what: "a fine grain overlay",
					why: "The hero photograph looks too digital without one.",
				},
			},
		})

		// Read once: racing `pending.then(r => r.text())` twice consumes the body
		// on the first read and throws "Body is unusable" on the second.
		const settled = pending.then((response) => response.text())

		// The resolve this scenario holds down: generation asked for in the chat
		// is answered IN the chat. The consent must dock in the sidebar, and the
		// surface the user was on must not move — the first shipped version
		// hijacked the Foundation tab and vetoed every navigation until all
		// pending consents were answered, and this scenario passed, because it
		// only asserted that the question appeared *somewhere*.
		const surfaceBefore = await chrome.getAttribute('[data-testid="app-shell"]', "data-surface")

		// Raced against the call itself: a handler that throws would otherwise
		// present as a selector timeout a minute later, pointing at the UI for a
		// failure that happened in the tool.
		const early = await Promise.race([
			chrome
				.waitForSelector('[data-testid="chat-interview-dock"] [data-testid="interview-question"]', { timeout: 60_000 })
				.then(() => null),
			settled,
		])
		assert(early === null, `the tool returned before asking the user: ${String(early).slice(0, 500)}`)
		const surfaceAfter = await chrome.getAttribute('[data-testid="app-shell"]', "data-surface")
		assert(
			surfaceAfter === surfaceBefore,
			`the consent moved the user: surface was "${surfaceBefore}", now "${surfaceAfter}"`,
		)
		const proposal = await chrome.textContent('[data-testid="chat-interview-dock"]')
		assert(
			proposal?.includes("a fine grain overlay"),
			`the proposal does not say what would be made: ${proposal?.slice(0, 200)}`,
		)
		await chrome.locator('[data-testid="interview-choice"]', { hasText: "Generate it" }).click()

		// Consent given, three takes to point at — docked in the chat like the
		// consent was. Raced for the same reason.
		const gaveUp = await Promise.race([
			chrome
				.waitForSelector('[data-testid="chat-interview-dock"] [data-testid="interview-takes"]', { timeout: 120_000 })
				.then(() => null),
			settled,
		])
		assert(gaveUp === null, `the tool returned instead of offering takes: ${String(gaveUp).slice(0, 500)}`)
		const offered = await chrome.locator("[data-interview-take]").count()
		assert(offered > 1, `only ${offered} take(s) were offered`)
		await shot(chrome, "25-agent-takes")
		await chrome.locator("[data-interview-take]").first().click()

		const answered = await settled
		assert(!answered.includes('"isError":true'), `the tool failed: ${answered.slice(0, 400)}`)
		// The endpoint answers as SSE, so the JSON-RPC frame is on a `data:` line
		// rather than being the whole body.
		const frame = answered
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim())
			.filter(Boolean)
			.pop()
		assert(Boolean(frame), `no JSON-RPC frame in the reply: ${answered.slice(0, 300)}`)
		const parsed = JSON.parse(JSON.parse(frame!).result.content[0].text)
		assert(parsed.generated === true, `the tool reported: ${JSON.stringify(parsed).slice(0, 300)}`)
		assert(String(parsed.tag ?? "").length > 0, "the agent was not told what to reference")

		// And it is an asset like any other, named after what was asked for.
		const index = await waitFor(
			"the agent-generated asset to reach the index",
			async () => {
				const text = await fs.readFile(path.join(fixture, ".caret", "assets", "index.json"), "utf-8").catch(() => "")
				return text.includes(`"${parsed.tag}"`) ? text : null
			},
			30_000,
		)
		const entry = (JSON.parse(index) as { assets: Array<Record<string, any>> }).assets.find(
			(asset) => asset.tag === parsed.tag,
		)
		assert(entry?.origin?.type === "generated", "the asset was not recorded as generated")
		assert(String(entry?.origin?.answers?.asked ?? "").includes("grain"), "what the agent asked for was not recorded")

		// Back to the shipped default: later scenarios must run against the app
		// as users get it, where chat generation redirects to the Assets tab.
		await chrome.evaluate(() => (window as any).caret.invoke("prefs:set", { chatAssetGeneration: false }))

		return `agent proposed "a fine grain overlay", user consented, ${offered} takes offered, picked one, landed as @${parsed.tag}`
	})

	await scenario("bj. the image key is stored in the OS keychain and never read back", async () => {
		// The lane that costs money was, until this landed, configurable only by an
		// environment variable — which is a test setup, not a product. This drives
		// the field a real person would use.
		await chrome.getByTestId("top-bar").getByRole("button", { name: "Backend" }).click()
		const section = chrome.getByTestId("gemini-key-section")
		await section.waitFor({ timeout: 30_000 })

		// The offer has to say most projects never need this, or a key field reads
		// as the whole feature being paywalled.
		const copy = await section.innerText()
		assert(/need no account/i.test(copy), `the key section says: ${copy.replace(/\n/g, " ")}`)
		assert(/keychain/i.test(copy), "the key section does not say where the key goes")

		const field = section.getByTestId("gemini-key")
		assert((await field.getAttribute("type")) === "password", "the key field is not masked")

		await field.fill("test-key-do-not-use-0000")
		await section.getByTestId("gemini-key-save").click()
		await section.getByText("A key is stored.").waitFor({ timeout: 15_000 })

		// The value must not survive in the renderer, and must not be readable
		// back through IPC — a key a compromised renderer can read is one it can
		// send somewhere.
		assert((await field.inputValue()) === "", "the key was left sitting in the field")
		const leaked = await chrome.evaluate(async () => {
			const prefs = (await (window as any).caret.invoke("prefs:get")) as Record<string, unknown>
			return JSON.stringify(prefs).includes("test-key-do-not-use-0000")
		})
		assert(!leaked, "the raw key came back through prefs:get")

		// And on disk it is ciphertext, not the key.
		const prefsPath = path.join(userData, "preferences.json")
		const stored = await fs.readFile(prefsPath, "utf-8").catch(() => "")
		if (stored) {
			assert(!stored.includes("test-key-do-not-use-0000"), "the key was written to preferences.json in plain text")
			assert(stored.includes('"secrets"'), "no encrypted secret was written")
		}

		await section.getByTestId("gemini-key-clear").click()
		await waitFor(
			"the key to be forgotten",
			async () => ((await section.getByTestId("gemini-key-clear").count()) === 0 ? true : null),
			15_000,
		)

		return "key stored encrypted, absent from prefs:get and from preferences.json in the clear, then removed"
	})

	// The paid lane, driven for real. Skipped rather than faked without
	// credentials: a mocked pass here would certify the plumbing and say nothing
	// about the thing that actually costs money and can actually refuse.
	if (!PAID) {
		skipPaid("bi. a photograph is generated, picked and indexed")
	} else if (!process.env.GEMINI_API_KEY && !process.env.CARET_VERTEX_PROJECT && !process.env.GOOGLE_CLOUD_PROJECT) {
		skip("bi. a photograph is generated, picked and indexed", "no Gemini or Vertex credentials in this environment")
	} else {
		await scenario("bi. a photograph is generated, picked and indexed", async () => {
			await chrome.getByTestId("assets-generate").click()
			const panel = chrome.getByTestId("generate-asset")
			await panel.waitFor({ timeout: 15_000 })

			// A subject nothing in the old library could have produced. The six
			// hardcoded objects were a vase, a lamp, headphones, a succulent, a chair
			// and a watch; an overhead workbench is a recipe, not a request.
			const WANTED = "an architect's drafting table seen from above, with rolled drawings on it"
			const ask = panel.getByTestId("generate-ask")
			await ask.waitFor({ timeout: 15_000 })
			await ask.locator('[data-generate-kind="image"]').click()
			await ask.getByTestId("generate-request").fill(WANTED)
			await ask.getByTestId("generate-begin").click()

			// Clarification is optional and skippable, and skipping must reach the
			// takes rather than stranding the user on a screen of questions. The
			// clarify screen can arrive LATE (it is a model turn), and skipping
			// now runs the rebuild (another model turn) before the takes stage —
			// so this polls for either, skips at most once, and waits wide.
			const clarify = panel.getByTestId("generate-clarify")
			const variants = panel.getByTestId("generate-variants")
			let skipped = false
			await waitFor(
				"the takes grid (past any clarify questions)",
				async () => {
					if (!skipped && (await clarify.isVisible().catch(() => false))) {
						skipped = true
						await clarify.getByTestId("generate-clarify-skip").click()
						return null
					}
					return (await variants.isVisible().catch(() => false)) ? true : null
				},
				240_000,
			)
			// The wait is the feature here: paid calls at ~15s apiece, run together
			// rather than in sequence.
			await variants.locator("[data-generate-variant] img").first().waitFor({ timeout: 180_000 })

			const rendered = await waitFor(
				"a generated photograph to decode",
				async () => {
					const width = await variants
						.locator("[data-generate-variant] img")
						.first()
						.evaluate((img: HTMLImageElement) => img.naturalWidth)
					return width > 0 ? width : null
				},
				60_000,
			)
			assert(rendered > 100, `the photograph decoded at ${rendered}px`)

			const failures = await variants.locator("[data-generate-variant-error]").count()
			const usable = await variants.locator("[data-generate-variant]").count()
			assert(usable > 0, "every variant failed")

			await shot(chrome, "22-generate-photographs")
			await variants.locator("[data-generate-variant]").first().click()
			// Selecting a take, then "Use this take" — see bg.
			await panel.getByTestId("generate-use-take").click()

			const name = panel.getByTestId("generate-name")
			await name.waitFor({ timeout: 15_000 })
			await name.getByTestId("generate-tag").fill("hero-bench")
			await name.getByTestId("generate-save").click()

			// Completed entry, not first sight — see bg for why.
			const raw = await waitFor(
				"the photograph to reach the index with its provenance",
				async () => {
					const text = await fs.readFile(path.join(fixture, ".caret", "assets", "index.json"), "utf-8").catch(() => "")
					if (!text.includes('"hero-bench"')) return null
					const found = (JSON.parse(text) as { assets: Array<Record<string, any>> }).assets.find(
						(asset) => asset.tag === "hero-bench",
					)
					return found?.description && found?.origin?.type === "generated" ? text : null
				},
				30_000,
			)

			const entry = (JSON.parse(raw) as { assets: Array<Record<string, unknown>> }).assets.find(
				(asset) => asset.tag === "hero-bench",
			)
			assert(entry?.kind === "image", `the photograph was indexed as ${entry?.kind}`)
			// Intrinsic size probed from the real file header, not from the request.
			assert(Number(entry?.width) > 100, `the photograph measured ${entry?.width}x${entry?.height}`)

			// Post-processing, checked on the file rather than on the intention.
			// The model returns 1344x768 for a 16:9 request — 1.75:1, close enough
			// to look fine and wrong enough to show a seam in a full-bleed hero.
			const ratio = Number(entry?.width) / Number(entry?.height)
			assert(Math.abs(ratio - 16 / 9) < 0.01, `the stored photograph is ${ratio.toFixed(3)}:1, not 16:9`)
			assert(entry?.mime === "image/webp", `the photograph was stored as ${entry?.mime}`)

			const post = (entry?.origin as Record<string, any>)?.postProcessed
			assert(Boolean(post), "post-processing was not recorded")
			// A 1.4MB PNG per hero, committed forever, is the thing this prevents.
			assert(
				Number(post.to.bytes) < Number(post.from.bytes) / 3,
				`post-processing only got ${post.from.bytes} down to ${post.to.bytes} bytes`,
			)
			assert(Number(entry?.bytes) === Number(post.to.bytes), "the index disagrees with what was recorded")

			const origin = entry?.origin as Record<string, unknown> | undefined
			assert(origin?.lane === "raster", `the lane was recorded as ${origin?.lane}`)
			assert(String(origin?.producer ?? "").includes("gemini"), `the model was recorded as ${origin?.producer}`)
			// For a paid lane the resolved prompt is the only record of what the
			// money bought, and it has to carry the negative constraints too.
			assert(String(origin?.resolved ?? "").includes("Do not include:"), "the slop constraints are not in the record")
			// The whole point: what was sent is what the user asked for, verbatim.
			assert(
				String(origin?.resolved ?? "").includes(WANTED),
				`the resolved prompt is not the user's request: ${String(origin?.resolved ?? "").slice(0, 300)}`,
			)
			// And none of the old hardcoded subjects can have leaked in.
			for (const ghost of ["ceramic vase", "table lamp", "over-ear headphones", "succulent", "wristwatch"]) {
				assert(!String(origin?.resolved ?? "").includes(ghost), `the resolved prompt substituted "${ghost}"`)
			}
			assert((origin?.answers as Record<string, string>)?.asked === WANTED, "the request was not kept in provenance")

			// What the money bought is recorded from the provider's own meter — for
			// a paid lane, "cost per asset" is provenance, not bookkeeping.
			const cost = (entry?.origin as Record<string, any>)?.cost
			assert(Boolean(cost), "the cost of the paid call was not recorded")
			assert(cost.unit === "tokens", `the cost was recorded in ${cost.unit}, not the provider's meter`)
			assert(Number(cost.amount) > 0, `the recorded cost is ${cost.amount}`)
			assert(Number(cost.round?.calls) >= usable, `the round recorded ${cost.round?.calls} calls for ${usable} variants`)

			await chrome.getByTestId("assets-view").getByText("Done").click()
			return (
				`asked for "${WANTED}" and got it — ${usable} take(s) (${failures} refused), picked one, ` +
				`cropped to 16:9 at ${entry?.width}x${entry?.height}, ` +
				`${Math.round(Number(post.from.bytes) / 1024)}KB ${post.from.mime} → ${Math.round(Number(post.to.bytes) / 1024)}KB webp, ` +
				`${cost.amount} tokens metered (round of ${cost.round?.calls}: ${cost.round?.amount})`
			)
		})
	}

	// The cutout, driven for real. Same gating as bi and for the same
	// reason: a mocked pass would certify the plumbing and say nothing about
	// whether a model actually paints the key flat enough to remove.
	if (!PAID) {
		skipPaid("bm. a cutout is generated on plain white, and lands with alpha")
	} else if (!process.env.GEMINI_API_KEY && !process.env.CARET_VERTEX_PROJECT && !process.env.GOOGLE_CLOUD_PROJECT) {
		skip(
			"bm. a cutout is generated on plain white, and lands with alpha",
			"no Gemini or Vertex credentials in this environment",
		)
	} else {
		await scenario("bm. a cutout is generated on plain white, and lands with alpha", async () => {
			// A clean pass through bi leaves the surface on canvas; a failed one
			// leaves it on assets, possibly with the generate panel still open. The
			// top-bar button is a *toggle*, so clicking it blindly would close the
			// very surface this scenario needs.
			if ((await chrome.getByTestId("app-shell").getAttribute("data-surface")) !== "assets") {
				await chrome.getByTestId("top-bar").getByRole("button", { name: "Assets" }).click()
			}
			await chrome.waitForSelector('[data-testid="assets-view"]', { timeout: 30_000 })
			if ((await chrome.getByTestId("generate-asset").count()) > 0) {
				await chrome.getByTestId("generate-asset").getByText("Cancel").click()
			}
			await chrome.getByTestId("assets-generate").click()
			const panel = chrome.getByTestId("generate-asset")
			await panel.waitFor({ timeout: 15_000 })

			// The exact object that started all of this: a contact form needed a
			// paperclip, and the generator could only produce a ceramic vase. It is
			// also outside every recipe anyone wrote, which is the point.
			const WANTED_CUTOUT = "a brushed steel paperclip"
			const ask = panel.getByTestId("generate-ask")
			await ask.waitFor({ timeout: 15_000 })
			await ask.locator('[data-generate-kind="image"]').click()
			await ask.getByTestId("generate-request").fill(WANTED_CUTOUT)
			// Transparency is a property of the image, not a kind of its own — and
			// it is what switches on the flat-key-colour hard requirement.
			await ask.getByTestId("generate-transparent").check()
			await ask.getByTestId("generate-begin").click()

			// Same late-clarify + rebuild road as the image scenario above.
			const clarify = panel.getByTestId("generate-clarify")
			const variants = panel.getByTestId("generate-variants")
			let skipped = false
			await waitFor(
				"the cutout takes grid (past any clarify questions)",
				async () => {
					if (!skipped && (await clarify.isVisible().catch(() => false))) {
						skipped = true
						await clarify.getByTestId("generate-clarify-skip").click()
						return null
					}
					return (await variants.isVisible().catch(() => false)) ? true : null
				},
				240_000,
			)
			await variants.locator("[data-generate-variant] img").first().waitFor({ timeout: 240_000 })

			// The cut happened *before* the pick: what is on screen is the finished
			// cutout as PNG-with-alpha, not the original on its white background.
			const previewSrc = await variants
				.locator("[data-generate-variant] img")
				.first()
				.evaluate((img: HTMLImageElement) => img.src.slice(0, 24))
			assert(previewSrc.startsWith("data:image/png"), `the preview is ${previewSrc}, not the cut-out png`)

			const keyFailures = await variants.locator("[data-generate-variant-error]").count()
			const usable = await variants.locator("[data-generate-variant]").count()
			assert(usable > 0, "every cutout variant failed — generation or keying")
			await shot(chrome, "24-generate-cutouts")

			await variants.locator("[data-generate-variant]").first().click()
			// Selecting a take, then "Use this take" — see bg.
			await panel.getByTestId("generate-use-take").click()
			const name = panel.getByTestId("generate-name")
			await name.waitFor({ timeout: 15_000 })
			await name.getByTestId("generate-tag").fill("cutout-object")
			await name.getByTestId("generate-save").click()

			// Completed entry, not first sight — see bg for why.
			const raw = await waitFor(
				"the cutout to reach the index with its provenance",
				async () => {
					const text = await fs.readFile(path.join(fixture, ".caret", "assets", "index.json"), "utf-8").catch(() => "")
					if (!text.includes('"cutout-object"')) return null
					const found = (JSON.parse(text) as { assets: Array<Record<string, any>> }).assets.find(
						(asset) => asset.tag === "cutout-object",
					)
					return found?.description && found?.origin?.type === "generated" ? text : null
				},
				30_000,
			)
			const entry = (JSON.parse(raw) as { assets: Array<Record<string, any>> }).assets.find(
				(asset) => asset.tag === "cutout-object",
			)
			assert(Boolean(entry), "the cutout is not in the index")

			// The prompt asked for the plain white the runner floods away — that is
			// the whole mechanism, and it belongs in the record of what the money
			// bought. Not a key colour: asked for an exact hex the model returns a
			// flat background of its own choosing, measured at 0% agreement with the
			// colour requested, and perfect cutouts were refused for it.
			assert(
				/white/i.test(String(entry?.origin?.resolved ?? "")),
				"the background instruction is not in the resolved prompt",
			)
			// And it was a paperclip that was asked for, not whatever a recipe
			// happened to name. This is the assertion the old suite could not make.
			assert(
				String(entry?.origin?.resolved ?? "").includes(WANTED_CUTOUT),
				`the resolved prompt is not the user's request: ${String(entry?.origin?.resolved ?? "").slice(0, 300)}`,
			)
			assert(Boolean(entry?.origin?.cost), "the cutout's cost was not recorded")

			// And the stored file genuinely carries alpha — webp through the canvas
			// or the png fallback, but never a cutout flattened onto a background.
			const file = await fs.readFile(path.join(fixture, ".caret", "assets", String(entry?.file)))
			const hasAlpha =
				entry?.mime === "image/webp"
					? file.subarray(12, 16).toString() === "VP8X" && (file[20] & 0x10) !== 0
					: entry?.mime === "image/png" && file[25] === 6
			assert(hasAlpha, `the stored cutout (${entry?.mime}) carries no alpha channel`)

			await chrome.getByTestId("assets-view").getByText("Done").click()
			return `asked for "${WANTED_CUTOUT}" — ${usable} cutout(s) (${keyFailures} refused), saved as @cutout-object, ${entry?.mime} with alpha, cost recorded`
		})
	}

	await scenario("be. @ picks an asset inside the app's own canvas", async () => {
		// The picker is certified in verify:design-shell, but that runs the shell in
		// a browser. Here it runs where it ships: a WebContentsView, with the page
		// in a child frame, reached through the main process. The canvas has changed
		// meaning across hosts before — `window.parent` is the same window at top
		// level, which is what duplicated every inline edit — so "it worked in the
		// harness" is not evidence about the app.
		const outcome = await app!.evaluate(async ({ BrowserWindow }) => {
			// No helper functions in here, however much they would tidy it up: this
			// body is serialized into the main process, and esbuild's keepNames wraps
			// every function-valued const in a `__name` helper that does not exist
			// there. The first version of this scenario failed on exactly that.
			//
			// The canvas view is waited for, not assumed: it appears only once the
			// design server is up, which is well after the window exists.
			let canvas: any = null
			const viewDeadline = Date.now() + 120000
			while (Date.now() < viewDeadline && !canvas) {
				const win = BrowserWindow.getAllWindows()[0]
				const views = (win?.contentView?.children ?? []) as any[]
				const found = views.find((v) => v.webContents && !v.webContents.isDestroyed())
				if (found && found.webContents.getURL().startsWith("http://127.0.0.1")) canvas = found
				if (!canvas) await new Promise((r) => setTimeout(r, 500))
			}
			if (!canvas) return { error: "the canvas view never mounted" }
			const wc = canvas.webContents

			try {
				let deadline = Date.now() + 30000
				let ready = false
				while (Date.now() < deadline && !ready) {
					ready = await wc.executeJavaScript(`!!document.querySelector('.caret-canvas-frame')`).catch(() => false)
					if (!ready) await new Promise((r) => setTimeout(r, 250))
				}
				if (!ready) return { error: "no page card ever appeared on the canvas" }

				await wc.executeJavaScript(`(document.querySelector('.caret-canvas-frame')).click(), true`)

				deadline = Date.now() + 30000
				let pageFrame: any = null
				while (Date.now() < deadline && !pageFrame) {
					pageFrame = wc.mainFrame.frames.find((f: any) => f.url.includes("mode=focused")) ?? null
					if (!pageFrame) await new Promise((r) => setTimeout(r, 250))
				}
				if (!pageFrame) return { error: "the focused page never became a frame of the canvas" }

				deadline = Date.now() + 30000
				let painter = false
				while (Date.now() < deadline && !painter) {
					painter = await pageFrame
						.executeJavaScript(`!!document.querySelector('.caret-focused-paint-btn')`)
						.catch(() => false)
					if (!painter) await new Promise((r) => setTimeout(r, 250))
				}
				if (!painter) return { error: "the paint control never appeared in the focused page" }

				// Clicked until the overlay is actually up, not once and hoped for.
				// Focusing a page runs the caret-id precompute, which can write the
				// source and bounce the iframe through HMR — a click that lands in
				// that window sets state on a tree that is about to be replaced.
				let overlayUp = false
				for (let attempt = 0; attempt < 5 && !overlayUp; attempt++) {
					await pageFrame
						.executeJavaScript(
							`(() => { const b = document.querySelector('.caret-focused-paint-btn'); if (b) b.click(); return !!b })()`,
						)
						.catch(() => false)
					const attemptDeadline = Date.now() + 4000
					while (Date.now() < attemptDeadline && !overlayUp) {
						overlayUp = await pageFrame
							.executeJavaScript(`!!document.querySelector('.caret-overlay')`)
							.catch(() => false)
						if (!overlayUp) await new Promise((r) => setTimeout(r, 250))
					}
				}
				if (!overlayUp) return { error: "paint mode never engaged after five clicks" }

				// Real mouse events, because the painter takes pointer capture and a
				// dispatched PointerEvent has no pointer to capture. Coordinates are
				// in the view's space, so the iframe's own offset is added.
				const offset = await wc.executeJavaScript(
					`(() => { const r = document.querySelector('.caret-focused-iframe').getBoundingClientRect(); return { x: r.x, y: r.y } })()`,
				)
				const from = { x: Math.round(offset.x) + 120, y: Math.round(offset.y) + 160 }
				const to = { x: from.x + 320, y: from.y + 220 }
				wc.sendInputEvent({ type: "mouseMove", x: from.x, y: from.y })
				wc.sendInputEvent({ type: "mouseDown", x: from.x, y: from.y, button: "left", clickCount: 1 })
				for (let step = 1; step <= 6; step++) {
					wc.sendInputEvent({
						type: "mouseMove",
						x: Math.round(from.x + ((to.x - from.x) * step) / 6),
						y: Math.round(from.y + ((to.y - from.y) * step) / 6),
						button: "left",
						buttons: 1,
					})
					await new Promise((r) => setTimeout(r, 40))
				}
				wc.sendInputEvent({ type: "mouseUp", x: to.x, y: to.y, button: "left", clickCount: 1 })

				deadline = Date.now() + 20000
				let box = false
				while (Date.now() < deadline && !box) {
					box = await pageFrame
						.executeJavaScript(`!!document.querySelector('.caret-overlay-prompt input')`)
						.catch(() => false)
					if (!box) await new Promise((r) => setTimeout(r, 250))
				}
				if (!box) {
					// Distinguishing the three ways this fails is the difference between
					// one more run and five: the overlay never mounted, the drag never
					// registered, or the rect came out too small for the prompt.
					const state = await pageFrame
						.executeJavaScript(`(() => ({
							overlay: !!document.querySelector('.caret-overlay'),
							rect: !!document.querySelector('.caret-overlay-rect'),
							size: (() => { const r = document.querySelector('.caret-overlay-rect'); if (!r) return null; const b = r.getBoundingClientRect(); return Math.round(b.width) + 'x' + Math.round(b.height) })(),
							iframeOffset: ${JSON.stringify(offset)},
							dragged: ${JSON.stringify({ from, to })},
						}))()`)
						.catch((e: any) => ({ probeFailed: String(e) }))
					return { error: `painting a region did not open an instruction box: ${JSON.stringify(state)}` }
				}

				// Typed the way a keystroke arrives: through the native setter and an
				// input event, which is exactly what React's value tracker needs and
				// what the picker listens for.
				await pageFrame.executeJavaScript(`(() => {
					const input = document.querySelector('.caret-overlay-prompt input')
					input.focus()
					const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
					setter.call(input, 'Put @her')
					input.dispatchEvent(new Event('input', { bubbles: true }))
					return true
				})()`)

				// Polled to a decoded thumbnail, not merely to a row: an <img> that
				// exists but never paints is the exact failure a wrong asset URL
				// produces, and it looks fine in a DOM assertion.
				deadline = Date.now() + 30000
				let option: { tag: string; decoded: number } | null = null
				while (Date.now() < deadline) {
					option = await pageFrame
						.executeJavaScript(`(() => {
							const row = document.querySelector('[data-caret-asset-option]')
							if (!row) return null
							const img = row.querySelector('img')
							return { tag: row.getAttribute('data-caret-asset-option'), decoded: img ? img.naturalWidth : 0 }
						})()`)
						.catch(() => null)
					if (option && option.decoded > 0) break
					await new Promise((r) => setTimeout(r, 250))
				}
				if (!option) return { error: "the picker never opened, or opened with no options in it" }

				// Picked with a real mouse press on the row, hovering first — the way a
				// person picks, and the way it was reported broken. Hovering used to
				// rebuild the list, replacing the element between press and release so
				// no click ever fired; and react-grab reads any press outside its
				// selection as "dismiss", which put a "Discard?" prompt on screen
				// instead of an asset in the box.
				const rowBox = await pageFrame.executeJavaScript(`(() => {
					const row = document.querySelector('[data-caret-asset-option]')
					const r = row.getBoundingClientRect()
					return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
				})()`)
				const at = { x: Math.round(offset.x + rowBox.x), y: Math.round(offset.y + rowBox.y) }
				wc.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y })
				await new Promise((r) => setTimeout(r, 300))
				wc.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 })
				wc.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount: 1 })
				await new Promise((r) => setTimeout(r, 400))

				const picked = await pageFrame.executeJavaScript(
					`(document.querySelector('.caret-overlay-prompt input') || {}).value || ''`,
				)

				// Leave the page as it was found: paint mode off, back on the canvas.
				await pageFrame
					.executeJavaScript(`(() => {
						const input = document.querySelector('.caret-overlay-prompt input')
						if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
						return true
					})()`)
					.catch(() => {})
				await wc
					.executeJavaScript(
						`(() => { const b = document.querySelector('.caret-focused-toolbar-btn'); b && b.click(); return true })()`,
					)
					.catch(() => {})

				return { option, picked }
			} catch (err) {
				return { error: err instanceof Error ? err.message : String(err) }
			}
		})

		assert(!("error" in outcome) || !outcome.error, `driving the canvas failed: ${(outcome as any).error}`)
		const { option, picked } = outcome as { option: { tag: string; decoded: number }; picked: string }
		assert(option.tag === "hero-shot-2x", `the picker offered "${option.tag}"`)
		assert(option.decoded > 0, "the picker's thumbnail never decoded inside the app")
		assert(picked.includes("@hero-shot-2x"), `clicking the row did not put the tag in the box: "${picked}"`)

		return `clicked @${option.tag} from a decoded thumbnail in the real canvas view`
	})

	await scenario("bn. an inline colour edit detaches, offers the token, and a click promotes it", async () => {
		// Phase 7's colour write policy, driven in the real app: an element bound
		// to brand-500 gets an inline colour edit (detach by default), the canvas
		// offers "change the token instead" with the measured reach, and clicking
		// it repoints foundation.json, regenerates the theme, and re-binds the
		// element. The native colour dialog is the one part not driven — the value
		// is set on the picker's own input and dispatched as an input event, the
		// same synthesis the file-drop scenario uses for its native boundary.
		const caretDir = path.join(fixture, ".caret")
		const foundationPath = path.join(caretDir, "tokens", "foundation.json")
		const pagePath = path.join(caretDir, "pages", "home", "index.tsx")

		// A foundation with a real scale — the scaffold default has an empty one.
		const foundation = JSON.parse(await fs.readFile(foundationPath, "utf-8"))
		foundation.color.brand.scale = { "500": "#0b7aff", "600": "#0066db" }
		await fs.writeFile(foundationPath, JSON.stringify(foundation, null, 2))

		// The desktop watcher must regenerate the theme on its own.
		await waitFor(
			"the watcher to regenerate caret-theme.css with the new scale",
			async () => {
				const css = await fs.readFile(path.join(caretDir, "caret-theme.css"), "utf-8").catch(() => "")
				return css.includes("--color-brand-500: #0b7aff;") ? true : null
			},
			30000,
		)

		// Bind the subtitle to the token (external write; the healer tolerates it).
		const source = await fs.readFile(pagePath, "utf-8")
		assert(source.includes("text-zinc-400"), "fixture page no longer has the subtitle class this scenario edits")
		await fs.writeFile(pagePath, source.replace("text-zinc-400", "text-brand-500"))

		const outcome = await app!.evaluate(async ({ BrowserWindow }) => {
			// No helper functions in here — this body is serialized into the main
			// process, and esbuild's keepNames wraps function-valued consts in a
			// `__name` helper that does not exist there.
			let canvas: any = null
			const viewDeadline = Date.now() + 120000
			while (Date.now() < viewDeadline && !canvas) {
				const win = BrowserWindow.getAllWindows()[0]
				const views = (win?.contentView?.children ?? []) as any[]
				const found = views.find((v) => v.webContents && !v.webContents.isDestroyed())
				if (found && found.webContents.getURL().startsWith("http://127.0.0.1")) canvas = found
				if (!canvas) await new Promise((r) => setTimeout(r, 500))
			}
			if (!canvas) return { error: "the canvas view never mounted" }
			const wc = canvas.webContents

			try {
				// Focused page frame — reuse it if a prior scenario left one open,
				// else click the home card.
				let pageFrame: any = wc.mainFrame.frames.find((f: any) => f.url.includes("mode=focused")) ?? null
				if (!pageFrame) {
					let deadline0 = Date.now() + 30000
					let ready = false
					while (Date.now() < deadline0 && !ready) {
						ready = await wc.executeJavaScript(`!!document.querySelector('.caret-canvas-frame')`).catch(() => false)
						if (!ready) await new Promise((r) => setTimeout(r, 250))
					}
					if (!ready) return { error: "no page card ever appeared on the canvas" }
					await wc.executeJavaScript(`(document.querySelector('.caret-canvas-frame')).click(), true`)
					deadline0 = Date.now() + 30000
					while (Date.now() < deadline0 && !pageFrame) {
						pageFrame = wc.mainFrame.frames.find((f: any) => f.url.includes("mode=focused")) ?? null
						if (!pageFrame) await new Promise((r) => setTimeout(r, 250))
					}
					if (!pageFrame) return { error: "the focused page never became a frame of the canvas" }
				}

				// The subtitle must carry the token class as delivered by HMR, and
				// react-grab must be up. The frame handle is re-resolved on every
				// poll: focusing a page runs the caret-id precompute, which can
				// bounce the iframe through HMR and leave a captured handle dead.
				let deadline = Date.now() + 30000
				let bound = false
				let lastSeen = "never found the element"
				while (Date.now() < deadline && !bound) {
					pageFrame = wc.mainFrame.frames.find((f: any) => f.url.includes("mode=focused")) ?? pageFrame
					const probe = await pageFrame
						.executeJavaScript(
							`(() => { const el = document.querySelector('[data-caret-id="hero-subtitle"]'); return el ? el.className : null })()`,
						)
						.catch((e: any) => `frame probe failed: ${String(e).slice(0, 80)}`)
					if (typeof probe === "string") lastSeen = probe
					bound = typeof probe === "string" && probe.includes("text-brand-500")
					if (!bound) await new Promise((r) => setTimeout(r, 250))
				}
				if (!bound)
					return { error: `the token-bound subtitle never appeared in the focused page (last saw: ${lastSeen})` }
				await pageFrame.executeJavaScript(`((window).__REACT_GRAB__?.activate?.(), true)`).catch(() => {})
				await new Promise((r) => setTimeout(r, 800))

				// Right-click the subtitle with a real mouse to open react-grab's menu.
				const offset = await wc.executeJavaScript(
					`(() => { const r = document.querySelector('.caret-focused-iframe').getBoundingClientRect(); return { x: r.x, y: r.y } })()`,
				)
				const target = await pageFrame.executeJavaScript(
					`(() => { const r = document.querySelector('[data-caret-id="hero-subtitle"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`,
				)
				const at = { x: Math.round(offset.x + target.x), y: Math.round(offset.y + target.y) }

				let menuClicked = false
				for (let attempt = 0; attempt < 5 && !menuClicked; attempt++) {
					pageFrame = wc.mainFrame.frames.find((f: any) => f.url.includes("mode=focused")) ?? pageFrame
					wc.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y })
					await new Promise((r) => setTimeout(r, 300))
					wc.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "right", clickCount: 1 })
					wc.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "right", clickCount: 1 })
					const menuDeadline = Date.now() + 4000
					while (Date.now() < menuDeadline && !menuClicked) {
						menuClicked = await pageFrame
							.executeJavaScript(
								`(() => {
									const host = document.querySelector('[data-react-grab]')
									const root = host && host.shadowRoot
									if (!root) return false
									const items = Array.from(root.querySelectorAll('button, [role="menuitem"], div'))
									const item = items.find((n) => n.textContent && n.textContent.trim() === 'Edit color')
									if (!item) return false
									item.click()
									return true
								})()`,
							)
							.catch(() => false)
						if (!menuClicked) await new Promise((r) => setTimeout(r, 250))
					}
				}
				if (!menuClicked) return { error: "react-grab's menu never offered Edit color" }

				// Caret's own colour popover is open now. Type the hex the way a user
				// would (React-controlled input → prototype setter + input event) and
				// commit with Enter — the write happens on settle, not per keystroke.
				deadline = Date.now() + 8000
				let fed = false
				while (Date.now() < deadline && !fed) {
					pageFrame = wc.mainFrame.frames.find((f: any) => f.url.includes("mode=focused")) ?? pageFrame
					fed = await pageFrame
						.executeJavaScript(
							`(() => {
								const input = document.querySelector('#caret-color-popover [data-color-hex]')
								if (!input) return false
								const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
								setter.call(input, '#123456')
								input.dispatchEvent(new Event('input', { bubbles: true }))
								input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
								return true
							})()`,
						)
						.catch(() => false)
					if (!fed) await new Promise((r) => setTimeout(r, 250))
				}
				if (!fed) return { error: "Edit color never opened Caret's colour popover" }

				// The detach toast, with its measured reach, then the real click.
				deadline = Date.now() + 20000
				let buttonText = ""
				while (Date.now() < deadline && !buttonText) {
					pageFrame = wc.mainFrame.frames.find((f: any) => f.url.includes("mode=focused")) ?? pageFrame
					buttonText = await pageFrame
						.executeJavaScript(
							`(() => { const b = document.querySelector('#caret-detach-toast button'); return b ? b.textContent : '' })()`,
						)
						.catch(() => "")
					if (!buttonText) await new Promise((r) => setTimeout(r, 250))
				}
				if (!buttonText) return { error: "the detach toast never appeared after replacing a token class" }
				await pageFrame.executeJavaScript(`(document.querySelector('#caret-detach-toast button')).click(), true`)

				return { buttonText }
			} catch (err) {
				return { error: err instanceof Error ? err.message : String(err) }
			}
		})

		assert(!("error" in outcome) || !outcome.error, `driving the colour edit failed: ${(outcome as any).error}`)
		const { buttonText } = outcome as { buttonText: string }
		assert(buttonText.includes("Change the token instead"), `unexpected toast action: "${buttonText}"`)
		assert(buttonText.includes("(1 place)"), `the toast did not carry the measured reach: "${buttonText}"`)

		// The promote's three writes, all observable on disk.
		await waitFor(
			"foundation.json to carry the promoted value",
			async () => {
				const f = JSON.parse(await fs.readFile(foundationPath, "utf-8").catch(() => "{}"))
				return f?.color?.brand?.scale?.["500"] === "#123456" ? true : null
			},
			20000,
		)
		await waitFor(
			"the theme to regenerate from the promoted token",
			async () => {
				const css = await fs.readFile(path.join(caretDir, "caret-theme.css"), "utf-8").catch(() => "")
				return css.includes("--color-brand-500: #123456;") ? true : null
			},
			20000,
		)
		await waitFor(
			"the element to re-bind onto the token class",
			async () => {
				const page = await fs.readFile(pagePath, "utf-8").catch(() => "")
				return page.includes("text-brand-500") && !page.includes("text-[#123456]") ? true : null
			},
			20000,
		)

		return "detach offered the token with its reach (1 place); the click repointed brand-500, regenerated the theme, and re-bound the element"
	})

	await scenario("bt. the property panel resolves real Params from the host and writes a splice", async () => {
		// Phase 8.4 in the real app: selecting the (token-bound) subtitle opens
		// the panel, the HOST resolves its Params from source (the shell suite
		// only fakes this half), the colour row names the token it is bound to,
		// and committing a padding value splices `p-[24px]` into the page file.
		const caretDir = path.join(fixture, ".caret")
		const pagePath = path.join(caretDir, "pages", "home", "index.tsx")

		const outcome = await app!.evaluate(async ({ BrowserWindow }) => {
			let canvas: any = null
			const viewDeadline = Date.now() + 60000
			while (Date.now() < viewDeadline && !canvas) {
				const win = BrowserWindow.getAllWindows()[0]
				const views = (win?.contentView?.children ?? []) as any[]
				const found = views.find((v) => v.webContents && !v.webContents.isDestroyed())
				if (found && found.webContents.getURL().startsWith("http://127.0.0.1")) canvas = found
				if (!canvas) await new Promise((r) => setTimeout(r, 500))
			}
			if (!canvas) return { error: "the canvas view never mounted" }
			const wc = canvas.webContents

			try {
				let pageFrame: any = wc.mainFrame.frames.find((f: any) => f.url.includes("mode=focused")) ?? null
				if (!pageFrame) return { error: "no focused page frame (bn should have left one open)" }

				// A real left-click on the subtitle — selection is the panel's trigger.
				const offset = await wc.executeJavaScript(
					`(() => { const r = document.querySelector('.caret-focused-iframe').getBoundingClientRect(); return { x: r.x, y: r.y } })()`,
				)
				const target = await pageFrame.executeJavaScript(
					`(() => { const r = document.querySelector('[data-caret-id="hero-subtitle"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`,
				)
				const at = { x: Math.round(offset.x + target.x), y: Math.round(offset.y + target.y) }

				// Click until the panel has rendered rows from the host's reply.
				let colorRow = ""
				const deadline = Date.now() + 30000
				while (Date.now() < deadline && !colorRow) {
					pageFrame = wc.mainFrame.frames.find((f: any) => f.url.includes("mode=focused")) ?? pageFrame
					wc.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y })
					await new Promise((r) => setTimeout(r, 200))
					wc.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 })
					wc.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount: 1 })
					const rowDeadline = Date.now() + 5000
					while (Date.now() < rowDeadline && !colorRow) {
						colorRow = await pageFrame
							.executeJavaScript(
								`(() => {
									const row = document.querySelector('#caret-param-panel [data-param-row="color"]')
									return row ? row.textContent : ''
								})()`,
							)
							.catch(() => "")
						if (!colorRow) await new Promise((r) => setTimeout(r, 250))
					}
				}
				if (!colorRow) return { error: "the panel never rendered a colour row from the host's Params" }

				// Commit a padding value through the row's input.
				const committed = await pageFrame.executeJavaScript(
					`(() => {
						const input = document.querySelector('#caret-param-panel [data-param-input="padding"]')
						if (!input || input.disabled) return false
						input.value = '24px'
						input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
						return true
					})()`,
				)
				if (!committed) return { error: "the padding row was missing or disabled" }

				return { colorRow }
			} catch (err) {
				return { error: err instanceof Error ? err.message : String(err) }
			}
		})

		assert(!("error" in outcome) || !outcome.error, `driving the panel failed: ${(outcome as any).error}`)
		const { colorRow } = outcome as { colorRow: string }
		assert(colorRow.includes("token brand-500"), `the colour row does not name its token: "${colorRow}"`)

		await waitFor(
			"the padding splice to land in the page file",
			async () => {
				const source = await fs.readFile(pagePath, "utf-8").catch(() => "")
				return source.includes("p-[24px]") ? true : null
			},
			20000,
		)
		const source = await fs.readFile(pagePath, "utf-8")
		assert(
			/data-caret-id="hero-subtitle"[^>]*className="[^"]*p-\[24px\]/s.test(source) ||
				/className="[^"]*p-\[24px\][^"]*"[^>]*data-caret-id="hero-subtitle"/s.test(source),
			"p-[24px] landed, but not on the subtitle element",
		)

		return `panel named the binding ("token brand-500") and a committed padding spliced p-[24px] onto the subtitle`
	})

	await scenario("bv. a bulk edit hits every selected element, and Cmd+Z restores all of it as one step", async () => {
		// Phase 8.7 end to end: subtitle selected, headline shift-added, ONE
		// padding commit — both elements gain the class on disk — then the
		// unified undo restores the whole batch as a single step, through git
		// commit objects scoped to .caret/.
		const caretDir = path.join(fixture, ".caret")
		const pagePath = path.join(caretDir, "pages", "home", "index.tsx")
		const before = await fs.readFile(pagePath, "utf-8")
		assert(!before.includes("p-[32px]"), "the fixture already carries the class this scenario plants")

		const outcome = await app!.evaluate(async ({ BrowserWindow }) => {
			let canvas: any = null
			const viewDeadline = Date.now() + 60000
			while (Date.now() < viewDeadline && !canvas) {
				const win = BrowserWindow.getAllWindows()[0]
				const views = (win?.contentView?.children ?? []) as any[]
				const found = views.find((v) => v.webContents && !v.webContents.isDestroyed())
				if (found && found.webContents.getURL().startsWith("http://127.0.0.1")) canvas = found
				if (!canvas) await new Promise((r) => setTimeout(r, 500))
			}
			if (!canvas) return { error: "the canvas view never mounted" }
			const wc = canvas.webContents

			try {
				let pageFrame: any = wc.mainFrame.frames.find((f: any) => f.url.includes("mode=focused")) ?? null
				if (!pageFrame) return { error: "no focused page frame (bt should have left home open)" }

				// No helper-function consts in this body — esbuild's keepNames wraps
				// them in a `__name` helper that does not exist in the main process.
				const offset = await wc.executeJavaScript(
					`(() => { const r = document.querySelector('.caret-focused-iframe').getBoundingClientRect(); return { x: r.x, y: r.y } })()`,
				)

				// The headline got its caret-id from the precompute seeding pass.
				const headlineId = await pageFrame.executeJavaScript(
					`(() => { const el = document.querySelector('h1[data-caret-id]'); return el ? el.getAttribute('data-caret-id') : null })()`,
				)
				if (!headlineId) return { error: "the headline never got a seeded caret-id" }

				// The WHOLE two-click sequence retries as a unit. Focusing a page
				// runs the caret-id precompute, and an earlier scenario's commit
				// can land an HMR update at any moment — either replaces the
				// document, silently dropping the first selection, so the
				// shift-click arrives in a fresh page with nothing to extend.
				let announced = false
				const lastHeadlinePoint = { x: 0, y: 0 }
				for (let attempt = 0; attempt < 4 && !announced; attempt++) {
					pageFrame =
						wc.mainFrame.frames.find((f: any) => f.url.includes("mode=focused") && f.url.includes("page=home")) ??
						pageFrame

					const subtitleRaw = await pageFrame
						.executeJavaScript(
							`(() => { const el = document.querySelector('[data-caret-id="hero-subtitle"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`,
						)
						.catch(() => null)
					if (!subtitleRaw) {
						await new Promise((r) => setTimeout(r, 1000))
						continue
					}
					const at = { x: Math.round(offset.x + subtitleRaw.x), y: Math.round(offset.y + subtitleRaw.y) }
					wc.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y })
					await new Promise((r) => setTimeout(r, 200))
					wc.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 })
					wc.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount: 1 })

					// The subtitle must actually BE the panel's subject before the
					// shift-click; otherwise there is nothing to grow.
					let onSubtitle = false
					const subtitleDeadline = Date.now() + 8000
					while (Date.now() < subtitleDeadline && !onSubtitle) {
						onSubtitle = await pageFrame
							.executeJavaScript(
								`(document.querySelector('#caret-param-panel')?.dataset?.caretId === 'hero-subtitle')`,
							)
							.catch(() => false)
						if (!onSubtitle) await new Promise((r) => setTimeout(r, 250))
					}
					if (!onSubtitle) continue

					// The shift-click is dispatched INSIDE the page, not as OS input.
					// Two reasons, both learned the hard way: the focused view's
					// chrome overlays the top of the iframe, so a click there never
					// reaches the page (measured — the point sat inside the target's
					// rect and no handler saw it); and Electron's synthetic input
					// emits no pointer events. Real-input shift-clicking is already
					// certified against a real browser in the design shell (scenario
					// y). What THIS scenario is for is the host round trip: one
					// commit reaching every selected element, undone as one step.
					const secondId = await pageFrame
						.executeJavaScript(
							`(() => {
								const candidates = Array.from(document.querySelectorAll('[data-caret-id]'))
									.filter((el) => el.getAttribute('data-caret-id') !== 'hero-subtitle')
									.map((el) => ({ el, r: el.getBoundingClientRect() }))
									.filter((c) => c.r.width > 0 && c.r.height > 0)
								if (!candidates.length) return null
								const pick = candidates[candidates.length - 1]
								const options = {
									bubbles: true,
									cancelable: true,
									shiftKey: true,
									clientX: pick.r.x + pick.r.width / 2,
									clientY: pick.r.y + pick.r.height / 2,
								}
								pick.el.dispatchEvent(new MouseEvent('mousedown', options))
								pick.el.dispatchEvent(new MouseEvent('mouseup', options))
								pick.el.dispatchEvent(new MouseEvent('click', options))
								return pick.el.getAttribute('data-caret-id')
							})()`,
						)
						.catch(() => null)
					if (!secondId) continue

					const announceDeadline = Date.now() + 8000
					while (Date.now() < announceDeadline && !announced) {
						announced = await pageFrame
							.executeJavaScript(`(document.querySelector('#caret-param-panel')?.dataset?.selectionCount === '2')`)
							.catch(() => false)
						if (!announced) await new Promise((r) => setTimeout(r, 250))
					}
				}
				if (!announced) {
					const diag = await pageFrame
						.executeJavaScript(
							`(() => { const p = document.querySelector('#caret-param-panel'); return { count: p?.dataset?.selectionCount ?? null, panelId: p?.dataset?.caretId ?? null } })()`,
						)
						.catch(() => null)
					return { error: "the panel never announced the 2-element selection — diag: " + JSON.stringify(diag) }
				}

				// One commit for the batch.
				let committed = false
				const commitDeadline = Date.now() + 15000
				while (Date.now() < commitDeadline && !committed) {
					committed = await pageFrame.executeJavaScript(
						`(() => {
							const input = document.querySelector('#caret-param-panel [data-param-input="padding"]')
							if (!input || input.disabled) return false
							input.focus()
							input.value = '32px'
							input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
							return true
						})()`,
					)
					if (!committed) await new Promise((r) => setTimeout(r, 250))
				}
				if (!committed) return { error: "the padding row was missing or disabled" }

				return { headlineId }
			} catch (err) {
				return { error: err instanceof Error ? err.message : String(err) }
			}
		})

		assert(!("error" in outcome) || !outcome.error, `driving the bulk edit failed: ${(outcome as any).error}`)

		await waitFor(
			"both elements to gain p-[32px] on disk",
			async () => {
				const source = await fs.readFile(pagePath, "utf-8").catch(() => "")
				return (source.match(/p-\[32px\]/g) ?? []).length >= 2 ? true : null
			},
			20000,
		)

		// The unified undo, spoken from the page: one keystroke, the whole batch.
		// The host's undo-result is recorded so a failure names its cause.
		const undone = await app!.evaluate(async ({ BrowserWindow }) => {
			const win = BrowserWindow.getAllWindows()[0]
			const views = (win?.contentView?.children ?? []) as any[]
			const canvas = views.find((v) => v.webContents && !v.webContents.isDestroyed())
			if (!canvas) return false
			const pageFrame = canvas.webContents.mainFrame.frames.find((f: any) => f.url.includes("mode=focused"))
			if (!pageFrame) return false
			await pageFrame.executeJavaScript(
				`(window.__UNDO_RESULTS__ = [], window.addEventListener('message', (e) => { if (e.data?.type === 'undo-result') window.__UNDO_RESULTS__.push(e.data.payload) }), true)`,
			)
			await pageFrame.executeJavaScript(
				`((document.activeElement)?.blur?.(), window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true })), true)`,
			)
			return true
		})
		assert(undone, "could not send the undo keystroke")

		try {
			await waitFor(
				"the undo to restore the pre-bulk page",
				async () => {
					const source = await fs.readFile(pagePath, "utf-8").catch(() => "")
					return source.includes("p-[32px]") ? null : true
				},
				20000,
			)
		} catch (err) {
			const results = await app!.evaluate(async ({ BrowserWindow }) => {
				const win = BrowserWindow.getAllWindows()[0]
				const views = (win?.contentView?.children ?? []) as any[]
				const canvas = views.find((v) => v.webContents && !v.webContents.isDestroyed())
				const pageFrame = canvas?.webContents.mainFrame.frames.find((f: any) => f.url.includes("mode=focused"))
				return (await pageFrame?.executeJavaScript(`window.__UNDO_RESULTS__ ?? []`).catch(() => null)) ?? null
			})
			throw new Error(`${err} — undo-result payloads: ${JSON.stringify(results)}`)
		}

		return `one commit put p-[32px] on both elements; Ctrl+Z restored the batch as one step`
	})

	await scenario("bu. editing one .map() row's text writes that row's data item, and only it", async () => {
		// Phase 8.6 end to end in the real app: a list page over a same-file data
		// literal, the row's text edited inline, and the write landing in the
		// DATA — item 2's field — while the template and every other item stay
		// byte-identical. The look/content split is the whole point: the template
		// span belongs to look edits, the data literal to content edits.
		const caretDir = path.join(fixture, ".caret")
		const catalogDir = path.join(caretDir, "pages", "list-demo")
		await fs.mkdir(catalogDir, { recursive: true })
		const pagePath = path.join(catalogDir, "index.tsx")
		const pageSource = `const products = [
  { id: "a", name: "Monolith Trainer", price: 120 },
  { id: "b", name: "Aurora Slip-on", price: 95 },
]

export default function ListDemo() {
  return (
    <ul className="min-h-screen bg-white p-8 space-y-2">
      {products.map((product) => (
        <li key={product.id} className="p-3 rounded-lg border border-zinc-200">
          <p data-caret-id="demo-name" className="font-bold">{product.name}</p>
        </li>
      ))}
    </ul>
  )
}
`
		await fs.writeFile(pagePath, pageSource)
		await fs.writeFile(
			path.join(catalogDir, "meta.json"),
			JSON.stringify({ id: "list-demo", title: "List Demo", type: "page", states: [], tags: [] }),
		)

		const outcome = await app!.evaluate(async ({ BrowserWindow }) => {
			let canvas: any = null
			const viewDeadline = Date.now() + 60000
			while (Date.now() < viewDeadline && !canvas) {
				const win = BrowserWindow.getAllWindows()[0]
				const views = (win?.contentView?.children ?? []) as any[]
				const found = views.find((v) => v.webContents && !v.webContents.isDestroyed())
				if (found && found.webContents.getURL().startsWith("http://127.0.0.1")) canvas = found
				if (!canvas) await new Promise((r) => setTimeout(r, 500))
			}
			if (!canvas) return { error: "the canvas view never mounted" }
			const wc = canvas.webContents

			try {
				// Leave any focused page, then open the list page from the grid.
				await wc.executeJavaScript(
					`((document.querySelector('button[title="Back to canvas"]')) || {click(){}}).click(), true`,
				)
				const findCard = `(() => {
					const frames = Array.from(document.querySelectorAll('.caret-canvas-frame'))
					return frames.find((f) => f.querySelector('.caret-canvas-frame-title')?.textContent?.trim() === 'List Demo') ?? null
				})()`
				let cardReady = false
				let deadline = Date.now() + 60000
				while (Date.now() < deadline && !cardReady) {
					cardReady = await wc.executeJavaScript(`!!${findCard}`).catch(() => false)
					if (!cardReady) await new Promise((r) => setTimeout(r, 500))
				}
				if (!cardReady) return { error: "the List Demo card never appeared on the canvas" }
				await wc.executeJavaScript(`(${findCard}).click(), true`)

				let pageFrame: any = null
				deadline = Date.now() + 30000
				while (Date.now() < deadline && !pageFrame) {
					pageFrame =
						wc.mainFrame.frames.find(
							(f: any) => f.url.includes("mode=focused") && f.url.includes("page=list-demo"),
						) ?? null
					if (!pageFrame) await new Promise((r) => setTimeout(r, 250))
				}
				if (!pageFrame) return { error: "the focused list page never became a frame" }

				// Both rendered rows present, react-grab up.
				deadline = Date.now() + 30000
				let rows = 0
				while (Date.now() < deadline && rows !== 2) {
					pageFrame = wc.mainFrame.frames.find((f: any) => f.url.includes("page=list-demo")) ?? pageFrame
					rows = await pageFrame
						.executeJavaScript(`document.querySelectorAll('[data-caret-id="demo-name"]').length`)
						.catch(() => 0)
					if (rows !== 2) await new Promise((r) => setTimeout(r, 250))
				}
				if (rows !== 2) return { error: `expected 2 rendered rows, saw ${rows}` }
				await pageFrame.executeJavaScript(`((window).__REACT_GRAB__?.activate?.(), true)`).catch(() => {})
				await new Promise((r) => setTimeout(r, 800))

				// Right-click ROW 2's name with a real mouse.
				const offset = await wc.executeJavaScript(
					`(() => { const r = document.querySelector('.caret-focused-iframe').getBoundingClientRect(); return { x: r.x, y: r.y } })()`,
				)
				const target = await pageFrame.executeJavaScript(
					`(() => { const r = document.querySelectorAll('[data-caret-id="demo-name"]')[1].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`,
				)
				const at = { x: Math.round(offset.x + target.x), y: Math.round(offset.y + target.y) }

				let menuClicked = false
				for (let attempt = 0; attempt < 5 && !menuClicked; attempt++) {
					pageFrame = wc.mainFrame.frames.find((f: any) => f.url.includes("page=list-demo")) ?? pageFrame
					wc.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y })
					await new Promise((r) => setTimeout(r, 300))
					wc.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "right", clickCount: 1 })
					wc.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "right", clickCount: 1 })
					const menuDeadline = Date.now() + 4000
					while (Date.now() < menuDeadline && !menuClicked) {
						menuClicked = await pageFrame
							.executeJavaScript(
								`(() => {
									const host = document.querySelector('[data-react-grab]')
									const root = host && host.shadowRoot
									if (!root) return false
									const items = Array.from(root.querySelectorAll('button, [role="menuitem"], div'))
									const item = items.find((n) => n.textContent && n.textContent.trim() === 'Edit text')
									if (!item) return false
									item.click()
									return true
								})()`,
							)
							.catch(() => false)
						if (!menuClicked) await new Promise((r) => setTimeout(r, 250))
					}
				}
				if (!menuClicked) return { error: "react-grab's menu never offered Edit text on the row" }

				// The row is contentEditable — set the new text and commit with Enter.
				await new Promise((r) => setTimeout(r, 500))
				const committed = await pageFrame.executeJavaScript(
					`(() => {
						const el = document.querySelectorAll('[data-caret-id="demo-name"]')[1]
						if (el.contentEditable !== 'true') return false
						el.textContent = 'Aurora Loafer'
						el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
						return true
					})()`,
				)
				if (!committed) return { error: "the row never became contentEditable" }

				return { ok: true }
			} catch (err) {
				return { error: err instanceof Error ? err.message : String(err) }
			}
		})

		assert(!("error" in outcome) || !outcome.error, `driving the row edit failed: ${(outcome as any).error}`)

		await waitFor(
			"the row edit to land in the DATA literal",
			async () => {
				const source = await fs.readFile(pagePath, "utf-8").catch(() => "")
				return source.includes('"Aurora Loafer"') ? true : null
			},
			20000,
		)
		const after = await fs.readFile(pagePath, "utf-8")
		assert(after.includes('"Monolith Trainer"'), "item 1 was touched — the edit did not stay on its row")
		assert(after.includes("{product.name}"), "the TEMPLATE was rewritten — content must go to the data, not the JSX")
		assert(!after.includes("Aurora Slip-on"), "the old value survived — the data write missed")

		// Leave the canvas on its grid: scenarios that "reuse the focused frame"
		// (bo's home edits) must not inherit the list page. This exact pollution
		// cost a full-suite run.
		await app!.evaluate(async ({ BrowserWindow }) => {
			const win = BrowserWindow.getAllWindows()[0]
			const views = (win?.contentView?.children ?? []) as any[]
			const canvas = views.find((v) => v.webContents && !v.webContents.isDestroyed())
			await canvas?.webContents
				.executeJavaScript(`((document.querySelector('button[title="Back to canvas"]')) || {click(){}}).click(), true`)
				.catch(() => {})
		})

		return `row 2's text landed in the data literal ("Aurora Loafer"), template and item 1 untouched`
	})

	await scenario("cf. a shader component renders real moving pixels in the shell, no model anywhere", async () => {
		// The runner template is a string until a project runs it; this is where
		// it runs. Seeded exactly the way acceptShader writes it — the shared lib
		// runner plus a small instance whose knobs are literal props — then
		// rendered isolated and captured, asserting live pixels rather than a
		// mounted element: a canvas that exists but never draws is the exact
		// failure a template slip produces.
		const caretDir = path.join(fixture, ".caret")
		const { SHADER_RUNNER_SOURCE } = await import("../src/core/design/authoring/shader-runner")
		await fs.mkdir(path.join(caretDir, "lib"), { recursive: true })
		await fs.writeFile(path.join(caretDir, "lib", "CaretShader.tsx"), SHADER_RUNNER_SOURCE)

		await fs.mkdir(path.join(caretDir, "components", "shaders"), { recursive: true })
		await fs.writeFile(
			path.join(caretDir, "components", "shaders", "glow.tsx"),
			`import CaretShader from "../../lib/CaretShader"

const FRAGMENT = \`vec4 caretMain(vec2 uv) {
	float aspect = u_resolution.x / u_resolution.y;
	vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
	vec3 n = caretReliefNormal(p * u_scale, u_time * u_speed, 1.5);
	vec2 s = caretShade(n, vec3(-0.7, 0.55, 0.28), 40.0);
	vec3 col = caretPalette(pow(s.x, 1.5), u_shadow, u_base, u_light);
	return vec4(col + s.y * u_light * 0.6, 1.0);
}\`

export default function GlowShader({ className }: { className?: string }) {
	return (
		<CaretShader
			fragment={FRAGMENT}
			uniforms={{
				u_speed: 0.35, // Speed
				u_scale: 1.1, // Form scale
				u_shadow: "#05061a", // Shadow
				u_base: "#1d2bd6", // Base
				u_light: "#a78bfa", // Light
			}}
			className={className}
		/>
	)
}
`,
		)

		const pageDir = path.join(caretDir, "pages", "shader-demo")
		await fs.mkdir(pageDir, { recursive: true })
		await fs.writeFile(
			path.join(pageDir, "index.tsx"),
			`import GlowShader from "../../components/shaders/glow"

export default function ShaderDemo() {
  return (
    <div className="min-h-screen bg-black p-8">
      <GlowShader className="h-[420px] w-[640px]" />
    </div>
  )
}
`,
		)
		await fs.writeFile(
			path.join(pageDir, "meta.json"),
			JSON.stringify({ id: "shader-demo", title: "Shader Demo", type: "page", states: [], tags: [] }),
		)

		// Rendered isolated in a fresh hidden window, captured twice with time in
		// between — pixels must exist AND move, because the runner's whole promise
		// is a LIVE background, and a frozen first frame would pass a single shot.
		const outcome = await waitFor(
			"the shader page to render moving pixels",
			async () =>
				app!.evaluate(async ({ BrowserWindow }) => {
					// The canvas is a WebContentsView CHILD of the window, not a window —
					// the same trap ce's poll fell into.
					const win = BrowserWindow.getAllWindows()[0]
					const views = (win?.contentView?.children ?? []) as any[]
					const source = views
						.map((v) => (v.webContents && !v.webContents.isDestroyed() ? v.webContents.getURL() : ""))
						.find((u: string) => u.startsWith("http://127.0.0.1"))
					if (!source) return null
					const base = new URL(source).origin
					const probe = new BrowserWindow({
						show: false,
						width: 900,
						height: 600,
						paintWhenInitiallyHidden: true,
						webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
					})
					try {
						await probe.loadURL(`${base}?page=shader-demo&isolated=1`)
						await probe.webContents.executeJavaScript(
							`new Promise((r) => { const check = () => { const c = document.querySelector("canvas"); if (c && c.width > 0) requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 250))); else setTimeout(check, 200) }; check() })`,
						)
						const a = await probe.webContents.capturePage()
						await new Promise((r) => setTimeout(r, 450))
						const b = await probe.webContents.capturePage()
						const bitsA = a.getBitmap()
						const bitsB = b.getBitmap()
						let blank = true
						for (let i = 4; i < bitsA.length; i += 4) {
							if (bitsA[i] !== bitsA[0] || bitsA[i + 1] !== bitsA[1] || bitsA[i + 2] !== bitsA[2]) {
								blank = false
								break
							}
						}
						let moved = false
						for (let i = 0; i < bitsA.length && !moved; i += 4) {
							if (Math.abs(bitsA[i] - bitsB[i]) > 3) moved = true
						}
						return { blank, moved }
					} catch (err) {
						return { error: String(err instanceof Error ? err.message : err) }
					} finally {
						if (!probe.isDestroyed()) probe.destroy()
					}
				}),
			120_000,
		)
		assert(!("error" in outcome), `the shader page did not render: ${(outcome as any).error}`)
		assert(!(outcome as any).blank, "the shader canvas painted nothing — the runner drew a blank")
		assert((outcome as any).moved, "the shader pixels are frozen — the animation loop never advanced")

		return "the hand-seeded shader component painted and animated in the real shell"
	})

	await scenario("bw. an agent reads and writes the same Params over MCP", async () => {
		// The shared human/agent surface, closed end to end: get_params resolves
		// the subtitle the way the user's panel does — naming its token binding —
		// and set_param lands the same minimal splice the panel writes, on disk.
		assert(discovery, "no discovery record (scenario b must run first)")
		await openMcpSession(discovery.url, discovery.token)

		const read = await callMcp(discovery.url, discovery.token, {
			jsonrpc: "2.0",
			id: 71,
			method: "tools/call",
			params: { name: "get_params", arguments: { pageId: "home", caretId: "hero-subtitle" } },
		})
		const readText = await read.text()
		assert(
			readText.includes("brand-500"),
			`get_params did not name the subtitle's token binding. Server said: ${readText.slice(0, 400)}`,
		)

		const write = await callMcp(discovery.url, discovery.token, {
			jsonrpc: "2.0",
			id: 72,
			method: "tools/call",
			params: {
				name: "set_param",
				arguments: { pageId: "home", caretId: "hero-subtitle", property: "margin-top", raw: "12px" },
			},
		})
		const writeText = await write.text()
		// The reply is pretty-printed inside the SSE frame — assert on the error
		// flag and the echoed param, not on JSON spacing.
		assert(
			!writeText.includes('"isError":true') && writeText.includes("margin-top"),
			`set_param did not succeed. Server said: ${writeText.slice(0, 400)}`,
		)

		const pagePath = path.join(fixture, ".caret", "pages", "home", "index.tsx")
		await waitFor(
			"the agent's param write to land in the page file",
			async () => {
				const source = await fs.readFile(pagePath, "utf-8").catch(() => "")
				return source.includes("mt-[12px]") ? true : null
			},
			10000,
		)

		// A refusal must be typed, not a shrug.
		const missing = await callMcp(discovery.url, discovery.token, {
			jsonrpc: "2.0",
			id: 73,
			method: "tools/call",
			params: {
				name: "set_param",
				arguments: { pageId: "home", caretId: "no-such-element", property: "padding", raw: "1px" },
			},
		})
		const missingText = await missing.text()
		assert(
			missingText.includes("caret-id"),
			`a missing element did not refuse with its cause. Server said: ${missingText.slice(0, 300)}`,
		)

		return `get_params named the token binding; set_param spliced mt-[12px] onto the subtitle; a bad target refused with its cause`
	})

	await scenario("bx. the mapping is recorded over MCP and drift is a hash comparison, both ways", async () => {
		// Phase 9's bookkeeping loop, deterministically: an agent reports which
		// app file a design page translated into, drift reads clean, then an
		// app-side edit turns into 'app-drift' naming the file, a design-side
		// edit turns it into 'conflict', and the proposal trigger refuses
		// non-cases with their cause.
		assert(discovery, "no MCP discovery record")
		await openMcpSession(discovery.url, discovery.token)

		const appFile = path.join(fixture, "src", "checkout-view.tsx")
		await fs.writeFile(appFile, "export const CheckoutView = () => <div>translated v1</div>\n")

		const report = await callMcp(discovery.url, discovery.token, {
			jsonrpc: "2.0",
			id: 91,
			method: "tools/call",
			params: {
				name: "report_sync_mapping",
				arguments: {
					mappings: [{ designPath: ".caret/pages/home/index.tsx", appPaths: ["src/checkout-view.tsx"] }],
				},
			},
		})
		const reportText = await report.text()
		assert(
			reportText.includes('"recorded": 1') || reportText.includes('\\"recorded\\": 1'),
			`mapping not recorded: ${reportText.slice(0, 300)}`,
		)

		const clean = await callMcp(discovery.url, discovery.token, {
			jsonrpc: "2.0",
			id: 92,
			method: "tools/call",
			params: { name: "get_drift", arguments: {} },
		})
		const cleanText = await clean.text()
		assert(
			cleanText.includes('"clean": 1') || cleanText.includes('\\"clean\\": 1'),
			`expected a clean mapping: ${cleanText.slice(0, 300)}`,
		)

		// The app walks away.
		await fs.writeFile(appFile, "export const CheckoutView = () => <div>edited directly in the app</div>\n")
		const drifted = await callMcp(discovery.url, discovery.token, {
			jsonrpc: "2.0",
			id: 93,
			method: "tools/call",
			params: { name: "get_drift", arguments: {} },
		})
		const driftedText = await drifted.text()
		assert(
			(driftedText.includes('"appDrift": 1') || driftedText.includes('\\"appDrift\\": 1')) &&
				driftedText.includes("checkout-view"),
			`app drift was not detected by hash: ${driftedText.slice(0, 400)}`,
		)

		// The design moves too — now it is a conflict, and nothing merges it.
		const pagePath = path.join(fixture, ".caret", "pages", "home", "index.tsx")
		const page = await fs.readFile(pagePath, "utf-8")
		await fs.writeFile(pagePath, `${page}\n{/* moved after mapping */}\n`)
		const conflicted = await callMcp(discovery.url, discovery.token, {
			jsonrpc: "2.0",
			id: 94,
			method: "tools/call",
			params: { name: "get_drift", arguments: {} },
		})
		const conflictedText = await conflicted.text()
		assert(
			conflictedText.includes('"conflicts": 1') || conflictedText.includes('\\"conflicts\\": 1'),
			`both-sides movement did not classify as conflict: ${conflictedText.slice(0, 400)}`,
		)

		// Restore BOTH sides — scenarios between here and by (ff/gg sync flows)
		// must not inherit a conflicted mapping, or their forward sync correctly
		// holds home back and their plan never starts. by re-creates its own
		// drift when it runs.
		await fs.writeFile(pagePath, page)
		await fs.writeFile(appFile, "export const CheckoutView = () => <div>translated v1</div>\n")
		const restored = await callMcp(discovery.url, discovery.token, {
			jsonrpc: "2.0",
			id: 98,
			method: "tools/call",
			params: { name: "get_drift", arguments: {} },
		})
		const restoredText = await restored.text()
		assert(
			restoredText.includes('"clean": 1') || restoredText.includes('\\"clean\\": 1'),
			`the mapping did not read clean after restore: ${restoredText.slice(0, 300)}`,
		)
		const notDrifted = await callMcp(discovery.url, discovery.token, {
			jsonrpc: "2.0",
			id: 95,
			method: "tools/call",
			params: { name: "propose_design_update", arguments: { designPath: ".caret/tokens/foundation.json" } },
		})
		const notDriftedText = await notDrifted.text()
		assert(notDriftedText.includes("not a page"), `a non-page did not refuse with its cause: ${notDriftedText.slice(0, 300)}`)

		return `mapping recorded; clean → app-drift (file named) → conflict → restored to clean; non-page proposal refused with its cause`
	})

	await scenario("bz. a real drag in the app commits a resize to the page source", async () => {
		// Phase 10's host round trip, which only this suite can cover: a drag on
		// the real handles in the real window, released, landing as a class in
		// the page file — and undoable as one step like every other gesture.
		const caretDir = path.join(fixture, ".caret")
		const pagePath = path.join(caretDir, "pages", "home", "index.tsx")
		const before = await fs.readFile(pagePath, "utf-8")
		assert(!/w-\[\d+px\]/.test(before), "the fixture page already carries a pixel width")

		const outcome = await app!.evaluate(async ({ BrowserWindow }) => {
			let canvas: any = null
			const viewDeadline = Date.now() + 60000
			while (Date.now() < viewDeadline && !canvas) {
				const win = BrowserWindow.getAllWindows()[0]
				const views = (win?.contentView?.children ?? []) as any[]
				const found = views.find((v) => v.webContents && !v.webContents.isDestroyed())
				if (found && found.webContents.getURL().startsWith("http://127.0.0.1")) canvas = found
				if (!canvas) await new Promise((r) => setTimeout(r, 500))
			}
			if (!canvas) return { error: "the canvas view never mounted" }
			const wc = canvas.webContents

			try {
				// Open Home from the grid rather than inheriting a focused page.
				await wc.executeJavaScript(
					`((document.querySelector('button[title="Back to canvas"]')) || {click(){}}).click(), true`,
				)
				const findHome = `(() => {
					const frames = Array.from(document.querySelectorAll('.caret-canvas-frame'))
					return frames.find((f) => f.querySelector('.caret-canvas-frame-title')?.textContent?.trim() === 'Home') ?? null
				})()`
				let deadline = Date.now() + 60000
				let ready = false
				while (Date.now() < deadline && !ready) {
					ready = await wc.executeJavaScript(`!!${findHome}`).catch(() => false)
					if (!ready) await new Promise((r) => setTimeout(r, 500))
				}
				if (!ready) return { error: "the Home card never appeared" }
				await wc.executeJavaScript(`(${findHome}).click(), true`)

				let pageFrame: any = null
				deadline = Date.now() + 30000
				while (Date.now() < deadline && !pageFrame) {
					pageFrame =
						wc.mainFrame.frames.find((f: any) => f.url.includes("mode=focused") && f.url.includes("page=home")) ??
						null
					if (!pageFrame) await new Promise((r) => setTimeout(r, 250))
				}
				if (!pageFrame) return { error: "the focused Home page never became a frame" }

				// The focused iframe is SCALED (a 1440px page shown in a narrower
				// view), so an in-page rect is not a mouse coordinate: every point
				// must be mapped through the measured scale, or a click aimed at an
				// 8px handle lands hundreds of pixels away while a click aimed at a
				// wide paragraph still happens to hit. The subtitle click surviving
				// unscaled is exactly what hid this — selection worked, the drag
				// never did.
				const offset = await wc.executeJavaScript(
					`(() => { const r = document.querySelector('.caret-focused-iframe').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width } })()`,
				)
				const innerWidth = await pageFrame.executeJavaScript(`window.innerWidth`)
				const scale = innerWidth > 0 ? offset.w / innerWidth : 1
				// Inlined at each use — a named helper const in here gets esbuild's
				// __name wrapper, which does not exist on the Electron side (see the
				// harness notes; this file has hit that exact ReferenceError).

				// Select the subtitle, which the handles attach to.
				const subtitleRaw = await pageFrame.executeJavaScript(
					`(() => { const el = document.querySelector('[data-caret-id="hero-subtitle"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`,
				)
				if (!subtitleRaw) return { error: "no subtitle on the page" }
				const at = {
					x: Math.round(offset.x + subtitleRaw.x * scale),
					y: Math.round(offset.y + subtitleRaw.y * scale),
				}

				let handles = false
				deadline = Date.now() + 30000
				while (Date.now() < deadline && !handles) {
					pageFrame = wc.mainFrame.frames.find((f: any) => f.url.includes("page=home")) ?? pageFrame
					wc.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y })
					await new Promise((r) => setTimeout(r, 200))
					wc.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 })
					wc.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount: 1 })
					const handleDeadline = Date.now() + 4000
					while (Date.now() < handleDeadline && !handles) {
						handles = await pageFrame
							.executeJavaScript(`!!document.querySelector('#caret-resize-handles')`)
							.catch(() => false)
						if (!handles) await new Promise((r) => setTimeout(r, 250))
					}
				}
				if (!handles) {
					const diag = await pageFrame
						.executeJavaScript(
							`(() => { const p = document.querySelector('#caret-param-panel'); return { panel: !!p, panelId: p?.dataset?.caretId ?? null, grab: !!window.__REACT_GRAB__, ids: document.querySelectorAll('[data-caret-id]').length } })()`,
						)
						.catch(() => null)
					return { error: "the resize handles never appeared on selection — diag: " + JSON.stringify(diag) }
				}

				// Drag the right-edge handle with a real mouse — and CHECK the grab
				// took. A mouseDown that misses the handle (these coordinates cross
				// a scaled iframe, see the harness notes) produces no drag, no
				// commit, and thirty silent seconds; one full run failed exactly
				// that way. The committed width lands back in the DOM as a w-[..px]
				// class within about a second of a real drag, so each attempt polls
				// for it and a miss retries the grab instead of reporting nothing.
				let dragged = false
				for (let attempt = 0; attempt < 3 && !dragged; attempt++) {
					const handleRaw = await pageFrame.executeJavaScript(
						`(() => { const h = document.querySelector('#caret-resize-handles'); if (!h) return null; const r = h.children[0].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`,
					)
					if (!handleRaw) return { error: "the resize handles disappeared before the drag" }
					const from = {
						x: Math.round(offset.x + handleRaw.x * scale),
						y: Math.round(offset.y + handleRaw.y * scale),
					}
					wc.sendInputEvent({ type: "mouseMove", x: from.x, y: from.y })
					wc.sendInputEvent({ type: "mouseDown", x: from.x, y: from.y, button: "left", clickCount: 1 })
					for (let step = 1; step <= 6; step++) {
						wc.sendInputEvent({
							type: "mouseMove",
							x: from.x - Math.round((90 * step) / 6),
							y: from.y,
							button: "left",
							buttons: 1,
						})
						await new Promise((r) => setTimeout(r, 40))
					}
					wc.sendInputEvent({ type: "mouseUp", x: from.x - 90, y: from.y, button: "left", clickCount: 1 })

					const landedDeadline = Date.now() + 6000
					while (Date.now() < landedDeadline && !dragged) {
						dragged = await pageFrame
							.executeJavaScript(
								`(() => { const el = document.querySelector('[data-caret-id="hero-subtitle"]'); return !!el && /w-\\[\\d+px\\]/.test(el.className) })()`,
							)
							.catch(() => false)
						if (!dragged) await new Promise((r) => setTimeout(r, 300))
					}
				}
				if (!dragged)
					return {
						error: `three drags on the handle produced no committed width in the DOM (iframe scale ${scale.toFixed(3)}, iframe ${Math.round(offset.w)}px wide showing innerWidth ${innerWidth}px)`,
					}

				return { ok: true }
			} catch (err) {
				return { error: err instanceof Error ? err.message : String(err) }
			}
		})

		assert(!("error" in outcome) || !outcome.error, `driving the resize failed: ${(outcome as any).error}`)

		const landed = await waitFor(
			"the resize to land in the page source",
			async () => {
				const source = await fs.readFile(pagePath, "utf-8").catch(() => "")
				const match = /w-\[(\d+)px\]/.exec(source)
				return match ? match[0] : null
			},
			30_000,
		)
		const after = await fs.readFile(pagePath, "utf-8")
		assert(
			/data-caret-id="hero-subtitle"[^>]*w-\[\d+px\]/s.test(after) ||
				/w-\[\d+px\][^>]*data-caret-id="hero-subtitle"/s.test(after),
			"the width landed, but not on the element that was dragged",
		)

		return `a real drag committed ${landed} onto the subtitle through the host`
	})

	await scenario("bo. the same correction made twice raises an offer, and accepting it promotes the token", async () => {
		// Correction capture end to end: two elements bound to brand-600, each
		// hand-recoloured to the same value through the real Edit color action.
		// The second edit crosses the threshold; a notification appears in the
		// chrome; clicking "Change the token" repoints the foundation and
		// re-binds BOTH detached elements.
		const caretDir = path.join(fixture, ".caret")
		const foundationPath = path.join(caretDir, "tokens", "foundation.json")
		const pagePath = path.join(caretDir, "pages", "home", "index.tsx")

		const foundation = JSON.parse(await fs.readFile(foundationPath, "utf-8"))
		foundation.color.brand.scale = { ...foundation.color.brand.scale, "600": "#0066db" }
		await fs.writeFile(foundationPath, JSON.stringify(foundation, null, 2))
		await waitFor(
			"the theme to define brand-600",
			async () => {
				const css = await fs.readFile(path.join(caretDir, "caret-theme.css"), "utf-8").catch(() => "")
				return css.includes("--color-brand-600: #0066db;") ? true : null
			},
			30000,
		)

		let source = await fs.readFile(pagePath, "utf-8")
		source = source.replace(/className="text-5xl font-bold [^"]*"/, 'className="text-5xl font-bold text-brand-600"')
		if (!source.includes("hero-link")) {
			source = source.replace(
				/(<p data-caret-id="hero-subtitle"[^\n]*\n)/,
				`$1      <a data-caret-id="hero-link" className="mt-2 block text-brand-600">Learn more</a>\n`,
			)
		}
		await fs.writeFile(pagePath, source)

		const outcome = await app!.evaluate(async ({ BrowserWindow }) => {
			// Same serialization constraints as bn: no function-valued consts.
			let canvas: any = null
			const viewDeadline = Date.now() + 120000
			while (Date.now() < viewDeadline && !canvas) {
				const win = BrowserWindow.getAllWindows()[0]
				const views = (win?.contentView?.children ?? []) as any[]
				const found = views.find((v) => v.webContents && !v.webContents.isDestroyed())
				if (found && found.webContents.getURL().startsWith("http://127.0.0.1")) canvas = found
				if (!canvas) await new Promise((r) => setTimeout(r, 500))
			}
			if (!canvas) return { error: "the canvas view never mounted" }
			const wc = canvas.webContents

			try {
				let pageFrame: any = wc.mainFrame.frames.find((f: any) => f.url.includes("mode=focused")) ?? null
				if (!pageFrame) {
					let deadline0 = Date.now() + 30000
					let ready = false
					while (Date.now() < deadline0 && !ready) {
						ready = await wc.executeJavaScript(`!!document.querySelector('.caret-canvas-frame')`).catch(() => false)
						if (!ready) await new Promise((r) => setTimeout(r, 250))
					}
					if (!ready) return { error: "no page card ever appeared on the canvas" }
					await wc.executeJavaScript(`(document.querySelector('.caret-canvas-frame')).click(), true`)
					deadline0 = Date.now() + 30000
					while (Date.now() < deadline0 && !pageFrame) {
						pageFrame = wc.mainFrame.frames.find((f: any) => f.url.includes("mode=focused")) ?? null
						if (!pageFrame) await new Promise((r) => setTimeout(r, 250))
					}
					if (!pageFrame) return { error: "the focused page never became a frame of the canvas" }
				}

				const offset = await wc.executeJavaScript(
					`(() => { const r = document.querySelector('.caret-focused-iframe').getBoundingClientRect(); return { x: r.x, y: r.y } })()`,
				)

				for (const caretId of ["hero-title", "hero-link"]) {
					// Wait for the bound class (HMR-delivered), re-resolving the frame.
					const deadline = Date.now() + 30000
					let bound = false
					while (Date.now() < deadline && !bound) {
						pageFrame = wc.mainFrame.frames.find((f: any) => f.url.includes("mode=focused")) ?? pageFrame
						bound = await pageFrame
							.executeJavaScript(
								`(() => { const el = document.querySelector('[data-caret-id="${caretId}"]'); return !!el && el.className.includes('text-brand-600') })()`,
							)
							.catch(() => false)
						if (!bound) await new Promise((r) => setTimeout(r, 250))
					}
					if (!bound) return { error: `${caretId} never appeared bound to brand-600` }
					await pageFrame.executeJavaScript(`((window).__REACT_GRAB__?.activate?.(), true)`).catch(() => {})
					await new Promise((r) => setTimeout(r, 600))

					const target = await pageFrame.executeJavaScript(
						`(() => { const r = document.querySelector('[data-caret-id="${caretId}"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`,
					)
					const at = { x: Math.round(offset.x + target.x), y: Math.round(offset.y + target.y) }

					let menuClicked = false
					for (let attempt = 0; attempt < 5 && !menuClicked; attempt++) {
						pageFrame = wc.mainFrame.frames.find((f: any) => f.url.includes("mode=focused")) ?? pageFrame
						wc.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y })
						await new Promise((r) => setTimeout(r, 300))
						wc.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "right", clickCount: 1 })
						wc.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "right", clickCount: 1 })
						const menuDeadline = Date.now() + 4000
						while (Date.now() < menuDeadline && !menuClicked) {
							menuClicked = await pageFrame
								.executeJavaScript(
									`(() => {
										const host = document.querySelector('[data-react-grab]')
										const root = host && host.shadowRoot
										if (!root) return false
										const items = Array.from(root.querySelectorAll('button, [role="menuitem"], div'))
										const item = items.find((n) => n.textContent && n.textContent.trim() === 'Edit color')
										if (!item) return false
										item.click()
										return true
									})()`,
								)
								.catch(() => false)
							if (!menuClicked) await new Promise((r) => setTimeout(r, 250))
						}
					}
					if (!menuClicked) return { error: `react-grab's menu never offered Edit color on ${caretId}` }

					const deadline2 = Date.now() + 8000
					let fed = false
					while (Date.now() < deadline2 && !fed) {
						pageFrame = wc.mainFrame.frames.find((f: any) => f.url.includes("mode=focused")) ?? pageFrame
						fed = await pageFrame
							.executeJavaScript(
								`(() => {
									const input = document.querySelector('#caret-color-popover [data-color-hex]')
									if (!input) return false
									const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
									setter.call(input, '#654321')
									input.dispatchEvent(new Event('input', { bubbles: true }))
									input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
									return true
								})()`,
							)
							.catch(() => false)
						if (!fed) await new Promise((r) => setTimeout(r, 250))
					}
					if (!fed) return { error: `Edit color never opened the colour popover on ${caretId}` }
					await new Promise((r) => setTimeout(r, 800))
				}

				return { done: true }
			} catch (err) {
				return { error: err instanceof Error ? err.message : String(err) }
			}
		})
		assert(!("error" in outcome) || !outcome.error, `driving the two edits failed: ${(outcome as any).error}`)

		// The offer lands in the chrome window; the click is a real click.
		const offer = chrome.locator('[data-testid="notification-stack"]', {
			hasText: "brand-600",
		})
		await offer.waitFor({ timeout: 20000 })
		await chrome.getByRole("button", { name: "Change the token" }).click()

		await waitFor(
			"the correction to repoint brand-600",
			async () => {
				const f = JSON.parse(await fs.readFile(foundationPath, "utf-8").catch(() => "{}"))
				return f?.color?.brand?.scale?.["600"] === "#654321" ? true : null
			},
			20000,
		)
		await waitFor(
			"both detached elements to re-bind",
			async () => {
				const page = await fs.readFile(pagePath, "utf-8").catch(() => "")
				const rebound = (page.match(/text-brand-600/g) ?? []).length >= 2 && !page.includes("text-[#654321]")
				return rebound ? true : null
			},
			20000,
		)

		return "two hand-corrections raised the offer; accepting repointed brand-600 and re-bound both elements"
	})

	await scenario("bp. a promoted rule reaches the always-on rules files", async () => {
		// The durable half of correction capture: `.caret/rules.json` is versioned
		// design content, and however it changes — Caret's promote, a hand edit, a
		// git pull — the generated rules files must carry it. Written externally
		// here, which is the hardest of the three paths (needs the watcher).
		const rulesPath = path.join(fixture, ".caret", "rules.json")
		const ruleText = "Card grids use 24px gaps, never 16px"
		await fs.writeFile(
			rulesPath,
			JSON.stringify(
				{ version: 1, rules: [{ id: "r1", text: ruleText, source: "manual", addedAt: new Date().toISOString() }] },
				null,
				2,
			),
		)

		await waitFor(
			"AGENTS.md to carry the standing correction",
			async () => {
				const agents = await fs.readFile(path.join(fixture, "AGENTS.md"), "utf-8").catch(() => "")
				return agents.includes("Standing corrections") && agents.includes(ruleText) ? true : null
			},
			30000,
		)

		// Versioned, not ignored: the scaffold's gitignore must not swallow it.
		const gitignore = await fs.readFile(path.join(fixture, ".caret", ".gitignore"), "utf-8")
		assert(!gitignore.split("\n").some((l) => l.trim() === "rules.json"), ".caret/.gitignore must not ignore rules.json")

		return `an externally written rules.json reached AGENTS.md ("${ruleText}")`
	})

	await scenario("br. the design checks find planted defects, and the canvas shows them unasked", async () => {
		// The acceptance checker in the shipped app: a page with planted slop
		// tells lands (external write — the healer's path), an agent asks for the
		// checks over MCP and gets the findings, and the canvas chip surfaces
		// them without anyone having called anything.
		assert(discovery, "no MCP discovery record")
		const flawedDir = path.join(fixture, ".caret", "pages", "flawed")
		await fs.mkdir(flawedDir, { recursive: true })
		await fs.writeFile(
			path.join(flawedDir, "index.tsx"),
			`export default function Flawed() {
  return (
    <div className="min-h-screen bg-white p-8">
      <h1 className="text-2xl font-bold text-zinc-900">Flawed</h1>
      <div style={{ width: 320, height: 200, background: "#d4d4d4" }} />
      <img src="/caret-assets/Hero Shot@2x.png" style={{ width: 600 }} />
      <div>
        <div className="p-4">Exactly the same testimonial text repeated here</div>
        <div className="p-4">Exactly the same testimonial text repeated here</div>
        <div className="p-4">A different card so the container has three children</div>
      </div>
    </div>
  )
}
`,
		)
		await fs.writeFile(
			path.join(flawedDir, "meta.json"),
			JSON.stringify({ id: "flawed", title: "Flawed", type: "page", states: [], tags: [] }),
		)

		// The agent's half: run_design_checks over the real MCP endpoint. Polled:
		// a page written moments ago is not routable until Vite reloads the
		// router module, and a check against the "page not found" card honestly
		// finds nothing — the checker is eventually consistent with the render.
		let lastFound: string[] = []
		const checksFound = await waitFor(
			"the planted tells to be found once the page renders",
			async () => {
				const response = await callMcp(discovery!.url, discovery!.token, {
					jsonrpc: "2.0",
					id: 71,
					method: "tools/call",
					params: { name: "run_design_checks", arguments: { pageId: "flawed" } },
				})
				const body = await response.text()
				const payloadMatch = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body)
				if (!payloadMatch) return null
				const parsed = JSON.parse(JSON.parse(`"${payloadMatch[1]}"`))
				if (!parsed.ok) return null
				const found = new Set<string>((parsed.findings as Array<{ check: string }>).map((f) => f.check))
				lastFound = [...found]
				const planted = ["placeholder-box", "missing-alt", "image-upscaled", "identical-cards"]
				return planted.every((check) => found.has(check)) ? found : null
			},
			// Covers a cold fixture: the design preview may still be npm-installing
			// when this scenario runs in a subset, and the checker honestly reports
			// render-unavailable until it is up.
			300_000,
		).catch((err) => {
			throw new Error(`${err} — last findings: ${JSON.stringify(lastFound)}`)
		})

		// The results landed where the canvas reads them.
		const stored = JSON.parse(await fs.readFile(path.join(fixture, ".caret", ".checks-results.json"), "utf-8"))
		assert(
			stored.pages.some((p: { pageId: string; findings: unknown[] }) => p.pageId === "flawed" && p.findings.length > 0),
			"the results file does not carry the flawed page's findings",
		)

		// The canvas chip, unasked: click it, the panel names the page.
		const chip = await app!.evaluate(async ({ BrowserWindow }) => {
			const win = BrowserWindow.getAllWindows()[0]
			const views = (win?.contentView?.children ?? []) as any[]
			const canvas = views.find((v) => v.webContents && !v.webContents.isDestroyed())
			if (!canvas) return { error: "no canvas view" }
			const wc = canvas.webContents
			// The chip lives on the grid view; an earlier scenario may have left a
			// page focused. Going back is exactly what a user would do to see it.
			await wc
				.executeJavaScript(
					`(() => { const b = document.querySelector('.caret-focused-toolbar-btn'); if (b) b.click(); return true })()`,
				)
				.catch(() => {})
			const deadline = Date.now() + 30000
			let text = ""
			while (Date.now() < deadline && !text) {
				text = await wc
					.executeJavaScript(`(document.querySelector('[data-testid="design-checks-chip"]') || {}).textContent || ""`)
					.catch(() => "")
				if (!text) await new Promise((r) => setTimeout(r, 400))
			}
			if (!text) return { error: "the checks chip never appeared on the canvas" }
			await wc.executeJavaScript(`(document.querySelector('[data-testid="design-checks-chip"]')).click(), true`)
			const panel = await wc
				.executeJavaScript(`(document.querySelector('[data-testid="design-checks-panel"]') || {}).textContent || ""`)
				.catch(() => "")
			return { text, panel }
		})
		assert(!("error" in chip) || !chip.error, `canvas chip: ${(chip as any).error}`)
		const { text, panel } = chip as { text: string; panel: string }
		assert(/\d+ design check finding/.test(text), `unexpected chip text: "${text}"`)
		assert(panel.includes("flawed"), `the panel does not name the flawed page: "${panel.slice(0, 200)}"`)

		await fs.rm(flawedDir, { recursive: true, force: true })
		return `MCP returned ${checksFound.size} check kinds incl. all four planted; canvas chip "${text.trim()}" opened a panel naming the page`
	})

	await scenario(
		"bs. a catalog import is auto-supplied on consent, and the budget refuses a second signature piece",
		async () => {
			// The 7.5 loop end to end: an externally written page imports a catalog
			// component by its documented path; the healer routes it to auto-supply;
			// the consent prompt is answered with a real click; the vendored source
			// lands with its licence, lock entry and deps; the rules index marks it
			// installed. Then the restraint budget: two signature imports on one page
			// — the first is supplied, the second is refused and flagged as an error.
			const caretDir = path.join(fixture, ".caret")
			const pageDir = path.join(caretDir, "pages", "catalogdemo")
			await fs.mkdir(pageDir, { recursive: true })
			await fs.writeFile(
				path.join(pageDir, "meta.json"),
				JSON.stringify({ id: "catalogdemo", title: "Catalog demo", type: "page", states: ["default"], tags: [] }),
			)
			await fs.writeFile(
				path.join(pageDir, "index.tsx"),
				`import { Marquee } from "../../components/catalog/magicui/marquee"

export default function CatalogDemo() {
  return (
    <div className="min-h-screen bg-white p-8">
      <Marquee><span>One</span><span>Two</span></Marquee>
    </div>
  )
}
`,
			)

			// Consent arrives as a notification in the chrome; the click is real.
			await chrome.locator('[data-testid="notification-stack"]', { hasText: "Magic UI" }).waitFor({ timeout: 60_000 })
			await chrome.getByRole("button", { name: "Allow for this project" }).click()

			await waitFor(
				"the vendored component to land with its lock entry",
				async () => {
					const component = await fs
						.readFile(path.join(caretDir, "components", "catalog", "magicui", "marquee.tsx"), "utf-8")
						.catch(() => "")
					const lock = JSON.parse(
						await fs
							.readFile(path.join(caretDir, "components", "catalog", "catalog-lock.json"), "utf-8")
							.catch(() => "{}"),
					)
					const entry = (lock.installed ?? []).find(
						(e: { library: string; component: string }) => e.library === "magicui" && e.component === "marquee",
					)
					return component.length > 100 && entry && entry.origin.includes("magicuidesign/magicui@") ? true : null
				},
				120_000,
			)

			// The licence rides with the install, and the dep landed in the design layer.
			const licence = await fs.readFile(path.join(caretDir, "components", "catalog", "magicui", "LICENSE"), "utf-8")
			assert(licence.includes("MIT"), "the licence did not travel with the vendored source")
			const caretPkg = JSON.parse(await fs.readFile(path.join(caretDir, "package.json"), "utf-8"))
			assert(caretPkg.dependencies?.motion, "the component's dep was not added to the design layer")

			// The rules index knows.
			await waitFor(
				"the rules index to mark it installed",
				async () => {
					const agents = await fs.readFile(path.join(fixture, "AGENTS.md"), "utf-8").catch(() => "")
					return agents.includes("`magicui/marquee`") && agents.includes("(installed)") ? true : null
				},
				30_000,
			)

			// The budget: two signature imports; the consented library needs no second
			// prompt, the first signature piece is supplied, the second refused.
			await fs.writeFile(
				path.join(pageDir, "index.tsx"),
				`import { Marquee } from "../../components/catalog/magicui/marquee"
import { Particles } from "../../components/catalog/magicui/particles"
import PixelTrail from "../../components/catalog/fancy/pixel-trail"

export default function CatalogDemo() {
  return (
    <div className="min-h-screen bg-white p-8">
      <Particles />
      <PixelTrail />
      <Marquee><span>One</span><span>Two</span></Marquee>
    </div>
  )
}
`,
			)

			await waitFor(
				"the first signature component to be supplied",
				async () =>
					(await fs
						.readFile(path.join(caretDir, "components", "catalog", "magicui", "particles.tsx"), "utf-8")
						.catch(() => "")) !== ""
						? true
						: null,
				120_000,
			)

			// pixel-trail must NOT be supplied — the page already carries particles.
			// (fancy has never been consented either, but the budget check fires first
			// and is the thing this pins.)
			const pixelTrailLanded = await fs
				.access(path.join(caretDir, "components", "catalog", "fancy", "pixel-trail.tsx"))
				.then(() => true)
				.catch(() => false)
			assert(!pixelTrailLanded, "the budget did not stop a second signature component")

			// And the checker names it, over the same MCP surface an agent uses.
			assert(discovery, "no MCP discovery record")
			const findings = await waitFor(
				"run_design_checks to flag the budget breach",
				async () => {
					const response = await callMcp(discovery!.url, discovery!.token, {
						jsonrpc: "2.0",
						id: 81,
						method: "tools/call",
						params: { name: "run_design_checks", arguments: { pageId: "catalogdemo" } },
					})
					const body = await response.text()
					const payloadMatch = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body)
					if (!payloadMatch) return null
					const parsed = JSON.parse(JSON.parse(`"${payloadMatch[1]}"`))
					const checks = new Set((parsed.findings ?? []).map((f: { check: string }) => f.check))
					return checks.has("restraint-budget") ? [...checks] : null
				},
				60_000,
			)

			await fs.rm(pageDir, { recursive: true, force: true })
			return `marquee auto-supplied on a real consent click (licence + lock + deps + rules index); second signature piece refused; checker flagged restraint-budget (findings: ${findings.join(", ")})`
		},
	)

	await scenario("s. a canvas message reaches the host through the preload bridge", async () => {
		// The preload bridge replaced the VS Code postMessage relay and is written
		// from scratch. Nothing else here exercises it end to end. Post a message
		// the way the canvas does and assert the host acted on it — precompute
		// answers with a precompute-result, which only the host can produce.
		const replied = await app!.evaluate(async ({ BrowserWindow }) => {
			const win = BrowserWindow.getAllWindows()[0]
			const views = (win?.contentView?.children ?? []) as any[]
			const canvas = views.find((v) => v.webContents && !v.webContents.isDestroyed())
			if (!canvas) return "no canvas view"

			return canvas.webContents.executeJavaScript(`
				new Promise((resolve) => {
					const timer = setTimeout(() => resolve("timeout"), 15000)
					window.addEventListener("message", (e) => {
						if (e.data?.source === "caret-host" && e.data?.type === "precompute-result") {
							clearTimeout(timer)
							resolve("precompute-result")
						}
					})
					window.parent.postMessage(
						{ source: "caret-vite", type: "page-focused", payload: { filePath: "pages/home/index.tsx" } },
						"*",
					)
				})
			`)
		})

		assert(replied === "precompute-result", `the host did not answer through the bridge: ${replied}`)
		return "canvas → preload → IPC → host → back to the canvas, round-trip confirmed"
	})

	await scenario("k. sync refuses honestly with no agent connected", async () => {
		assert(discovery, "no discovery record")
		const { runSync } = await import("../src/core/design/sync/sync-orchestrator")
		const result = await runSync(fixture)
		assert(result.status === "no-agent", `expected "no-agent", got "${result.status}"`)
		// Naming the missing thing is not enough — the refusal has to say what to
		// do. It used to point at MCP agent settings, which would not have helped:
		// connecting an agent over MCP enables none of the outbound features.
		assert(result.message.includes("backend"), `the refusal does not name what is missing: ${result.message}`)
		assert(!/agent settings/i.test(result.message), "the refusal still points at MCP, which cannot carry outbound work")
		return `refused with: "${result.message.slice(0, 60)}…"`
	})

	// ── the coding backend ────────────────────────────────────────────────────
	//
	// Everything below is click-only from a profile that has never configured a
	// backend, and everything below spends real inference on a real model. These
	// are the scenarios that say whether "clicking things in Caret causes an agent
	// to do them" is true.

	await scenario("cc. with no backend, the chat refuses and names the fix", async () => {
		await ensureChatOpen(chrome)
		await chrome.waitForSelector('[data-testid="chat-no-backend"]', { timeout: 20_000 })

		const refusal = await chrome.textContent('[data-testid="chat-no-backend"]')
		assert(refusal?.includes("backend"), `the refusal does not name what is missing: ${refusal}`)
		// Naming the fix is the whole point: "no backend" alone tells nobody what
		// to do about it.
		assert(/Settings.*Backend/.test(refusal ?? ""), `the refusal does not say where to go: ${refusal}`)
		assert(await chrome.getByTestId("chat-input").isDisabled(), "the input is enabled with nothing behind it")

		await shot(chrome, "10-chat-no-backend")
		return `refused with: "${refusal?.trim().slice(0, 60)}…"`
	})

	await scenario("hh. the entry flow describes once and routes every door, with no model anywhere", async () => {
		// The tabs are gone: a re-run goes describe-first, then chooses how much
		// control the user wants. Runs here deliberately — before any backend is
		// chosen — because the routing itself must cost nothing and the manual
		// door must work with no model at all.
		//
		// `o` left a committed foundation, so Foundation opens on the DS view and
		// re-running is a deliberate act behind the blast-radius banner.
		await openDesignSystem(chrome)
		await chrome.click('[data-testid="ds-rerun"]')

		await chrome.waitForSelector('[data-testid="foundation-describe"]', { timeout: 20_000 })
		assert(
			(await chrome.getByTestId("foundation-rerun-notice").count()) === 1,
			"re-running over a committed foundation did not show the blast-radius banner",
		)
		const description = "A dashboard for technical support teams who triage tickets all day"
		await chrome.fill('[data-testid="foundation-describe"]', description)
		await chrome.click('[data-testid="foundation-describe-continue"]')
		await shot(chrome, "12-entry-chooser")

		// Both doors are on screen (the AI-led third door was removed 2026-08-31 —
		// silent decisions shipped a serif body and a null base size); the
		// interview needs a backend and must say so rather than pretend.
		for (const door of ["foundation-mode-collaborative", "foundation-mode-manual"]) {
			assert((await chrome.getByTestId(door).count()) === 1, `the chooser is missing ${door}`)
		}
		await chrome.click('[data-testid="foundation-mode-collaborative"]')
		await chrome.waitForSelector('[data-testid="wizard-needs-backend"]', { timeout: 30_000 })

		// Back around to the manual door, which needs nothing: re-entering the
		// surface resets the flow to the DS view (no interview is in flight).
		await openDesignSystem(chrome)
		await chrome.click('[data-testid="ds-rerun"]')
		await chrome.waitForSelector('[data-testid="foundation-describe"]', { timeout: 20_000 })
		await chrome.fill('[data-testid="foundation-describe"]', description)
		await chrome.click('[data-testid="foundation-describe-continue"]')
		await chrome.click('[data-testid="foundation-mode-manual"]')

		// The manual editor opens with the description already in the vibe step —
		// the entry flow's description feeds all three doors.
		const textarea = chrome.locator("textarea").first()
		await textarea.waitFor({ timeout: 20_000 })
		const prefilled = await textarea.inputValue()
		assert(
			prefilled.includes("triage tickets"),
			`the description did not prefill the manual editor: "${prefilled.slice(0, 60)}"`,
		)
		await shot(chrome, "13-entry-manual-prefilled")

		// Leave the surface where the suite expects it.
		await chrome.getByTestId("top-bar").getByRole("button", { name: "Foundation" }).click()
		return "describe → chooser showed both doors; the interview refused honestly; manual opened prefilled"
	})

	await scenario("jj. with no backend, the interview refuses honestly and its escape works", async () => {
		// The wizard is genuinely AI-run, so without a model it must not pretend —
		// it says what it needs and hands the user the token editor, rather than
		// dead-ending or faking an interview.
		await openDesignSystem(chrome)
		await chrome.click('[data-testid="ds-rerun"]')
		await chrome.waitForSelector('[data-testid="foundation-describe"]', { timeout: 20_000 })
		await chrome.fill('[data-testid="foundation-describe"]', "A quiet reading app for long-form essays")
		await chrome.click('[data-testid="foundation-describe-continue"]')
		await chrome.click('[data-testid="foundation-mode-collaborative"]')

		await chrome.waitForSelector('[data-testid="wizard-needs-backend"]', { timeout: 30_000 })
		await shot(chrome, "13-wizard-needs-backend")

		// The offered escape actually goes somewhere.
		await chrome.getByRole("button", { name: "Set tokens by hand" }).click()
		const textarea = chrome.locator("textarea").first()
		await textarea.waitFor({ timeout: 20_000 })

		// Leave the surface where the suite expects it.
		await chrome.getByTestId("top-bar").getByRole("button", { name: "Foundation" }).click()
		return "refused with the reason, and the manual door works"
	})

	await scenario("oo. a design-system section edits in place and the save regenerates the ramp", async () => {
		// The DS view's promise: see a token, change it where you see it, and the
		// derivation keeps every consequence in step — no model, no full editor.
		await openDesignSystem(chrome)
		await chrome.click('[data-testid="ds-edit-color"]')

		// The colour step mounts inline; drive its hex field to a new brand seed.
		const hexField = chrome.locator('[data-testid="ds-section-color"] input[placeholder="#000000"]')
		await hexField.waitFor({ timeout: 20_000 })
		await hexField.fill("#7c3aed")
		await hexField.press("Enter")
		await chrome.waitForTimeout(400)
		await shot(chrome, "13b-ds-inline-edit")
		await chrome.click('[data-testid="ds-save-color"]')

		const tokens = await waitFor(
			"the inline edit to land in foundation.json",
			async () => {
				const parsed = JSON.parse(await fs.readFile(path.join(fixture, ".caret", "tokens", "foundation.json"), "utf-8"))
				return parsed.color?.brand?.seed === "#7c3aed" ? parsed : null
			},
			30_000,
		)
		// The consequences moved with the choice: seed at 500, meta preserved,
		// on-colours recomputed against the new brand.
		assert(
			tokens.color.brand.scale?.["500"] === "#7c3aed",
			`brand-500 did not follow the new seed: ${tokens.color.brand.scale?.["500"]}`,
		)
		assert(tokens.meta?.committed === true, "meta was lost by an inline edit")
		assert(tokens.color.on?.brand, "on-brand was not recomputed")
		assert(tokens.border?.focusRing?.color === "#7c3aed", "the focus ring did not follow the brand")

		// Back on the view, the new swatch is what renders.
		await chrome.waitForSelector('[data-testid="ds-section-color"]', { timeout: 20_000 })
		const colorText = await chrome.textContent('[data-testid="ds-section-color"]')
		assert(colorText?.includes("#7c3aed"), "the DS view did not re-read the saved seed")

		// Leave the surface where the suite expects it.
		await chrome.getByTestId("top-bar").getByRole("button", { name: "Foundation" }).click()
		return "edited the brand seed in place; ramp, on-colours and focus ring all followed"
	})

	// Which model — if any — this run may spend. Resolved once, before the
	// backend scenarios, so they all skip together rather than half-running.
	const model = await resolveVerifyModel()

	await scenario("dd. the bundled backend is found and choosing it makes the chat usable", async () => {
		await chrome.getByTestId("top-bar").getByRole("button", { name: "Backend" }).click()
		await chrome.waitForSelector('[data-testid="backend-opencode"]', { timeout: 90_000 })

		const row = chrome.getByTestId("backend-opencode")
		await waitFor(
			"the bundled backend to report ready",
			async () => ((await row.textContent())?.includes("ready") ? true : null),
			90_000,
		)

		await shot(chrome, "11-backend-setup")
		await row.getByRole("button", { name: "Use this" }).click()

		// Pins the model for the rest of the run, through the same field a user
		// would type in. Left empty the backend defaults to a reasoning model,
		// which is slow at "replace this word" and makes the scenarios below
		// measure the wrong thing.
		if (model) {
			// The field is a grouped `<select>` when the backend can enumerate its
			// models and a text input when it cannot, and the two are driven
			// differently — `fill` does nothing to a select. Which one is present is
			// itself a property of the backend, so the harness asks rather than
			// assumes.
			const field = chrome.getByTestId("backend-model")
			const tag = await field.evaluate((element) => element.tagName)

			if (tag === "SELECT") {
				await field.selectOption(model.id)
			} else {
				await field.fill(model.id)
				await field.blur()
			}
		}

		await chrome.getByTestId("top-bar").getByRole("button", { name: "Backend" }).click()
		// Self-established, not inherited: the composer this reads lives in the
		// sidebar cc happened to leave open. If cc failed — or the sidebar's
		// open/closed state changes for any reason — this must still find it.
		await ensureChatOpen(chrome)
		await waitFor(
			"the chat to become usable",
			async () => ((await chrome.getByTestId("chat-input").isDisabled()) ? null : true),
			30_000,
		)

		return `bundled backend selected, chat enabled${model ? `, model ${model.id} (${model.source})` : ""}`
	})

	await scenario("de. chat history is its own view, not a strip on top of the conversation", async () => {
		// The first version pushed the session list above a still-live
		// transcript — clutter that hid most of both. Open, history must
		// REPLACE the chat; back must restore it. Asserted on presence of the
		// transcript element, which is the whole point of the swap.
		await ensureChatOpen(chrome)
		await chrome.click('[data-testid="chat-sidebar"] button[title="Earlier sessions"]')
		await chrome.waitForSelector('[data-testid="chat-sessions"]', { timeout: 10_000 })
		assert(
			(await chrome.locator('[data-testid="chat-transcript"]').count()) === 0,
			"the transcript is still rendered underneath the history view",
		)
		const title = await chrome.textContent('[data-testid="chat-title"]')
		assert(title?.includes("Chat history"), `the header does not say where you are: ${title}`)

		await chrome.click('[data-testid="chat-sidebar"] button[title="Back to the chat"]')
		await chrome.waitForSelector('[data-testid="chat-transcript"]', { timeout: 10_000 })
		assert(
			(await chrome.locator('[data-testid="chat-sessions"]').count()) === 0,
			"the history list survived returning to the chat",
		)
		return "history replaced the chat, and back restored it"
	})

	await scenario("ce. an overlay move edit gets measured geometry and lands centered, verified by re-measure", async () => {
		// The spatial feedback loop end to end: two images, one askew; the overlay
		// edit carries the rects the canvas measured (so the model can subtract
		// instead of eyeball), the asset index carries where the clip's opaque
		// pixels sit inside its transparent margins, and after the turn the
		// verify loop re-renders, re-measures and resumes the session until the
		// numbers agree. Needs the backend dd chose — like bu, this drives the
		// real edit lane.
		const caretDir = path.join(fixture, ".caret")

		// Real PNGs, made where nativeImage lives. The clip's opaque pixels sit
		// at (60,40) 100x200 inside a 200x300 frame — asymmetric margins, the
		// exact shape that makes box-center alignment quietly wrong. Loops are
		// inlined: a named helper const inside evaluate gets esbuild's __name
		// wrapper, which does not exist on the Electron side.
		const pngs = await app!.evaluate(async ({ nativeImage }) => {
			const shirtData = Buffer.alloc(480 * 520 * 4)
			for (let i = 0; i < shirtData.length; i += 4) {
				shirtData[i] = 160
				shirtData[i + 1] = 90
				shirtData[i + 2] = 60
				shirtData[i + 3] = 255
			}
			const clipData = Buffer.alloc(200 * 300 * 4)
			for (let y = 0; y < 300; y++) {
				for (let x = 0; x < 200; x++) {
					const i = (y * 200 + x) * 4
					const on = x >= 60 && x < 160 && y >= 40 && y < 240
					clipData[i] = on ? 60 : 0
					clipData[i + 1] = on ? 90 : 0
					clipData[i + 2] = on ? 160 : 0
					clipData[i + 3] = on ? 255 : 0
				}
			}
			return {
				shirt: nativeImage.createFromBitmap(shirtData, { width: 480, height: 520 }).toPNG().toString("base64"),
				clip: nativeImage.createFromBitmap(clipData, { width: 200, height: 300 }).toPNG().toString("base64"),
			}
		})
		const assetsDir = path.join(caretDir, "assets")
		await fs.mkdir(assetsDir, { recursive: true })
		await fs.writeFile(path.join(assetsDir, "verify-shirt.png"), Buffer.from(pngs.shirt, "base64"))
		await fs.writeFile(path.join(assetsDir, "verify-clip.png"), Buffer.from(pngs.clip, "base64"))

		// The watcher indexes the drop and the enrichment pass measures the
		// opaque bound — the field the geometry prompt turns into "visual center".
		const opaqueBox = await waitFor(
			"the clip's opaque bound to be measured into the index",
			async () => {
				try {
					const idx = JSON.parse(await fs.readFile(path.join(assetsDir, "index.json"), "utf-8"))
					return idx?.assets?.find((a: any) => a.file === "verify-clip.png")?.opaqueBox ?? null
				} catch {
					return null
				}
			},
			30000,
		)
		assert(
			opaqueBox.x === 60 && opaqueBox.y === 40 && opaqueBox.width === 100 && opaqueBox.height === 200,
			`the measured opaque bound is wrong: ${JSON.stringify(opaqueBox)}`,
		)

		const pageDir = path.join(caretDir, "pages", "align-demo")
		await fs.mkdir(pageDir, { recursive: true })
		const pagePath = path.join(pageDir, "index.tsx")
		await fs.writeFile(
			pagePath,
			`export default function AlignDemo() {
  return (
    <div className="min-h-screen bg-white p-8">
      <div data-caret-id="stage" style={{ position: "relative", width: 480, height: 520 }}>
        <img data-caret-id="shirt" src="/caret-assets/verify-shirt.png" width={480} height={520} alt="a shirt" />
        <img
          data-caret-id="clip"
          src="/caret-assets/verify-clip.png"
          width={100}
          height={150}
          style={{ position: "absolute", left: 24, top: 40 }}
          alt="a clothes clip"
        />
      </div>
    </div>
  )
}
`,
		)
		await fs.writeFile(
			path.join(pageDir, "meta.json"),
			JSON.stringify({ id: "align-demo", title: "Align Demo", type: "page", states: [], tags: [] }),
		)

		const driven = await app!.evaluate(async ({ BrowserWindow }) => {
			let canvas: any = null
			const viewDeadline = Date.now() + 60000
			while (Date.now() < viewDeadline && !canvas) {
				const win = BrowserWindow.getAllWindows()[0]
				const views = (win?.contentView?.children ?? []) as any[]
				const found = views.find((v) => v.webContents && !v.webContents.isDestroyed())
				if (found && found.webContents.getURL().startsWith("http://127.0.0.1")) canvas = found
				if (!canvas) await new Promise((r) => setTimeout(r, 500))
			}
			if (!canvas) return { error: "the canvas view never mounted" }
			const wc = canvas.webContents

			try {
				await wc.executeJavaScript(
					`((document.querySelector('button[title="Back to canvas"]')) || {click(){}}).click(), true`,
				)
				const findCard = `(() => {
					const frames = Array.from(document.querySelectorAll('.caret-canvas-frame'))
					return frames.find((f) => f.querySelector('.caret-canvas-frame-title')?.textContent?.trim() === 'Align Demo') ?? null
				})()`
				let cardReady = false
				let deadline = Date.now() + 60000
				while (Date.now() < deadline && !cardReady) {
					cardReady = await wc.executeJavaScript(`!!${findCard}`).catch(() => false)
					if (!cardReady) await new Promise((r) => setTimeout(r, 500))
				}
				if (!cardReady) return { error: "the Align Demo card never appeared on the canvas" }
				await wc.executeJavaScript(`(${findCard}).click(), true`)

				let pageFrame: any = null
				deadline = Date.now() + 30000
				while (Date.now() < deadline && !pageFrame) {
					pageFrame =
						wc.mainFrame.frames.find(
							(f: any) => f.url.includes("mode=focused") && f.url.includes("page=align-demo"),
						) ?? null
					if (!pageFrame) await new Promise((r) => setTimeout(r, 250))
				}
				if (!pageFrame) return { error: "the focused align page never became a frame" }

				// Both images decoded — geometry measured off half-loaded pixels lies.
				deadline = Date.now() + 30000
				let imagesReady = false
				while (Date.now() < deadline && !imagesReady) {
					pageFrame = wc.mainFrame.frames.find((f: any) => f.url.includes("page=align-demo")) ?? pageFrame
					imagesReady = await pageFrame
						.executeJavaScript(
							`(() => {
								const shirt = document.querySelector('[data-caret-id="shirt"]')
								const clip = document.querySelector('[data-caret-id="clip"]')
								return !!(shirt && clip && shirt.naturalWidth > 0 && clip.naturalWidth > 0)
							})()`,
						)
						.catch(() => false)
					if (!imagesReady) await new Promise((r) => setTimeout(r, 250))
				}
				if (!imagesReady) return { error: "the seeded images never decoded in the focused page" }

				let overlayUp = false
				for (let attempt = 0; attempt < 5 && !overlayUp; attempt++) {
					await pageFrame
						.executeJavaScript(
							`(() => { const b = document.querySelector('.caret-focused-paint-btn'); if (b) b.click(); return !!b })()`,
						)
						.catch(() => false)
					const attemptDeadline = Date.now() + 4000
					while (Date.now() < attemptDeadline && !overlayUp) {
						overlayUp = await pageFrame
							.executeJavaScript(`!!document.querySelector('.caret-overlay')`)
							.catch(() => false)
						if (!overlayUp) await new Promise((r) => setTimeout(r, 250))
					}
				}
				if (!overlayUp) return { error: "paint mode never engaged" }

				// Paint a region over the stage. The drag uses the same fixed
				// view-space coordinates the other overlay scenarios proved out —
				// the focused iframe renders SCALED (1060px showing a 1440px
				// viewport), so mapping in-page rects to mouse coordinates is a
				// trap, and the painted region only needs to INTERSECT the images
				// for them to be measured, not cover them.
				const offset = await wc.executeJavaScript(
					`(() => { const r = document.querySelector('.caret-focused-iframe').getBoundingClientRect(); return { x: r.x, y: r.y } })()`,
				)
				const from = { x: Math.round(offset.x) + 60, y: Math.round(offset.y) + 60 }
				const to = { x: from.x + 340, y: from.y + 320 }
				wc.sendInputEvent({ type: "mouseMove", x: from.x, y: from.y })
				wc.sendInputEvent({ type: "mouseDown", x: from.x, y: from.y, button: "left", clickCount: 1 })
				for (let step = 1; step <= 6; step++) {
					wc.sendInputEvent({
						type: "mouseMove",
						x: Math.round(from.x + ((to.x - from.x) * step) / 6),
						y: Math.round(from.y + ((to.y - from.y) * step) / 6),
						button: "left",
						buttons: 1,
					})
					await new Promise((r) => setTimeout(r, 40))
				}
				wc.sendInputEvent({ type: "mouseUp", x: to.x, y: to.y, button: "left", clickCount: 1 })

				deadline = Date.now() + 20000
				let box = false
				while (Date.now() < deadline && !box) {
					box = await pageFrame
						.executeJavaScript(`!!document.querySelector('.caret-overlay-prompt input')`)
						.catch(() => false)
					if (!box) await new Promise((r) => setTimeout(r, 250))
				}
				if (!box) {
					const state = await pageFrame
						.executeJavaScript(`(() => ({
							overlay: !!document.querySelector('.caret-overlay'),
							rect: !!document.querySelector('.caret-overlay-rect'),
							size: (() => { const r = document.querySelector('.caret-overlay-rect'); if (!r) return null; const b = r.getBoundingClientRect(); return Math.round(b.width) + 'x' + Math.round(b.height) })(),
							dragged: ${JSON.stringify({ from, to })},
						}))()`)
						.catch((e: any) => ({ probeFailed: String(e) }))
					return { error: `painting the stage did not open the instruction box: ${JSON.stringify(state)}` }
				}

				// Submit with Enter, the way a person does; handleSubmit measures the
				// elements under the rect and sends the payload this scenario exists
				// to certify.
				await pageFrame.executeJavaScript(`(() => {
					const input = document.querySelector('.caret-overlay-prompt input')
					input.focus()
					const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
					setter.call(input, 'center the clip horizontally on the shirt image')
					input.dispatchEvent(new Event('input', { bubbles: true }))
					input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
					return true
				})()`)
				return { ok: true }
			} catch (err) {
				return { error: err instanceof Error ? err.message : String(err) }
			}
		})
		assert(!("error" in driven) || !driven.error, `driving the overlay edit failed: ${(driven as any).error}`)

		// The model turn plus up to two verify rounds. Geometry is polled in the
		// live frame rather than the source, because "centered" has many correct
		// spellings (left, inset, transform, flex) and the pixels are the promise.
		// The last probe is kept for the timeout diagnosis — a bare timeout here
		// cost three runs before it said what it was actually seeing.
		let lastProbe: unknown = "never probed"
		const centered = await waitFor(
			"the clip to land centered on the shirt",
			async () => {
				const measured = await app!.evaluate(async ({ BrowserWindow }) => {
					const win = BrowserWindow.getAllWindows()[0]
					const views = (win?.contentView?.children ?? []) as any[]
					// The URL filter is load-bearing: the first live view is often the
					// CHROME, whose frame tree never contains the page — a poll without
					// it measures nothing forever and reads as a timeout.
					const canvas = views.find(
						(v) =>
							v.webContents &&
							!v.webContents.isDestroyed() &&
							v.webContents.getURL().startsWith("http://127.0.0.1"),
					)
					if (!canvas) return { probeFailed: "no canvas view" }
					const frame = canvas.webContents.mainFrame.frames.find((f: any) => f.url.includes("page=align-demo"))
					if (!frame) return { probeFailed: "no align-demo frame" }
					return frame
						.executeJavaScript(
							`(() => {
								const shirt = document.querySelector('[data-caret-id="shirt"]')
								const clip = document.querySelector('[data-caret-id="clip"]')
								if (!shirt || !clip) return { probeFailed: "elements missing: shirt=" + !!shirt + " clip=" + !!clip }
								const s = shirt.getBoundingClientRect()
								const c = clip.getBoundingClientRect()
								return {
									shirtCx: s.x + s.width / 2,
									clipCx: c.x + c.width / 2,
									clipW: c.width,
									clipClass: clip.getAttribute("class"),
									clipStyle: clip.getAttribute("style"),
									clipComputed: { position: getComputedStyle(clip).position, left: getComputedStyle(clip).left },
								}
							})()`,
						)
						.catch((e: any) => ({ probeFailed: String(e).slice(0, 120) }))
				})
				lastProbe = measured
				if (!measured || (measured as any).probeFailed) return null
				const m = measured as { shirtCx: number; clipCx: number; clipW: number }
				// The clip's visual center sits right of its box center (margins 60
				// left, 40 right at scale w/200) — accept either interpretation
				// within 8px of the shirt's centerline.
				const scale = m.clipW / 200
				const visualShift = (110 - 100) * scale // opaque center 110 vs box center 100, intrinsic px
				const boxDelta = Math.abs(m.clipCx - m.shirtCx)
				const visualDelta = Math.abs(m.clipCx + visualShift - m.shirtCx)
				return Math.min(boxDelta, visualDelta) <= 8 ? { boxDelta, visualDelta } : null
			},
			600_000,
			async () => `last probe: ${JSON.stringify(lastProbe)}`,
		)

		// The overlay edit now snapshots an undo step before the agent touches
		// anything — the gap that used to make Cmd+Z skip straight past it.
		const journal = JSON.parse(await fs.readFile(path.join(caretDir, ".undo-journal.json"), "utf-8"))
		assert(
			journal.steps?.some((s: any) => typeof s.label === "string" && s.label.startsWith("overlay edit:")),
			"no undo step was captured for the overlay edit",
		)

		// Leave the canvas on its grid for whoever runs next.
		await app!.evaluate(async ({ BrowserWindow }) => {
			const win = BrowserWindow.getAllWindows()[0]
			const views = (win?.contentView?.children ?? []) as any[]
			const canvas = views.find((v) => v.webContents && !v.webContents.isDestroyed())
			await canvas?.webContents
				.executeJavaScript(`((document.querySelector('button[title="Back to canvas"]')) || {click(){}}).click(), true`)
				.catch(() => {})
		})

		return `the clip centered within ${Math.round(Math.min(centered.boxDelta, centered.visualDelta))}px of the shirt's centerline, and the edit left an undo step`
	})

	await scenario("cg. the sidebar chat agent reaches Caret's own tools through the bridge", async () => {
		// The gap this closes: Caret's tools were served only to EXTERNALLY
		// connected agents, and the user's own chat had none — "the agent can
		// make things easier by using the generator as a tool" was true for
		// Cursor and false for Caret. The road is a stdio bridge OpenCode spawns
		// per project directory (probe-mcp-bridge.ts measured the spawn
		// behaviour; stdio-bridge.test.ts holds the proxying) — this drives the
		// last leg: a real chat turn, a real tool call, in the app.
		const sent = await chrome.evaluate(async (target) => {
			return Boolean(
				await (window as any).caret.invoke(
					"agent:send",
					target,
					"Call the get_project tool now and tell me the page count. If you have no such tool, say TOOLLESS.",
				),
			)
		}, fixture)
		assert(sent !== null, "the chat send returned nothing")

		const toolEntry = await waitFor(
			"the chat transcript to show a caret tool call",
			async () => {
				const state = await chrome.evaluate(
					async (target) => (window as any).caret.invoke("agent:state", target),
					fixture,
				)
				const entries = state?.transcript?.entries ?? []
				const tool = entries.find(
					(entry: { kind: string; name?: string }) =>
						entry.kind === "tool" && (entry.name ?? "").includes("get_project"),
				)
				if (tool) return tool
				// TOOLLESS in an assistant reply means the bridge did not deliver —
				// fail fast with the honest cause instead of waiting out the clock.
				const gaveUp = entries.some(
					(entry: { kind: string; text?: string }) =>
						entry.kind === "assistant" && (entry.text ?? "").includes("TOOLLESS"),
				)
				if (gaveUp) throw new Error("the agent says it has no get_project tool — the bridge did not deliver")
				return null
			},
			300_000,
		)

		return `the chat agent called ${(toolEntry as { name?: string }).name} through the per-project bridge`
	})

	await scenario("ch. the agent offers assets as options in the chat, and a pick answers the tool", async () => {
		// The planning conversation's missing piece, end to end and model-free:
		// an agent (driven here as a raw MCP client, the way ca does) offers two
		// existing assets against a question; the widget docks in the CHAT — not
		// the interview surface — the sidebar opens itself if it was closed, a
		// chip's thumbnail opens the viewer over the canvas for a closer look
		// without answering anything, and only "Use this" resolves the tool.
		assert(discovery, "no discovery record (scenario b must run first)")

		const assetsDir = path.join(fixture, ".caret", "assets")
		await fs.mkdir(assetsDir, { recursive: true })
		await fs.writeFile(path.join(assetsDir, "pick-a.png"), solidPng(400, 250, [40, 90, 160]))
		await fs.writeFile(path.join(assetsDir, "pick-b.png"), solidPng(400, 250, [160, 90, 40]))
		await waitFor(
			"the two option assets to be indexed",
			async () => {
				try {
					const raw = JSON.parse(await fs.readFile(path.join(assetsDir, "index.json"), "utf-8"))
					const tags = new Set((raw.assets ?? []).map((a: { tag: string }) => a.tag))
					return tags.has("pick-a") && tags.has("pick-b") ? true : null
				} catch {
					return null
				}
			},
			30_000,
		)

		// Fired, not awaited: the tool BLOCKS on the user, and the assertion that
		// it has not returned yet is part of the contract.
		const pending = callMcp(discovery.url, discovery.token, {
			jsonrpc: "2.0",
			id: 61,
			method: "tools/call",
			params: {
				name: "present_asset_options",
				arguments: {
					question: "Which one for the hero?",
					tags: ["pick-a", "pick-b"],
					why: "The plan needs a hero image.",
				},
			},
		}).then(async (response) => mcpSaid(await response.text()))

		await chrome.waitForSelector('[data-testid="chat-asset-options"]', { timeout: 20_000 })
		const chips = chrome.locator('[data-testid="chat-asset-option"]')
		assert((await chips.count()) === 2, "both offered assets should appear as chips")

		// Looking must never commit: the thumbnail opens the viewer, the tool
		// stays pending, and the canvas-covering overlay names the right asset.
		await chips.filter({ hasText: "@pick-a" }).locator("button").first().click()
		await chrome.waitForSelector('[data-testid="asset-viewer"]', { timeout: 10_000 })
		const viewed = await chrome.textContent('[data-testid="asset-viewer-tag"]')
		assert(viewed?.includes("pick-a"), `the viewer shows "${viewed}", not the clicked asset`)
		await chrome.click('[data-testid="asset-viewer-close"]')

		await chips.filter({ hasText: "@pick-b" }).locator('[data-testid="chat-asset-option-use"]').click()
		const said = await waitFor("the blocked tool call to resolve with the pick", async () => pending, 30_000)
		assert(said.includes('"picked"') && said.includes("pick-b"), `the tool answered with: ${said.slice(0, 200)}`)

		return `offered two assets in the chat, viewed one without answering, and "Use this" resolved the tool with pick-b`
	})

	await scenario("bf. @ picks an asset in the chat composer too", async () => {
		// The composer is a different surface from the canvas — Caret's own window,
		// not the generated shell — so nothing the canvas picker does carries over,
		// and this reached a user precisely because only the canvas was covered.
		// Needs a backend: the composer is disabled without one.
		const input = chrome.getByTestId("chat-input")
		await input.fill("")
		await input.click()
		await chrome.keyboard.type("Put @her")

		const list = chrome.getByTestId("asset-mentions")
		await list.waitFor({ timeout: 15_000 })
		const option = list.locator('[data-asset-mention="hero-shot-2x"]')
		await option.waitFor({ timeout: 15_000 })

		const width = await waitFor(
			"the composer thumbnail to decode",
			async () => {
				const value = await option.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)
				return value > 0 ? value : null
			},
			20_000,
		)
		assert(width === 240, `the composer thumbnail decoded at ${width}px`)

		// Clicking, and hovering first — the two things that were broken in the
		// canvas picker and would fail the same way here.
		await option.hover()
		await option.click()
		await waitFor(
			"the tag to land in the draft",
			async () => ((await input.inputValue()).includes("@hero-shot-2x") ? true : null),
			10_000,
		)

		// Choosing must not also send: the composer sends on Enter, and the picker
		// has to consume that key first.
		assert(!(await chrome.getByTestId("chat-input").isDisabled()), "the composer sent the message on a pick")

		await input.fill("")
		return "picker opened in the chat composer, thumbnail decoded, click inserted the tag without sending"
	})

	await scenario("cd. the paperclip offers both acts, and an attached image never joins the library", async () => {
		// Two different things behind one button: a tag names a file the agent can
		// put *in* the page, an attachment is only something to look at. The risk
		// worth covering is that adding the second quietly changed the first, since
		// `@` is how every asset reference in this app gets written.
		const input = chrome.getByTestId("chat-input")
		await input.fill("")

		await chrome.getByTestId("chat-sidebar").getByRole("button", { name: "Attach" }).click()
		await chrome.getByTestId("chat-attach-menu").waitFor({ timeout: 10_000 })

		await chrome.getByTestId("chat-attach-asset").click()
		await waitFor("the @ to land in the draft", async () => ((await input.inputValue()).includes("@") ? true : null), 10_000)
		await chrome.getByTestId("asset-mentions").waitFor({ timeout: 15_000 })
		await input.fill("")

		// "Upload image" opens a native dialog Playwright cannot drive, so the same
		// state is reached the way most people will reach it anyway — by dropping.
		await input.evaluate(async (element) => {
			const canvas = document.createElement("canvas")
			canvas.width = 8
			canvas.height = 8
			const context = canvas.getContext("2d")
			if (!context) throw new Error("no 2d context")
			context.fillStyle = "#ff0000"
			context.fillRect(0, 0, 8, 8)
			const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"))
			if (!blob) throw new Error("the fixture image did not encode")

			const transfer = new DataTransfer()
			transfer.items.add(new File([blob], "reference.png", { type: "image/png" }))
			element.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }))
		})

		const chips = chrome.getByTestId("chat-attachments")
		await chips.waitFor({ timeout: 10_000 })
		assert((await chips.locator("img").count()) === 1, "the dropped image did not appear above the composer")

		// The distinction this whole control exists for: looking at an image must
		// not file it. An attachment that landed in `.caret/assets` would be
		// committed with the design and would need a tag nobody asked for.
		const assets = await fs.readdir(path.join(fixture, ".caret", "assets")).catch(() => [] as string[])
		assert(!assets.includes("reference.png"), "an attached image was written into the asset library")

		await chips.getByRole("button", { name: "Remove reference.png" }).click()
		assert((await chips.count()) === 0, "the attachment could not be taken off again")

		return "the menu offers both, tagging still types @, a dropped image rides along without joining the library"
	})

	const inference = model ? scenario : (name: string, _run: () => Promise<string>) => void skip(name, NO_MODEL_REASON)

	await inference("ee. an instruction typed in the chat rewrites the design source to exactly that", async () => {
		const pagePath = path.join(fixture, ".caret", "pages", "home", "index.tsx")

		await chrome
			.getByTestId("chat-input")
			.fill(
				'In .caret/pages/home/index.tsx, change the paragraph text "Built with Caret" to exactly "Certified by Caret". Change nothing else.',
			)
		await chrome.getByTestId("chat-send").click()

		await waitFor(
			"the design source to change",
			async () => ((await fs.readFile(pagePath, "utf-8")).includes("Certified by Caret") ? true : null),
			300_000,
		)

		await shot(chrome, "12-chat-edit")

		// The decisive half: Caret answered the permission itself. A `.caret/` write
		// is auto-approved by fixed policy, and the transcript has to say so —
		// a silent auto-approval is indistinguishable from an agent nobody checked.
		const resolved = await chrome.getByTestId("chat-permission-resolved").first().textContent()
		assert(resolved?.includes("Allowed"), `the write was not recorded as allowed: ${resolved}`)
		assert(resolved?.includes("design layer"), `the transcript does not say why Caret allowed it without asking: ${resolved}`)
		return `page rewritten; permission auto-answered ("${resolved?.trim().slice(0, 60)}…")`
	})

	// Caret's own guarantees and the model's competence are certified separately.
	//
	// They used to be one scenario, which was a mistake: when the model wandered,
	// the whole thing went red and took the deterministic assertions down with it
	// — so a suite failure said nothing about whether Caret was correct. `ff` is
	// entirely Caret's contract and does not depend on the model producing good
	// edits. `gg` is the end-to-end result, and is allowed to be inconclusive.

	const syncStatePath = path.join(fixture, ".caret", "sync-state.json")
	const appSourcePath = path.join(fixture, "src")

	async function bookmarkNow(): Promise<string | null> {
		const raw = await fs.readFile(syncStatePath, "utf-8").catch(() => null)
		const state = raw ? (JSON.parse(raw) as { lastSyncedCommit?: string | null }) : null
		return state?.lastSyncedCommit ?? null
	}

	/** Clicks Sync and walks the preflight, up to the plan awaiting approval. */
	async function planASync(): Promise<void> {
		await chrome.getByTestId("top-bar").getByRole("button", { name: "Sync" }).click()

		// The preflight offers to commit the design layer first. That prompt is part
		// of the flow a user walks, so it is clicked rather than pre-empted. It only
		// appears when the design layer is actually dirty.
		const commit = chrome.getByTestId("notification-stack").getByRole("button", { name: "Commit .caret/ changes" })
		await commit.waitFor({ timeout: 60_000 }).then(
			() => commit.click(),
			() => {},
		)

		// The plan completing is the *model's* job. What `ff` certifies is what
		// Caret does given a plan, so a model that never produces one makes the
		// scenario inconclusive rather than failed — the same distinction gg draws.
		// The card appearing is the settled plan: a turn that ended without plan
		// text FAILS in the conversation and no card ever shows, so this wait
		// also holds down the empty-plan rule end to end. Ten minutes, not five:
		// the stall watchdog may spend four minutes discovering a dead stream and
		// retry the turn once, and the wait has to outlive that recovery.
		await chrome.waitForSelector('[data-testid="chat-plan"]', { timeout: 600_000 }).catch(async () => {
			// Say WHICH thing didn't happen. "The model did not finish" covered
			// both a declining model and a dead provider stream, and the
			// difference is the whole diagnosis — the transcript names it now
			// that the watchdog writes its findings there.
			const transcript = (await chrome.textContent('[data-testid="chat-transcript"]').catch(() => null)) ?? ""
			if (transcript.includes("went silent again")) {
				throw new Inconclusive("the provider stream died twice (stall watchdog gave up) — a provider fault, not Caret's")
			}
			if (transcript.includes("went silent")) {
				throw new Inconclusive("the provider stream died and the retry was still running at the deadline")
			}
			if (transcript.includes("without writing the plan")) {
				throw new Inconclusive(
					"the model ended its turn without writing a plan — model behaviour, correctly failed by Caret",
				)
			}
			throw new Inconclusive(`the model did not finish a plan within ten minutes; chat tail: …${transcript.slice(-400)}`)
		})

		// The sync lane opens with the composer toggle on Plan — the mode is the
		// surface now, not a header chip.
		assert(
			(await chrome.getByTestId("chat-mode-plan").getAttribute("aria-pressed")) === "true",
			"the sync conversation did not open in Plan mode",
		)
	}

	await inference("ff. a plan writes nothing, and discarding it leaves the bookmark alone", async () => {
		// A design change the app does not have yet. Deliberately a single word:
		// what is being certified here is the loop, not the model's judgment.
		const pagePath = path.join(fixture, ".caret", "pages", "home", "index.tsx")
		const page = await fs.readFile(pagePath, "utf-8")
		await fs.writeFile(pagePath, page.replace(">Welcome<", ">Zephyr<"))

		const before = await readTree(appSourcePath)
		await planASync()
		await shot(chrome, "13-sync-plan")

		// The guarantee, checked at the only moment it can be: a read-only plan has
		// run to completion and the app is still byte-for-byte what it was. The
		// whole tree, not one file — a plan that created `src/pages/` would have
		// slipped past a single-file check.
		assert(
			(await readTree(appSourcePath)) === before,
			"the plan phase wrote to the app — the read-only boundary did not hold",
		)

		await chrome.getByTestId("chat-plan-discard").click()

		// Discarding has to leave *everything* alone, including the bookmark —
		// otherwise the design change is recorded as synced and never offered again.
		// The Discard affordance leaving the card is the plan demoting to history.
		await waitFor(
			"the discard to land",
			async () => ((await chrome.getByTestId("chat-plan-discard").count()) ? null : true),
			30_000,
		)
		assert((await readTree(appSourcePath)) === before, "discarding a plan still changed the app")
		assert((await bookmarkNow()) === null, "discarding a plan advanced the sync bookmark")

		return "plan read-only, discard left the app and the bookmark untouched"
	})

	await inference("gg. applying a plan changes the app and advances the bookmark", async () => {
		const before = await readTree(appSourcePath)

		// The discarded change is still pending, which is itself the claim: a
		// discarded sync is offered again rather than quietly lost.
		await planASync()
		// The flip IS the Apply: switching the composer toggle to Act with a
		// settled plan starts the apply turn — no separate confirm button.
		await chrome.getByTestId("chat-mode-act").click()

		// Applying is where writes to the user's *own* source happen, and those ask
		// by default — accepting a plan is not the same as consenting to each file.
		// So the prompts are answered, exactly as a user would.
		let allowed = 0
		const deadline = Date.now() + 420_000
		let bookmark: string | null = null

		while (Date.now() < deadline) {
			const allow = chrome.getByTestId("chat-permission-allow")
			if (await allow.count()) {
				await allow
					.first()
					.click()
					.catch(() => {})
				allowed += 1
			}

			bookmark = await bookmarkNow()
			if (bookmark) break

			// Caret says this in its own voice when a turn ends having written
			// nothing. Waiting out the remaining minutes after that would tell us
			// nothing we do not already know.
			const transcript = (await chrome.textContent('[data-testid="chat-transcript"]').catch(() => null)) ?? ""
			if (transcript.includes("without changing anything in your app")) {
				// Say what it actually did. "Finished without editing" on its own has
				// already sent me chasing the wrong cause twice; the tail of the chat
				// and git's own view are what distinguish "the model declined" from
				// "Caret failed to notice".
				await shot(chrome, "14-sync-inconclusive")
				const status = child_process.execSync("git status --porcelain", { cwd: fixture }).toString().trim()
				throw new Inconclusive(
					`the model finished without editing anything (${allowed} write(s) allowed).\n` +
						`  git status: ${status.split("\n").slice(0, 8).join(" | ") || "(clean)"}\n` +
						`  chat tail: …${transcript.slice(-700)}`,
				)
			}

			await new Promise((resolve) => setTimeout(resolve, 500))
		}

		await shot(chrome, "14-sync-applied")

		if (!bookmark) {
			const transcript = (await chrome.textContent('[data-testid="chat-transcript"]').catch(() => null)) ?? ""
			throw new Inconclusive(`the model was still working after 7 minutes; last of the chat: …${transcript.slice(-400)}`)
		}

		// This half *is* Caret's, and stays a hard failure: the bookmark may only
		// advance when the apply actually wrote something. Advancing without it
		// records the design change as synced and never offers it again.
		const applied = await readTree(appSourcePath)
		assert(applied !== before, "the bookmark advanced but nothing in the app changed")
		// Anywhere under `src/`. A good sync is allowed to restructure — one run
		// split two design pages into a router and page components — so pinning
		// this to `App.tsx` would fail the correct outcome.
		assert(applied.includes("Zephyr"), `the app did not follow the design:\n${applied.slice(0, 1200)}`)

		return `app updated after ${allowed} allowed write(s), bookmark at ${bookmark.slice(0, 8)}`
	})

	await inference("ii. the wizard interviews, finishes on demand, and Caret writes the file", async () => {
		// The whole loop, live: the model composes a question from the widget
		// vocabulary, the UI renders and answers it, "Just finish" forces a
		// proposal from what's known, and the committed file is Caret's own
		// derivation. Two model turns, so it stays affordable on a free model.
		// The fixture is committed, so the road in is the DS view's re-run door.
		await openDesignSystem(chrome)
		await chrome.click('[data-testid="ds-rerun"]')
		await chrome.waitForSelector('[data-testid="foundation-describe"]', { timeout: 20_000 })

		await chrome.fill(
			'[data-testid="foundation-describe"]',
			"A quiet reading app for long-form essays. People sit with it for an hour at a time. Calm, bookish, light background.",
		)
		await chrome.click('[data-testid="foundation-describe-continue"]')
		await chrome.click('[data-testid="foundation-mode-collaborative"]')

		// The first question is a whole model turn composing UI; give it the same
		// patience as any inference scenario — and a model that cannot produce one
		// in time is the model's failure, not Caret's, same as ff's five-minute
		// rule. A free model has been observed doing this in 90s on one run and
		// blowing 240s on the next.
		const first = await Promise.race([
			chrome.waitForSelector('[data-testid="wizard-question"]', { timeout: 300_000 }).then(() => "question" as const),
			chrome.waitForSelector('[data-testid="wizard-error"]', { timeout: 300_000 }).then(() => "error" as const),
		]).catch(() => "timeout" as const)
		if (first === "timeout") {
			throw new Inconclusive("the model did not compose a first question within five minutes")
		}
		if (first === "error") {
			const message = (await chrome.textContent('[data-testid="wizard-error"]'))?.trim() ?? ""
			throw new Inconclusive(`the model never produced a renderable question: ${message.slice(0, 200)}`)
		}

		const questionText = (await chrome.textContent('[data-testid="wizard-question"] h1'))?.trim() ?? ""
		assert(questionText.length > 5, "a question rendered with no text")
		await shot(chrome, "15-wizard-question")

		// Answer it through the real UI. Whatever kind the model chose, either the
		// widget preselected something (Continue enabled) or it needs input (skip
		// is the honest answer for a harness with no opinions).
		const continueEnabled = await chrome.getByTestId("wizard-continue").isEnabled()
		await chrome.click(continueEnabled ? '[data-testid="wizard-continue"]' : '[data-testid="wizard-skip"]')

		// Then stop the interview and make it construct from what it has.
		await chrome
			.waitForSelector('[data-testid="wizard-finish-now"], [data-testid="wizard-finish"], [data-testid="wizard-error"]', {
				timeout: 300_000,
			})
			.catch(() => {
				throw new Inconclusive("the model did not produce a second turn within five minutes")
			})
		if (await chrome.getByTestId("wizard-finish-now").count()) {
			await chrome.click('[data-testid="wizard-finish-now"]')
		}

		const finished = await Promise.race([
			chrome.waitForSelector('[data-testid="wizard-finish"]', { timeout: 300_000 }).then(() => "finish" as const),
			chrome.waitForSelector('[data-testid="wizard-error"]', { timeout: 300_000 }).then(() => "error" as const),
		]).catch(() => "timeout" as const)
		if (finished === "timeout") {
			throw new Inconclusive("the model did not construct a foundation within five minutes")
		}
		if (finished === "error") {
			const message = (await chrome.textContent('[data-testid="wizard-error"]'))?.trim() ?? ""
			throw new Inconclusive(`the model could not construct a valid foundation: ${message.slice(0, 200)}`)
		}
		await shot(chrome, "16-wizard-finish")

		const before = await fs.readFile(path.join(fixture, ".caret", "tokens", "foundation.json"), "utf-8")
		await chrome.click('[data-testid="wizard-commit"]')

		const tokens = await waitFor(
			"the wizard to write foundation.json",
			async () => {
				const raw = await fs.readFile(path.join(fixture, ".caret", "tokens", "foundation.json"), "utf-8")
				return raw !== before ? JSON.parse(raw) : null
			},
			30_000,
		)

		// Caret's derivation, not the model's file: scales must exist and cohere.
		assert(tokens.typography?.fontFamily, "no body typeface")
		assert(Object.keys(tokens.typography.scale ?? {}).length > 0, "no derived type scale")
		assert(/^#[0-9a-f]{6}$/.test(tokens.color?.brand?.seed ?? ""), `brand seed is not a hex: ${tokens.color?.brand?.seed}`)
		assert(Object.keys(tokens.color.brand.scale ?? {}).length > 0, "no derived colour scale")
		// The seed IS 500 — the repaired ramp contract, asserted where a real
		// interview writes a real file. A near-white or near-black seed is nudged
		// by design, so only a mid-range seed is held to exact equality.
		{
			const hex = tokens.color.brand.seed.slice(1)
			const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
			const lightness = (Math.max(r, g, b) + Math.min(r, g, b)) / 2
			if (lightness >= 0.2 && lightness <= 0.85) {
				assert(
					tokens.color.brand.scale?.["500"] === tokens.color.brand.seed,
					`brand-500 (${tokens.color.brand.scale?.["500"]}) is not the seed (${tokens.color.brand.seed})`,
				)
			}
		}
		assert((tokens.spacing?.scale ?? []).length > 0, "no spacing scale")
		// The commit's survivors: the rationale and the committed marker, which
		// used to be destroyed with the scratch.
		assert(tokens.meta?.committed === true, "the committed foundation carries no meta.committed marker")
		assert((tokens.meta?.rule ?? "").length > 0, "the restraint rule was not persisted into meta")
		assert(Object.keys(tokens.color.neutral?.scale ?? {}).length > 0, "the neutral scale shipped empty — stock grey again")

		// Scratch cleared on commit — a committed interview must not offer a resume.
		await waitFor(
			"the wizard's scratch to be cleared",
			async () =>
				fs
					.access(path.join(fixture, ".caret", ".interview.json"))
					.then(() => null)
					.catch(() => true),
			20_000,
		)

		return `asked "${questionText.slice(0, 50)}…", finished → ${tokens.typography.displayFamily ?? tokens.typography.fontFamily}, ${tokens.color.brand.seed}`
	})

	await inference(
		"bq. a playground round runs three parallel takes; one cancels, the winner applies with an undo step",
		async () => {
			// The playground end to end on the real backend: the Playground button on
			// the canvas toolbar opens the start screen, one instruction spawns three
			// UNATTENDED conversations at once (the status stream proves the overlap),
			// a per-take × cancels one without touching its siblings, a ready take
			// expands to full size, and "Use this one" replaces the page, captures an
			// undo step, and cleans the whole tree up.
			const caretDir = path.join(fixture, ".caret")
			// About, not home: the chat/sync scenarios have a model rewrite home, and
			// a runtime-broken rewrite leaves the focused view honestly showing its
			// error card. About is never model-touched.
			const pagePath = path.join(caretDir, "pages", "about", "index.tsx")
			const scratchPath = path.join(caretDir, ".variants.json")
			const undoJournalPath = path.join(caretDir, ".undo-journal.json")
			const journalBefore = await fs.readFile(undoJournalPath, "utf-8").catch(() => null)
			const stepsBefore = journalBefore ? ((JSON.parse(journalBefore).steps?.length as number) ?? 0) : 0

			// The canvas must be the visible surface — other scenarios leave the
			// chrome wherever they ended.
			const surface = await chrome.getByTestId("app-shell").getAttribute("data-surface")
			if (surface && surface !== "canvas") {
				const label = surface === "agent" ? "Backend" : surface[0].toUpperCase() + surface.slice(1)
				await chrome
					.getByTestId("top-bar")
					.getByRole("button", { name: label })
					.click()
					.catch(() => {})
			}

			const driven = await app!.evaluate(async ({ BrowserWindow }) => {
				// Same serialization constraints as be/bn: no function-valued consts.
				let canvas: any = null
				const viewDeadline = Date.now() + 60000
				while (Date.now() < viewDeadline && !canvas) {
					const win = BrowserWindow.getAllWindows()[0]
					const views = (win?.contentView?.children ?? []) as any[]
					const found = views.find((v) => v.webContents && !v.webContents.isDestroyed())
					if (found && found.webContents.getURL().startsWith("http://127.0.0.1")) canvas = found
					if (!canvas) await new Promise((r) => setTimeout(r, 500))
				}
				if (!canvas) return { error: "the canvas view never mounted" }
				const wc = canvas.webContents

				try {
					// The page door: open About focused and click its Experiment button.
					// The door you came through IS the page choice — there is no picker.
					// Always open About fresh, never inherit another scenario's focused
					// page (it may be a model-broken home showing the error card).
					await wc.executeJavaScript(
						`((document.querySelector('button[title="Back to canvas"]')) || {click(){}}).click(), true`,
					)
					const findAbout = `(() => {
					const frames = Array.from(document.querySelectorAll('.caret-canvas-frame'))
					return frames.find((f) => f.querySelector('.caret-canvas-frame-title')?.textContent?.trim() === 'About') ?? null
				})()`
					let deadline = Date.now() + 30000
					let aboutUp = false
					while (Date.now() < deadline && !aboutUp) {
						aboutUp = await wc.executeJavaScript(`!!${findAbout}`).catch(() => false)
						if (!aboutUp) await new Promise((r) => setTimeout(r, 250))
					}
					if (!aboutUp) return { error: "the About card never appeared on the canvas" }

					// Record every explore-status push BEFORE starting: statuses from two
					// different nodes interleaving is the wire-level proof the takes ran
					// in PARALLEL conversations rather than queued one behind another.
					await wc.executeJavaScript(`(() => {
					window.__EXPLORE_STATUSES__ = []
					window.addEventListener("message", (e) => {
						if (e.data && e.data.source === "caret-host" && e.data.type === "explore-status" && e.data.payload) {
							window.__EXPLORE_STATUSES__.push({ n: e.data.payload.nodeId, p: e.data.payload.phase })
						}
					})
					return true
				})()`)

					await wc.executeJavaScript(`(${findAbout}).click(), true`)
					deadline = Date.now() + 30000
					let doorUp = false
					while (Date.now() < deadline && !doorUp) {
						doorUp = await wc
							.executeJavaScript(`!!document.querySelector('[data-testid="explore-enter-focused"]')`)
							.catch(() => false)
						if (!doorUp) await new Promise((r) => setTimeout(r, 250))
					}
					if (!doorUp) return { error: "the focused view's Experiment button never appeared" }
					await wc.executeJavaScript(`(document.querySelector('[data-testid="explore-enter-focused"]')).click(), true`)

					deadline = Date.now() + 15000
					let startUp = false
					while (Date.now() < deadline && !startUp) {
						startUp = await wc
							.executeJavaScript(`!!document.querySelector('[data-testid="explore-instruction"]')`)
							.catch(() => false)
						if (!startUp) await new Promise((r) => setTimeout(r, 250))
					}
					if (!startUp) return { error: "the page door never showed its instruction box" }

					const started = await wc.executeJavaScript(`(() => {
					const card = document.querySelector('[data-testid="explore-start-page"]')
					if (!card || !(card.textContent || "").includes("About")) return "the page door does not name About"
					if (document.querySelector('[data-testid="explore-page-select"]')) return "a page picker is showing — the door must be direct"
					const input = document.querySelector('[data-testid="explore-instruction"]')
					const setVal = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
					setVal.call(input, 'Make this page feel warmer and more welcoming')
					input.dispatchEvent(new Event('input', { bubbles: true }))
					const go = document.querySelector('[data-testid="explore-start-page-go"]')
					if (!go || go.disabled) return "the go button is missing or disabled"
					go.click()
					return true
				})()`)
					if (started !== true) return { error: "starting the round failed: " + started }
					return { ok: true }
				} catch (err) {
					return { error: err instanceof Error ? err.message : String(err) }
				}
			})
			assert(!("error" in driven) || !driven.error, `driving the playground request failed: ${(driven as any).error}`)

			// The exploration registers immediately, all three nodes working at once.
			const nodeIds = await waitFor(
				"the exploration to register",
				async () => {
					try {
						const raw = JSON.parse(await fs.readFile(scratchPath, "utf-8"))
						return raw?.nodes?.length === 3 ? (raw.nodes.map((n: { id: string }) => n.id) as string[]) : null
					} catch {
						return null
					}
				},
				20_000,
			)

			// Cancel the first take while the round runs: its × must settle it as
			// "cancelled" without touching the siblings' turns.
			// Searched across EVERY window's views, not `getAllWindows()[0]` — that
			// index is a race. cb's second project window stays open for the rest of
			// the run, and the overlay-verify loop opens hidden screenshot windows
			// whenever an edit turn lands, so whichever window sits at [0] when this
			// happens to run decided a whole scenario.
			const cancelTarget = nodeIds[0]
			const cancelClicked = await app!.evaluate(async ({ BrowserWindow }, target: string) => {
				const deadline = Date.now() + 30000
				while (Date.now() < deadline) {
					for (const win of BrowserWindow.getAllWindows()) {
						for (const view of (win?.contentView?.children ?? []) as any[]) {
							const wc = view?.webContents
							if (!wc || wc.isDestroyed() || !wc.getURL().startsWith("http://127.0.0.1")) continue
							const clicked = await wc
								.executeJavaScript(
									`(() => { const b = document.querySelector('[data-testid="explore-cancel-${target}"]'); if (!b) return false; b.click(); return true })()`,
								)
								.catch(() => false)
							if (clicked) return true
						}
					}
					await new Promise((r) => setTimeout(r, 300))
				}
				return false
			}, cancelTarget)
			assert(cancelClicked, `the per-take cancel for ${cancelTarget} never appeared on the playground`)

			await waitFor(
				"the cancelled take to settle as cancelled",
				async () => {
					try {
						const raw = JSON.parse(await fs.readFile(scratchPath, "utf-8"))
						const node = raw?.nodes?.find((n: { id: string }) => n.id === cancelTarget)
						if (node?.status === "ready" || node?.status === "failed") {
							throw new Error(`the cancelled take settled as "${node.status}" instead of cancelled`)
						}
						return node?.status === "cancelled" ? true : null
					} catch (err) {
						if (err instanceof Error && err.message.includes("settled as")) throw err
						return null
					}
				},
				120_000,
			)

			// The two surviving turns run in PARALLEL conversations — same patience
			// as ff/gg for the model work itself.
			const settled = await waitFor(
				"the remaining takes to settle",
				async () => {
					try {
						const raw = JSON.parse(await fs.readFile(scratchPath, "utf-8"))
						const nodes = raw?.nodes ?? []
						return nodes.length === 3 && nodes.every((n: { status: string }) => n.status !== "working")
							? (nodes as Array<{ id: string; status: string; error?: string }>)
							: null
					} catch {
						return null
					}
				},
				900_000,
			)
			const ready = settled.filter((n) => n.status === "ready")
			if (ready.length === 0) {
				throw new Inconclusive(
					`no take succeeded: ${settled.map((n) => `${n.id}=${n.status}${n.error ? ` (${n.error.slice(0, 60)})` : ""}`).join(", ")}`,
				)
			}

			// The parallelism proof: a status for one node arriving BETWEEN two
			// statuses of another means both conversations were live at once. The old
			// sequential loop could never produce that ordering.
			const statuses = await app!.evaluate(async ({ BrowserWindow }) => {
				for (const win of BrowserWindow.getAllWindows()) {
					for (const view of (win?.contentView?.children ?? []) as any[]) {
						const wc = view?.webContents
						if (!wc || wc.isDestroyed() || !wc.getURL().startsWith("http://127.0.0.1")) continue
						const list = await wc.executeJavaScript(`window.__EXPLORE_STATUSES__ ?? null`).catch(() => null)
						if (list) return list as Array<{ n: string; p: string }>
					}
				}
				return null
			})
			assert(statuses && statuses.length > 0, "no explore-status ever reached the canvas — the status stream is dead")
			const interleaved = (statuses as Array<{ n: string; p: string }>).some((status, index, list) => {
				const later = list.slice(index + 1)
				const other = later.findIndex((s) => s.n !== status.n)
				return other >= 0 && later.slice(other + 1).some((s) => s.n === status.n)
			})
			assert(
				interleaved,
				`take statuses never interleaved — generation looks sequential again. Stream: ${(
					statuses as Array<{ n: string; p: string }>
				)
					.map((s) => `${s.n.slice(-4)}:${s.p}`)
					.join(" ")
					.slice(0, 300)}`,
			)

			const chosen = ready[0]
			const chosenSource = await fs.readFile(path.join(caretDir, "pages", chosen.id, "index.tsx"), "utf-8")

			// A ready take expands to a full-size frame before the pick.
			const expanded = await app!.evaluate(async ({ BrowserWindow }, target: string) => {
				const deadline = Date.now() + 30000
				while (Date.now() < deadline) {
					for (const win of BrowserWindow.getAllWindows()) {
						for (const view of (win?.contentView?.children ?? []) as any[]) {
							const wc = view?.webContents
							if (!wc || wc.isDestroyed() || !wc.getURL().startsWith("http://127.0.0.1")) continue
							const result = await wc
								.executeJavaScript(
									`(async () => {
									const b = document.querySelector('[data-testid="explore-preview-${target}"]')
									if (!b) return null
									b.click()
									await new Promise((r) => setTimeout(r, 400))
									const frame = document.querySelector('[data-testid="explore-expanded"] iframe')
									if (!frame) return { error: "expand clicked but no full-size frame appeared" }
									const width = frame.getBoundingClientRect().width
									const back = document.querySelector('[data-testid="explore-collapse"]')
									if (back) back.click()
									return { width }
								})()`,
								)
								.catch(() => null)
							if (result) return result as { width?: number; error?: string }
						}
					}
					await new Promise((r) => setTimeout(r, 300))
				}
				return { error: "no view ever offered the expand button" }
			}, chosen.id)
			assert(!expanded.error, `expanding ${chosen.id} failed: ${expanded.error}`)
			assert(
				Math.round(expanded.width ?? 0) === 1440,
				`the expanded frame is ${expanded.width}px wide — expected 1440 (scale 1)`,
			)

			// On failure this reports what the compare surface actually shows. The
			// scratch file saying "ready" and the button never rendering are two
			// different faults — the take failing, or the canvas never hearing that it
			// landed — and "never became clickable" cannot tell them apart. Two runs
			// were spent learning nothing because of that.
			// Same all-windows search as overlayShown, and for the same reason: the
			// one-shot `getAllWindows()[0]` grab this used to make was the whole
			// failure — "no canvas view" while the canvas sat healthy in another
			// window. The click is attempted per live view; the first view that has
			// the button wins, which also self-selects the right project window.
			const picked = await app!.evaluate(async ({ BrowserWindow }, useTestId: string) => {
				const deadline = Date.now() + 30000
				let lastDiag = "no live canvas view in any window"
				while (Date.now() < deadline) {
					for (const win of BrowserWindow.getAllWindows()) {
						for (const view of (win?.contentView?.children ?? []) as any[]) {
							const wc = view?.webContents
							if (!wc || wc.isDestroyed() || !wc.getURL().startsWith("http://127.0.0.1")) continue
							const clicked = await wc
								.executeJavaScript(
									`(() => { const b = document.querySelector('[data-testid="${useTestId}"]'); if (!b) return false; b.click(); return true })()`,
								)
								.catch(() => false)
							if (clicked) return { ok: true, diag: "" }
							const diag = await wc
								.executeJavaScript(
									`(() => {
									const view = document.querySelector('[data-testid="explore-view"]')
									if (!view) return null
									const cards = Array.from(document.querySelectorAll('[data-testid^="variant-card-"]')).map((c) => ({
										id: c.getAttribute('data-testid'),
										hasUseButton: !!c.querySelector('[data-testid^="variant-use-"]'),
										label: c.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 60),
									}))
									return JSON.stringify({ playgroundUp: true, cards })
								})()`,
								)
								.catch((e: unknown) => `canvas probe failed: ${String(e).slice(0, 120)}`)
							if (diag) lastDiag = String(diag)
						}
					}
					await new Promise((r) => setTimeout(r, 300))
				}
				return { ok: false, diag: lastDiag }
			}, `variant-use-${chosen.id}`)
			if (!picked.ok) {
				const onDisk = await fs.readFile(scratchPath, "utf-8").catch(() => "the scratch is gone")
				assert(
					false,
					`the "Use this one" button for ${chosen.id} never became clickable.\n` +
						`      playground: ${picked.diag}\n` +
						`      .variants.json: ${onDisk.replace(/\s+/g, " ").slice(0, 400)}`,
				)
			}

			await waitFor(
				"the winner to replace the page and the takes to clean up",
				async () => {
					const page = await fs.readFile(pagePath, "utf-8").catch(() => "")
					const scratchGone = await fs
						.access(scratchPath)
						.then(() => false)
						.catch(() => true)
					const dirsGone = await fs
						.access(path.join(caretDir, "pages", chosen.id))
						.then(() => false)
						.catch(() => true)
					return page === chosenSource && scratchGone && dirsGone ? true : null
				},
				30_000,
			)

			// The apply is undoable now — the journal must have grown by a step.
			const journalAfter = JSON.parse(await fs.readFile(undoJournalPath, "utf-8").catch(() => '{"steps":[]}'))
			assert(
				(journalAfter.steps?.length ?? 0) > stepsBefore,
				`the undo journal did not grow (${stepsBefore} → ${journalAfter.steps?.length ?? 0}) — the apply is not undoable`,
			)

			await shot(chrome, "24-variant-pick")
			return `3 parallel takes (statuses interleaved), ${cancelTarget} cancelled alone, ${chosen.id} expanded at scale 1 and chosen; page replaced, undo step captured, tree cleaned`
		},
	)

	await inference("bq2. a page that doesn't exist is explored into existence and added to the canvas", async () => {
		// The playground's second door: no source page, only a name and an
		// instruction. Three takes build the page from a stub in parallel;
		// settling on one ADDS it to the canvas as a real page — the exploration
		// never shows a page dir until the pick.
		const caretDir = path.join(fixture, ".caret")
		const scratchPath = path.join(caretDir, ".variants.json")
		const newPageDir = path.join(caretDir, "pages", "team")
		await fs.rm(newPageDir, { recursive: true, force: true })

		const driven = await app!.evaluate(async ({ BrowserWindow }) => {
			let canvas: any = null
			const viewDeadline = Date.now() + 60000
			while (Date.now() < viewDeadline && !canvas) {
				const win = BrowserWindow.getAllWindows()[0]
				const views = (win?.contentView?.children ?? []) as any[]
				const found = views.find((v) => v.webContents && !v.webContents.isDestroyed())
				if (found && found.webContents.getURL().startsWith("http://127.0.0.1")) canvas = found
				if (!canvas) await new Promise((r) => setTimeout(r, 500))
			}
			if (!canvas) return { error: "the canvas view never mounted" }
			const wc = canvas.webContents
			try {
				await wc.executeJavaScript(
					`((document.querySelector('button[title="Back to canvas"]')) || {click(){}}).click(), true`,
				)
				let deadline = Date.now() + 30000
				let enterUp = false
				while (Date.now() < deadline && !enterUp) {
					enterUp = await wc
						.executeJavaScript(`!!document.querySelector('[data-testid="explore-enter"]')`)
						.catch(() => false)
					if (!enterUp) await new Promise((r) => setTimeout(r, 250))
				}
				if (!enterUp) return { error: "the Playground button never appeared on the canvas toolbar" }
				await wc.executeJavaScript(`(document.querySelector('[data-testid="explore-enter"]')).click(), true`)
				deadline = Date.now() + 15000
				let startUp = false
				while (Date.now() < deadline && !startUp) {
					startUp = await wc
						.executeJavaScript(`!!document.querySelector('[data-testid="explore-start-new"]')`)
						.catch(() => false)
					if (!startUp) await new Promise((r) => setTimeout(r, 250))
				}
				if (!startUp) return { error: "the playground start screen never appeared" }
				const started = await wc.executeJavaScript(`(() => {
					const name = document.querySelector('[data-testid="explore-new-name"]')
					const brief = document.querySelector('[data-testid="explore-new-instruction"]')
					if (!name || !brief) return "the something-new card is incomplete"
					const setVal = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
					setVal.call(name, 'Team')
					name.dispatchEvent(new Event('input', { bubbles: true }))
					setVal.call(brief, 'A small team page: three people, name, role, one warm line each')
					brief.dispatchEvent(new Event('input', { bubbles: true }))
					const go = document.querySelector('[data-testid="explore-start-new-go"]')
					if (!go || go.disabled) return "the go button is missing or disabled"
					go.click()
					return true
				})()`)
				if (started !== true) return { error: "starting the new-page round failed: " + started }
				return { ok: true }
			} catch (err) {
				return { error: err instanceof Error ? err.message : String(err) }
			}
		})
		assert(!("error" in driven) || !driven.error, `driving the new-page request failed: ${(driven as any).error}`)

		// Registered with stub takes; pages/team itself must NOT exist yet.
		await waitFor(
			"the new-page exploration to register",
			async () => {
				try {
					const raw = JSON.parse(await fs.readFile(scratchPath, "utf-8"))
					return raw?.mode === "new" && raw?.pageId === "team" && raw?.nodes?.length === 3 ? true : null
				} catch {
					return null
				}
			},
			20_000,
		)
		const rootExistsEarly = await fs.access(newPageDir).then(
			() => true,
			() => false,
		)
		assert(!rootExistsEarly, "pages/team appeared during the exploration — the page must not exist until the pick")

		const settled = await waitFor(
			"the takes to settle",
			async () => {
				try {
					const raw = JSON.parse(await fs.readFile(scratchPath, "utf-8"))
					const nodes = raw?.nodes ?? []
					return nodes.length === 3 && nodes.every((n: { status: string }) => n.status !== "working")
						? (nodes as Array<{ id: string; status: string; error?: string }>)
						: null
				} catch {
					return null
				}
			},
			900_000,
		)
		const ready = settled.filter((n) => n.status === "ready")
		if (ready.length === 0) {
			throw new Inconclusive(
				`no take succeeded: ${settled.map((n) => `${n.id}=${n.status}${n.error ? ` (${n.error.slice(0, 60)})` : ""}`).join(", ")}`,
			)
		}
		const chosen = ready[0]
		const chosenSource = await fs.readFile(path.join(caretDir, "pages", chosen.id, "index.tsx"), "utf-8")
		assert(!chosenSource.includes("generating…"), `${chosen.id} still holds the stub — the model never built the page`)

		// Settle: "Add to canvas" on any live view that offers it.
		const picked = await app!.evaluate(async ({ BrowserWindow }, useTestId: string) => {
			const deadline = Date.now() + 30000
			while (Date.now() < deadline) {
				for (const win of BrowserWindow.getAllWindows()) {
					for (const view of (win?.contentView?.children ?? []) as any[]) {
						const wc = view?.webContents
						if (!wc || wc.isDestroyed() || !wc.getURL().startsWith("http://127.0.0.1")) continue
						const clicked = await wc
							.executeJavaScript(
								`(() => { const b = document.querySelector('[data-testid="${useTestId}"]'); if (!b) return false; b.click(); return true })()`,
							)
							.catch(() => false)
						if (clicked) return true
					}
				}
				await new Promise((r) => setTimeout(r, 300))
			}
			return false
		}, `variant-use-${chosen.id}`)
		assert(picked, `the "Add to canvas" button for ${chosen.id} never became clickable`)

		await waitFor(
			"the new page to join the canvas and the tree to clean up",
			async () => {
				const page = await fs.readFile(path.join(newPageDir, "index.tsx"), "utf-8").catch(() => "")
				const scratchGone = await fs
					.access(scratchPath)
					.then(() => false)
					.catch(() => true)
				if (page !== chosenSource || !scratchGone) return null
				const meta = JSON.parse(await fs.readFile(path.join(newPageDir, "meta.json"), "utf-8").catch(() => "{}"))
				return meta.id === "team" && meta.title === "Team" && !meta.variantOf ? true : null
			},
			30_000,
		)

		await shot(chrome, "24b-explore-new-page")
		return `"Team" explored from nothing: 3 stub takes built in parallel, ${chosen.id} added to the canvas as pages/team with a real identity`
	})

	await inference("by. app drift becomes a reviewed proposal, and accepting it makes the design true again", async () => {
		// Phase 9 end to end: home mapped to src/checkout-view.tsx and CLEAN,
		// then drifted, then propose_design_update runs a real model turn that
		// writes the App's-version take; the playground offers it against the
		// current design; a real click accepts it; the mapping refreshes and
		// get_drift reads clean — the design tells the truth again.
		//
		// The mapping is re-recorded HERE, not inherited from bx. This scenario
		// used to say "bx left home mapped and clean, nothing between here and
		// there inherits it" — which was false in a way that only failed when the
		// model felt like it: gg's sync apply refreshes home's mapping to
		// whichever app files the model chose to write, and a translation that
		// landed anywhere but checkout-view.tsx left this scenario drifting an
		// unmapped file. computeDrift then honestly reported nothing, and the
		// refusal read as a product bug. Recording first pins the baseline this
		// scenario's whole premise stands on.
		assert(discovery, "no MCP discovery record")
		await openMcpSession(discovery.url, discovery.token)

		await fs.writeFile(
			path.join(fixture, "src", "checkout-view.tsx"),
			"export const CheckoutView = () => <div>the translated checkout, at rest</div>\n",
		)
		const rerecord = await callMcp(discovery.url, discovery.token, {
			jsonrpc: "2.0",
			id: 95,
			method: "tools/call",
			params: {
				name: "report_sync_mapping",
				arguments: {
					mappings: [{ designPath: ".caret/pages/home/index.tsx", appPaths: ["src/checkout-view.tsx"] }],
				},
			},
		})
		const rerecordText = await rerecord.text()
		assert(
			rerecordText.includes('"recorded": 1') || rerecordText.includes('\\"recorded\\": 1'),
			`the baseline mapping was not recorded: ${mcpSaid(rerecordText)}`,
		)

		await fs.writeFile(
			path.join(fixture, "src", "checkout-view.tsx"),
			"export const CheckoutView = () => <div>edited directly in the app, after translation</div>\n",
		)

		const start = await callMcp(discovery.url, discovery.token, {
			jsonrpc: "2.0",
			id: 96,
			method: "tools/call",
			params: { name: "propose_design_update", arguments: { designPath: ".caret/pages/home/index.tsx" } },
		})
		const startText = await start.text()
		assert(
			startText.includes("proposalId") && !startText.includes('"isError":true'),
			`the proposal did not start: ${mcpSaid(startText)}`,
		)

		// The take streams into the playground; wait for it to be ready.
		// A model that produces NOTHING in six minutes is the model's failure,
		// not Caret's — same five-minute rule gg and ii draw (observed on the
		// free tier: an assistant turn with zero parts, no tools, no text).
		const scratchPath = path.join(fixture, ".caret", ".variants.json")
		try {
			await waitFor(
				"the App's-version take to finish its model turn",
				async () => {
					const raw = await fs.readFile(scratchPath, "utf-8").catch(() => null)
					if (!raw) return null
					const set = JSON.parse(raw)
					if (set.kind !== "drift-proposal") return null
					const take = set.nodes?.[0]
					if (take?.status === "failed") throw new Error(`the proposal turn failed: ${take.error}`)
					return take?.status === "ready" ? true : null
				},
				360_000,
			)
		} catch (err) {
			if (String(err).includes("Timed out")) {
				throw new Inconclusive("the model did not produce the proposal within six minutes")
			}
			throw err
		}

		// A review never hijacks the canvas: the pill is the way in. Click it if
		// the playground isn't up yet, then accept the App's version by click.
		// Same diagnosis as bq: the scratch reading "ready" while no button renders
		// is the canvas not hearing about it, which is a different fault from the
		// take failing, and the bare boolean could name neither.
		// All windows, all views, retried — the `getAllWindows()[0]` one-shot this
		// replaces is a race against cb's still-open second window and the hidden
		// screenshot windows the verify loop spawns. See bq for the full account.
		const picked = await app!.evaluate(async ({ BrowserWindow }) => {
			const deadline = Date.now() + 30000
			let lastDiag = "no live canvas view in any window"
			while (Date.now() < deadline) {
				for (const win of BrowserWindow.getAllWindows()) {
					for (const view of (win?.contentView?.children ?? []) as any[]) {
						const wc = view?.webContents
						if (!wc || wc.isDestroyed() || !wc.getURL().startsWith("http://127.0.0.1")) continue
						const clicked = await wc
							.executeJavaScript(
								`(() => {
									const b = document.querySelector('[data-testid="variant-use-home--v1"]')
									if (b) { b.click(); return "accepted" }
									const pill = document.querySelector('[data-testid="explore-open-pill"]')
									if (pill) { pill.click(); return "entered" }
									return false
								})()`,
							)
							.catch(() => false)
						if (clicked === "accepted") return { ok: true, diag: "" }
						const diag = await wc
							.executeJavaScript(
								`(() => {
									const view = document.querySelector('[data-testid="explore-view"]')
									if (!view) return null
									const cards = Array.from(document.querySelectorAll('[data-testid^="variant-card-"]')).map((c) => ({
										id: c.getAttribute('data-testid'),
										hasUseButton: !!c.querySelector('[data-testid^="variant-use-"]'),
										label: c.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 60),
									}))
									return JSON.stringify({ playgroundUp: true, cards })
								})()`,
							)
							.catch((e: unknown) => `canvas probe failed: ${String(e).slice(0, 120)}`)
						if (diag) lastDiag = String(diag)
					}
				}
				await new Promise((r) => setTimeout(r, 300))
			}
			return { ok: false, diag: lastDiag }
		})
		if (!picked.ok) {
			const onDisk = await fs.readFile(scratchPath, "utf-8").catch(() => "the scratch is gone")
			assert(
				false,
				`the App's-version take never became acceptable on the playground.\n` +
					`      playground: ${picked.diag}\n` +
					`      .variants.json: ${onDisk.replace(/\s+/g, " ").slice(0, 400)}`,
			)
		}

		// The deterministic contract of an accept: the take applies and cleans up,
		// and the mapping refreshes. What the model WROTE into the proposal is the
		// model's business — a lazy take may even match the page byte-for-byte —
		// so page content is not asserted.
		await waitFor(
			"the pick to apply and the takes to clean up",
			async () => {
				const scratchGone = await fs
					.access(scratchPath)
					.then(() => false)
					.catch(() => true)
				return scratchGone ? true : null
			},
			30_000,
		)

		// The acceptance IS the reverse sync: the mapping refreshed, drift clean.
		// Polled, not asked once — the accept deletes the scratch (which the wait
		// above watches) BEFORE it re-records the mapping, and the refresh runs a
		// git subprocess. A single get_drift fired the instant the scratch
		// vanished raced that gap and lost a full run; the product's ordering is
		// fine, the harness just has to wait for the state it is asserting.
		//
		// Clean is asserted for THIS scenario's entry, not globally. The global
		// check ("appDrift": 0 anywhere) inherited every earlier scenario's
		// leftovers: gg and ce write whatever app files the model chose, and a
		// run where those landed after align-demo's mapping was recorded kept
		// global drift nonzero forever — a timeout here for dirt this scenario
		// never made. Same lesson as the re-record above: own premise, own entry.
		let afterText = ""
		await waitFor(
			"the mapping to refresh and home's drift to read clean",
			async () => {
				const after = await callMcp(discovery!.url, discovery!.token, {
					jsonrpc: "2.0",
					id: 97,
					method: "tools/call",
					params: { name: "get_drift", arguments: {} },
				})
				afterText = await after.text()
				try {
					const frames = afterText.includes("data:")
						? afterText
								.split("\n")
								.filter((line) => line.startsWith("data:"))
								.map((line) => line.slice(5).trim())
						: [afterText]
					for (const frame of frames) {
						const text = JSON.parse(frame)?.result?.content?.[0]?.text
						if (typeof text !== "string") continue
						const drift = JSON.parse(text) as {
							entries?: Array<{ designPath?: string; classification?: string }>
						}
						const home = drift.entries?.find((entry) => entry.designPath === ".caret/pages/home/index.tsx")
						if (home?.classification === "clean") return true
					}
				} catch {
					// Not parseable yet — keep polling.
				}
				return null
			},
			20_000,
			// The raw body starts with SSE framing; the tool's own words say which
			// entry is still dirty.
			async () => `last get_drift said: ${mcpSaid(afterText)}`,
		)

		return `app drift → model-written proposal → accepted by click → mapping refreshed, home reads clean`
	})

	// ── the authored and 3D lanes, for real ────────────────────────────────────
	// Both spend someone's money or credits, so both are gated on the credentials
	// actually being present and skipped honestly otherwise — a run with skips
	// never reports CERTIFIED.

	// Probed only when paid lanes may run — `claude auth status` costs no
	// inference, but a subprocess with a ten-second timeout is still a wait for
	// an answer nothing below would use.
	const claudeReady =
		PAID &&
		(await new Promise<boolean>((resolve) => {
			child_process.execFile("claude", ["auth", "status"], { timeout: 10_000 }, (err, stdout) => {
				try {
					resolve(!err && Boolean((JSON.parse(stdout) as { loggedIn?: boolean }).loggedIn))
				} catch {
					resolve(false)
				}
			})
		}))

	if (!PAID) {
		skipPaid("bk. a mark is drawn, watched converging, and indexed")
	} else if (!claudeReady) {
		skip("bk. a mark is drawn, watched converging, and indexed", "the Claude CLI is not signed in on this machine")
	} else if (!process.env.GEMINI_API_KEY && !process.env.CARET_VERTEX_PROJECT && !process.env.GOOGLE_CLOUD_PROJECT) {
		skip(
			"bk. a mark is drawn, watched converging, and indexed",
			"the mark lane draws from a generated target image and needs Gemini or Vertex credentials",
		)
	} else {
		await scenario("bk. a mark is drawn, watched converging, and indexed", async () => {
			// The loop needs a model that accepts images, and the fixture's selected
			// backend is the bundled one — so the scenario walks the same road a
			// user would: switch the backend to Claude in the UI, then draw.
			await chrome.getByTestId("top-bar").getByRole("button", { name: "Backend" }).click()
			const claudeRow = chrome.getByTestId("backend-claude")
			await claudeRow.waitFor({ timeout: 30_000 })
			await claudeRow.getByRole("button").first().click()
			await chrome.getByText("Back to canvas").click()

			await chrome.getByTestId("top-bar").getByRole("button", { name: "Assets" }).click()
			await chrome.getByTestId("assets-generate").click()
			const panel = chrome.getByTestId("generate-asset")
			await panel.waitFor({ timeout: 15_000 })

			const ask = panel.getByTestId("generate-ask")
			await ask.waitFor({ timeout: 15_000 })
			await ask.locator('[data-generate-kind="mark"]').click()
			// A fact, not a style prompt — the field's whole contract, and the lane
			// that always got this right.
			await ask.getByTestId("generate-request").fill("a compass rose")
			await ask.getByTestId("generate-begin").click()

			// Marks ride the clarify → rebuild road now. Skipping the questions
			// still runs the rebuild (a model turn), so the wait covers both the
			// question screen appearing and the flow arriving directly.
			const flow = panel.getByTestId("generate-mark")
			const clarify = panel.getByTestId("generate-clarify")
			const arrived = await waitFor("the mark flow or its clarify questions", async () =>
				(await flow.isVisible().catch(() => false))
					? "flow"
					: (await clarify.isVisible().catch(() => false))
						? "clarify"
						: null,
			)
			if (arrived === "clarify") {
				await clarify.getByTestId("generate-clarify-skip").click()
				await flow.waitFor({ timeout: 180_000 })
				// The rebuild rewrote the subject into a brief — in front of the
				// user, into the editable field. Empty would mean it was lost.
				assert(
					((await flow.getByTestId("mark-subject").inputValue()) ?? "").trim().length > 0,
					"the subject was lost on the way into the mark flow",
				)
			} else {
				// No questions asked: carried through rather than asked again.
				assert(
					(await flow.getByTestId("mark-subject").inputValue()) === "a compass rose",
					"the mark lane asked for the subject a second time",
				)
			}
			await flow.getByTestId("mark-generate").click()

			// The vision probe, a target image, and up to six rounds of a real
			// model closing the gap. Minutes.
			const result = flow.getByTestId("mark-result")
			await result.waitFor({ timeout: 720_000 })

			// The convergence was streamed, not just claimed: at least one round's
			// render arrived as an image that actually decodes.
			const roundImages = await flow.locator('[data-testid="mark-rounds"] img').count()
			assert(roundImages >= 1, "no round renders were streamed to the UI")
			const decoded = await flow
				.locator('[data-testid="mark-rounds"] img')
				.first()
				.evaluate((img: HTMLImageElement) => img.naturalWidth)
			assert(decoded > 0, "a streamed round render did not decode")
			await shot(chrome, "23-mark-rounds")

			await flow.getByTestId("mark-tag").fill("compass-mark")
			await flow.getByTestId("mark-save").click()

			// Completed entry, not first sight — see bg for why.
			const raw = await waitFor(
				"the mark to reach the index with its provenance",
				async () => {
					const text = await fs.readFile(path.join(fixture, ".caret", "assets", "index.json"), "utf-8").catch(() => "")
					if (!text.includes('"compass-mark"')) return null
					const found = (JSON.parse(text) as { assets: Array<Record<string, any>> }).assets.find(
						(asset) => asset.tag === "compass-mark",
					)
					return found?.description && found?.origin?.type === "generated" ? text : null
				},
				30_000,
			)
			const entry = (JSON.parse(raw) as { assets: Array<Record<string, unknown>> }).assets.find(
				(asset) => asset.tag === "compass-mark",
			)
			assert(entry?.kind === "vector", `the mark was indexed as ${entry?.kind}`)
			const origin = entry?.origin as Record<string, unknown> | undefined
			assert(origin?.lane === "authored", `the lane was recorded as ${origin?.lane}`)
			assert((origin?.answers as Record<string, string>)?.subject === "a compass rose", "the subject was not recorded")

			return `${roundImages} round(s) streamed live, saved as @compass-mark with the subject and rounds in provenance`
		})
	}

	const tripoReady = Boolean(process.env.TRIPO_API_KEY)
	const vertexReady = Boolean(
		process.env.CARET_VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.GEMINI_API_KEY,
	)
	if (!PAID) {
		skipPaid("bl. an image becomes an optimized 3D model")
	} else if (!tripoReady || !vertexReady || !claudeReady) {
		const missing = [
			!tripoReady && "TRIPO_API_KEY",
			!vertexReady && "image credentials for the source",
			!claudeReady && "a signed-in Claude for verification",
		]
			.filter(Boolean)
			.join(", ")
		skip("bl. an image becomes an optimized 3D model", `missing: ${missing}`)
	} else {
		await scenario("bl. an image becomes an optimized 3D model", async () => {
			await chrome.getByTestId("assets-generate").click()
			const panel = chrome.getByTestId("generate-asset")
			await panel.waitFor({ timeout: 15_000 })

			const ask = panel.getByTestId("generate-ask")
			await ask.waitFor({ timeout: 15_000 })
			await ask.locator('[data-generate-kind="object3d"]').click()
			await ask.getByTestId("generate-request").fill("a ceramic mug with a simple silhouette")
			await ask.getByTestId("generate-begin").click()

			// Same clarify → rebuild road as the mark scenario above.
			const flow = panel.getByTestId("generate-model3d")
			const clarify3d = panel.getByTestId("generate-clarify")
			const arrived3d = await waitFor("the 3D flow or its clarify questions", async () =>
				(await flow.isVisible().catch(() => false))
					? "flow"
					: (await clarify3d.isVisible().catch(() => false))
						? "clarify"
						: null,
			)
			if (arrived3d === "clarify") {
				await clarify3d.getByTestId("generate-clarify-skip").click()
				await flow.waitFor({ timeout: 180_000 })
			}

			// The verification layer, certified on its reject path first: the
			// workbench photograph is several tools on a surface, and building a 3D
			// model from it would fuse them into a lump. The refusal costs one
			// vision turn and spends nothing at Tripo.
			await flow.locator('[data-model3d-source="hero-bench"]').click()
			await flow.getByTestId("model3d-generate").click()
			const refusal = flow.getByTestId("model3d-error")
			await refusal.waitFor({ timeout: 180_000 })
			const said = await refusal.innerText()
			assert(/single object/i.test(said), `the refusal does not explain the problem: ${said}`)
			assert(/saw/i.test(said), "the refusal does not carry what the model actually saw")

			// The purpose-made source: four single-object studies through the
			// ordinary photograph pipeline, picked by clicking, landing as a normal
			// asset that the flow then auto-selects.
			await flow.getByTestId("model3d-generate-source").click()
			const options = flow.getByTestId("model3d-source-options")
			await options.waitFor({ timeout: 240_000 })
			await options.locator("[data-model3d-source-option]").first().waitFor({ timeout: 240_000 })
			await options.locator("[data-model3d-source-option]").first().click()
			await flow.locator('[data-model3d-source^="object-study"]').waitFor({ timeout: 60_000 })

			await flow.getByTestId("model3d-generate").click()

			// Result or error, whichever lands — a hang on the error box was how the
			// first live run died, waiting 900s for a result that was never coming.
			const result = flow.getByTestId("model3d-result")
			const failed = flow.getByTestId("model3d-error")
			await Promise.race([
				result.waitFor({ timeout: 900_000 }),
				failed.waitFor({ timeout: 900_000 }).then(async () => {
					throw new Error(`the pipeline failed: ${await failed.innerText()}`)
				}),
			])
			await shot(chrome, "24-model3d-result")

			await flow.getByTestId("model3d-tag").fill("bench-object")
			await flow.getByTestId("model3d-save").click()

			// Completed entry, not first sight — see bg for why.
			const raw = await waitFor(
				"the model to reach the index with its provenance",
				async () => {
					const text = await fs.readFile(path.join(fixture, ".caret", "assets", "index.json"), "utf-8").catch(() => "")
					if (!text.includes('"bench-object"')) return null
					const found = (JSON.parse(text) as { assets: Array<Record<string, any>> }).assets.find(
						(asset) => asset.tag === "bench-object",
					)
					return found?.description && found?.origin?.type === "generated" ? text : null
				},
				30_000,
			)
			const entry = (JSON.parse(raw) as { assets: Array<Record<string, unknown>> }).assets.find(
				(asset) => asset.tag === "bench-object",
			)
			assert(entry?.kind === "model", `the model was indexed as ${entry?.kind}`)
			assert(Number(entry?.bytes) > 1_000, `the glb is only ${entry?.bytes} bytes`)

			// A glb that is actually a glb, on disk, byte one through four.
			const glb = await fs.readFile(path.join(fixture, ".caret", "assets", String(entry?.file)))
			assert(glb.toString("ascii", 0, 4) === "glTF", "the stored file does not carry the glb magic")

			const origin = entry?.origin as Record<string, unknown> | undefined
			assert(origin?.lane === "model3d", `the lane was recorded as ${origin?.lane}`)
			assert(origin?.producer === "tripo", `the producer was recorded as ${origin?.producer}`)
			const resolved = String(origin?.resolved ?? "")
			assert(resolved.includes("taskIds"), "the Tripo task ids were not recorded")
			assert(resolved.includes("draftBytes"), "the draft weight was not recorded")

			return `workbench refused as a source with what the model saw, object study generated and accepted, glb landed at ${Math.round(Number(entry?.bytes) / 1024)}KB`
		})
	}
}

async function cleanup(): Promise<void> {
	await app?.close().catch(() => {})
	if (fixture && !KEEP) {
		await fs.rm(fixture, { recursive: true, force: true }).catch(() => {})
	} else if (fixture) {
		log(`fixture kept at ${fixture}`)
	}
	if (userData && !KEEP) await fs.rm(userData, { recursive: true, force: true }).catch(() => {})
	reapOrphanedBackends()
}

/**
 * Kills bundled-backend servers this harness orphaned.
 *
 * The app spawns `opencode.exe serve` as an ordinary child and kills it in
 * `before-quit` — which never fires here, because Playwright's teardown
 * SIGKILLs the app. The server is reparented to PID 1 and its agent loop polls
 * the provider forever; one session of verify runs left **32** of them running.
 *
 * Two conditions, both required, so a real Caret the user has open is never
 * touched: the command line must name *this repo's* bundled binary, and the
 * process must already be an orphan (PPID 1) — a live app still holds its
 * child, so its server never matches.
 */
function reapOrphanedBackends(): void {
	const binary = path.resolve("node_modules/opencode-ai/bin/opencode.exe")
	try {
		const table = child_process.execFileSync("ps", ["-eo", "pid=,ppid=,command="], { encoding: "utf-8" })
		let reaped = 0
		for (const line of table.split("\n")) {
			const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
			if (!match) continue
			const [, pid, ppid, command] = match
			if (ppid !== "1" || !command.includes(binary)) continue
			try {
				process.kill(Number(pid))
				reaped++
			} catch {
				// Already gone, or not ours to kill. Either way, not a failure.
			}
		}
		if (reaped > 0) log(`reaped ${reaped} orphaned backend server(s)`)
	} catch {
		// `ps` unavailable or unparseable — skip rather than fail a finished run.
	}
}

main()
	.catch((err) => {
		results.push({ name: "harness", passed: false, detail: String(err) })
	})
	.finally(async () => {
		await cleanup()

		console.log("\n========== CARET APP CERTIFICATION ==========")
		for (const result of results) {
			const mark = result.skipped ? "SKIP" : result.passed ? "PASS" : "FAIL"
			console.log(`${mark}  ${result.name.padEnd(56)} ${result.detail}`)
		}
		const failed = results.filter((r) => !r.passed)
		const skipped = results.filter((r) => r.skipped)
		// Two different absences. A credential skip is a machine that *cannot*,
		// and blocks certification; a paid-off skip is a run that *chose not to
		// spend* on lanes certified live when they landed — the free surface can
		// still certify, with the exclusion named so nobody reads it as coverage.
		const unable = skipped.filter((r) => !r.paidOff)
		const paidOff = skipped.filter((r) => r.paidOff)
		console.log("=============================================")
		console.log(
			failed.length > 0
				? `${failed.length} scenario(s) FAILED`
				: unable.length > 0
					? // Never "all pass" with something unrun — that reads as full
						// coverage to anyone skimming a CI log.
						`${results.length - skipped.length} passed, ${skipped.length} SKIPPED (not certified)`
					: ONLY
						? `${results.length} passed — PARTIAL RUN (--only), not a certification`
						: paidOff.length > 0
							? `CERTIFIED (free surface): ${results.length - paidOff.length} scenarios pass — ` +
								`${paidOff.length} paid lane(s) off by default, run with --paid to certify them`
							: `CERTIFIED: all ${results.length} scenarios pass`,
		)
		process.exit(failed.length === 0 ? 0 : 1)
	})
