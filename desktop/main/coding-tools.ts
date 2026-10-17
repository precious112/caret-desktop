/**
 * "Your coding tools" (Backend tab): finds Claude Code, Codex, Cursor and
 * OpenCode on this computer and connects each to Caret with one click.
 *
 * The skill needs no setup here: choosing one already copies it into the
 * project folders these tools read. What this adds is Caret's connection,
 * which also carries the libraries switched on in the project.
 *
 * In development builds only, `CARET_CODING_TOOLS_HOME` replaces the home
 * folder whose settings files Caret edits, so the real-app tests never touch
 * the developer's own Cursor or OpenCode settings.
 */
import { execFile } from "child_process"
import { app } from "electron"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import {
	type BridgeEntry,
	CODING_TOOLS,
	type CodingToolId,
	claudeAddArgs,
	claudeRemoveArgs,
	codexAddArgs,
	codexRemoveArgs,
	holdsEntry,
	type Merged,
	mergeCursorConfig,
	mergeOpencodeConfig,
	pasteSnippet,
} from "../../src/core/design/coding-tools/entries"
import { systemSpawnEnv } from "../../src/core/design/spawn-env"
import { Logger } from "../../src/shared/services/Logger"
import type { CodingToolWire } from "../shared/ipc"
import { capture } from "./analytics"
import { getPrefs, setPref } from "./prefs"

const BINARY: Partial<Record<CodingToolId, string>> = { claude: "claude", codex: "codex", opencode: "opencode" }

export type SetUpResult = { ok: true } | { ok: false; error: string; snippet?: string }

function testHome(): string | null {
	const override = process.env.CARET_CODING_TOOLS_HOME
	return !app.isPackaged && override ? override : null
}

function home(): string {
	return testHome() ?? os.homedir()
}

/**
 * How Caret runs a coding tool's own command. In a test, the tool is pointed
 * at the test's home folder too (Claude Code reads HOME, Codex CODEX_HOME), so
 * not even the real commands can touch the developer's own settings.
 */
function toolEnv(): NodeJS.ProcessEnv {
	const test = testHome()
	return test ? { ...systemSpawnEnv(), HOME: test, CODEX_HOME: path.join(test, ".codex") } : systemSpawnEnv()
}

function bridgeEntry(): BridgeEntry {
	return {
		command: process.execPath,
		args: [path.join(app.getPath("userData"), "mcp-stdio-bridge.cjs")],
		env: { ELECTRON_RUN_AS_NODE: "1" },
	}
}

const cursorFile = () => path.join(home(), ".cursor", "mcp.json")
const opencodeDir = () => path.join(home(), ".config", "opencode")

/** A program on the search path Caret uses for every tool it starts. */
async function findProgram(name: string): Promise<string | null> {
	const env = systemSpawnEnv()
	const names = process.platform === "win32" ? [`${name}.cmd`, `${name}.exe`, name] : [name]
	for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
		for (const candidate of names) {
			const full = path.join(dir, candidate)
			if (
				await fs.access(full, fs.constants.X_OK).then(
					() => true,
					() => false,
				)
			)
				return full
		}
	}
	return null
}

async function found(id: CodingToolId): Promise<string | boolean> {
	const binary = BINARY[id]
	if (binary) return (await findProgram(binary)) ?? false
	// Cursor is an app, not a command.
	const exists = (p: string) =>
		fs.stat(p).then(
			() => true,
			() => false,
		)
	return (
		(await exists(path.join(home(), ".cursor"))) ||
		(process.platform === "darwin" && (await exists("/Applications/Cursor.app")))
	)
}

function run(program: string, args: string[]): Promise<{ ok: boolean; output: string }> {
	return new Promise((resolve) => {
		execFile(program, args, { env: toolEnv(), timeout: 60_000, shell: process.platform === "win32" }, (err, stdout, stderr) =>
			resolve({ ok: !err, output: `${stdout}${stderr}`.trim() || String(err ?? "") }),
		)
	})
}

async function readOrNull(file: string): Promise<string | null> {
	return fs.readFile(file, "utf8").catch(() => null)
}

/** Writes a settings file with Caret's entry, keeping a copy of what was there. */
async function writeMerged(file: string, merged: Merged, tool: "cursor" | "opencode"): Promise<SetUpResult> {
	if (!merged.ok) {
		return {
			ok: false,
			error: `Caret didn't change ${file}: ${merged.reason}. Add this to it yourself:`,
			snippet: pasteSnippet(tool, bridgeEntry()),
		}
	}
	await fs.mkdir(path.dirname(file), { recursive: true })
	const before = await readOrNull(file)
	if (before !== null) await fs.writeFile(`${file}.caret-backup`, before)
	await fs.writeFile(file, merged.text)
	return { ok: true }
}

export async function setUpCodingTool(id: CodingToolId): Promise<SetUpResult> {
	const entry = bridgeEntry()
	// Codex refuses a CODEX_HOME that does not exist yet.
	const test = testHome()
	if (test) await fs.mkdir(path.join(test, ".codex"), { recursive: true })
	let result: SetUpResult
	if (id === "claude" || id === "codex") {
		const program = await findProgram(id)
		if (!program)
			return { ok: false, error: `${id === "claude" ? "Claude Code" : "Codex"} isn't installed on this computer.` }
		// Replace any older "caret" entry (the copy-paste one stopped working on every restart).
		await run(program, id === "claude" ? claudeRemoveArgs() : codexRemoveArgs())
		const added = await run(program, id === "claude" ? claudeAddArgs(entry) : codexAddArgs(entry))
		result = added.ok ? { ok: true } : { ok: false, error: `It refused: ${added.output.split("\n").slice(-3).join(" ")}` }
	} else if (id === "cursor") {
		result = await writeMerged(cursorFile(), mergeCursorConfig(await readOrNull(cursorFile()), entry), "cursor")
	} else {
		if (await readOrNull(path.join(opencodeDir(), "opencode.jsonc"))) {
			result = {
				ok: false,
				error: "Your OpenCode settings are in opencode.jsonc, which can hold comments Caret would lose. Add this to it yourself:",
				snippet: pasteSnippet("opencode", entry),
			}
		} else {
			const file = path.join(opencodeDir(), "opencode.json")
			result = await writeMerged(file, mergeOpencodeConfig(await readOrNull(file), entry), "opencode")
		}
	}
	if (result.ok) {
		await setPref("codingToolsSetUp", { ...getPrefs().codingToolsSetUp, [id]: true })
		Logger.info(`[coding-tools] ${id} connected to Caret`)
		capture("coding_tool_set_up", { tool: id })
	} else {
		Logger.warn(`[coding-tools] ${id} not set up: ${result.error}`)
	}
	return result
}

async function isSetUp(id: CodingToolId): Promise<boolean> {
	const bridge = bridgeEntry().args[0]
	if (id === "cursor") return holdsEntry(await readOrNull(cursorFile()), bridge)
	if (id === "opencode") return holdsEntry(await readOrNull(path.join(opencodeDir(), "opencode.json")), bridge)
	return Boolean(getPrefs().codingToolsSetUp?.[id])
}

export async function listCodingTools(): Promise<CodingToolWire[]> {
	return Promise.all(
		CODING_TOOLS.map(async (tool) => ({
			id: tool.id,
			name: tool.name,
			found: Boolean(await found(tool.id)),
			setUp: await isSetUp(tool.id),
			skillsFolder: tool.skillsFolder,
		})),
	)
}
