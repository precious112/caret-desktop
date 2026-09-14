/**
 * Copy-pasteable connection instructions, one per agent.
 *
 * Once the server speaks MCP this is documentation rather than architecture,
 * but it is documentation the app has to generate: the URL and the bearer token
 * are per project and change on every launch, so a static docs page cannot
 * carry them.
 */
import * as path from "path"

import type { AgentClientConfig } from "./types"

export function buildAgentClientConfigs(projectPath: string, url: string | null, token: string): AgentClientConfig[] {
	if (!url) return []

	const name = path.basename(projectPath)
	const headers = { Authorization: `Bearer ${token}` }

	const streamableEntry = {
		type: "http",
		url,
		headers,
	}

	return [
		{
			client: "Claude Code",
			instruction: "Run this in the project directory:",
			snippet: `claude mcp add --transport http caret ${url} --header "Authorization: Bearer ${token}"`,
		},
		{
			client: "Cursor",
			instruction: "Add to .cursor/mcp.json in this project:",
			targetPath: path.join(projectPath, ".cursor", "mcp.json"),
			snippet: JSON.stringify({ mcpServers: { caret: streamableEntry } }, null, 2),
		},
		{
			client: "Codex",
			instruction: "Add to ~/.codex/config.toml:",
			targetPath: "~/.codex/config.toml",
			snippet: [`[mcp_servers.caret]`, `url = "${url}"`, `http_headers = { Authorization = "Bearer ${token}" }`].join("\n"),
		},
		{
			client: "OpenCode",
			instruction: "Add to opencode.json in this project:",
			targetPath: path.join(projectPath, "opencode.json"),
			snippet: JSON.stringify({ mcp: { caret: { type: "remote", url, enabled: true, headers } } }, null, 2),
		},
		{
			client: "Kimi CLI",
			instruction: "Add to ~/.kimi/mcp.json:",
			targetPath: "~/.kimi/mcp.json",
			snippet: JSON.stringify({ mcpServers: { caret: streamableEntry } }, null, 2),
		},
		{
			client: "GLM / Zhipu CLI",
			instruction: `Add to the MCP section of your CLI config, for project "${name}":`,
			snippet: JSON.stringify({ mcpServers: { caret: streamableEntry } }, null, 2),
		},
	]
}
