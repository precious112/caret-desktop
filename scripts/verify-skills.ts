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
import * as child_process from "child_process"
import * as fs from "fs/promises"
import * as path from "path"

import { pinOf, SKILLS, skillById } from "../src/core/design/skills/catalog"
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
const SKILLS_MIRROR = path.resolve("test-fixtures/skills/mirror")

const args = process.argv.slice(2)
const ONLY = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1].split(",")) : null
/** Live: GitHub, the real libraries, the real coding-tool commands, and CARET_VERIFY_MODEL for the chat. */
const LIVE = args.includes("--live")
const LIVE_MODEL = process.env.CARET_VERIFY_MODEL?.trim() ?? ""

interface Run {
	id: string
	project: string
	userData: string
	dir: string
	logFile: string
	launched: LaunchedApp
	/** The home folder whose coding-tool settings Caret edits in this run (never the real one). */
	toolsHome: string
	/** Every command the stand-in claude, codex and opencode were asked to run, one per line. */
	callsFile: string
	env: Record<string, string>
}

let template: string | undefined

/** A fresh project and profile, with the stand-in library and only the built-in libraries the case wants on. */
interface RunOptions {
	/** Built-in libraries installed in the profile; none by default, so nothing reaches the network. */
	librariesInstalled?: string[]
	/** Prepares the project before Caret opens it. */
	prepare?(project: string): Promise<void>
	/** Prepares the throwaway home folder (coding-tool settings) before Caret opens. */
	prepareHome?(home: string): Promise<void>
	/**
	 * The live run: skills from GitHub, the default libraries for real, the real
	 * coding-tool commands (still pointed at the throwaway home), and a model.
	 */
	live?: boolean
}

/**
 * Stand-ins for the coding tools' own commands: each records what it was asked
 * and succeeds. They come first on the search path, so Caret never runs the
 * real Claude Code, Codex or OpenCode in a test.
 */
async function standInTools(dir: string): Promise<{ bin: string; callsFile: string }> {
	const bin = path.join(dir, "bin")
	const callsFile = path.join(dir, "tool-calls.log")
	await fs.mkdir(bin, { recursive: true })
	for (const name of ["claude", "codex", "opencode"]) {
		const script = path.join(bin, name)
		await fs.writeFile(
			script,
			`#!/bin/sh\nprintf '%s' "${name}" >> "${callsFile}"\nfor a in "$@"; do printf ' %s' "$a" >> "${callsFile}"; done\nprintf '\\n' >> "${callsFile}"\nexit 0\n`,
		)
		await fs.chmod(script, 0o755)
	}
	return { bin, callsFile }
}

async function startRun(id: string, options: RunOptions = {}): Promise<Run> {
	const dir = path.join(SHOTS, `case-${id}`)
	await fs.rm(dir, { recursive: true, force: true })
	await fs.mkdir(dir, { recursive: true })
	const project = await buildProject(template)
	await options.prepare?.(project)
	const toolsHome = path.join(dir, "home")
	await fs.mkdir(toolsHome, { recursive: true })
	await options.prepareHome?.(toolsHome)
	const { bin, callsFile } = await standInTools(dir)
	const userData = await freshProfile(
		options.live
			? { ...(LIVE_MODEL ? { backendId: "opencode", backendModel: LIVE_MODEL } : {}) }
			: { librariesInstalled: options.librariesInstalled ?? [] },
	)
	const logFile = path.join(dir, "main.log")
	const env: Record<string, string> = options.live
		? { CARET_CODING_TOOLS_HOME: toolsHome }
		: {
				CARET_TEST_LIBRARY: FAKE_LIBRARY,
				CARET_SKILLS_SOURCE: SKILLS_MIRROR,
				CARET_CODING_TOOLS_HOME: toolsHome,
				PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
			}
	const launched = await launchApp({ project, userData, logFile, env })
	template ??= project
	return { id, project, userData, dir, logFile, launched, toolsHome, callsFile, env }
}

/** Quits Caret and opens it again on the same project and profile. */
async function relaunch(run: Run): Promise<void> {
	await run.launched.close()
	run.launched = await launchApp({ project: run.project, userData: run.userData, logFile: run.logFile, env: run.env })
}

async function withRun(id: string, options: RunOptions, body: (run: Run) => Promise<string>): Promise<string> {
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

/** Opens a top-bar tab (Skills or Libraries) on its Browse or Installed view. */
async function openTab(run: Run, name: "Skills" | "Libraries", view: "browse" | "installed"): Promise<void> {
	const chrome = run.launched.chrome
	const surface = chrome.getByTestId(name === "Skills" ? "skills-view" : "libraries-view")
	if (!(await surface.count())) await chrome.getByTestId("top-bar").getByRole("button", { name, exact: true }).click()
	await surface.waitFor({ timeout: 20_000 })
	await chrome.getByTestId(`catalog-tab-${view}`).click()
	await waitFor(
		`${name} to show ${view}`,
		async () => ((await chrome.getByTestId(`catalog-tab-${view}`).getAttribute("aria-selected")) === "true" ? true : null),
		10_000,
	)
}

async function openLibraries(run: Run): Promise<void> {
	await openTab(run, "Libraries", "installed")
	await run.launched.chrome.getByTestId("libraries-section").waitFor({ timeout: 20_000 })
}

/** Every file of a skill as Caret should install it: the saved copy of each pinned file, plus the licence. */
async function expectedSkillFiles(id: string): Promise<Map<string, Buffer>> {
	const skill = skillById(id)
	const pin = pinOf(id)
	assert(skill && pin, `no pin for ${id}`)
	const files = new Map<string, Buffer>()
	for (const file of pin.files) {
		files.set(file.path, await fs.readFile(path.join(SKILLS_MIRROR, skill.repo, pin.commit, skill.path, file.path)))
	}
	if (pin.licenceFile) {
		files.set(
			path.basename(pin.licenceFile.path),
			await fs.readFile(path.join(SKILLS_MIRROR, skill.repo, pin.commit, pin.licenceFile.path)),
		)
	}
	return files
}

/** Fails unless `folder` holds exactly `expected`, byte for byte (Caret's own mark files aside). */
async function assertSameFiles(folder: string, expected: Map<string, Buffer>, what: string): Promise<void> {
	const actual = (await listFiles(folder)).filter((file) => !file.startsWith(".caret-"))
	assert(
		JSON.stringify(actual) === JSON.stringify([...expected.keys()].sort()),
		`${what} holds ${actual.join(", ") || "nothing"}; expected ${[...expected.keys()].sort().join(", ")}`,
	)
	for (const [file, data] of expected) {
		assert((await fs.readFile(path.join(folder, file))).equals(data), `${what}: ${file} differs from the saved copy`)
	}
}

async function listFiles(folder: string): Promise<string[]> {
	const out: string[] = []
	const walk = async (dir: string): Promise<void> => {
		for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
			const full = path.join(dir, entry.name)
			if (entry.isDirectory()) await walk(full)
			else out.push(path.relative(folder, full))
		}
	}
	await walk(folder)
	return out.sort()
}

const SKILL_FOLDERS = [".claude/skills", ".agents/skills"]

async function installSkill(run: Run, id: string): Promise<void> {
	await openTab(run, "Skills", "browse")
	const card = run.launched.chrome.locator(`[data-testid="skill-card"][data-id="${id}"]`)
	await card.getByTestId("skill-install").click()
	await waitFor(
		`${id} to read Installed`,
		async () => ((await card.getByText("Installed", { exact: true }).count()) ? true : null),
		60_000,
		async () => (await card.textContent()) ?? "",
	)
}

async function chooseSkill(run: Run, id: string | null): Promise<void> {
	await openTab(run, "Skills", "installed")
	const row = run.launched.chrome.locator(`[data-testid="skill-row"][data-id="${id ?? "none"}"]`)
	await row.getByTestId("skill-choose").click()
	await waitFor(
		`${id ?? "no skill"} to be chosen`,
		async () => ((await row.getAttribute("data-chosen")) === "true" ? true : null),
		20_000,
	)
}

/** The chat's design-skill label, read the way the user sees it. */
async function chatSkillLabel(run: Run): Promise<string> {
	const chrome = run.launched.chrome
	if (!(await chrome.getByTestId("chat-sidebar").count())) {
		await chrome.getByTestId("top-bar").getByRole("button", { name: "Chat", exact: true }).click()
	}
	const label = chrome.getByTestId("chat-skill")
	await label.waitFor({ timeout: 15_000 })
	return (await label.textContent()) ?? ""
}

async function waitForLabel(run: Run, expected: string): Promise<void> {
	let last = ""
	await waitFor(
		`the chat to read "${expected}"`,
		async () => {
			last = await chatSkillLabel(run)
			return last === expected ? true : null
		},
		15_000,
		async () => `it reads "${last}"`,
	)
}

const CURSOR_BEFORE = `${JSON.stringify({ theme: "dark", mcpServers: { mine: { command: "mine" } } }, null, 2)}\n`
const OPENCODE_WITH_COMMENTS = '{\n  // the user\'s own notes\n  "model": "anthropic/claude"\n}\n'

/** A skill the user put in the project themselves, before Caret opened it. */
async function userOwnSkill(project: string): Promise<void> {
	await fs.mkdir(path.join(project, ".claude/skills/my-own"), { recursive: true })
	await fs.writeFile(path.join(project, ".claude/skills/my-own/SKILL.md"), "---\nname: my-own\n---\nThe user's own skill.\n")
}

const CASES: Array<{ id: string; title: string; run(): Promise<string> }> = [
	{
		id: "1",
		title: "Skills and Libraries each show exactly their own hand-picked list; installing a skill stores exactly its files",
		run: () =>
			withRun("1", {}, async (run) => {
				const chrome = run.launched.chrome
				await openTab(run, "Skills", "browse")
				const skillCards = await chrome
					.getByTestId("skill-card")
					.evaluateAll((cards) => cards.map((card) => card.getAttribute("data-id")))
				assert(
					JSON.stringify(skillCards) === JSON.stringify(SKILLS.map((skill) => skill.id)),
					`Skills shows ${skillCards.join(", ")}`,
				)
				assert((await chrome.getByTestId("library-card").count()) === 0, "the Skills tab shows libraries")
				await shot(chrome, run.dir, "skills-browse")

				await openTab(run, "Libraries", "browse")
				const libraryCards = await chrome
					.getByTestId("library-card")
					.evaluateAll((cards) => cards.map((card) => card.getAttribute("data-id")))
				const expected = ["shadcn", "aceternity", "twentyfirst", "testlib", "lazyweb", "gummble"]
				assert(
					JSON.stringify(libraryCards) === JSON.stringify(expected),
					`Libraries shows ${libraryCards.join(", ")}; expected ${expected.join(", ")} (components, then references)`,
				)
				assert((await chrome.getByTestId("skill-card").count()) === 0, "the Libraries tab shows skills")
				await shot(chrome, run.dir, "libraries-browse")

				await installSkill(run, "frontend-design")
				await openTab(run, "Skills", "installed")
				assert(
					(await chrome.locator('[data-testid="skill-row"][data-id="frontend-design"]').count()) === 1,
					"the installed skill is not listed under Installed",
				)
				await assertSameFiles(
					path.join(run.userData, "skills", "frontend-design"),
					await expectedSkillFiles("frontend-design"),
					"Caret's copy of Frontend Design",
				)
				await shot(chrome, run.dir, "skills-installed")
				return "6 skills and 6 libraries, each only in its own tab; Frontend Design stored byte for byte, licence included"
			}),
	},
	{
		id: "2",
		title: "choosing a skill puts it in both project folders coding tools read, and the chat names it",
		run: () =>
			withRun("2", {}, async (run) => {
				assert((await chatSkillLabel(run)) === "Skill: none", "the chat names a skill before one was chosen")
				await installSkill(run, "frontend-design")
				await chooseSkill(run, "frontend-design")
				const expected = await expectedSkillFiles("frontend-design")
				for (const base of SKILL_FOLDERS) {
					await assertSameFiles(path.join(run.project, base, "frontend-design"), expected, `${base}/frontend-design`)
				}
				await waitForLabel(run, "Skill: Frontend Design")
				await shot(run.launched.chrome, run.dir, "chat-skill")
				return 'copied into .claude/skills and .agents/skills byte for byte; the chat reads "Skill: Frontend Design"'
			}),
	},
	{
		id: "3",
		title: "switching skills replaces Caret's copy and leaves the user's own skill alone",
		run: () =>
			withRun("3", { prepare: userOwnSkill }, async (run) => {
				await installSkill(run, "frontend-design")
				await installSkill(run, "emil-design-eng")
				await chooseSkill(run, "frontend-design")
				await chooseSkill(run, "emil-design-eng")
				for (const base of SKILL_FOLDERS) {
					const gone = await fs.stat(path.join(run.project, base, "frontend-design")).catch(() => null)
					assert(!gone, `${base}/frontend-design is still there after switching`)
					await assertSameFiles(
						path.join(run.project, base, "emil-design-eng"),
						await expectedSkillFiles("emil-design-eng"),
						`${base}/emil-design-eng`,
					)
				}
				const own = await fs.readFile(path.join(run.project, ".claude/skills/my-own/SKILL.md"), "utf8")
				assert(own.includes("The user's own skill."), "the user's own skill was changed or removed")
				await waitForLabel(run, "Skill: Design Engineering")
				return "Frontend Design gone from both folders, Design Engineering there, the user's own skill untouched"
			}),
	},
	{
		id: "4",
		title: "removing the chosen skill cleans the project folders and the chat reads none",
		run: () =>
			withRun("4", { prepare: userOwnSkill }, async (run) => {
				await installSkill(run, "emil-design-eng")
				await chooseSkill(run, "emil-design-eng")
				await waitForLabel(run, "Skill: Design Engineering")
				await openTab(run, "Skills", "installed")
				await run.launched.chrome
					.locator('[data-testid="skill-row"][data-id="emil-design-eng"]')
					.getByTestId("skill-remove")
					.click()
				await waitFor(
					"the skill to leave Installed",
					async () =>
						(await run.launched.chrome.locator('[data-testid="skill-row"][data-id="emil-design-eng"]').count()) === 0
							? true
							: null,
					20_000,
				)
				for (const base of SKILL_FOLDERS) {
					assert(
						!(await fs.stat(path.join(run.project, base, "emil-design-eng")).catch(() => null)),
						`${base} still has the skill`,
					)
				}
				assert(
					!(await fs.stat(path.join(run.userData, "skills", "emil-design-eng")).catch(() => null)),
					"Caret still stores the skill",
				)
				assert(
					await fs.stat(path.join(run.project, ".claude/skills/my-own/SKILL.md")),
					"the user's own skill was removed",
				)
				await waitForLabel(run, "Skill: none")
				return 'gone from both folders and from Caret; the user\'s own skill kept; the chat reads "Skill: none"'
			}),
	},
	{
		id: "5",
		title: "a skill that can't be downloaded says so, and nothing is half-installed",
		run: () =>
			withRun("5", {}, async (run) => {
				const chrome = run.launched.chrome
				// Impeccable has no saved copy, so its download fails like a dropped connection.
				await openTab(run, "Skills", "browse")
				const card = chrome.locator('[data-testid="skill-card"][data-id="impeccable"]')
				await card.getByTestId("skill-install").click()
				const message = await waitFor(
					"the card to say the download failed",
					async () => {
						const text = (await card.textContent()) ?? ""
						return /could not be downloaded/.test(text) ? text : null
					},
					30_000,
				)
				assert(/Impeccable could not be downloaded/.test(message), `the message does not name the skill: ${message}`)
				assert((await card.getByTestId("skill-install").count()) === 1, "the card no longer offers Install")
				const stored = await fs.readdir(path.join(run.userData, "skills")).catch(() => [] as string[])
				assert(stored.length === 0, `a failed download left ${stored.join(", ")} behind`)
				await shot(chrome, run.dir, "download-failed")
				return "the card says Impeccable could not be downloaded; Caret's skills folder is empty"
			}),
	},
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
		id: "8",
		title: "Set up connects each coding tool to Caret the way that tool expects, and leaves a file it can't safely edit alone",
		run: () =>
			withRun(
				"8",
				{
					prepareHome: async (home) => {
						await fs.mkdir(path.join(home, ".cursor"), { recursive: true })
						await fs.writeFile(path.join(home, ".cursor/mcp.json"), CURSOR_BEFORE)
						await fs.mkdir(path.join(home, ".config/opencode"), { recursive: true })
						await fs.writeFile(path.join(home, ".config/opencode/opencode.jsonc"), OPENCODE_WITH_COMMENTS)
					},
				},
				async (run) => {
					const chrome = run.launched.chrome
					const execPath = await run.launched.app.evaluate(({ app }) => app.getPath("exe"))
					const bridge = path.join(run.userData, "mcp-stdio-bridge.cjs")
					await chrome.getByTestId("top-bar").getByRole("button", { name: "Backend", exact: true }).click()
					const section = chrome.getByTestId("coding-tools-section")
					await section.waitFor({ timeout: 20_000 })
					await waitFor(
						"the four coding tools to be listed",
						async () => ((await chrome.getByTestId("coding-tool").count()) === 4 ? true : null),
						20_000,
					)
					const row = (id: string) => chrome.locator(`[data-testid="coding-tool"][data-tool="${id}"]`)
					for (const id of ["claude", "codex", "cursor", "opencode"]) {
						assert(((await row(id).textContent()) ?? "").includes("Found on this computer"), `${id} was not found`)
					}

					for (const id of ["claude", "codex", "cursor"]) {
						await row(id).getByTestId("coding-tool-setup").click()
						await waitFor(
							`${id} to read Connected`,
							async () => ((await row(id).getByTestId("coding-tool-done").count()) ? true : null),
							30_000,
						)
					}

					const calls = (await fs.readFile(run.callsFile, "utf8")).trim().split("\n")
					const expectedCalls = [
						"claude mcp remove --scope user caret",
						`claude mcp add --scope user caret -e ELECTRON_RUN_AS_NODE=1 -- ${execPath} ${bridge}`,
						"codex mcp remove caret",
						`codex mcp add caret --env ELECTRON_RUN_AS_NODE=1 -- ${execPath} ${bridge}`,
					]
					assert(
						JSON.stringify(calls) === JSON.stringify(expectedCalls),
						`the tools were asked:\n    ${calls.join("\n    ")}\n  expected:\n    ${expectedCalls.join("\n    ")}`,
					)

					const cursor = JSON.parse(await fs.readFile(path.join(run.toolsHome, ".cursor/mcp.json"), "utf8"))
					assert(
						JSON.stringify(cursor.mcpServers.mine) === JSON.stringify({ command: "mine" }),
						"Cursor's own server entry changed",
					)
					assert(cursor.theme === "dark", "another Cursor setting was lost")
					assert(
						JSON.stringify(cursor.mcpServers.caret) ===
							JSON.stringify({ command: execPath, args: [bridge], env: { ELECTRON_RUN_AS_NODE: "1" } }),
						`Cursor's caret entry is ${JSON.stringify(cursor.mcpServers.caret)}`,
					)
					assert(
						(await fs.readFile(path.join(run.toolsHome, ".cursor/mcp.json.caret-backup"), "utf8")) === CURSOR_BEFORE,
						"Cursor's settings were not backed up exactly",
					)

					await row("opencode").getByTestId("coding-tool-setup").click()
					const problem = row("opencode").getByTestId("coding-tool-problem")
					await waitFor(
						"OpenCode's row to explain why Caret left its settings alone",
						async () => ((await problem.count()) ? true : null),
						20_000,
						async () =>
							`the row reads: ${(await row("opencode").textContent()) ?? ""}; opencode.json exists: ${Boolean(await fs.stat(path.join(run.toolsHome, ".config/opencode/opencode.json")).catch(() => null))}`,
					)
					const said = (await problem.textContent()) ?? ""
					assert(
						/opencode\.jsonc/.test(said) && said.includes(bridge),
						`OpenCode's refusal does not explain and offer the entry: ${said}`,
					)
					assert(
						(await fs.readFile(path.join(run.toolsHome, ".config/opencode/opencode.jsonc"), "utf8")) ===
							OPENCODE_WITH_COMMENTS,
						"OpenCode's settings with comments were changed",
					)
					assert(
						!(await fs.stat(path.join(run.toolsHome, ".config/opencode/opencode.json")).catch(() => null)),
						"Caret wrote a second OpenCode settings file",
					)
					assert(
						(await row("opencode").getByTestId("coding-tool-done").count()) === 0,
						"OpenCode reads Set up though nothing was written",
					)

					const details = (await row("claude").getByTestId("coding-tool-details").textContent()) ?? ""
					assert(
						details.includes("Connected to Caret") && details.includes("Test library"),
						`Claude Code's row says: ${details}`,
					)
					await shot(chrome, run.dir, "coding-tools")
					return "Claude Code and Codex through their own commands, exactly; Cursor merged with a backup; OpenCode's commented file untouched, with what to paste"
				},
			),
	},
	{
		id: "9",
		title: "a pasted 21st.dev key is stored encrypted and is never written into the project",
		run: () =>
			withRun("9", { librariesInstalled: ["twentyfirst"] }, async (run) => {
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
				// The rules files are rewritten one after another, so wait for both.
				await waitFor(
					"the libraries section to leave AGENTS.md and CLAUDE.md",
					async () => {
						const claude = await fs.readFile(path.join(run.project, "CLAUDE.md"), "utf8").catch(() => heading)
						return !(await rulesText(run.project)).includes(heading) && !claude.includes(heading) ? true : null
					},
					30_000,
				)

				await chrome.locator('[data-library="testlib"]').getByTestId("library-toggle").click()
				await waitFor(
					"the libraries section to come back",
					async () => ((await rulesText(run.project)).includes(heading) ? true : null),
					30_000,
				)
				return "present with the stand-in on, gone from AGENTS.md and CLAUDE.md when it was switched off, back when on"
			}),
	},
	{
		id: "10",
		title: "after quitting and reopening Caret, the skill, the library switches and the set-up tools are all still there, and the connection still works",
		run: () =>
			withRun(
				"10",
				{ prepareHome: async (home) => fs.mkdir(path.join(home, ".cursor"), { recursive: true }).then(() => {}) },
				async (run) => {
					await installSkill(run, "frontend-design")
					await chooseSkill(run, "frontend-design")
					await openLibraries(run)
					await run.launched.chrome.locator('[data-library="testlib"]').getByTestId("library-toggle").click()
					await waitFor(
						"the stand-in library to read Off",
						async () =>
							(await run.launched.chrome
								.locator('[data-library="testlib"]')
								.getByTestId("library-toggle")
								.textContent()) === "Off"
								? true
								: null,
						15_000,
					)
					await run.launched.chrome.getByTestId("top-bar").getByRole("button", { name: "Backend", exact: true }).click()
					const cursorRow = () => run.launched.chrome.locator('[data-testid="coding-tool"][data-tool="cursor"]')
					await cursorRow().getByTestId("coding-tool-setup").click()
					await waitFor(
						"Cursor to read Connected",
						async () => ((await cursorRow().getByTestId("coding-tool-done").count()) ? true : null),
						30_000,
					)

					await relaunch(run)

					await waitForLabel(run, "Skill: Frontend Design")
					await openLibraries(run)
					const toggle = run.launched.chrome.locator('[data-library="testlib"]').getByTestId("library-toggle")
					assert((await toggle.textContent()) === "Off", "the library switched off came back on after reopening")
					await run.launched.chrome.getByTestId("top-bar").getByRole("button", { name: "Backend", exact: true }).click()
					await cursorRow().waitFor({ timeout: 20_000 })
					await waitFor(
						"Cursor to still read Connected",
						async () => ((await cursorRow().getByTestId("coding-tool-done").count()) ? true : null),
						20_000,
					)

					await openLibraries(run)
					await toggle.click()
					await waitFor(
						"the stand-in library to read On",
						async () => ((await toggle.textContent()) === "On" ? true : null),
						15_000,
					)
					const client = await connectLikeACodingTool(run, run.project)
					try {
						const tools = await waitFor(
							"the library's tools through the reopened Caret",
							async () => {
								const list = await toolsOf(client)
								return list.some((tool) => tool.name === "testlib_search_components") ? list : null
							},
							60_000,
						)
						const result = await client.callTool({
							name: "testlib_search_components",
							arguments: { query: "after restart" },
						})
						const text = (result.content as Array<{ text?: string }>).map((part) => part.text ?? "").join(" ")
						assert(text.includes("FAKE-LIBRARY-RESULT"), `the search after reopening failed: ${text}`)
						return `skill, switch and Cursor setup kept; the same connection reached the reopened Caret (${tools.length} tools)`
					} finally {
						await client.close()
					}
				},
			),
	},
	{
		id: "11",
		title: "the Design pass is gone: no switch under the chat, no section in the Backend tab",
		run: () =>
			withRun("11", {}, async (run) => {
				const chrome = run.launched.chrome
				await chatSkillLabel(run)
				for (const id of ["design-pass-switch", "design-pass-line"]) {
					assert((await chrome.getByTestId(id).count()) === 0, `${id} is on screen`)
				}
				await chrome.getByTestId("top-bar").getByRole("button", { name: "Backend", exact: true }).click()
				await chrome
					.getByRole("heading", { name: "Backend" })
					.first()
					.waitFor({ timeout: 20_000 })
					.catch(() => {})
				const backend = (await chrome.locator("body").textContent()) ?? ""
				assert(!/Design pass/.test(backend), "the Backend tab still mentions the Design pass")
				assert((await chrome.getByTestId("libraries-section").count()) === 0, "the Backend tab still lists the libraries")
				return "no Design pass anywhere; the libraries live in their own tab"
			}),
	},
]

/** Runs a coding tool's own command the way a user would, pointed at the test's home folder. */
function realTool(command: string, args: string[], cwd: string, home: string): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve) => {
		child_process.execFile(
			command,
			args,
			{ cwd, env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, ".codex") }, timeout: 120_000 },
			(err, stdout, stderr) =>
				resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, output: `${stdout}${stderr}` }),
		)
	})
}

/** A real program on the search path (the user's shell may wrap it in a function Caret never sees). */
function realProgram(name: string): string | null {
	try {
		return child_process.execFileSync("/bin/zsh", ["-lc", `whence -p ${name}`], { encoding: "utf8" }).trim() || null
	} catch {
		return null
	}
}

const LIVE_CASES: Array<{ id: string; title: string; run(): Promise<string> }> = [
	{
		id: "L1",
		title: "every hand-picked skill downloads from GitHub at its pinned version, every file checked",
		run: () =>
			withRun("L1", { live: true }, async (run) => {
				for (const skill of SKILLS) await installSkill(run, skill.id)
				for (const skill of SKILLS) {
					const pin = pinOf(skill.id)
					assert(pin, `no pin for ${skill.id}`)
					const stored = (await listFiles(path.join(run.userData, "skills", skill.id))).filter(
						(file) => !file.startsWith(".caret-"),
					)
					const expected = [
						...pin.files.map((file) => file.path),
						...(pin.licenceFile ? [path.basename(pin.licenceFile.path)] : []),
					].sort()
					assert(
						JSON.stringify(stored) === JSON.stringify(expected),
						`${skill.id}: stored ${stored.length} files, expected ${expected.length}`,
					)
				}
				return `${SKILLS.length} skills downloaded and checked against their fingerprints`
			}),
	},
	{
		id: "L2",
		title: "the default libraries answer a real search through Caret's connection",
		run: () =>
			withRun("L2", { live: true }, async (run) => {
				const client = await connectLikeACodingTool(run, run.project)
				try {
					const wanted = ["shadcn_search_items_in_registries", "aceternity_search_components"]
					let names: string[] = []
					await waitFor(
						"shadcn's and Aceternity's tools through Caret",
						async () => {
							names = (await toolsOf(client)).map((tool) => tool.name)
							return wanted.every((name) => names.includes(name)) ? true : null
						},
						180_000,
						async () => `tools so far: ${names.filter((name) => name.includes("_")).join(", ")}`,
					)
					assert(
						names.some((name) => name.startsWith("lazyweb_")),
						"Lazyweb's tools are missing",
					)
					const shadcn = await client.callTool({
						name: "shadcn_search_items_in_registries",
						arguments: { registries: ["@shadcn"], query: "button" },
					})
					const shadcnText = (shadcn.content as Array<{ text?: string }>).map((part) => part.text ?? "").join(" ")
					assert(!shadcn.isError && /button/i.test(shadcnText), `shadcn's search failed: ${shadcnText.slice(0, 300)}`)
					const aceternity = await client.callTool({
						name: "aceternity_search_components",
						arguments: { query: "hero" },
					})
					const aceternityText = (aceternity.content as Array<{ text?: string }>)
						.map((part) => part.text ?? "")
						.join(" ")
					assert(
						!aceternity.isError && aceternityText.length > 20,
						`Aceternity's search failed: ${aceternityText.slice(0, 300)}`,
					)
					return "shadcn, Aceternity and Lazyweb listed through Caret; shadcn and Aceternity answered real searches"
				} finally {
					await client.close()
				}
			}),
	},
	{
		id: "L3",
		title: "the real Claude Code and Codex, set up from Caret, list Caret as connected",
		run: () =>
			withRun("L3", { live: true }, async (run) => {
				const claude = realProgram("claude")
				const codex = realProgram("codex")
				assert(claude && codex, "Claude Code and Codex must both be installed for the live run")
				const chrome = run.launched.chrome
				await chrome.getByTestId("top-bar").getByRole("button", { name: "Backend", exact: true }).click()
				const row = (id: string) => chrome.locator(`[data-testid="coding-tool"][data-tool="${id}"]`)
				for (const id of ["claude", "codex"]) {
					await row(id).getByTestId("coding-tool-setup").click()
					await waitFor(
						`${id} to read Connected`,
						async () => ((await row(id).getByTestId("coding-tool-done").count()) ? true : null),
						60_000,
						async () => (await row(id).textContent()) ?? "",
					)
				}
				const claudeList = await realTool(claude, ["mcp", "list"], run.project, run.toolsHome)
				assert(/caret.*(✓|Connected)/i.test(claudeList.output), `claude mcp list says:\n${claudeList.output}`)
				const codexList = await realTool(codex, ["mcp", "list"], run.project, run.toolsHome)
				assert(
					/caret/.test(codexList.output) && codexList.output.includes("mcp-stdio-bridge.cjs"),
					`codex mcp list says:\n${codexList.output}`,
				)
				return "claude mcp list: caret connected; codex mcp list: caret, running Caret's helper program"
			}),
	},
	{
		id: "L4",
		title: "Caret's chat receives the chosen skill with a real message",
		run: () =>
			withRun("L4", { live: true }, async (run) => {
				assert(LIVE_MODEL, "set CARET_VERIFY_MODEL (a cheap model) for the live run")
				await installSkill(run, "frontend-design")
				await chooseSkill(run, "frontend-design")
				await waitForLabel(run, "Skill: Frontend Design")
				const chrome = run.launched.chrome
				const sentAt = Date.now()
				await chrome.getByTestId("chat-input").fill("Reply with the single word: ready. Do not use any tools.")
				await chrome.getByTestId("chat-send").click()
				const db = path.join(process.env.HOME ?? "", ".local/share/opencode/opencode.db")
				const system = await waitFor(
					"the AI server to record the message",
					async () => {
						const out = child_process
							.execFileSync("sqlite3", [
								db,
								`select json_extract(m.data,'$.system') from message m join session s on s.id = m.session_id where json_extract(m.data,'$.role')='user' and s.directory like '%${path.basename(run.project)}%' and m.time_created >= ${sentAt - 5000} order by m.time_created desc limit 1`,
							])
							.toString()
						return out.trim() || null
					},
					120_000,
				)
				assert(
					system.includes("## Design skill: Frontend Design"),
					`the chat's instructions do not carry the skill: ${system.slice(0, 300)}`,
				)
				assert(/foundation .* always wins/.test(system), "the chat is not told the foundation wins")
				return "the AI server's own record of the message carries Frontend Design and the foundation-wins rule"
			}),
	},
]

async function main(): Promise<void> {
	reapOrphanedBackends()
	await fs.stat("out/main/index.js").catch(() => {
		throw new Error("No build: run `npm run test:skills`, which builds first.")
	})
	const chosen = (LIVE ? LIVE_CASES : CASES).filter((c) => !ONLY || ONLY.has(c.id))
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
