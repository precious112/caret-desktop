/**
 * get_screenshot and the design checks rendering the SAME page at once.
 *
 * The checks' cleanup used to destroy every window showing that page — the
 * screenshot's capture window included — and the screenshot call then never
 * answered (verify-app t, twice; 6/6 calls here). Checks run after every agent
 * turn, which is exactly when an agent screenshots the page it just wrote.
 *
 *   npm run build && npx tsx scripts/probe-screenshot-race.ts
 */
import { _electron as electron } from "playwright"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { ensureCaretDirectoryExists } from "../src/core/design/scaffold"

const root = path.resolve(".")
const ROUNDS = 6
async function call(url: string, token: string, name: string, args: Record<string, unknown>): Promise<string> {
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
		signal: AbortSignal.timeout(60_000),
	})
	return res.text()
}

async function main(): Promise<void> {
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "caret-race-"))
	await ensureCaretDirectoryExists(project)
	const pageDir = path.join(project, ".caret/pages/home")
	await fs.mkdir(pageDir, { recursive: true })
	await fs.writeFile(
		path.join(pageDir, "index.tsx"),
		'export default function Home() {\n  return (\n    <main className="min-h-screen p-16">\n      <h1 className="text-4xl font-semibold">Home</h1>\n      <p className="mt-4">A page to photograph.</p>\n    </main>\n  )\n}\n',
	)
	await fs.writeFile(
		path.join(pageDir, "meta.json"),
		JSON.stringify({ id: "home", title: "Home", type: "page", states: [], tags: [] }),
	)
	const userData = await fs.mkdtemp(path.join(os.tmpdir(), "caret-profile-"))
	await fs.writeFile(path.join(userData, "preferences.json"), JSON.stringify({ telemetryNoticeShown: true }))

	const app = await electron.launch({
		args: [path.join(root, "out/main/index.js"), `--user-data-dir=${userData}`, project],
		env: { ...process.env, NODE_ENV: "test", CARET_DISABLE_TELEMETRY: "1" },
		cwd: root,
	})

	try {
		const chrome = await app.firstWindow()
		await chrome.waitForFunction(
			() => document.querySelector('[data-testid="top-bar"]')?.textContent?.includes("Preview running"),
			undefined,
			{ timeout: 25 * 60_000, polling: 1000 },
		)
		const { url, token } = JSON.parse(await fs.readFile(path.join(project, ".caret/.mcp.json"), "utf-8"))
		let hung = 0
		let answered = 0
		for (let round = 1; round <= ROUNDS; round++) {
			const [shot, checks] = await Promise.allSettled([
				call(url, token, "get_screenshot", { pageId: "home" }),
				call(url, token, "run_design_checks", { pageId: "home" }),
			])
			const shotOk = shot.status === "fulfilled"
			if (!shotOk) hung++
			else answered++
			console.log(
				`round ${round}: get_screenshot ${shotOk ? (shot.value.includes('"type":"image"') ? "returned an image" : "answered without an image") : "HUNG"}, checks ${checks.status === "fulfilled" ? "answered" : "HUNG"}`,
			)
		}
		console.log(
			hung === 0
				? `PASS  every get_screenshot answered (${answered}/${ROUNDS})`
				: `FAIL  ${hung}/${ROUNDS} get_screenshot calls hung`,
		)
	} finally {
		await app.close().catch(() => {})
		await fs.rm(project, { recursive: true, force: true })
		await fs.rm(userData, { recursive: true, force: true })
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
