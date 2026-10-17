/**
 * Connecting a coding tool to Caret: the one "caret" entry each tool needs.
 *
 * The entry starts Caret's helper program (the stdio bridge), which finds the
 * right Caret project from the folder the coding tool is working in. So one
 * entry in the tool's personal settings serves every project, and it keeps
 * working after Caret restarts (the program reads the current address and
 * password each time).
 *
 * Claude Code and Codex have their own commands for adding a connection, so
 * Caret uses those and never edits their settings by hand. Cursor and OpenCode
 * don't: Caret adds its one entry to their settings file, and refuses a file
 * it can't read safely (comments, which plain JSON reading would drop).
 */

export type CodingToolId = "claude" | "codex" | "cursor" | "opencode"

export const SERVER_NAME = "caret"

/** How the coding tool starts Caret's helper program. */
export interface BridgeEntry {
	command: string
	args: string[]
	env: Record<string, string>
}

export const CODING_TOOLS: ReadonlyArray<{
	id: CodingToolId
	name: string
	/** The project folder where this tool reads the chosen design skill. */
	skillsFolder: string
}> = [
	{ id: "claude", name: "Claude Code", skillsFolder: ".claude/skills" },
	{ id: "codex", name: "Codex", skillsFolder: ".agents/skills" },
	{ id: "cursor", name: "Cursor", skillsFolder: ".agents/skills" },
	{ id: "opencode", name: "OpenCode", skillsFolder: ".agents/skills" },
]

const envPairs = (entry: BridgeEntry) => Object.entries(entry.env).map(([key, value]) => `${key}=${value}`)

/** `claude mcp add`: personal scope, so the entry serves every project. */
export function claudeAddArgs(entry: BridgeEntry): string[] {
	return [
		"mcp",
		"add",
		"--scope",
		"user",
		SERVER_NAME,
		...envPairs(entry).flatMap((pair) => ["-e", pair]),
		"--",
		entry.command,
		...entry.args,
	]
}

export function claudeRemoveArgs(): string[] {
	return ["mcp", "remove", "--scope", "user", SERVER_NAME]
}

export function codexAddArgs(entry: BridgeEntry): string[] {
	return ["mcp", "add", SERVER_NAME, ...envPairs(entry).flatMap((pair) => ["--env", pair]), "--", entry.command, ...entry.args]
}

export function codexRemoveArgs(): string[] {
	return ["mcp", "remove", SERVER_NAME]
}

export type Merged = { ok: true; text: string } | { ok: false; reason: string }

/** Reads a settings file as plain JSON, or says why Caret won't touch it. */
function readJson(text: string | null): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
	if (text === null || text.trim() === "") return { ok: true, value: {} }
	try {
		const value = JSON.parse(text)
		if (!value || typeof value !== "object" || Array.isArray(value))
			return { ok: false, reason: "it is not a settings object" }
		return { ok: true, value }
	} catch {
		return { ok: false, reason: "it has comments or isn't plain JSON, and Caret won't rewrite a file it might damage" }
	}
}

/** Cursor's `mcp.json` with Caret's entry added (or replaced); everything else kept as it was. */
export function mergeCursorConfig(text: string | null, entry: BridgeEntry): Merged {
	const read = readJson(text)
	if (!read.ok) return read
	const servers = { ...((read.value.mcpServers as Record<string, unknown>) ?? {}) }
	servers[SERVER_NAME] = { command: entry.command, args: entry.args, env: entry.env }
	return { ok: true, text: `${JSON.stringify({ ...read.value, mcpServers: servers }, null, 2)}\n` }
}

/** OpenCode's `opencode.json` with Caret's entry added (or replaced); everything else kept as it was. */
export function mergeOpencodeConfig(text: string | null, entry: BridgeEntry): Merged {
	const read = readJson(text)
	if (!read.ok) return read
	const servers = { ...((read.value.mcp as Record<string, unknown>) ?? {}) }
	servers[SERVER_NAME] = { type: "local", command: [entry.command, ...entry.args], environment: entry.env, enabled: true }
	return {
		ok: true,
		text: `${JSON.stringify({ $schema: "https://opencode.ai/config.json", ...read.value, mcp: servers }, null, 2)}\n`,
	}
}

/** What to paste by hand when Caret can't edit a file itself. */
export function pasteSnippet(tool: "cursor" | "opencode", entry: BridgeEntry): string {
	const merged = tool === "cursor" ? mergeCursorConfig(null, entry) : mergeOpencodeConfig(null, entry)
	return merged.ok ? merged.text : ""
}

/** Whether a tool's settings text already holds Caret's entry, pointing at this helper program. */
export function holdsEntry(text: string | null, bridgePath: string): boolean {
	return Boolean(text?.includes(bridgePath)) && Boolean(text?.includes(SERVER_NAME))
}
