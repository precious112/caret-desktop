/**
 * The catalog install engine — how a curated component actually enters a
 * project.
 *
 * Four tiers, one contract: plain source lands under
 * `.caret/components/catalog/<library>/`, its npm deps land in the design
 * layer's own package.json (installed with `--ignore-scripts` — an allowlist
 * is not a reason to run arbitrary postinstalls), exact-match hex values are
 * rebound to foundation tokens, and every install is recorded in the
 * versioned lock (`catalog-lock.json`) — library, component, pinned origin,
 * licence, files, deps. The lock is what makes a component choice persist the
 * way every other correction does: next session's agent sees what this
 * project already uses and reuses it instead of inventing a new one.
 *
 * The watch-and-heal codemod fires on these writes automatically (any
 * `.caret/` write does), so installed components get caret-ids and become as
 * visually editable as their `editable` grade allows — no extra machinery.
 *
 * Supply-chain posture: allowlist only (ids must exist in the CATALOG),
 * pinned origins, no third-party CLI ever executes inside the project (the
 * one `cli`-tier library runs in a throwaway temp dir and only the landed
 * source file is copied over).
 */
import { execFile } from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { promisify } from "util"

import { fetch } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { runExclusive, writeFileAtomic } from "../file-mutation-queue"
import { systemSpawnEnv } from "../spawn-env"
import { readFoundationTokens } from "../tokens"
import { tokenClassForHex } from "../visual-editing/token-colors"
import { CATALOG_INSTALL_DIR, type CatalogComponent, type CatalogLibrary, findCatalogComponent } from "./catalog"

const execFileAsync = promisify(execFile)

export interface CatalogLockEntry {
	library: string
	component: string
	/** Where it came from: `repo@sha` (vendored), the registry URL, `npm:pkg@version`, or `cli:pkg`. */
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

export interface InstallResult {
	ok: boolean
	/** Present when ok — the entry recorded in the lock. */
	entry?: CatalogLockEntry
	/** Present when not ok — why, in words an agent can act on. */
	reason?: string
	alreadyInstalled?: boolean
}

function catalogDir(workspacePath: string): string {
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

async function appendLock(workspacePath: string, entry: CatalogLockEntry): Promise<void> {
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
async function installDeps(workspacePath: string, deps: string[]): Promise<void> {
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

async function writeComponentFile(workspacePath: string, relative: string, content: string): Promise<void> {
	const target = path.join(catalogDir(workspacePath), relative)
	await fs.mkdir(path.dirname(target), { recursive: true })
	await writeFileAtomic(target, content)
}

// ---------------------------------------------------------------------------
// Tier implementations
// ---------------------------------------------------------------------------

async function installVendored(
	workspacePath: string,
	mirrorDir: string,
	library: CatalogLibrary,
	component: CatalogComponent,
	tokenFor: (hex: string) => string | null,
): Promise<CatalogLockEntry> {
	const manifest = JSON.parse(await fs.readFile(path.join(mirrorDir, "manifest.json"), "utf-8"))
	const manifestComponent = manifest.libraries?.[library.id]?.components?.[component.id]
	if (!manifestComponent) {
		throw new Error(`the shipped mirror has no ${library.id}/${component.id} — the catalog and mirror are out of step`)
	}

	const libMirror = path.join(mirrorDir, library.id)
	const files: string[] = []

	const mainSource = await fs.readFile(path.join(libMirror, manifestComponent.file), "utf-8")
	await writeComponentFile(workspacePath, path.join(library.id, `${component.id}.tsx`), rebindHexClasses(mainSource, tokenFor))
	files.push(path.join(library.id, `${component.id}.tsx`))

	for (const extra of [...manifestComponent.extraFiles, "_cn.ts"]) {
		try {
			const content = await fs.readFile(path.join(libMirror, extra), "utf-8")
			await writeComponentFile(workspacePath, path.join(library.id, extra), content)
			if (!files.includes(path.join(library.id, extra))) files.push(path.join(library.id, extra))
		} catch {
			// _cn.ts only exists when some component in the lib needed it.
			if (extra !== "_cn.ts") throw new Error(`mirror is missing ${library.id}/${extra}`)
		}
	}

	// The licence travels into the project alongside the source it covers.
	await fs
		.copyFile(path.join(libMirror, "LICENSE"), path.join(catalogDir(workspacePath), library.id, "LICENSE"))
		.catch(() => {})

	await installDeps(workspacePath, manifestComponent.deps)

	return {
		library: library.id,
		component: component.id,
		origin: `${library.repo}@${library.pinnedSha}`,
		licence: library.licence,
		installedAt: new Date().toISOString(),
		files,
		deps: manifestComponent.deps,
	}
}

interface RegistryItemFile {
	path: string
	content: string
}

async function installRegistry(
	workspacePath: string,
	library: CatalogLibrary,
	component: CatalogComponent,
	tokenFor: (hex: string) => string | null,
): Promise<CatalogLockEntry> {
	const url = (library.registryTemplate ?? "").replace("{name}", component.source)
	const response = await fetch(url)
	if (!response.ok) {
		throw new Error(`${library.name}'s registry answered ${response.status} for ${component.id} (${url})`)
	}
	const item = (await response.json()) as {
		files?: RegistryItemFile[]
		dependencies?: string[]
		registryDependencies?: string[]
	}
	if (!item.files || item.files.length === 0) {
		throw new Error(`${library.name}'s registry item for ${component.id} carries no files`)
	}
	if (item.registryDependencies && item.registryDependencies.length > 0) {
		// Depth-one resolution only, and only within the same registry — an
		// allowlist that follows arbitrary cross-registry links isn't one.
		for (const dependency of item.registryDependencies) {
			if (/^https?:/.test(dependency)) {
				throw new Error(
					`${component.id} depends on an external registry item (${dependency}) — not installable under the allowlist`,
				)
			}
		}
	}

	const files: string[] = []
	const deps = new Set<string>([...(library.baseDeps ?? []), ...(component.deps ?? []), ...(item.dependencies ?? [])])

	for (const [index, file] of item.files.entries()) {
		const basename = path.basename(file.path)
		const relative = path.join(library.id, index === 0 ? `${component.id}.tsx` : basename)
		// Registry items import shadcn-style aliases; rewrite the utils one to a
		// local helper and refuse the rest rather than landing broken source.
		let content = file.content.replace(/from\s+(["'])@\/lib\/utils\1/g, 'from "./_cn"')
		if (/from\s+["']@\//.test(content)) {
			const alias = /from\s+["'](@\/[^"']+)["']/.exec(content)?.[1]
			throw new Error(`${component.id} imports ${alias}, which has no local equivalent — not installable as-is`)
		}
		if (content.includes('"./_cn"')) {
			await writeComponentFile(
				workspacePath,
				path.join(library.id, "_cn.ts"),
				`import { clsx, type ClassValue } from "clsx"\nimport { twMerge } from "tailwind-merge"\n\nexport function cn(...inputs: ClassValue[]) {\n\treturn twMerge(clsx(inputs))\n}\n`,
			)
			if (!files.includes(path.join(library.id, "_cn.ts"))) files.push(path.join(library.id, "_cn.ts"))
			deps.add("clsx")
			deps.add("tailwind-merge")
		}
		content = rebindHexClasses(content, tokenFor)
		await writeComponentFile(workspacePath, relative, content)
		files.push(relative)
	}

	await installDeps(workspacePath, [...deps])

	return {
		library: library.id,
		component: component.id,
		origin: url,
		licence: library.licence,
		installedAt: new Date().toISOString(),
		files,
		deps: [...deps].sort(),
	}
}

/** Wrapper templates for the npm (wrap-only) tier — token-bindable props, sealed interior. */
function npmWrapper(library: CatalogLibrary, component: CatalogComponent): string {
	const exportName = component.source
	if (library.id === "ldrs") {
		return `/**
 * ${library.name} ${exportName} — wrap-only: the loader renders inside a web
 * component, so the interior is not inline-editable. Colour, size and speed
 * are the surface; bind colour to a foundation value.
 */
import { ${exportName} } from "ldrs/react"
import "ldrs/react/${exportName}.css"

export default function ${exportName}Loader({
	color = "#0b7aff",
	size = 40,
	speed = 2,
}: {
	color?: string
	size?: number
	speed?: number
}) {
	return <${exportName} color={color} size={size} speed={speed} />
}
`
	}
	if (library.id === "paper-shaders") {
		return `/**
 * ${library.name} ${exportName} — wrap-only shader surface. The canvas
 * interior is not inline-editable; colours bind through the props.
 */
import { ${exportName} } from "@paper-design/shaders-react"

export default function ${exportName}Surface({
	colors = ["#0b7aff", "#16233d", "#e8e3da"],
	style,
}: {
	colors?: string[]
	style?: React.CSSProperties
}) {
	return <${exportName} colors={colors} style={{ width: "100%", height: "100%", ...style }} />
}
`
	}
	if (library.id === "tsparticles") {
		return `/**
 * tsParticles — wrap-only. Configure via the options object; colours bind
 * through the props below.
 */
import Particles, { ParticlesProvider } from "@tsparticles/react"
import { loadSlim } from "@tsparticles/slim"

const init = async (engine: unknown) => {
	await loadSlim(engine as never)
}

export default function ParticleField({
	color = "#0b7aff",
	linkColor = "#8b93a7",
	count = 60,
}: {
	color?: string
	linkColor?: string
	count?: number
}) {
	return (
		<ParticlesProvider init={init}>
			<Particles
				id="caret-particles"
				options={{
					fullScreen: { enable: false },
					particles: {
						number: { value: count },
						color: { value: color },
						links: { enable: true, color: linkColor },
						move: { enable: true, speed: 1 },
						size: { value: 2 },
					},
				}}
				style={{ position: "absolute", inset: 0 }}
			/>
		</ParticlesProvider>
	)
}
`
	}
	throw new Error(`no wrapper template for npm library ${library.id}`)
}

async function installNpm(
	workspacePath: string,
	library: CatalogLibrary,
	component: CatalogComponent,
): Promise<CatalogLockEntry> {
	const deps = [library.npmPackage ?? "", ...(component.deps ?? [])].filter(Boolean)
	const relative = path.join(library.id, `${component.id}.tsx`)
	await writeComponentFile(workspacePath, relative, npmWrapper(library, component))
	await installDeps(workspacePath, deps)
	return {
		library: library.id,
		component: component.id,
		origin: `npm:${library.npmPackage}`,
		licence: library.licence,
		installedAt: new Date().toISOString(),
		files: [relative],
		deps: deps.sort(),
	}
}

/**
 * The one CLI-tier library runs in a THROWAWAY temp directory — a third-party
 * CLI never executes with the user's project as its working directory. Only
 * the landed source file is copied over.
 */
async function installCli(
	workspacePath: string,
	library: CatalogLibrary,
	component: CatalogComponent,
	tokenFor: (hex: string) => string | null,
): Promise<CatalogLockEntry> {
	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "caret-catalog-cli-"))
	try {
		// The CLI prompts to install deps; "n" declines — Caret installs deps
		// itself, with scripts disabled.
		await new Promise<void>((resolve, reject) => {
			// Same Windows/`npx.cmd` and macOS/PATH story as installDeps above.
			const child = execFile(
				"npx",
				["-y", "lightswind@latest", "add", component.source],
				{ cwd: scratch, timeout: 240_000, shell: process.platform === "win32", env: systemSpawnEnv() },
				(error) => (error ? reject(error) : resolve()),
			)
			child.stdin?.write("n\n")
			child.stdin?.end()
		})

		// The CLI lands files under components/lightswind (no src/ in scratch).
		const landedDir = path.join(scratch, "components", "lightswind")
		const landed = await fs.readdir(landedDir).catch(() => [] as string[])
		if (landed.length === 0) {
			throw new Error(`the ${library.name} CLI reported success but landed no files`)
		}

		const files: string[] = []
		for (const name of landed) {
			const content = await fs.readFile(path.join(landedDir, name), "utf-8")
			const relative = path.join(library.id, name === landed[0] ? `${component.id}.tsx` : name)
			await writeComponentFile(workspacePath, relative, rebindHexClasses(content, tokenFor))
			files.push(relative)
		}

		const deps = component.deps ?? []
		await installDeps(workspacePath, deps)

		return {
			library: library.id,
			component: component.id,
			origin: "cli:lightswind@latest",
			licence: library.licence,
			installedAt: new Date().toISOString(),
			files,
			deps: [...deps].sort(),
		}
	} finally {
		await fs.rm(scratch, { recursive: true, force: true }).catch(() => {})
	}
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

export interface InstallOptions {
	/** Where the vendored mirror lives (the desktop resolves the bundled path). */
	mirrorDir: string
}

export async function installCatalogComponent(
	workspacePath: string,
	libraryId: string,
	componentId: string,
	options: InstallOptions,
): Promise<InstallResult> {
	const found = findCatalogComponent(libraryId, componentId)
	if (!found) {
		return { ok: false, reason: `${libraryId}/${componentId} is not in the catalog — only allowlisted components install` }
	}
	const { library, component } = found

	const lock = await readCatalogLock(workspacePath)
	if (isInstalled(lock, libraryId, componentId)) {
		const entry = lock.installed.find((e) => e.library === libraryId && e.component === componentId)
		return { ok: true, entry, alreadyInstalled: true }
	}

	const tokens = await readFoundationTokens(workspacePath)
	const tokenFor = (hex: string) => tokenClassForHex(hex, tokens)

	try {
		let entry: CatalogLockEntry
		switch (library.tier) {
			case "vendored":
				entry = await installVendored(workspacePath, options.mirrorDir, library, component, tokenFor)
				break
			case "registry":
				entry = await installRegistry(workspacePath, library, component, tokenFor)
				break
			case "npm":
				entry = await installNpm(workspacePath, library, component)
				break
			case "cli":
				entry = await installCli(workspacePath, library, component, tokenFor)
				break
		}
		await appendLock(workspacePath, entry)
		Logger.info(`[catalog] installed ${libraryId}/${componentId} (${entry.origin})`)
		return { ok: true, entry }
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err)
		Logger.warn(`[catalog] install of ${libraryId}/${componentId} failed: ${reason}`)
		return { ok: false, reason }
	}
}
