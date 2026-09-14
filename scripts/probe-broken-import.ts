/**
 * One broken page must not take the canvas down.
 *
 * The reproduction from a real certification run: bs's budget correctly
 * refused a second catalog component, which left `catalogdemo` importing a
 * file that does not exist — and with the router's old static imports, that
 * one unresolvable import 500'd the router module and every page on the
 * canvas died with it (ce, bq and by all starved downstream). This boots the
 * real shell, plants exactly that page, and asserts the blast radius is one
 * page. No model anywhere; costs nothing.
 *
 *   npx tsx scripts/probe-broken-import.ts
 */
import * as child_process from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { RenderingShell } from "../src/core/design/rendering-shell"
import { ensureCaretDirectoryExists } from "../src/core/design/scaffold"

const PAGE = (body: string) => `export default function Page() {\n\treturn <main className="p-8">${body}</main>\n}\n`
const META = (id: string) => JSON.stringify({ id, title: id, type: "page", states: ["default"], tags: [] })

async function page(dir: string, id: string, source: string): Promise<void> {
	const pageDir = path.join(dir, ".caret", "pages", id)
	await fs.mkdir(pageDir, { recursive: true })
	await fs.writeFile(path.join(pageDir, "index.tsx"), source)
	await fs.writeFile(path.join(pageDir, "meta.json"), META(id))
}

async function main(): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "caret-brokenimp-"))
	child_process.execSync("git init -q", { cwd: dir })
	await ensureCaretDirectoryExists(dir)
	await page(dir, "healthy", PAGE("<h1>healthy</h1>"))

	const shell = new RenderingShell(dir)
	try {
		await shell.start()
		const url = shell.getUrl()
		if (!url) throw new Error("the shell reported no url")
		console.log(`shell at ${url}`)

		// The exact failure shape from the run: an import of a component the
		// budget refused to supply, landing while the server is already up.
		await page(
			dir,
			"brokendemo",
			`import { PixelTrail } from "../../components/catalog/fancy/pixel-trail"\n${PAGE("<PixelTrail />")}`,
		)
		await new Promise((resolve) => setTimeout(resolve, 3000))

		// 1. The router module itself must stay transformable — this is the
		// request that 500'd before, taking the canvas top document with it.
		const router = await fetch(`${url}@id/__x00__virtual:caret-router`)
		console.log(`router module: ${router.status} ${router.ok ? "(evaluable)" : "(BROKEN — the old failure)"}`)
		const routerBody = await router.text()
		const lazy = routerBody.includes("loader:") && !routerBody.includes("import Page")
		console.log(`router carries loaders, no static page imports: ${lazy}`)

		// 2. The healthy page still transforms and still lists in the router.
		const healthy = await fetch(`${url}pages/healthy/index.tsx`)
		console.log(`healthy page module: ${healthy.status}`)
		const listsBoth = routerBody.includes('"healthy"') && routerBody.includes('"brokendemo"')
		console.log(`router lists both pages: ${listsBoth}`)

		// 3. The broken page's own module still errors — the fault is real and
		// must stay visible where it belongs, not be papered over.
		const brokenPage = await fetch(`${url}pages/brokendemo/index.tsx`)
		console.log(`broken page module: ${brokenPage.status} (its own 500 is correct — the error card renders from it)`)

		const survived = router.ok && lazy && healthy.ok && listsBoth && !brokenPage.ok
		console.log(survived ? "\n→ blast radius is ONE page. The canvas survives." : "\n→ STILL BROKEN")
		process.exitCode = survived ? 0 : 1
	} finally {
		await shell.stop()
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
