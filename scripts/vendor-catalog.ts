/**
 * Builds the vendored catalog mirror from pinned repo tarballs.
 *
 * Usage:
 *   npx tsx scripts/vendor-catalog.ts /path/to/extracted-tarballs
 *
 * The input directory holds one extracted repo per vendored library, named by
 * repo basename (magicui/, fancy/, motion-primitives/, cult-ui/, animata/),
 * each at the SHA pinned in the catalog. The script copies the curated
 * component sources into `assets/catalog/<libId>/`, normalises imports, and
 * writes a manifest the install engine reads at runtime.
 *
 * Normalisation rules (kept dumb on purpose — anything cleverer belongs in a
 * review, not a script):
 * - `@/lib/utils` → `./_cn` (one shared cn helper written per library dir;
 *   pulls clsx + tailwind-merge into the component's dep list)
 * - `@/hooks/<name>` → resolved from the repo's own hooks dir, copied to
 *   `<lib>/hooks/<name>.ts`, import rewritten — only when the file exists
 * - any other `@/…` import → the component is SKIPPED and reported; a
 *   silently broken vendored component is worse than a smaller catalog
 * - `.css` siblings are copied alongside (some Animata components have them)
 *
 * Every import of a bare npm package is collected and compared against the
 * catalog's declared deps — a mismatch fails the run, so catalog.ts can never
 * drift from what the source actually needs.
 */
import * as fs from "fs/promises"
import * as path from "path"

import { CATALOG } from "../src/core/design/catalog/catalog"

const OUT_DIR = path.resolve("assets/catalog")

const CN_HELPER = `import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs))
}
`

/** Repo dir name + hooks root per vendored library. */
const REPO_LAYOUT: Record<string, { dir: string; hooksRoots: string[] }> = {
	magicui: { dir: "magicui", hooksRoots: ["apps/www/hooks", "apps/www/registry/magicui"] },
	fancy: { dir: "fancy", hooksRoots: ["src/hooks"] },
	"motion-primitives": { dir: "motion-primitives", hooksRoots: ["hooks"] },
	"cult-ui": { dir: "cult-ui", hooksRoots: ["apps/www/hooks"] },
	animata: { dir: "animata", hooksRoots: ["hooks"] },
}

/** Modules that are part of the runtime, not npm deps to install. */
const AMBIENT_MODULES = new Set(["react", "react-dom", "react/jsx-runtime"])

/** Deps every install carries implicitly (the cn helper needs them) — no declaration noise. */
const IMPLICIT_DEPS = new Set(["clsx", "tailwind-merge"])

interface ManifestComponent {
	file: string
	extraFiles: string[]
	deps: string[]
}

interface Manifest {
	version: 1
	generatedAt: string
	libraries: Record<string, { sha: string; licence: string; repo: string; components: Record<string, ManifestComponent> }>
}

function packageNameOf(source: string): string {
	if (source.startsWith("@")) {
		const [scope, name] = source.split("/")
		return `${scope}/${name}`
	}
	return source.split("/")[0]
}

async function main(): Promise<void> {
	const inputRoot = process.argv[2]
	if (!inputRoot) {
		console.error("usage: vendor-catalog.ts <extracted-tarballs-dir>")
		process.exit(1)
	}

	const manifest: Manifest = { version: 1, generatedAt: new Date().toISOString(), libraries: {} }
	const problems: string[] = []

	await fs.rm(OUT_DIR, { recursive: true, force: true })

	for (const library of CATALOG) {
		if (library.tier !== "vendored") continue
		const layout = REPO_LAYOUT[library.id]
		const repoDir = path.join(inputRoot, layout.dir)
		const libOut = path.join(OUT_DIR, library.id)
		await fs.mkdir(libOut, { recursive: true })

		// The licence rides with the mirror — it is the thing that makes the
		// mirror legal.
		let licenceCopied = false
		for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENCE.md", "license"]) {
			try {
				await fs.copyFile(path.join(repoDir, name), path.join(libOut, "LICENSE"))
				licenceCopied = true
				break
			} catch {}
		}
		if (!licenceCopied) {
			problems.push(`${library.id}: no LICENSE file found in the repo — the mirror would be unlicensed`)
			continue
		}

		manifest.libraries[library.id] = {
			sha: library.pinnedSha ?? "",
			licence: library.licence,
			repo: library.repo ?? "",
			components: {},
		}
		let cnWritten = false

		for (const component of library.components) {
			const sourcePath = path.join(repoDir, component.source)
			let source: string
			try {
				source = await fs.readFile(sourcePath, "utf-8")
			} catch {
				problems.push(`${library.id}/${component.id}: source not found at ${component.source}`)
				continue
			}

			const deps = new Set<string>(library.baseDeps ?? [])
			for (const declared of component.deps ?? []) deps.add(declared)
			const discovered = new Set<string>()
			const extraFiles: string[] = []
			let skip: string | null = null

			// Rewrite imports line-wise: dumb and reviewable.
			const importRe = /from\s+["']([^"']+)["']/g
			let rewritten = source
			for (const match of source.matchAll(importRe)) {
				const spec = match[1]
				if (spec === "@/lib/utils" || spec === "@/lib/utils.ts") {
					rewritten = rewritten.replaceAll(match[0], match[0].replace(spec, "./_cn"))
					discovered.add("clsx")
					discovered.add("tailwind-merge")
					if (!cnWritten) {
						await fs.writeFile(path.join(libOut, "_cn.ts"), CN_HELPER)
						cnWritten = true
					}
					continue
				}
				if (spec.startsWith("@/hooks/")) {
					const hookName = spec.slice("@/hooks/".length)
					let resolved = false
					for (const hooksRoot of layout.hooksRoots) {
						for (const ext of [".ts", ".tsx"]) {
							const hookPath = path.join(repoDir, hooksRoot, hookName + ext)
							try {
								const hookSource = await fs.readFile(hookPath, "utf-8")
								await fs.mkdir(path.join(libOut, "hooks"), { recursive: true })
								await fs.writeFile(path.join(libOut, "hooks", hookName + ext), hookSource)
								extraFiles.push(`hooks/${hookName}${ext}`)
								rewritten = rewritten.replaceAll(match[0], match[0].replace(spec, `./hooks/${hookName}`))
								resolved = true
								break
							} catch {}
						}
						if (resolved) break
					}
					if (!resolved) skip = `unresolvable hook import ${spec}`
					continue
				}
				if (spec.startsWith("@/animata/")) {
					// Animata components import siblings by alias; single-level copy,
					// with the sibling's own cn import rewritten the same way.
					const relative = spec.slice("@/animata/".length)
					let resolved = false
					for (const ext of [".tsx", ".ts"]) {
						const siblingPath = path.join(repoDir, "animata", relative + ext)
						try {
							let siblingSource = await fs.readFile(siblingPath, "utf-8")
							if (/@\/(?!lib\/utils)/.test(siblingSource.replace(/@\/lib\/utils/g, ""))) {
								break // the sibling has its own alias imports — too deep, skip the component
							}
							siblingSource = siblingSource.replace(/from\s+["']@\/lib\/utils["']/g, 'from "../_cn"')
							if (siblingSource.includes("../_cn")) {
								discovered.add("clsx")
								discovered.add("tailwind-merge")
								if (!cnWritten) {
									await fs.writeFile(path.join(libOut, "_cn.ts"), CN_HELPER)
									cnWritten = true
								}
							}
							const outRel = path.join("internal", relative + ext)
							await fs.mkdir(path.dirname(path.join(libOut, outRel)), { recursive: true })
							await fs.writeFile(path.join(libOut, outRel), siblingSource)
							extraFiles.push(outRel)
							rewritten = rewritten.replaceAll(match[0], match[0].replace(spec, `./internal/${relative}`))
							resolved = true
							break
						} catch {}
					}
					if (!resolved) skip = `unresolvable internal import ${spec}`
					continue
				}
				if (spec.startsWith("@/")) {
					skip = `unresolvable internal import ${spec}`
					continue
				}
				if (spec.startsWith(".")) continue
				const pkg = packageNameOf(spec)
				if (!AMBIENT_MODULES.has(pkg)) discovered.add(pkg)
			}

			if (skip) {
				problems.push(`${library.id}/${component.id}: SKIPPED — ${skip}`)
				continue
			}

			// The catalog must declare every dep the source actually imports.
			for (const pkg of IMPLICIT_DEPS)
				if (discovered.has(pkg)) {
					deps.add(pkg)
				}
			const undeclared = [...discovered].filter((pkg) => !deps.has(pkg) && !IMPLICIT_DEPS.has(pkg))
			if (undeclared.length > 0) {
				problems.push(`${library.id}/${component.id}: undeclared deps ${undeclared.join(", ")} — add to catalog.ts`)
			}
			for (const pkg of discovered) deps.add(pkg)

			const outFile = `${component.id}.tsx`
			await fs.writeFile(path.join(libOut, outFile), rewritten)

			// css siblings (e.g. animata card-spread.css)
			const cssSibling = sourcePath.replace(/\.tsx$/, ".css")
			try {
				await fs.copyFile(cssSibling, path.join(libOut, `${component.id}.css`))
				extraFiles.push(`${component.id}.css`)
			} catch {}

			manifest.libraries[library.id].components[component.id] = {
				file: outFile,
				extraFiles,
				deps: [...deps].sort(),
			}
		}
	}

	await fs.writeFile(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2))

	console.log(`vendored into ${OUT_DIR}`)
	for (const [libId, lib] of Object.entries(manifest.libraries)) {
		console.log(`  ${libId}: ${Object.keys(lib.components).length} component(s)`)
	}
	if (problems.length > 0) {
		console.log("\nPROBLEMS:")
		for (const problem of problems) console.log(`  - ${problem}`)
		process.exit(2)
	}
}

void main()
