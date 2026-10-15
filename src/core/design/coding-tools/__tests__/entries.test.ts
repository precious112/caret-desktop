import { strict as assert } from "assert"

import { claudeAddArgs, codexAddArgs, holdsEntry, mergeCursorConfig, mergeOpencodeConfig, pasteSnippet } from "../entries"

const ENTRY = { command: "/Apps/Caret", args: ["/data/mcp-stdio-bridge.cjs"], env: { ELECTRON_RUN_AS_NODE: "1" } }

describe("coding tools · Caret's entry in each tool", () => {
	it("Claude Code: personal scope, the name before the environment, the program after --", () => {
		assert.deepEqual(claudeAddArgs(ENTRY), [
			"mcp",
			"add",
			"--scope",
			"user",
			"caret",
			"-e",
			"ELECTRON_RUN_AS_NODE=1",
			"--",
			"/Apps/Caret",
			"/data/mcp-stdio-bridge.cjs",
		])
	})

	it("Codex: its own add command, the program after --", () => {
		assert.deepEqual(codexAddArgs(ENTRY), [
			"mcp",
			"add",
			"caret",
			"--env",
			"ELECTRON_RUN_AS_NODE=1",
			"--",
			"/Apps/Caret",
			"/data/mcp-stdio-bridge.cjs",
		])
	})

	it("Cursor: adds exactly one entry and keeps every other setting", () => {
		const before = JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" })
		const merged = mergeCursorConfig(before, ENTRY)
		assert.ok(merged.ok)
		const after = JSON.parse(merged.text)
		assert.deepEqual(after.mcpServers.other, { command: "x" })
		assert.equal(after.theme, "dark")
		assert.deepEqual(after.mcpServers.caret, { command: "/Apps/Caret", args: ["/data/mcp-stdio-bridge.cjs"], env: ENTRY.env })
		assert.deepEqual(Object.keys(after.mcpServers), ["other", "caret"])
	})

	it("OpenCode: a local entry with the whole command in one list, other settings kept", () => {
		const merged = mergeOpencodeConfig(JSON.stringify({ model: "x/y", mcp: { mine: { type: "remote", url: "u" } } }), ENTRY)
		assert.ok(merged.ok)
		const after = JSON.parse(merged.text)
		assert.equal(after.model, "x/y")
		assert.deepEqual(after.mcp.mine, { type: "remote", url: "u" })
		assert.deepEqual(after.mcp.caret, {
			type: "local",
			command: ["/Apps/Caret", "/data/mcp-stdio-bridge.cjs"],
			environment: ENTRY.env,
			enabled: true,
		})
	})

	it("refuses a file with comments, and a missing file becomes a new one", () => {
		const withComments = '{\n  // my servers\n  "mcpServers": {}\n}'
		assert.equal(mergeCursorConfig(withComments, ENTRY).ok, false)
		assert.equal(mergeOpencodeConfig(withComments, ENTRY).ok, false)
		const fresh = mergeCursorConfig(null, ENTRY)
		assert.ok(fresh.ok && JSON.parse(fresh.text).mcpServers.caret)
		assert.ok(JSON.parse(pasteSnippet("opencode", ENTRY)).mcp.caret)
	})

	it("knows a settings file that already points at this helper program", () => {
		const merged = mergeCursorConfig(null, ENTRY)
		assert.ok(merged.ok)
		assert.equal(holdsEntry(merged.text, "/data/mcp-stdio-bridge.cjs"), true)
		assert.equal(holdsEntry(merged.text, "/elsewhere/bridge.cjs"), false)
		assert.equal(holdsEntry(null, "/data/mcp-stdio-bridge.cjs"), false)
	})
})
