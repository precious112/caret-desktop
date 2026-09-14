/**
 * How an agent finds this project's MCP server.
 *
 * A fixed global port is wrong for a desktop app: open two projects and the
 * second collides with the first, and a client config that names a port names a
 * *machine* rather than a project. So each project gets an OS-assigned port,
 * written into a discovery file inside its own `.caret/`.
 *
 * The file carries the bearer token, so it is written gitignored and with
 * owner-only permissions. It is the credential — anything that can read it can
 * drive the server.
 */
import * as fs from "fs/promises"
import * as path from "path"

export interface DiscoveryRecord {
	version: 1
	/** Full URL an MCP client should connect to. */
	url: string
	port: number
	token: string
	/** Absolute path of the project this server serves. */
	project: string
	/** PID of the Caret process, so a stale file can be recognised. */
	pid: number
	startedAt: string
}

export function discoveryPath(projectPath: string): string {
	return path.join(projectPath, ".caret", ".mcp.json")
}

export async function writeDiscovery(projectPath: string, record: DiscoveryRecord): Promise<void> {
	const target = discoveryPath(projectPath)
	await fs.mkdir(path.dirname(target), { recursive: true })
	const tmp = `${target}.tmp`
	// 0600 before the rename, so the token is never briefly world-readable.
	await fs.writeFile(tmp, JSON.stringify(record, null, 2), { mode: 0o600 })
	await fs.rename(tmp, target)
}

export async function readDiscovery(projectPath: string): Promise<DiscoveryRecord | null> {
	try {
		const parsed = JSON.parse(await fs.readFile(discoveryPath(projectPath), "utf-8")) as DiscoveryRecord
		return parsed?.version === 1 ? parsed : null
	} catch {
		return null
	}
}

export async function clearDiscovery(projectPath: string): Promise<void> {
	await fs.rm(discoveryPath(projectPath), { force: true }).catch(() => {})
}
