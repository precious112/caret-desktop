/**
 * An error screen must clear itself the moment the fix lands.
 *
 * The failure shape from the field: a page error-cards (broken import, crash),
 * the agent fixes the file, and the card stays — the failed dynamic import is
 * cached for the document's lifetime and HMR propagation stops at the
 * self-accepting router, so nothing ever reaches the dead document again. The
 * only recovery was destroying the iframe by clicking the page.
 *
 * This boots the real shell, opens a broken page in a real browser document,
 * fixes the file on disk, and asserts the document recovers on its own — no
 * reload, no click, nothing driven from this side. Both halves are exercised:
 * a transform failure (missing import) and the fix arriving as a CREATED file
 * (the `add`-event case). No model anywhere; costs nothing.
 *
 *   npx tsx scripts/probe-error-recovery.ts
 */
import * as child_process from "child_process"
import * as fsSync from "fs"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { RenderingShell } from "../src/core/design/rendering-shell"
import { ensureCaretDirectoryExists } from "../src/core/design/scaffold"

/** Same fallback as verify-design-shell: any Chromium in the ms-playwright cache will do. */
async function launchBrowser() {
	const { chromium } = await import("playwright")
	try {
		return await chromium.launch({ headless: true })
	} catch {
		const cacheRoot = path.join(os.homedir(), "Library", "Caches", "ms-playwright")
		const candidates: string[] = []
		for (const dir of fsSync.existsSync(cacheRoot) ? fsSync.readdirSync(cacheRoot) : []) {
			if (dir.startsWith("chromium_headless_shell-")) {
				candidates.push(path.join(cacheRoot, dir, "chrome-mac", "headless_shell"))
				candidates.push(path.join(cacheRoot, dir, "chrome-headless-shell-mac-x64", "chrome-headless-shell"))
			}
			if (dir.startsWith("chromium-")) {
				candidates.push(path.join(cacheRoot, dir, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"))
			}
		}
		for (const executablePath of candidates.reverse()) {
			if (fsSync.existsSync(executablePath)) {
				console.log(`using fallback browser: ${executablePath}`)
				return await chromium.launch({ headless: true, executablePath })
			}
		}
		throw new Error("No Chromium available. Run: npx playwright install chromium")
	}
}

const META = (id: string) => JSON.stringify({ id, title: id, type: "page", states: ["default"], tags: [] })

async function page(dir: string, id: string, source: string): Promise<void> {
	const pageDir = path.join(dir, ".caret", "pages", id)
	await fs.mkdir(pageDir, { recursive: true })
	await fs.writeFile(path.join(pageDir, "index.tsx"), source)
	await fs.writeFile(path.join(pageDir, "meta.json"), META(id))
}

const BROKEN = `import { Missing } from "../../components/does-not-exist"
export default function Page() {
	return <main className="p-8"><Missing /></main>
}
`
const FIXED = `export default function Page() {
	return <main className="p-8"><h1>recovered</h1></main>
}
`
const IMPORTER = `import { Missing } from "../../components/late-arrival"
export default function Page() {
	return <main className="p-8"><Missing /></main>
}
`
const LATE_COMPONENT = `export function Missing() {
	return <h1>supplied late</h1>
}
`

async function main(): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "caret-errrecover-"))
	child_process.execSync("git init -q", { cwd: dir })
	await ensureCaretDirectoryExists(dir)
	await page(dir, "brokenfix", BROKEN)
	await page(dir, "lateimport", IMPORTER)

	const shell = new RenderingShell(dir)
	const browser = await launchBrowser()
	const failures: string[] = []
	try {
		await shell.start()
		const url = shell.getUrl()
		if (!url) throw new Error("the shell reported no url")
		console.log(`shell at ${url}`)

		const tab = await browser.newPage()

		// --- Case 1: a broken import, fixed by editing the page file. ---------
		await tab.goto(`${url}?page=brokenfix&isolated=1`)
		await tab.waitForSelector("[data-caret-page-error]", { timeout: 15_000 })
		const carried = await tab.getAttribute("[data-caret-page-error]", "data-caret-page-error")
		console.log(`error card up, carrying: ${carried?.slice(0, 100)}`)
		// The card must carry the CAUSE ("Failed to resolve import …"), not the
		// generic "failed to fetch module" the import() rejection reports — the
		// checks feed this text to the agent, and only the cause is actionable.
		if (!carried || !/resolve import/i.test(carried)) {
			failures.push("the error card does not carry the underlying resolve error for the checks to feed back")
		}

		// Fix the file on disk. From here on the document is on its own.
		await fs.writeFile(path.join(dir, ".caret", "pages", "brokenfix", "index.tsx"), FIXED)
		try {
			await tab.waitForSelector("h1:has-text('recovered')", { timeout: 15_000 })
			console.log("→ the error card cleared itself after the edit — no click, no reload")
		} catch {
			failures.push("the error card never cleared after the file was fixed (change event)")
		}

		// --- Case 2: the fix is a CREATED file the broken import pointed at. --
		await tab.goto(`${url}?page=lateimport&isolated=1`)
		await tab.waitForSelector("[data-caret-page-error]", { timeout: 15_000 })
		await fs.mkdir(path.join(dir, ".caret", "components"), { recursive: true })
		await fs.writeFile(path.join(dir, ".caret", "components", "late-arrival.tsx"), LATE_COMPONENT)
		try {
			await tab.waitForSelector("h1:has-text('supplied late')", { timeout: 15_000 })
			console.log("→ the error card cleared itself after the missing file was created (add event)")
		} catch {
			failures.push("the error card never cleared after the missing file was created (add event)")
		}

		if (failures.length === 0) {
			console.log("\n→ dead documents heal themselves. PASS")
			process.exitCode = 0
		} else {
			console.log(`\n→ STILL BROKEN:\n${failures.map((f) => `  - ${f}`).join("\n")}`)
			process.exitCode = 1
		}
	} finally {
		await browser.close().catch(() => {})
		await shell.stop()
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
