/**
 * Helpers for tests that drive the real Caret app: make a throwaway project,
 * launch the built app on it with a throwaway profile, keep the app's own log,
 * wait for things with a reason on timeout, take screenshots.
 *
 * Every launch uses a fresh profile folder (`--user-data-dir`), so a test never
 * reads or changes the developer's own settings, and one test case can never
 * inherit another's state.
 */
import * as child_process from "child_process"
import * as fsSync from "fs"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { type ElectronApplication, _electron as electron, type Page } from "playwright"

import { writeSampleApp } from "../src/core/design/interview/testing/sample-app"
import { ensureCaretDirectoryExists } from "../src/core/design/scaffold"

export function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message)
}

/**
 * Polls until `check` returns something truthy, or the deadline passes. On a
 * timeout, `diagnose` says what the app looked like when it gave up, so a
 * failure names a cause instead of costing a re-run.
 */
export async function waitFor<T>(
	label: string,
	check: () => Promise<T | null | undefined | false>,
	timeoutMs = 120_000,
	diagnose?: () => Promise<string>,
): Promise<T> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const value = await check()
		if (value) return value
		await new Promise((resolve) => setTimeout(resolve, 400))
	}
	const detail = diagnose ? await diagnose().catch((err) => `(diagnosis failed: ${err})`) : ""
	throw new Error(`Timed out waiting for ${label}${detail ? `: ${detail}` : ""}`)
}

const APP_SOURCE = `export default function App() {
	return <main><h1>Argus</h1><p>Monitoring for your own servers.</p></main>
}
`

/**
 * A folder Caret recognises as a project, with a little app code and a git
 * commit. With `sampleApp`, the app is the shared sample app (a Next.js and
 * Tailwind dashboard), set up exactly as scripts/record-interview.ts sets it
 * up, so the "Use what my app already has" requests match its recordings.
 */
export async function buildProject(template?: string, options: { sampleApp?: boolean } = {}): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "caret-interview-"))
	if (options.sampleApp) {
		await writeSampleApp(dir)
		await ensureCaretDirectoryExists(dir)
		copyDependencies(template, dir)
		return dir
	}
	await ensureCaretDirectoryExists(dir)
	await fs.mkdir(path.join(dir, "src"), { recursive: true })
	await fs.writeFile(path.join(dir, "src", "App.tsx"), APP_SOURCE)
	copyDependencies(template, dir)
	const git = (args: string[]) => child_process.execFileSync("git", args, { cwd: dir, stdio: "ignore" })
	git(["init", "-q"])
	git(["config", "user.email", "caret@local"])
	git(["config", "user.name", "Caret"])
	git(["config", "commit.gpgSign", "false"])
	git(["add", "-A"])
	git(["commit", "-q", "-m", "fixture", "--no-verify"])
	return dir
}

/**
 * Reuses the preview dependencies another test project already installed. A
 * clone on macOS is near-instant; if anything is missing, Caret's own check
 * reinstalls, so a bad copy costs time, never correctness.
 */
function copyDependencies(template: string | undefined, dir: string): void {
	if (!template) return
	for (const name of ["node_modules", "package.json", "package-lock.json"]) {
		const from = path.join(template, ".caret", name)
		if (fsSync.existsSync(from)) child_process.execFileSync("cp", ["-cR", from, path.join(dir, ".caret", name)])
	}
}

export interface LaunchedApp {
	app: ElectronApplication
	/** The main window: Caret's own screens (not the canvas preview). */
	chrome: Page
	close(): Promise<void>
}

/**
 * Launches the built app (`out/main/index.js`) on a project. The app's own
 * console output is appended to `logFile`, so a relaunch keeps one log.
 */
export async function launchApp(options: {
	project: string
	userData: string
	logFile: string
	env?: Record<string, string>
}): Promise<LaunchedApp> {
	// Opened first, so nothing awaits between the process starting and the
	// listeners attaching: the app's earliest lines were sometimes lost.
	const log = await fs.open(options.logFile, "a")
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), `--user-data-dir=${options.userData}`, options.project],
		env: { ...process.env, NODE_ENV: "test", CARET_DISABLE_TELEMETRY: "1", ...options.env },
	})
	app.process().stdout?.on("data", (chunk) => void log.write(chunk))
	app.process().stderr?.on("data", (chunk) => void log.write(chunk))
	app.on("close", () => void log.write(`\n[test] the app process exited at ${new Date().toISOString()}\n`))

	await app.firstWindow({ timeout: 60_000 })
	const chrome = await waitFor(
		"Caret's main window",
		async () => app.windows().find((page) => page.url().startsWith("file:")) ?? null,
		60_000,
	)
	// The top bar appears once the project has loaded, which on a fresh project
	// includes installing the preview's dependencies.
	await chrome.waitForSelector('[data-testid="top-bar"]', { timeout: 240_000 })
	return {
		app,
		chrome,
		async close() {
			await app.close().catch(() => {})
			await log.close().catch(() => {})
		},
	}
}

/** A fresh profile folder with the first-run notices already dismissed. */
export async function freshProfile(prefs: Record<string, unknown> = {}): Promise<string> {
	const userData = await fs.mkdtemp(path.join(os.tmpdir(), "caret-profile-"))
	await fs.writeFile(path.join(userData, "preferences.json"), JSON.stringify({ telemetryNoticeShown: true, ...prefs }))
	return userData
}

/** A screenshot for a person to look at. Never fails a test. */
export async function shot(page: Page, dir: string, name: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true })
	await page.screenshot({ path: path.join(dir, `${name}.png`) }).catch(() => {})
}

/** From the Foundation entry screen to the description box, whichever form the entry takes. */
export async function openDescribe(chrome: Page, description: string): Promise<void> {
	await chrome.waitForSelector('[data-testid="foundation-entry"]', { timeout: 30_000 })
	if (await chrome.getByTestId("foundation-route-new-look").count()) {
		await chrome.click('[data-testid="foundation-route-new-look"]')
	}
	await chrome.waitForSelector('[data-testid="foundation-describe"]', { timeout: 20_000 })
	await chrome.fill('[data-testid="foundation-describe"]', description)
}

/** The project's MCP address and token, which an outside agent uses to talk to Caret. */
export async function readDiscovery(project: string): Promise<{ url: string; token: string } | null> {
	try {
		return JSON.parse(await fs.readFile(path.join(project, ".caret", ".mcp.json"), "utf-8"))
	} catch {
		return null
	}
}

/** Calls one of Caret's MCP tools the way an outside agent (for example the chat) would. */
export async function callMcpTool(
	discovery: { url: string; token: string },
	name: string,
	args: Record<string, unknown>,
): Promise<string> {
	const post = (body: unknown) =>
		fetch(discovery.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: `Bearer ${discovery.token}`,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(90_000),
		})
	await post({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "caret-test", version: "0.1.0" } },
	})
	await post({ jsonrpc: "2.0", method: "notifications/initialized" })
	const response = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } })
	return response.text()
}

/** Stops AI servers left behind by a crashed earlier run (their parent is gone). */
export function reapOrphanedBackends(): void {
	const binary = path.resolve("node_modules/opencode-ai/bin/opencode.exe")
	try {
		const table = child_process.execFileSync("ps", ["-eo", "pid=,ppid=,command="], { encoding: "utf-8" })
		for (const line of table.split("\n")) {
			const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
			if (match && match[2] === "1" && match[3].includes(binary)) {
				try {
					process.kill(Number(match[1]))
				} catch {
					// Already gone.
				}
			}
		}
	} catch {
		// `ps` unavailable: nothing to reap.
	}
}
