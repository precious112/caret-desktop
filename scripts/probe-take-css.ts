/**
 * Does a playground take's EDIT reach Tailwind's CSS?
 *
 * The dogfood report: after an exploration, every take renders with broken
 * styling — paddings and roundings missing. The suspect is the Tailwind
 * scan-freeze gotcha in a new costume: take pages are CREATED while the
 * shell runs (covered by caretTailwindFreshPlugin's add handler) and then
 * EDITED by the model minutes later with classes nothing else uses. This
 * boots the real shell, runs the real createExploration, edits the take the
 * way the model does (a plain file write), and asks global.css whether the
 * new classes exist. No model anywhere; costs nothing.
 *
 *   npx tsx scripts/probe-take-css.ts
 */
import * as child_process from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { RenderingShell } from "../src/core/design/rendering-shell"
import { ensureCaretDirectoryExists } from "../src/core/design/scaffold"
import { createExploration } from "../src/core/design/variants"

const META = (id: string) => JSON.stringify({ id, title: id, type: "page", states: ["default"], tags: [] })

const BOOT_PAGE = `export default function Page() {
	return <main className="p-8"><h1 className="text-3xl">today</h1></main>
}
`

// Classes the model plausibly writes and nothing in the boot set uses.
const NOVEL = ["p-14", "rounded-3xl", "tracking-widest"]
const EDITED_PAGE = `export default function Page() {
	return (
		<main className="p-14">
			<h1 className="rounded-3xl tracking-widest">a bolder reading</h1>
		</main>
	)
}
`

async function css(url: string): Promise<string> {
	// `?direct` is how Vite serves the TRANSFORMED stylesheet as CSS; the bare
	// path returns the HMR JS wrapper for an imported stylesheet.
	const base = url.replace(/\/$/, "")
	for (const candidate of [`${base}/global.css?direct`, `${base}/global.css`]) {
		const response = await fetch(candidate, { headers: { accept: "text/css" } })
		const body = await response.text()
		if (response.ok && body.includes("tailwind")) return body
		if (response.ok && body.includes(".p-8")) return body
	}
	const fallback = await fetch(`${base}/global.css?direct`)
	return await fallback.text()
}

function report(label: string, sheet: string): string[] {
	const missing = NOVEL.filter((cls) => !sheet.includes(`.${cls.replace(/[[\]]/g, "\\$&")}`))
	console.log(`${label}: ${missing.length === 0 ? "all novel classes present" : `MISSING ${missing.join(", ")}`}`)
	return missing
}

async function main(): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "caret-takecss-"))
	child_process.execSync("git init -q", { cwd: dir })
	await ensureCaretDirectoryExists(dir)
	const pageDir = path.join(dir, ".caret", "pages", "today")
	await fs.mkdir(pageDir, { recursive: true })
	await fs.writeFile(path.join(pageDir, "index.tsx"), BOOT_PAGE)
	await fs.writeFile(path.join(pageDir, "meta.json"), META("today"))

	const shell = new RenderingShell(dir)
	try {
		await shell.start()
		const url = shell.getUrl()
		if (!url) throw new Error("the shell reported no url")
		console.log(`shell at ${url}`)

		const boot = await css(url)
		if (!boot.includes(".p-8")) throw new Error("the boot page's own p-8 is not in global.css — the shell itself is broken")
		if (NOVEL.some((cls) => boot.includes(`.${cls}`))) throw new Error("a 'novel' class exists at boot — pick different ones")

		// The real thing, not a simulation of it: the exploration copies the page
		// into take dirs while Vite runs, exactly as the router does.
		const exploration = await createExploration(dir, { pageId: "today", instruction: "warmer" })
		const take = exploration.nodes[0].id
		console.log(`takes spawned: ${exploration.nodes.map((n) => n.id).join(", ")}`)
		await new Promise((r) => setTimeout(r, 3000))

		// The model's edit: a plain write to the take file, minutes after boot.
		await fs.writeFile(path.join(dir, ".caret", "pages", take, "index.tsx"), EDITED_PAGE)
		await new Promise((r) => setTimeout(r, 3000))

		const afterEdit = await css(url)
		const missing = report("after the model's edit", afterEdit)

		if (missing.length > 0) {
			// The historical tell: a change to a BOOT-TIME file sweeps late files up.
			await fs.writeFile(path.join(pageDir, "index.tsx"), BOOT_PAGE + "\n")
			await new Promise((r) => setTimeout(r, 3000))
			const afterKick = await css(url)
			const stillMissing = report("after touching a boot-time file", afterKick)
			if (stillMissing.length === 0) {
				console.log("REPRODUCED: the take's edit contributed no CSS until an unrelated boot-time file changed.")
				process.exitCode = 1
				return
			}
			console.log("MISSING EVEN AFTER THE KICK — the take file is not in the scan set at all.")

			// Experiment 1: does an EXPLICIT @source for the take dir override
			// whatever excluded it (the gitignore being the suspect)?
			const globalCssPath = path.join(dir, ".caret", "global.css")
			const original = await fs.readFile(globalCssPath, "utf-8")
			await fs.writeFile(
				globalCssPath,
				original.replace(
					'@source "./pages/**/*.{tsx,jsx}";',
					'@source "./pages/**/*.{tsx,jsx}";\n@source "./pages/today--v1/index.tsx";',
				),
			)
			await new Promise((r) => setTimeout(r, 3000))
			const afterExplicit = report("experiment 1 — explicit @source for the take file", await css(url))
			await fs.writeFile(globalCssPath, original)
			await new Promise((r) => setTimeout(r, 1500))

			// Experiment 2: drop the gitignore pattern, nudge the stylesheet.
			const gitignorePath = path.join(dir, ".caret", ".gitignore")
			const gitignore = await fs.readFile(gitignorePath, "utf-8")
			await fs.writeFile(gitignorePath, gitignore.replace(/^pages\/\*--v\*\/$/m, ""))
			await fs.writeFile(globalCssPath, original + "\n")
			await new Promise((r) => setTimeout(r, 3000))
			const afterUnignore = report("experiment 2 — gitignore pattern removed", await css(url))

			console.log(
				`verdict: explicit @source ${afterExplicit.length === 0 ? "FIXES it" : "does NOT fix it"}; ` +
					`un-gitignoring ${afterUnignore.length === 0 ? "FIXES it" : "does NOT fix it"}`,
			)
			process.exitCode = 1
			return
		}
		console.log("no reproduction: the take's edit reached global.css on its own.")
	} finally {
		shell.stop()
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
	}
}

void main()
