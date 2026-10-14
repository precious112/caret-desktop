/**
 * What every component install shares — how a component actually enters a
 * project (the fetching itself is `registry-install.ts`).
 *
 * One contract: plain source lands under `.caret/components/catalog/`, its npm
 * deps land in the design layer's own package.json (installed with
 * `--ignore-scripts` — choosing a component is not a reason to run arbitrary
 * postinstalls), exact-match hex values are rebound to foundation tokens, and
 * every install is recorded in the versioned lock (`catalog-lock.json`) —
 * library, component, origin, files, deps. The lock is what makes a component
 * choice persist the way every other correction does: next session's agent
 * sees what this project already uses and reuses it instead of inventing a new
 * one.
 *
 * The watch-and-heal codemod fires on these writes automatically (any
 * `.caret/` write does), so installed components get caret-ids and become
 * visually editable — no extra machinery.
 */
import { execFile } from "child_process"
import * as fs from "fs/promises"
import * as path from "path"
import { promisify } from "util"

import { runExclusive, writeFileAtomic } from "../file-mutation-queue"
import { systemSpawnEnv } from "../spawn-env"

/** Where installed components live, under `.caret/components/`. */
export const CATALOG_INSTALL_DIR = "catalog"

const execFileAsync = promisify(execFile)

export interface CatalogLockEntry {
	library: string
	component: string
	/** Where it came from: the registry item's URL, or the 21st.dev component's page. (Older installs: `repo@sha`, `npm:pkg`, `cli:pkg`.) */
	origin: string
	licence: string
	installedAt: string
	/** Files written, relative to `.caret/components/catalog/`. */
	files: string[]
	deps: string[]
}

export interface CatalogLock {
	version: 1
	installed: CatalogLockEntry[]
}

export function catalogDir(workspacePath: string): string {
	return path.join(workspacePath, ".caret", "components", CATALOG_INSTALL_DIR)
}

function lockPath(workspacePath: string): string {
	return path.join(catalogDir(workspacePath), "catalog-lock.json")
}

export async function readCatalogLock(workspacePath: string): Promise<CatalogLock> {
	try {
		const raw = JSON.parse(await fs.readFile(lockPath(workspacePath), "utf-8"))
		return { version: 1, installed: Array.isArray(raw?.installed) ? raw.installed : [] }
	} catch {
		return { version: 1, installed: [] }
	}
}

export function isInstalled(lock: CatalogLock, libraryId: string, componentId: string): boolean {
	return lock.installed.some((entry) => entry.library === libraryId && entry.component === componentId)
}

export async function appendLock(workspacePath: string, entry: CatalogLockEntry): Promise<void> {
	const target = lockPath(workspacePath)
	await runExclusive(target, async () => {
		const lock = await readCatalogLock(workspacePath)
		lock.installed = [
			...lock.installed.filter(
				(existing) => !(existing.library === entry.library && existing.component === entry.component),
			),
			entry,
		]
		await fs.mkdir(path.dirname(target), { recursive: true })
		await writeFileAtomic(target, JSON.stringify(lock, null, 2))
	})
}

/**
 * Adds dependencies to the design layer's package.json and installs them.
 * `--ignore-scripts`: catalog deps are rendering libraries, and none of them
 * has a legitimate reason to run code at install time inside a user's repo.
 */
export async function installDeps(workspacePath: string, deps: string[]): Promise<void> {
	if (deps.length === 0) return
	const caretDir = path.join(workspacePath, ".caret")
	const packagePath = path.join(caretDir, "package.json")

	await runExclusive(packagePath, async () => {
		const pkg = JSON.parse(await fs.readFile(packagePath, "utf-8"))
		pkg.dependencies = pkg.dependencies ?? {}
		let changed = false
		for (const dep of deps) {
			if (!pkg.dependencies[dep]) {
				pkg.dependencies[dep] = "latest"
				changed = true
			}
		}
		if (changed) await writeFileAtomic(packagePath, JSON.stringify(pkg, null, 2))
	})

	// `shell` on Windows only: npm there is `npm.cmd`, which execFile cannot
	// start without one. The arguments are fixed strings, so the shell's lack of
	// quoting cannot bite. The augmented PATH is for Finder-launched macOS apps,
	// which inherit an environment without Homebrew's bin directories.
	await execFileAsync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
		cwd: caretDir,
		timeout: 300_000,
		shell: process.platform === "win32",
		env: systemSpawnEnv(),
	})
}

/**
 * Rebinds exact-match hex values to foundation tokens in freshly landed
 * source: `bg-[#0b7aff]` becomes `bg-brand-500` when the foundation defines
 * exactly that value. Only Tailwind arbitrary-value colour classes — prop
 * defaults and canvas colours stay as the library authored them (those bind
 * through props, which is the wrapper's job, not a rewrite's).
 */
export function rebindHexClasses(source: string, tokenFor: (hex: string) => string | null): string {
	return source.replace(
		/\b(bg|text|border|ring|from|to|via|outline|accent|fill|stroke)-\[(#[0-9a-fA-F]{3,8})\]/g,
		(whole, prefix: string, hex: string) => {
			const token = tokenFor(hex)
			return token ? `${prefix}-${token}` : whole
		},
	)
}

export async function writeComponentFile(workspacePath: string, relative: string, content: string): Promise<void> {
	const target = path.join(catalogDir(workspacePath), relative)
	await fs.mkdir(path.dirname(target), { recursive: true })
	await writeFileAtomic(target, content)
}
