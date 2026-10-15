/**
 * The Skills and Libraries features, certified in the real app.
 *
 * Each case opens the built Caret (`out/main/index.js`) on a fresh project
 * with a fresh profile, does what a user (or a coding tool) does, and then
 * reads the files on disk and Caret's own log. Nothing is skipped: a case that
 * cannot run fails, and so does a run where fewer cases ran than were chosen.
 *
 * No network: the built-in libraries are switched off in the test profile, and
 * a stand-in library (`test-fixtures/libraries/fake-library.cjs`) answers with
 * known results, through a switch that only exists in development builds.
 *
 *   npm run test:skills                  build, then every case
 *   npx tsx scripts/verify-skills.ts --only 6,7   some cases (not a certification)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import * as fs from "fs/promises"
import * as path from "path"

import {
	assert,
	buildProject,
	freshProfile,
	type LaunchedApp,
	launchApp,
	reapOrphanedBackends,
	shot,
	waitFor,
} from "./verify-kit"

const SHOTS = path.resolve("release/skills-shots")
const FAKE_LIBRARY = path.resolve("test-fixtures/libraries/fake-library.cjs")
const BUILT_IN = ["shadcn", "aceternity", "lazyweb", "gummble", "twentyfirst"]

const args = process.argv.slice(2)
const ONLY = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1].split(",")) : null

interface Run {
	id: string
	project: string
	userData: string
	dir: string
	logFile: string
	launched: LaunchedApp
}

let template: string | undefined

/** A fresh project and profile, with the stand-in library and only the built-in libraries the case wants on. */
async function startRun(id: string, options: { builtInOn?: string[] } = {}): Promise<Run> {
	const dir = path.join(SHOTS, `case-${id}`)
	await fs.rm(dir, { recursive: true, force: true })
	await fs.mkdir(dir, { recursive: true })
	const project = await buildProject(template)
	const userData = await freshProfile({ librariesOff: BUILT_IN.filter((library) => !options.builtInOn?.includes(library)) })
	const logFile = path.join(dir, "main.log")
	const launched = await launchApp({ project, userData, logFile, env: { CARET_TEST_LIBRARY: FAKE_LIBRARY } })
	template ??= project
	return { id, project, userData, dir, logFile, launched }
}

async function withRun(id: string, options: { builtInOn?: string[] }, body: (run: Run) => Promise<string>): Promise<string> {
	const run = await startRun(id, options)
	try {
		const detail = await body(run)
		await checkLog(run)
		return detail
	} catch (err) {
		await shot(run.launched.chrome, run.dir, "failure")
		throw err
	} finally {
		await run.launched.close()
	}
}

/** The app logged no error. (That it used the stand-in library is proved by case 6's tool list, not a log line.) */
async function checkLog(run: Run): Promise<void> {
	const log = await fs.readFile(run.logFile, "utf8")
	const errors = log.split("\n").filter((line) => /\bERROR\b/.test(line))
	assert(errors.length === 0, `the app logged errors:\n  ${errors.slice(0, 5).join("\n  ")}`)
}

/** Connects to Caret from a folder exactly as a coding tool does: the helper program, started in that folder. */
async function connectLikeACodingTool(run: Run, folder: string): Promise<Client> {
	const execPath = await run.launched.app.evaluate(({ app }) => app.getPath("exe"))
	const bridge = path.join(run.userData, "mcp-stdio-bridge.cjs")
	await waitFor("the helper program to be written", async () => fs.stat(bridge).catch(() => null), 30_000)
	const client = new Client({ name: "coding-tool-stand-in", version: "1.0.0" })
	await client.connect(
		new StdioClientTransport({
			command: execPath,
			args: [bridge],
			cwd: folder,
			env: { ...(process.env as Record<string, string>), ELECTRON_RUN_AS_NODE: "1" },
			stderr: "ignore",
		}),
	)
	return client
}

async function toolsOf(client: Client): Promise<Tool[]> {
	return (await client.listTools()).tools
}

/** Every text file in the project, outside dependencies, that contains `needle`. */
async function filesContaining(root: string, needle: string): Promise<string[]> {
	const found: string[] = []
	const walk = async (dir: string): Promise<void> => {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			if (entry.name === "node_modules" || entry.name === ".git") continue
			const full = path.join(dir, entry.name)
			if (entry.isDirectory()) await walk(full)
			else if ((await fs.readFile(full, "utf8").catch(() => "")).includes(needle)) found.push(path.relative(root, full))
		}
	}
	await walk(root)
	return found
}

async function rulesText(project: string): Promise<string> {
	return fs.readFile(path.join(project, "AGENTS.md"), "utf8").catch(() => "")
}

async function openLibraries(run: Run): Promise<void> {
	const chrome = run.launched.chrome
	await chrome.getByTestId("top-bar").getByRole("button", { name: "Backend" }).click()
	await chrome.getByTestId("libraries-section").waitFor({ timeout: 20_000 })
}

const CASES: Array<{ id: string; title: string; run(): Promise<string> }> = [
	{
		id: "6",
		title: "a coding tool connected to Caret finds and uses a library through Caret, and nothing it should not see",
		run: () =>
			withRun("6", {}, async (run) => {
				const client = await connectLikeACodingTool(run, run.project)
				try {
					const tools = await waitFor(
						"the stand-in library's tools in Caret's tool list",
						async () => {
							const list = await toolsOf(client)
							return list.some((tool) => tool.name === "testlib_search_components") ? list : null
						},
						60_000,
					)
					const names = tools.map((tool) => tool.name)
					assert(names.includes("get_project"), "Caret's own tools are missing from the list")
					assert(!names.includes("testlib_delete_everything"), "a library tool that is not allowed was passed on")
					const union = tools.find((tool) => tool.name === "testlib_union_tool")
					assert(union, "the allowed testlib_union_tool was not passed on")
					assert(
						!("anyOf" in union.inputSchema) && union.inputSchema.type === "object",
						`a top-level anyOf was passed on: ${JSON.stringify(union.inputSchema)}`,
					)
					const result = await client.callTool({ name: "testlib_search_components", arguments: { query: "pricing" } })
					const text = (result.content as Array<{ text?: string }>).map((part) => part.text ?? "").join(" ")
					assert(
						text.includes('FAKE-LIBRARY-RESULT: @testlib/pricing-table for "pricing"'),
						`the library's answer did not come back: ${text}`,
					)
					return `${names.length} tools: Caret's own and the library's; the disallowed tool hidden, the union folded, a search answered`
				} finally {
					await client.close()
				}
			}),
	},
	{
		id: "7",
		title: "outside a Caret project, the connection starts quietly and offers nothing",
		run: () =>
			withRun("7", {}, async (run) => {
				const elsewhere = await fs.mkdtemp(path.join(path.dirname(run.project), "not-caret-"))
				const client = await connectLikeACodingTool(run, elsewhere)
				try {
					const tools = await toolsOf(client)
					assert(tools.length === 0, `a folder that is not a Caret project got ${tools.length} tools`)
					return "started without an error, zero tools"
				} finally {
					await client.close()
				}
			}),
	},
	{
		id: "9",
		title: "a pasted 21st.dev key is stored encrypted and is never written into the project",
		run: () =>
			withRun("9", { builtInOn: ["twentyfirst"] }, async (run) => {
				const chrome = run.launched.chrome
				const key = "caret-test-key-7f3a91"
				await openLibraries(run)
				const row = chrome.locator('[data-library="twentyfirst"]')
				await row.getByTestId("library-key").click()
				await row.getByTestId("library-key-input").fill(key)
				await row.getByTestId("library-key-save").click()
				await waitFor(
					"the key box to close",
					async () => ((await row.getByTestId("library-key-input").count()) === 0 ? true : null),
					30_000,
				)
				await shot(chrome, run.dir, "key-saved")
				const prefs = await fs.readFile(path.join(run.userData, "preferences.json"), "utf8")
				assert(JSON.parse(prefs).secrets?.twentyfirstApiKey, "the key was not stored")
				assert(!prefs.includes(key), "the key is in Caret's settings as plain text")
				const leaked = await filesContaining(run.project, key)
				assert(leaked.length === 0, `the key was written into the project: ${leaked.join(", ")}`)
				return "stored encrypted in Caret's settings; no project file contains it"
			}),
	},
	{
		id: "9b",
		title: "the rules suggest searching the libraries only while one is on, and name exactly those",
		run: () =>
			withRun("9b", {}, async (run) => {
				const chrome = run.launched.chrome
				const heading = "## Component and reference libraries"
				const rules = await waitFor(
					"the rules to name the stand-in library",
					async () => {
						const text = await rulesText(run.project)
						return text.includes(heading) ? text : null
					},
					30_000,
					async () => `AGENTS.md is ${(await rulesText(run.project)).length} characters, with no libraries section`,
				)
				assert(
					rules.includes("Components: Test library (tools named `testlib_…`)."),
					"the rules do not name the stand-in library",
				)
				for (const name of ["shadcn registries", "Aceternity UI", "Lazyweb", "Gummble", "21st.dev"]) {
					assert(!rules.includes(`${name} (tools named`), `the rules name ${name}, which is off`)
				}

				await openLibraries(run)
				await chrome.locator('[data-library="testlib"]').getByTestId("library-toggle").click()
				await waitFor(
					"the libraries section to leave the rules",
					async () => (!(await rulesText(run.project)).includes(heading) ? true : null),
					30_000,
				)
				const claude = await fs.readFile(path.join(run.project, "CLAUDE.md"), "utf8")
				assert(!claude.includes(heading), "CLAUDE.md still suggests the libraries")

				await chrome.locator('[data-library="testlib"]').getByTestId("library-toggle").click()
				await waitFor(
					"the libraries section to come back",
					async () => ((await rulesText(run.project)).includes(heading) ? true : null),
					30_000,
				)
				return "present with the stand-in on, gone from AGENTS.md and CLAUDE.md when it was switched off, back when on"
			}),
	},
]

async function main(): Promise<void> {
	reapOrphanedBackends()
	await fs.stat("out/main/index.js").catch(() => {
		throw new Error("No build: run `npm run test:skills`, which builds first.")
	})
	const chosen = CASES.filter((c) => !ONLY || ONLY.has(c.id))
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
	reapOrphanedBackends()
	const failed = results.filter((r) => !r.ok)
	console.log(
		`\n${results.length - failed.length} of ${chosen.length} cases passed${ONLY ? " (a subset: not a full certification)" : ""}.`,
	)
	process.exitCode = !failed.length && results.length === chosen.length ? 0 : 1
}

main()
	.catch((err) => {
		console.error(err instanceof Error ? err.message : err)
		process.exitCode = 1
	})
	.finally(() => setTimeout(() => process.exit(), 500))
