/**
 * The stdio↔HTTP bridge that gives the bundled chat backend Caret's tools.
 *
 * The problem it solves is a shape mismatch: one OpenCode server serves every
 * open project and takes its config once at spawn, while Caret's MCP endpoint
 * is per-project with a per-launch port and token. No static config entry can
 * point at "whichever project this session is in" — but a `local`-type MCP
 * entry can, because OpenCode spawns the command lazily at a session's first
 * turn WITH THE PROJECT DIRECTORY AS CWD (measured by probe-mcp-bridge.ts; the
 * docs only hint). So one global entry launches this bridge, and the bridge
 * finds the project's credentials in `<cwd>/.caret/.mcp.json`.
 *
 * The bridge is written to userData at boot and run by Caret's own binary with
 * ELECTRON_RUN_AS_NODE — the user's machine needs no node. It is plain CJS
 * with no dependencies because it runs far from node_modules, and it can be
 * that small because Caret's endpoint is STATELESS streamable-HTTP: every
 * stdio JSON-RPC message maps to one authorized POST, and the reply (JSON, or
 * an SSE body carrying JSON) maps back to one stdout line. In a directory with
 * no discovery record it serves zero tools rather than failing — a chat in a
 * non-Caret folder should degrade, not error.
 */

import { app } from "electron"
import * as fs from "fs/promises"
import * as path from "path"

import { MCP_BRIDGE_SOURCE } from "./bridge-source"

/**
 * Writes the bridge beside Caret's own data and returns the config entry the
 * OpenCode spawn should carry. Rewritten every boot — the file is derived.
 */
export async function ensureMcpBridge(): Promise<{
	type: "local"
	command: string[]
	environment: Record<string, string>
	timeout: number
}> {
	const bridgePath = path.join(app.getPath("userData"), "mcp-stdio-bridge.cjs")
	await fs.writeFile(bridgePath, MCP_BRIDGE_SOURCE, "utf-8")
	return {
		type: "local",
		command: [process.execPath, bridgePath],
		environment: { ELECTRON_RUN_AS_NODE: "1" },
		// Tool calls legitimately wait on the user (consent, picking a take) and
		// on generation loops. The default 5s would kill every one of them —
		// and 10 minutes killed real ones too (field-measured on test5: the
		// mark loop's target image queues behind the paced raster lane, then up
		// to six render-compare model rounds run; two attempts died at exactly
		// 600s with nothing to show). The lanes carry their own tighter budgets
		// that return best-so-far; this outer ceiling is only the backstop.
		timeout: 30 * 60 * 1000,
	}
}
