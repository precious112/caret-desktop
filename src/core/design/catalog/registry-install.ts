/**
 * Installs a component the AI chose: any shadcn-style registry item (`@magicui/marquee`) or a 21st.dev component (`21st:10635`).
 *
 * The same machinery as the old catalog's registry tier — the lock file, the
 * design layer's own package.json, hex colours rebound to foundation tokens —
 * widened from a hand-picked list to whatever the libraries offer. Everything
 * lands under `.caret/components/catalog/`, laid out the way registry code
 * expects its `@/` aliases to resolve, so a component's own imports keep
 * working without editing beyond the alias itself:
 *
 *   @/lib/utils           → catalog/lib/utils.ts   (the `cn` helper, written once)
 *   @/components/ui/x     → catalog/ui/x.tsx       (shadcn/ui pieces it builds on)
 *   @/components/<lib>/x  → catalog/<lib>/x.tsx
 *   @/hooks/x, @/lib/x    → catalog/hooks/x, catalog/lib/x
 */
import { readFile } from "fs/promises"
import * as path from "path"

import { fetch } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { readFoundationTokens } from "../tokens"
import { tokenClassForHex } from "../visual-editing/token-colors"
import {
	appendLock,
	type CatalogLockEntry,
	catalogDir,
	installDeps,
	readCatalogLock,
	rebindHexClasses,
	writeComponentFile,
} from "./install"
import { REGISTRIES } from "./registries"

export type ComponentRef = { kind: "registry"; registry: string; name: string } | { kind: "21st"; id: string }

/** "@registry/name" or "21st:<id>"; null for anything else. */
export function parseComponentRef(ref: string): ComponentRef | null {
	const trimmed = ref.trim()
	const registry = /^(@[a-z0-9][\w-]*)\/([a-z0-9][\w-]*)$/i.exec(trimmed)
	if (registry) return { kind: "registry", registry: registry[1].toLowerCase(), name: registry[2] }
	const twentyfirst = /^21st:(\d+)$/.exec(trimmed)
	if (twentyfirst) return { kind: "21st", id: twentyfirst[1] }
	return null
}

/** The folder under `catalog/` a registry's items land in: `@magicui` → `magicui`, `@shadcn` → `ui`. */
export function folderOf(registry: string): string {
	return registry === "@shadcn" ? "ui" : registry.replace(/^@/, "")
}

export interface InstalledComponent {
	ref: string
	/** The page imports from here, relative to a page's `index.tsx`. */
	importPath: string
	/** The export to import, when the file has no default export. */
	namedExport?: string
	alreadyInstalled?: boolean
}

export type InstallOutcome = ({ ok: true } & InstalledComponent) | { ok: false; ref: string; reason: string }

const CN_HELPER = `import { clsx, type ClassValue } from "clsx"\nimport { twMerge } from "tailwind-merge"\n\nexport function cn(...inputs: ClassValue[]) {\n\treturn twMerge(clsx(inputs))\n}\n`

/**
 * Rewrites a file's `@/` aliases to paths relative to where it lands
 * (`fileDir`, relative to `catalog/`). Returns the aliases it saw, so the caller
 * can install what they point at.
 */
export function rewriteAliases(content: string, fileDir: string): { content: string; needs: string[] } {
	const needs: string[] = []
	const out = content.replace(
		/(from\s+|import\s+)(["'])@\/([^"']+)\2/g,
		(_whole, lead: string, quote: string, target: string) => {
			const mapped = target.startsWith("components/") ? target.slice("components/".length) : target
			needs.push(mapped)
			let relative = path.posix.relative(fileDir || ".", mapped)
			if (!relative.startsWith(".")) relative = `./${relative}`
			return `${lead}${quote}${relative}${quote}`
		},
	)
	return { content: out, needs }
}

/** What 21st.dev's `get_component` answer carries: the source and the file name its demo imports. */
export function parse21stAnswer(text: string): { code: string; fileName: string } | null {
	const sections = `\n${text}`.split(/\n## /)
	const component = sections.find((section) => /^Component\b/.test(section))
	const code = component?.match(/```[\w-]*\n([\s\S]*?)```/)?.[1]
	if (!code) return null
	const demo = sections.find((section) => /^Demo\b/.test(section)) ?? ""
	const fileName = demo.match(/from\s+["']@\/components\/ui\/([^"']+)["']/)?.[1] ?? "component"
	return { code, fileName }
}

/** The export a page should import when a file has no default export. */
export function namedExportOf(code: string): string | undefined {
	if (/export\s+default\b/.test(code)) return undefined
	return (
		/export\s+(?:function|const|class)\s+([A-Z]\w*)/.exec(code)?.[1] ??
		/export\s+(?:function|const|class)\s+(\w+)/.exec(code)?.[1]
	)
}

/** npm packages a source file imports (not relative, not aliased, not React). */
export function packagesOf(code: string): string[] {
	const out = new Set<string>()
	for (const match of code.matchAll(/(?:from\s+|import\s+)["']([^"'.][^"']*)["']/g)) {
		const spec = match[1]
		if (spec.startsWith("@/")) continue
		const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]
		if (name === "react" || name === "react-dom") continue
		out.add(name)
	}
	return [...out]
}

interface RegistryItem {
	name?: string
	files?: Array<{ path: string; content?: string; type?: string; target?: string }>
	dependencies?: string[]
	registryDependencies?: string[]
}

export interface RegistryInstallOptions {
	/** 21st.dev's API key; without it a `21st:` ref cannot install. */
	twentyfirstKey?: string
	/** Installs npm dependencies into the design layer. Tests replace it. */
	installDeps?: (workspacePath: string, deps: string[]) => Promise<void>
}

/** What a paid item behind a registry's login needs, in the user's words. */
const ACCOUNT_OF: Record<string, string> = {
	"@aceternity": "an Aceternity account",
	"@magicui": "a Magic UI Pro account",
	"@smoothui": "a Smooth UI Pro account",
	"@kokonutui": "a Kokonut UI Pro account",
}

/** How deep a chain of registry dependencies is followed before Caret refuses it. */
const MAX_DEPTH = 4

class Installer {
	readonly files = new Set<string>()
	readonly deps = new Set<string>()
	private readonly done = new Set<string>()

	constructor(
		private readonly workspacePath: string,
		private readonly tokenFor: (hex: string) => string | null,
	) {}

	async write(relative: string, content: string): Promise<void> {
		await writeComponentFile(this.workspacePath, relative, rebindHexClasses(content, this.tokenFor))
		this.files.add(relative)
		for (const dep of packagesOf(content)) this.deps.add(dep)
	}

	/** Writes a file, rewriting its aliases and installing what they point at. */
	async writeWithAliases(relative: string, content: string, depth: number): Promise<void> {
		const { content: rewritten, needs } = rewriteAliases(content, path.posix.dirname(relative))
		await this.write(relative, rewritten)
		for (const need of needs) await this.provide(need, depth)
	}

	/** Makes `catalog/<need>` exist: the cn helper, or a registry item it names. */
	private async provide(need: string, depth: number): Promise<void> {
		if (need === "lib/utils") {
			if (!this.files.has("lib/utils.ts")) {
				await this.write("lib/utils.ts", CN_HELPER)
				this.deps.add("clsx")
				this.deps.add("tailwind-merge")
			}
			return
		}
		const [folder, name] = need.split("/")
		if (!name) return
		const registry = folder === "ui" ? "@shadcn" : `@${folder}`
		if (REGISTRIES[registry]) await this.registryItem(registry, name, depth + 1)
	}

	async registryItem(registry: string, name: string, depth: number): Promise<string> {
		const key = `${registry}/${name}`
		const folder = folderOf(registry)
		const main = `${folder}/${name}.tsx`
		if (this.done.has(key)) return main
		this.done.add(key)
		if (depth > MAX_DEPTH) throw new Error(`${key} sits too deep in a chain of registry dependencies to install safely`)
		const template = REGISTRIES[registry]
		if (!template) throw new Error(`${registry} is not a registry Caret installs from`)
		const url = template.replace("{name}", name)
		const response = await fetch(url)
		if (response.status === 401 || response.status === 403 || response.status === 402) {
			// A paid item behind the library's own login: say what it needs, not the status code.
			throw new Error(`${name} needs ${ACCOUNT_OF[registry] ?? `an account with ${registry}`} (it is a paid item)`)
		}
		if (!response.ok) throw new Error(`${registry} answered ${response.status} for ${name} (${url})`)
		const item = (await response.json()) as RegistryItem
		const files = (item.files ?? []).filter((file) => typeof file.content === "string")
		if (!files.length) throw new Error(`${registry}'s item ${name} carries no files`)

		for (const dependency of item.registryDependencies ?? []) {
			if (/^https?:/.test(dependency))
				throw new Error(`${key} depends on an item outside the known registries (${dependency})`)
			const ref = parseComponentRef(dependency)
			if (ref?.kind === "registry") await this.registryItem(ref.registry, ref.name, depth + 1)
			else if (/^[a-z0-9][\w-]*$/i.test(dependency)) await this.registryItem("@shadcn", dependency, depth + 1)
		}
		for (const dep of item.dependencies ?? []) this.deps.add(dep)

		for (const [index, file] of files.entries()) {
			const base = path.posix.basename(file.path)
			const kind = file.type ?? ""
			// The first component file is the item; hooks and libs keep their folders.
			const relative =
				kind === "registry:hook"
					? `hooks/${base}`
					: kind === "registry:lib"
						? `lib/${base}`
						: index === 0
							? main
							: `${folder}/${base}`
			await this.writeWithAliases(relative, file.content ?? "", depth)
		}
		return main
	}
}

async function call21st(key: string, id: string): Promise<string> {
	let session: string | null = null
	let n = 0
	const rpc = async (method: string, params: Record<string, unknown> = {}) => {
		const response = await fetch("https://21st.dev/api/mcp", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"x-api-key": key,
				...(session ? { "mcp-session-id": session } : {}),
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }),
		})
		session = response.headers.get("mcp-session-id") ?? session
		if (!response.ok) throw new Error(`21st.dev answered ${response.status}`)
		const body = await response.text()
		const line = body.trim().startsWith("{")
			? body
			: (body
					.split("\n")
					.filter((l) => l.startsWith("data:"))
					.pop()
					?.slice(5) ?? "")
		return line
			? (JSON.parse(line) as { result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> } })
			: null
	}
	await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "caret", version: "1" } })
	const answer = await rpc("tools/call", { name: "get_component", arguments: { id: Number(id) } })
	const text = (answer?.result?.content ?? [])
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n")
	if (answer?.result?.isError || /quota|limit reached|upgrade/i.test(text.slice(0, 300))) {
		throw new Error("21st.dev's daily download limit is used up for this key")
	}
	return text
}

/**
 * Installs one chosen component into the project, or says why it could not.
 * An already-installed component is not fetched again — a 21st.dev download
 * spends the key's daily quota.
 */
export async function installComponentRef(
	workspacePath: string,
	refText: string,
	options: RegistryInstallOptions = {},
): Promise<InstallOutcome> {
	const ref = parseComponentRef(refText)
	if (!ref) return { ok: false, ref: refText, reason: `"${refText}" is not a component Caret can install` }
	const library = ref.kind === "registry" ? folderOf(ref.registry) : "21st"
	const component = ref.kind === "registry" ? ref.name : ref.id

	const lock = await readCatalogLock(workspacePath)
	const existing = lock.installed.find((e) => e.library === library && e.component === component)
	if (existing) {
		const main = existing.files[0] ?? `${library}/${component}.tsx`
		return {
			ok: true,
			ref: refText,
			importPath: importPathOf(main),
			namedExport: await namedExportFromDisk(workspacePath, main),
			alreadyInstalled: true,
		}
	}

	const tokens = await readFoundationTokens(workspacePath)
	const installer = new Installer(workspacePath, (hex) => tokenClassForHex(hex, tokens))
	try {
		let main: string
		let origin: string
		let namedExport: string | undefined
		if (ref.kind === "registry") {
			main = await installer.registryItem(ref.registry, ref.name, 0)
			origin = (REGISTRIES[ref.registry] ?? "").replace("{name}", ref.name)
			namedExport = await namedExportFromDisk(workspacePath, main)
		} else {
			if (!options.twentyfirstKey)
				throw new Error("21st.dev needs a key: paste one in the Backend tab's Libraries section")
			const parsed = parse21stAnswer(await call21st(options.twentyfirstKey, ref.id))
			if (!parsed) throw new Error("21st.dev's answer had no component source")
			main = `21st/${ref.id}/${parsed.fileName}.tsx`
			// Some 21st.dev answers import the helper from a bare "cn" placeholder.
			await installer.writeWithAliases(main, parsed.code.replace(/from\s+(["'])cn\1/g, 'from "@/lib/utils"'), 0)
			origin = `https://21st.dev/community/components/${ref.id}`
			namedExport = namedExportOf(parsed.code)
		}
		const ordered = [main, ...[...installer.files].filter((f) => f !== main)]
		const entry: CatalogLockEntry = {
			library,
			component,
			origin,
			licence: "as published by the library",
			installedAt: new Date().toISOString(),
			files: ordered,
			deps: [...installer.deps].sort(),
		}
		await (options.installDeps ?? installDeps)(workspacePath, entry.deps)
		await appendLock(workspacePath, entry)
		Logger.info(`[catalog] installed ${refText} (${origin})`)
		return { ok: true, ref: refText, importPath: importPathOf(main), namedExport }
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err)
		Logger.warn(`[catalog] install of ${refText} failed: ${reason}`)
		return { ok: false, ref: refText, reason }
	}
}

/** A page lives at `.caret/pages/<id>/index.tsx`; the catalog at `.caret/components/catalog/`. */
export function importPathOf(main: string): string {
	return `../../components/catalog/${main.replace(/\.tsx?$/, "")}`
}

async function namedExportFromDisk(workspacePath: string, main: string): Promise<string | undefined> {
	try {
		return namedExportOf(await readFile(path.join(catalogDir(workspacePath), main), "utf-8"))
	} catch {
		return undefined
	}
}
