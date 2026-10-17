/**
 * The embedded OpenCode server process.
 *
 * One per Caret process, shared by every open project — sessions are scoped by a
 * `directory` query parameter, so a second server would buy nothing and cost
 * another ~150MB of resident binary.
 *
 * Security posture matches Caret's own MCP server: loopback only, an
 * OS-assigned port, and a random per-launch password. The password is not
 * optional — an unsecured coding agent listening on localhost is an arbitrary
 * file-write endpoint for anything else running on the machine, and the server
 * says as much on startup when it is missing.
 */
import { type ChildProcess, spawn } from "child_process"
import { randomBytes } from "crypto"
import * as net from "net"

import { Logger } from "@/shared/services/Logger"
import { BackendError } from "../backend"
import { resolveOpencodeBinary } from "./binary"
import { caretDataHome, discardSeededDatabase, seedFromSharedInstall } from "./data-home"
import type { OpencodeConfig } from "./protocol"

/** How long to wait for the "listening on" line before giving up. */
const BOOT_TIMEOUT_MS = 30_000

export interface RunningServer {
	url: string
	/** `Authorization` header value. HTTP Basic — the server refuses Bearer. */
	authorization: string
}

let starting: Promise<RunningServer> | null = null
let child: ChildProcess | null = null
let running: RunningServer | null = null

/**
 * Boots the server if it is not already up, and returns its address.
 *
 * Serialized: two projects opening at once must not race into two processes.
 */
export function ensureOpencodeServer(config: OpencodeConfig): Promise<RunningServer> {
	if (running) return Promise.resolve(running)
	starting ??= boot(config).finally(() => {
		starting = null
	})
	return starting
}

export function currentOpencodeServer(): RunningServer | null {
	return running
}

export async function stopOpencodeServer(): Promise<void> {
	const process = child
	child = null
	running = null
	if (!process || process.exitCode !== null) return
	process.kill()
}

/**
 * Boots against Caret's own data home, seeded once from the shared one.
 *
 * A seeded database the pinned binary refuses is discarded and the boot runs
 * again on an empty one: losing an earlier Caret's session history is better
 * than having no backend.
 */
async function boot(config: OpencodeConfig): Promise<RunningServer> {
	const seeded = seedFromSharedInstall()
	try {
		return await launch(config)
	} catch (err) {
		if (!seeded) throw err
		Logger.warn(`[backend] the carried-over OpenCode database was refused, starting fresh: ${err}`)
		discardSeededDatabase()
		return launch(config)
	}
}

async function launch(config: OpencodeConfig): Promise<RunningServer> {
	const binary = resolveOpencodeBinary()
	if (!binary) {
		throw new BackendError(
			"Caret's bundled coding backend is missing from this build. Reinstall Caret, or pick a different backend in Settings.",
			false,
		)
	}

	const password = randomBytes(24).toString("hex")
	const port = await freePort()

	const proc = spawn(binary, [`--port=${port}`, `--hostname=127.0.0.1`, "serve"], {
		env: {
			...process.env,
			XDG_DATA_HOME: caretDataHome(),
			OPENCODE_SERVER_PASSWORD: password,
			// The user's own ~/.claude/CLAUDE.md and skills are theirs, not the
			// design agent's: keep them out (the switch is in the pinned binary).
			// The project's AGENTS.md still loads; Caret writes the same core there.
			OPENCODE_DISABLE_CLAUDE_CODE: "1",
			OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
		},
		stdio: ["ignore", "pipe", "pipe"],
	})

	const url = await new Promise<string>((resolve, reject) => {
		let output = ""
		let settled = false

		const timer = setTimeout(() => {
			if (settled) return
			settled = true
			proc.kill()
			reject(new BackendError(`The coding backend did not start within ${BOOT_TIMEOUT_MS / 1000}s.\n${output.trim()}`))
		}, BOOT_TIMEOUT_MS)

		const scan = (chunk: Buffer) => {
			output += stripAnsi(chunk.toString())
			if (settled) return
			// The binary announces itself as `opencode server listening on <url>`.
			const match = output.match(/listening on\s+(https?:\/\/\S+)/)
			if (!match) return
			settled = true
			clearTimeout(timer)
			resolve(match[1].replace(/\/$/, ""))
		}

		proc.stdout?.on("data", scan)
		proc.stderr?.on("data", scan)

		proc.on("error", (err) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			reject(new BackendError(`The coding backend could not be launched: ${err.message}`, false))
		})

		proc.on("exit", (code) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			reject(new BackendError(`The coding backend exited with code ${code}.\n${output.trim()}`))
		})
	})

	// An exit *after* boot leaves every session holding a dead URL. Clearing the
	// cached handle means the next call boots a fresh process rather than
	// failing forever against a socket nobody is listening on.
	proc.on("exit", (code) => {
		if (child !== proc) return
		Logger.warn(`[backend] the coding backend exited unexpectedly (code ${code})`)
		child = null
		running = null
	})

	child = proc
	// HTTP Basic, and the username is checked: `opencode` is accepted and
	// anything else is a 401 regardless of the password. Bearer is refused
	// outright. Both were established against the running binary.
	running = { url, authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
	Logger.info(`[backend] opencode listening on ${url}`)
	return running
}

/** The binary colours its errors; the panel shows them as plain text. */
function stripAnsi(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character is what is being stripped
	return text.replace(/\x1b\[[0-9;]*m/g, "")
}

/** Asks the OS for a port, then hands it to the server. */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = net.createServer()
		probe.once("error", reject)
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address()
			const port = typeof address === "object" && address ? address.port : 0
			probe.close(() => (port ? resolve(port) : reject(new Error("could not obtain a free port"))))
		})
	})
}
