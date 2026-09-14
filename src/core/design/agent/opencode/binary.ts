/**
 * Finding the OpenCode binary Caret runs.
 *
 * **Never resolved from `PATH`.** A user who upgrades their own OpenCode install
 * must not change what Caret executes: the adapter is written against one pinned
 * server version whose event vocabulary and response shapes were read off that
 * version's live OpenAPI document, and a different binary can differ in both
 * without changing its version number.
 *
 * Two locations, in order: whatever the app bundle registered (packaged builds
 * put it under `resources/opencode/`), then the pinned npm package in
 * `node_modules`, which is where it lives in development. Nothing else.
 */
import * as fs from "fs"
import * as path from "path"

/**
 * Bumped together with the `opencode-ai` dependency and the pinned protocol.
 * A unit test asserts it matches package.json — builds stage the binary from
 * the dependency, so a drifting constant would document a server that is not
 * the one shipping.
 */
export const PINNED_OPENCODE_VERSION = "1.18.23"

let bundledDirectory: string | null = null

/**
 * Points the resolver at the packaged binary's directory.
 *
 * Called once from the Electron main process, which is the only place that knows
 * `process.resourcesPath`. The design core stays host-free.
 */
export function setBundledBackendDirectory(directory: string | null): void {
	bundledDirectory = directory
}

function executableName(): string {
	return process.platform === "win32" ? "opencode.exe" : "opencode"
}

function isExecutableFile(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isFile()
	} catch {
		return false
	}
}

/**
 * Absolute path of the bundled binary, or null when it is genuinely missing.
 *
 * Null is a reportable state, not a crash: the setup screen shows OpenCode as
 * unavailable with a reason, and the other backends still work.
 */
export function resolveOpencodeBinary(): string | null {
	const candidates: string[] = []

	if (bundledDirectory) {
		candidates.push(path.join(bundledDirectory, executableName()))
	}

	// The npm package hardlinks the platform binary to `bin/opencode.exe` on
	// every platform, Windows suffix included — see its postinstall script.
	candidates.push(path.join(nodeModulesRoot(), "opencode-ai", "bin", "opencode.exe"))

	return candidates.find(isExecutableFile) ?? null
}

/**
 * The nearest `node_modules` at or above the working directory.
 *
 * Neither `require.resolve` nor `__dirname` works across every context this runs
 * in: the design core is bundled into one file by electron-vite, the
 * certification scripts run as ESM under tsx where `__dirname` does not exist,
 * and a packaged app has no `node_modules` at all. Packaged builds register
 * their bundled directory explicitly, so this only has to find the development
 * tree — and there, the working directory is the repository root.
 */
function nodeModulesRoot(): string {
	let directory = process.cwd()
	for (let depth = 0; depth < 8; depth++) {
		const candidate = path.join(directory, "node_modules")
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate
		} catch {}
		const parent = path.dirname(directory)
		if (parent === directory) break
		directory = parent
	}
	return path.join(process.cwd(), "node_modules")
}
