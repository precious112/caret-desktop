/**
 * The entry screen's first fork — "is there an app here?" — must be right in
 * both directions: a fresh folder offered "use what my app already has" sends
 * the model reading nothing, and an existing app asked "what are you building?"
 * is the chore the onboarding redesign exists to remove.
 */
import { strict as assert } from "assert"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { detectAppProfile } from "../app-profile"

async function project(files: Record<string, string>): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "caret-appprofile-"))
	for (const [relative, content] of Object.entries(files)) {
		const full = path.join(root, relative)
		await fs.mkdir(path.dirname(full), { recursive: true })
		await fs.writeFile(full, content)
	}
	return root
}

describe("detectAppProfile", () => {
	it("reports no app for an empty folder", async () => {
		const root = await project({})
		assert.equal(await detectAppProfile(root), null)
		await fs.rm(root, { recursive: true, force: true })
	})

	it("does not count Caret's own design layer as an app", async () => {
		const root = await project({
			".caret/pages/home/index.tsx": "export default function Home() { return null }",
			".caret/package.json": JSON.stringify({ dependencies: { react: "19", vite: "6" } }),
		})
		assert.equal(await detectAppProfile(root), null, "a design-only folder was offered the from-app door")
		await fs.rm(root, { recursive: true, force: true })
	})

	it("does not count dependencies as the app", async () => {
		const root = await project({ "node_modules/some-lib/index.jsx": "export {}", "README.md": "# hi" })
		assert.equal(await detectAppProfile(root), null)
		await fs.rm(root, { recursive: true, force: true })
	})

	it("names the most specific framework and the styling it can see", async () => {
		const root = await project({
			"package.json": JSON.stringify({
				dependencies: { next: "15", react: "19", "react-dom": "19" },
				devDependencies: { tailwindcss: "4" },
			}),
			"app/page.tsx": "export default function Page() { return null }",
			"app/globals.css": '@import "tailwindcss";\n:root { --brand: #4f46e5; }',
			"app/layout.tsx": "export default function Layout() { return null }",
		})
		const profile = await detectAppProfile(root)
		assert.equal(profile?.framework, "Next.js", "React was named over the more specific Next.js")
		assert.deepEqual(profile?.styling, ["Tailwind"])
		assert.deepEqual(profile?.styleSources, ["app/globals.css"])
		await fs.rm(root, { recursive: true, force: true })
	})

	it("finds plain-CSS apps with no package.json at all", async () => {
		const root = await project({
			"index.html": "<!doctype html><title>x</title>",
			"styles/main.css": "body { color: #111; }",
			"styles/tokens.css": ":root {\n  --ink: #111;\n}",
		})
		const profile = await detectAppProfile(root)
		assert.ok(profile, "a static site was treated as an empty folder")
		assert.equal(profile.framework, null, "a framework was invented")
		assert.deepEqual(profile.styling, [], "a styling system was assumed")
		assert.deepEqual(profile.styleSources, ["styles/tokens.css"], "a stylesheet declaring nothing was listed")
		await fs.rm(root, { recursive: true, force: true })
	})

	it("lists Tailwind configs and theme files ahead of stylesheets, and detects Tailwind from its config", async () => {
		const root = await project({
			"src/App.tsx": "export default function App() { return null }",
			"tailwind.config.ts": "export default { theme: {} }",
			"src/theme.ts": "export const theme = {}",
			"src/index.css": "@tailwind base;",
		})
		const profile = await detectAppProfile(root)
		assert.deepEqual(profile?.styleSources, ["tailwind.config.ts", "src/theme.ts", "src/index.css"])
		assert.deepEqual(profile?.styling, ["Tailwind"])
		await fs.rm(root, { recursive: true, force: true })
	})
})
