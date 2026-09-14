/**
 * Whether the shell knows it is missing a dependency.
 *
 * This decision shipped wrong twice over, and both failures were invisible
 * until a user clicked something:
 *
 * - It checked for `node_modules` *before* merging `REQUIRED_DEPS` into
 *   package.json, so a project's first launch installed only what the scaffold
 *   wrote. The canvas rendered perfectly and the focused editor died on an
 *   unresolved import, for that whole session, then "fixed itself" on the next
 *   launch.
 * - It trusted package.json to mean the package was on disk. An interrupted
 *   install leaves the manifest complete and the tree missing, which reads as
 *   "already installed" forever.
 *
 * `needsInstall` is private, so these drive it through `start()`'s own contract
 * the way the shell does — by observing what it writes and what it concludes.
 */
import { strict as assert } from "assert"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { RenderingShell } from ".."

/** Reaches the private method deliberately: the alternative is booting Vite. */
function decide(shell: RenderingShell, caretDir: string): Promise<boolean> {
	return (shell as unknown as { needsInstall(dir: string): Promise<boolean> }).needsInstall(caretDir)
}

async function project(pkg: unknown, options: { nodeModules?: string[] } = {}): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "caret-needsinstall-"))
	const caretDir = path.join(root, ".caret")
	await fs.mkdir(caretDir, { recursive: true })
	await fs.writeFile(path.join(caretDir, "package.json"), JSON.stringify(pkg, null, 2))
	if (options.nodeModules) {
		for (const dep of options.nodeModules) {
			await fs.mkdir(path.join(caretDir, "node_modules", dep), { recursive: true })
		}
		// A real install carries vite's entry file, which needsInstall checks
		// directly — a package directory alone is not a working install.
		const viteBin = path.join(caretDir, "node_modules", "vite", "bin")
		await fs.mkdir(viteBin, { recursive: true })
		await fs.writeFile(path.join(viteBin, "vite.js"), "")
	}
	return caretDir
}

async function manifest(caretDir: string): Promise<{ dependencies?: Record<string, string> }> {
	return JSON.parse(await fs.readFile(path.join(caretDir, "package.json"), "utf-8"))
}

const SCAFFOLDED = {
	name: "caret-design-layer",
	dependencies: { react: "^19.0.0", "react-dom": "^19.0.0", "react-grab": "^0.1.37" },
	devDependencies: { tailwindcss: "^4.1.0", "@tailwindcss/vite": "^4.1.0" },
}

describe("RenderingShell.needsInstall", () => {
	it("adds the missing required deps on a first launch, before installing", async () => {
		// The exact shape of a brand-new project: scaffolded manifest, no tree.
		const caretDir = await project(SCAFFOLDED)
		const shell = new RenderingShell(path.dirname(caretDir))

		assert.equal(await decide(shell, caretDir), true)
		const pkg = await manifest(caretDir)
		assert.ok(
			pkg.dependencies?.["modern-screenshot"],
			"the first install would not have included modern-screenshot, breaking the focused editor all session",
		)
		await fs.rm(path.dirname(caretDir), { recursive: true, force: true })
	})

	it("reinstalls when a dep is listed but its directory is absent", async () => {
		const caretDir = await project(
			{ ...SCAFFOLDED, dependencies: { ...SCAFFOLDED.dependencies, "modern-screenshot": "^4.6.0" } },
			{ nodeModules: ["react", "react-dom", "react-grab", "tailwindcss", "@tailwindcss/vite"] },
		)
		const shell = new RenderingShell(path.dirname(caretDir))

		assert.equal(await decide(shell, caretDir), true, "a listed-but-missing package was treated as installed")
		await fs.rm(path.dirname(caretDir), { recursive: true, force: true })
	})

	it("is satisfied when everything required is really on disk", async () => {
		const caretDir = await project(
			{ ...SCAFFOLDED, dependencies: { ...SCAFFOLDED.dependencies, "modern-screenshot": "^4.6.0" } },
			{ nodeModules: ["react", "react-dom", "react-grab", "tailwindcss", "@tailwindcss/vite", "modern-screenshot"] },
		)
		const shell = new RenderingShell(path.dirname(caretDir))

		assert.equal(await decide(shell, caretDir), false)
		await fs.rm(path.dirname(caretDir), { recursive: true, force: true })
	})

	it("does not rewrite the manifest for a dep the scaffold put in devDependencies", async () => {
		// Duplicating tailwind into `dependencies` would dirty package.json on
		// every launch and trigger an install each time.
		const caretDir = await project(
			{ ...SCAFFOLDED, dependencies: { ...SCAFFOLDED.dependencies, "modern-screenshot": "^4.6.0" } },
			{ nodeModules: ["react", "react-dom", "react-grab", "tailwindcss", "@tailwindcss/vite", "modern-screenshot"] },
		)
		const shell = new RenderingShell(path.dirname(caretDir))

		await decide(shell, caretDir)
		const pkg = await manifest(caretDir)
		assert.equal(pkg.dependencies?.tailwindcss, undefined, "tailwind was duplicated out of devDependencies")
		await fs.rm(path.dirname(caretDir), { recursive: true, force: true })
	})
})
