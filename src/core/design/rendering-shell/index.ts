/**
 * Owns one project's Vite dev server — the process that actually renders the
 * design layer.
 *
 * This used to be module-level singleton state, which was correct while Caret
 * was a VS Code extension serving a single workspace. The desktop app opens
 * several projects at once, so the shell became an instance: one per project
 * window, each with its own port and its own log.
 */
import * as child_process from "child_process"
import { createWriteStream, type WriteStream } from "fs"
import * as fs from "fs/promises"
import * as path from "path"

import { Logger } from "@/shared/services/Logger"
import { systemSpawnEnv } from "../spawn-env"
import { emitDesignEvent } from "../telemetry-hooks"
import { generateEntryFiles } from "./entry-template"
import { generateViteConfig } from "./vite-config-template"

/**
 * Dependencies the design layer needs at runtime but that a hand-scaffolded (or
 * older) `.caret/package.json` may be missing. Checked on every boot so a project
 * created before a dependency was added heals itself rather than failing to render.
 */
const REQUIRED_DEPS: Record<string, string> = {
	"react-grab": "^0.1.37",
	tailwindcss: "^4.1.0",
	"@tailwindcss/vite": "^4.1.0",
	"modern-screenshot": "^4.6.0",
}

const VITE_BOOT_TIMEOUT_MS = 30_000

/**
 * Thrown when the canvas cannot start for a reason the user has to fix, as
 * opposed to a bug. Carries text meant to be shown, not logged.
 */
export class ShellPrerequisiteError extends Error {
	constructor(
		message: string,
		readonly remedyUrl: string,
	) {
		super(message)
		this.name = "ShellPrerequisiteError"
	}
}

/**
 * Fails with something the user can act on when `node` is not on PATH.
 *
 * The canvas is a Vite dev server, and Vite is spawned with system node. On a
 * developer's machine that is always there, which is exactly why this went
 * unnoticed: every machine Caret was tested on had it. On an ordinary computer
 * it usually does not, and the spawn then fails with ENOENT before Vite writes
 * a single line — so `vite.log` is created, stays empty, and the failure reads
 * as "the canvas is broken" rather than "a dependency is missing".
 */
async function assertNodeAvailable(): Promise<void> {
	const found = await new Promise<boolean>((resolve) => {
		const probe = child_process.spawn("node", ["--version"], { stdio: "ignore", env: systemSpawnEnv() })
		probe.on("error", () => resolve(false))
		probe.on("close", (code) => resolve(code === 0))
	})
	if (found) return

	emitDesignEvent("canvas_blocked", { reason: "node_missing" })
	throw new ShellPrerequisiteError(
		"Caret needs Node.js to run the live canvas, and it is not installed on this computer. " +
			"Install Node.js 20 or newer, then reopen the project.",
		"https://nodejs.org/en/download",
	)
}

export class RenderingShell {
	private viteProcess: child_process.ChildProcess | null = null
	private port: number | null = null
	private stoppingIntentionally = false

	/**
	 * @param onUnexpectedExit called when Vite dies while the shell is still
	 *   meant to be running. The canvas has no signal of its own when this
	 *   happens — it just goes blank — so the host must surface it.
	 */
	constructor(
		private readonly workspacePath: string,
		private readonly onUnexpectedExit: () => void = () => {},
	) {}

	getPort(): number | null {
		return this.port
	}

	getUrl(): string | null {
		return this.port === null ? null : `http://127.0.0.1:${this.port}/`
	}

	isRunning(): boolean {
		return this.viteProcess !== null
	}

	/** Installs missing dependencies if needed, regenerates the shell, boots Vite. */
	async start(): Promise<number> {
		const caretDir = path.join(this.workspacePath, ".caret")

		await assertNodeAvailable()

		if (await this.needsInstall(caretDir)) {
			Logger.info("[design] Installing .caret dependencies...")
			await runNpmInstall(caretDir)
		}

		await generateViteConfig(caretDir)
		await generateEntryFiles(caretDir)

		this.port = await this.spawnVite(caretDir)
		return this.port
	}

	stop(): void {
		if (!this.viteProcess) return
		this.stoppingIntentionally = true
		this.viteProcess.kill()
		this.viteProcess = null
		this.port = null
		Logger.info("[design] Rendering shell stopped")
	}

	/**
	 * True when anything the shell needs is not actually installed.
	 *
	 * Two things this gets right that the obvious version does not, both of
	 * which shipped broken:
	 *
	 * 1. **Merge the required deps before deciding, not after.** The old order
	 *    checked `node_modules` first and returned early when it was absent — so
	 *    a project's *very first* launch installed whatever the scaffold happened
	 *    to write and never added anything from `REQUIRED_DEPS`. The result was a
	 *    shell missing a dependency for its whole first session: the canvas looked
	 *    fine until the user opened a page, and the focused view then died on an
	 *    unresolved import. It "fixed itself" on the next launch, which is the
	 *    worst possible shape for a bug.
	 * 2. **Listed is not installed.** A dep can sit in `package.json` while its
	 *    directory is missing, because an install was interrupted or the tree was
	 *    pruned. Trusting the manifest leaves the app permanently broken in a way
	 *    that reads as "already installed". So the tree is what is checked.
	 */
	private async needsInstall(caretDir: string): Promise<boolean> {
		const pkgPath = path.join(caretDir, "package.json")

		let added = false
		try {
			const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"))
			for (const [dep, version] of Object.entries(REQUIRED_DEPS)) {
				// `devDependencies` counts: the scaffold puts the build-time ones
				// there, and duplicating them into `dependencies` would rewrite the
				// manifest on every single launch.
				if (!pkg.dependencies?.[dep] && !pkg.devDependencies?.[dep]) {
					pkg.dependencies = { ...pkg.dependencies, [dep]: version }
					added = true
				}
			}
			if (added) await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2))
		} catch {
			// No manifest to reason about; let the install rebuild from scratch.
			return true
		}

		if (added) return true

		try {
			await fs.access(path.join(caretDir, "node_modules"))
		} catch {
			return true
		}

		for (const dep of Object.keys(REQUIRED_DEPS)) {
			try {
				await fs.access(path.join(caretDir, "node_modules", dep))
			} catch {
				Logger.info(`[design] ${dep} is listed but not installed — reinstalling`)
				return true
			}
		}

		// A package directory is not a working install: an interrupted install can
		// leave vite's folder without its entry file. Check the exact file
		// spawnVite runs, not a marker for it.
		try {
			await fs.access(path.join(caretDir, "node_modules", "vite", "bin", "vite.js"))
		} catch {
			Logger.info("[design] vite is present but its entry is missing — reinstalling")
			return true
		}
		return false
	}

	private spawnVite(cwd: string): Promise<number> {
		return new Promise((resolve, reject) => {
			// Vite's real entry under system node, never the `.bin` shim: on Windows
			// the shim is a `.cmd` that only a shell can start, and `shell: true`
			// re-joins the command line unquoted — a project path with a space
			// (`C:\Users\First Last\…`) splits the command and Vite never boots.
			// Spawning node directly also means kill() reaches Vite itself rather
			// than a cmd.exe wrapper that would orphan it.
			const viteEntry = path.join(cwd, "node_modules", "vite", "bin", "vite.js")
			const logStream: WriteStream = createWriteStream(path.join(cwd, "vite.log"), { flags: "w" })

			this.stoppingIntentionally = false
			// 127.0.0.1, never "localhost". Vite resolves "localhost" and binds the
			// FIRST address it gets, which on this machine is ::1 and ::1 only —
			// measured, nothing listens on 127.0.0.1 at all. macOS then reaches it
			// because Chromium also prefers ::1, and Windows does not: it connects
			// to 127.0.0.1, finds nothing, and the canvas never loads while Vite
			// sits there healthy and logs nothing wrong. Pinning both the bind and
			// the URL to a literal address takes DNS out of the path entirely.
			//
			// No --port: Vite auto-increments from 5173 when the port is taken, which
			// is what keeps several open projects from colliding. The chosen port is
			// read back from stdout below rather than assumed.
			// NO_COLOR: Vite's colour lib enables ANSI codes on win32 even into a
			// pipe (macOS only colours a TTY), and the codes land BETWEEN
			// "127.0.0.1:" and the port digits — so the readback below never
			// matched on Windows, the 30s timeout fired, and the canvas reported
			// "failed to load" while Vite ran healthy. The escape codes are
			// visible verbatim in any Windows main.log from before this fix.
			const proc = child_process.spawn("node", [viteEntry, "--host", "127.0.0.1"], {
				cwd,
				stdio: "pipe",
				env: { ...systemSpawnEnv(), NO_COLOR: "1" },
			})
			this.viteProcess = proc

			let resolved = false
			const timeout = setTimeout(() => {
				if (!resolved) {
					resolved = true
					emitDesignEvent("canvas_blocked", { reason: "vite_boot_timeout" })
					reject(new Error("Vite server did not start within 30 seconds"))
				}
			}, VITE_BOOT_TIMEOUT_MS)

			let bootOutput = ""
			proc.stdout?.on("data", (data: Buffer) => {
				const output = data.toString()
				Logger.info(`[vite] ${output.trim()}`)
				logStream.write(output)

				// Belt to NO_COLOR's braces: tolerate colour codes and a "Local:"
				// line split across two data events.
				if (!resolved) bootOutput += output
				// eslint-disable-next-line no-control-regex
				const clean = bootOutput.replace(/\x1b\[[0-9;]*m/g, "")
				const match = clean.match(/Local:\s+http:\/\/127\.0\.0\.1:(\d+)/)
				if (match && !resolved) {
					resolved = true
					clearTimeout(timeout)
					resolve(Number.parseInt(match[1], 10))
				}
			})

			proc.stderr?.on("data", (data: Buffer) => {
				const output = data.toString()
				Logger.warn(`[vite stderr] ${output.trim()}`)
				logStream.write(output)
			})

			proc.on("close", (code) => {
				logStream.end()
				const wasRunning = resolved
				if (!resolved) {
					resolved = true
					clearTimeout(timeout)
					reject(new Error(`Vite process exited with code ${code}`))
				}
				this.viteProcess = null
				this.port = null
				if (wasRunning && !this.stoppingIntentionally) {
					Logger.error(`[design] Vite dev server exited unexpectedly (code ${code})`)
					emitDesignEvent("canvas_blocked", { reason: "vite_exited", code: code ?? -1 })
					this.onUnexpectedExit()
				}
			})

			proc.on("error", (err) => {
				if (!resolved) {
					resolved = true
					clearTimeout(timeout)
					// No event existed for this, so the one failure that makes the
					// whole product useless was the one thing analytics could not
					// see. Reason only, never a path or a message.
					emitDesignEvent("canvas_blocked", { reason: "vite_spawn_failed" })
					reject(err)
				}
			})
		})
	}
}

function runNpmInstall(cwd: string): Promise<void> {
	return new Promise((resolve, reject) => {
		// `shell: true` is what resolves `npm.cmd` on Windows; the augmented PATH
		// is what finds npm at all when a Finder-launched app inherits launchd's
		// minimal environment.
		const proc = child_process.spawn("npm", ["install"], { cwd, stdio: "pipe", shell: true, env: systemSpawnEnv() })

		let stderr = ""
		proc.stderr?.on("data", (data) => {
			stderr += data.toString()
		})

		proc.on("close", (code) => {
			if (code === 0) {
				resolve()
			} else {
				emitDesignEvent("canvas_blocked", { reason: "install_failed", code })
				reject(new Error(`npm install failed (exit ${code}): ${stderr}`))
			}
		})
		proc.on("error", (err) => {
			// npm is npm.cmd on Windows and absent entirely without Node, so this
			// is the same missing-prerequisite story one step earlier.
			emitDesignEvent("canvas_blocked", { reason: "npm_missing" })
			reject(err)
		})
	})
}
