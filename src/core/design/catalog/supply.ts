/**
 * Auto-supply: a page imports a component from `components/catalog/`, and
 * Caret makes the import true.
 *
 * Components come from shadcn-style registries and 21st.dev, installed into
 * `.caret/components/catalog/<registry>/<item>` (see `registry-install.ts`).
 * After any page write (agent turn, external save, inline edit), the scanner
 * finds catalog imports that are not installed yet; an import whose folder is a
 * known registry is installed from it, consent-gated per library. Anything else
 * stays visibly unresolved and the design checks name it.
 *
 * There is no budget on how many components a page may use: whether a
 * component earns its place is the AI's call.
 */
import type { CheckFinding } from "../design-checks"
import type { CatalogLock } from "./install"
import { REGISTRIES } from "./registries"

export interface CatalogImportRef {
	/** The import target relative to `components/catalog/`, without an extension (`magicui/marquee`). */
	target: string
	/** Installed already, per the lock. */
	installed: boolean
	/** The registry ref that supplies it (`@magicui/marquee`), when the folder is a known registry. */
	ref: string | null
}

const IMPORT = /from\s+["'](?:\.\.?\/)+components\/catalog\/([\w./-]+?)(?:\.tsx?)?["']/g

/** `magicui/marquee` → `@magicui/marquee`; `ui/button` → `@shadcn/button`; anything else null. */
export function registryRefFor(target: string): string | null {
	const [folder, name, ...rest] = target.split("/")
	if (!folder || !name || rest.length) return null
	const registry = folder === "ui" ? "@shadcn" : `@${folder}`
	return REGISTRIES[registry] ? `${registry}/${name}` : null
}

/** Every catalog import in a source file, in order of appearance, once each. */
export function scanCatalogImports(source: string, lock: CatalogLock): CatalogImportRef[] {
	const installedFiles = new Set(lock.installed.flatMap((entry) => entry.files.map((file) => file.replace(/\.tsx?$/, ""))))
	const seen = new Set<string>()
	const refs: CatalogImportRef[] = []
	for (const match of source.matchAll(IMPORT)) {
		const target = match[1]
		if (seen.has(target)) continue
		seen.add(target)
		refs.push({ target, installed: installedFiles.has(target), ref: registryRefFor(target) })
	}
	return refs
}

export interface SupplyPlan {
	/** Registry refs to install. */
	install: string[]
	/** Imports nothing can supply. */
	unknown: string[]
}

export function planSupply(source: string, lock: CatalogLock): SupplyPlan {
	const missing = scanCatalogImports(source, lock).filter((ref) => !ref.installed)
	return {
		install: missing.filter((ref) => ref.ref).map((ref) => ref.ref as string),
		unknown: missing.filter((ref) => !ref.ref).map((ref) => ref.target),
	}
}

/** Imports that will never resolve, as design-check findings. */
export function catalogFindings(source: string, pageId: string, lock: CatalogLock): CheckFinding[] {
	return planSupply(source, lock).unknown.map((target) => ({
		check: "catalog-unknown",
		severity: "error" as const,
		message: `the import of components/catalog/${target} is not installed and comes from no known registry: install a component with install_component ("@registry/name" or "21st:<id>") and import the path it returns`,
		pageId,
	}))
}
