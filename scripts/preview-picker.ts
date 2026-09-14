/**
 * Opens the app on a throwaway project and photographs the model picker.
 *
 * The picker is the surface that decides what a turn costs, so it is worth
 * looking at rather than reasoning about: the provider grouping, the doors to
 * subscriptions that are not connected, and what a refusal reads like. Costs
 * nothing — no turn is sent, and the entitlement probe only fires on a pick.
 *
 *   npx tsx scripts/preview-picker.ts [--keep]
 */

import * as child_process from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { type ElectronApplication, _electron as electron } from "playwright"

import { ensureCaretDirectoryExists } from "../src/core/design/scaffold"

const SHOTS = path.resolve("release/picker-shots")
const KEEP = process.argv.includes("--keep")

async function fixture(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "caret-picker-"))
	await ensureCaretDirectoryExists(dir)

	const pageDir = path.join(dir, ".caret", "pages", "home")
	await fs.mkdir(pageDir, { recursive: true })
	await fs.writeFile(
		path.join(pageDir, "index.tsx"),
		`export default function Home() {\n\treturn <main className="p-8"><h1>Home</h1></main>\n}\n`,
	)
	await fs.writeFile(
		path.join(pageDir, "meta.json"),
		JSON.stringify({ id: "home", title: "Home", type: "page", states: ["default"], tags: [] }, null, 2),
	)

	const git = (args: string) => child_process.execSync(`git ${args}`, { cwd: dir, stdio: "ignore" })
	git("init -q")
	git("config user.email caret@local")
	git("config user.name Caret")
	git("config commit.gpgSign false")
	git("add -A")
	git('commit -q -m "fixture" --no-verify')
	return dir
}

async function main(): Promise<void> {
	const project = await fixture()
	const userData = await fs.mkdtemp(path.join(os.tmpdir(), "caret-picker-profile-"))
	await fs.mkdir(SHOTS, { recursive: true })

	let app: ElectronApplication | null = null
	try {
		app = await electron.launch({
			args: [path.resolve("out/main/index.js"), `--user-data-dir=${userData}`, project],
			env: { ...process.env, CARET_VERIFY_PROJECT: project, NODE_ENV: "test" },
		})
		app.process().stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[main] ${chunk}`))
		app.process().stderr?.on("data", (chunk: Buffer) => process.stdout.write(`[main] ${chunk}`))

		const chrome = await app.firstWindow()
		await chrome.waitForSelector('[data-testid="top-bar"]', { timeout: 60_000 })

		// The bundled backend has to be chosen before the composer is live, the
		// same way a person would: the picker is not a substitute for connecting.
		await chrome.getByTestId("top-bar").getByRole("button", { name: "Backend" }).click()
		await chrome.waitForSelector('[data-testid="backend-opencode"]', { timeout: 90_000 })
		await chrome.screenshot({ path: path.join(SHOTS, "1-backend-tab.png") })
		await chrome.getByTestId("backend-opencode").getByRole("button", { name: "Use this" }).click()
		await chrome.getByTestId("top-bar").getByRole("button", { name: "Backend" }).click()

		// The composer exists only once the sidebar is open, and it opens from the
		// top bar rather than by default.
		await chrome.getByTestId("top-bar").getByRole("button", { name: "Chat" }).click()
		await chrome.waitForSelector('[data-testid="chat-model-pill"]', { timeout: 60_000 })
		await chrome.getByTestId("chat-model-pill").click()
		await chrome.waitForSelector('[data-testid="chat-model-menu"]', { timeout: 30_000 })
		// The list loads over IPC; give the catalogue a moment to land.
		await chrome.waitForTimeout(2500)
		await chrome.screenshot({ path: path.join(SHOTS, "2-model-picker.png") })

		const menu = await chrome.getByTestId("chat-model-menu").textContent()
		console.log(`\n=== what the picker offers\n${menu?.replace(/\s{2,}/g, "\n")}\n`)

		// The filter, on a name that spans two providers.
		await chrome.getByTestId("chat-model-filter").fill("kimi")
		await chrome.waitForTimeout(300)
		await chrome.screenshot({ path: path.join(SHOTS, "3-filtered.png") })
		console.log(
			`=== filtered to "kimi"\n${(await chrome.getByTestId("chat-model-menu").textContent())?.replace(/\s{2,}/g, "\n")}\n`,
		)

		// Picking one drives the entitlement probe: one trivial turn, and the
		// notice line only appears if the provider refuses.
		await chrome.getByTestId("chat-model-filter").fill("")
		const pick = process.env.CARET_PICKER_MODEL ?? "opencode-go/gpt-5.6-luna"
		await chrome.getByTestId(`chat-model-${pick}`).click()
		await chrome.waitForTimeout(12_000)
		await chrome.screenshot({ path: path.join(SHOTS, "4-after-pick.png") })

		const notice = await chrome
			.getByTestId("chat-model-notice")
			.textContent()
			.catch(() => null)
		const pill = await chrome.getByTestId("chat-model-pill").textContent()
		console.log(`=== after picking ${pick}\n  pill: ${pill}\n  notice: ${notice ?? "(none — the model answered)"}\n`)

		// The unhappy half, which the happy path cannot show: a model the provider
		// will not serve. Asked over the same IPC the picker uses, so what comes
		// back is exactly what the notice would quote.
		const refused = await chrome.evaluate(
			async ([path, model]) =>
				(window as never as { caret: { invoke(...args: unknown[]): Promise<unknown> } }).caret.invoke(
					"agent:probeModel",
					path,
					model,
				),
			[project, "opencode-go/no-such-model-exists"],
		)
		console.log(`=== a model the provider will not serve\n  probe said: ${JSON.stringify(refused)}\n`)

		if (KEEP) {
			console.log("--keep: leaving the app open. Ctrl-C when done.")
			await new Promise(() => {})
		}
	} finally {
		await app?.close().catch(() => {})
		if (!KEEP) {
			await fs.rm(project, { recursive: true, force: true }).catch(() => {})
			await fs.rm(userData, { recursive: true, force: true }).catch(() => {})
		}
	}
	console.log(`shots in ${SHOTS}`)
}

main().then(
	() => process.exit(0),
	(err) => {
		console.error(err)
		process.exit(1)
	},
)
