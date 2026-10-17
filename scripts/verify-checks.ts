/**
 * Caret's design checks, certified in the real app: they must judge a page as
 * it looks once its entrance animations have played, not halfway through.
 *
 * A field run reported five contrast errors on a landing page whose colours
 * all pass: every failing colour was the real one at about 46% strength, i.e.
 * text measured mid fade-in. The AI removed the page's motion to clear them.
 *
 * Two pages, asked about through Caret's connection exactly as the AI asks:
 * - "fade": real colours that fade in over 3 seconds, and text further down
 *   that only fades in when it is scrolled into view. Must have no contrast error.
 * - "faint": text that is genuinely too faint. Must still get one.
 *
 *   npm run test:checks        build, then the case
 */
import * as fs from "fs/promises"
import * as path from "path"

import {
	assert,
	buildProject,
	callMcpTool,
	freshProfile,
	launchApp,
	readDiscovery,
	reapOrphanedBackends,
	waitFor,
} from "./verify-kit"

const SHOTS = path.resolve("release/checks-shots")

const FADE_PAGE = `import { useEffect, useRef } from "react"

/** Fades in the way animation libraries do: the browser's own animations, on mount and on scrolling into view. */
export default function Fade() {
	const top = useRef<HTMLDivElement>(null)
	const below = useRef<HTMLDivElement>(null)
	useEffect(() => {
		for (const element of Array.from(top.current?.children ?? [])) {
			element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 3000, easing: "ease-out", fill: "both" })
		}
		const element = below.current
		if (!element) return
		const observer = new IntersectionObserver((entries) => {
			if (!entries.some((entry) => entry.isIntersecting)) return
			element.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 1000, easing: "ease-out", fill: "forwards" })
			observer.disconnect()
		})
		observer.observe(element)
		return () => observer.disconnect()
	}, [])
	return (
		<main className="min-h-[3200px] bg-[#1b1c1d] p-16">
			<div ref={top}>
				<h1 className="text-5xl text-[#fafafa]">Argus watches your servers</h1>
				<p className="mt-6 text-lg text-[#b5b8ba]">It investigates instead of just alerting.</p>
				<p className="mt-4 text-sm text-[#4ade80]">All systems healthy</p>
				<a className="mt-4 block text-base text-[#28a4f0]" href="#docs">Read the docs</a>
			</div>
			<div className="mt-[2400px] text-lg text-[#b5b8ba] opacity-20" ref={below}>
				Further down, revealed when scrolled into view.
			</div>
		</main>
	)
}
`

const FAINT_PAGE = `export default function Faint() {
	return (
		<main className="min-h-screen bg-[#1b1c1d] p-16">
			<p className="text-lg text-[#3a3c3d]">This text is genuinely too faint to read.</p>
		</main>
	)
}
`

async function writePage(project: string, id: string, source: string): Promise<void> {
	const dir = path.join(project, ".caret", "pages", id)
	await fs.mkdir(dir, { recursive: true })
	await fs.writeFile(path.join(dir, "index.tsx"), source)
	await fs.writeFile(
		path.join(dir, "meta.json"),
		`${JSON.stringify({ id, title: id, type: "page", states: ["default"], tags: [] }, null, 2)}\n`,
	)
}

interface Finding {
	check: string
	severity: string
	message: string
	pageId: string
}

/** The design checks' findings for one page, through Caret's connection. */
async function checksFor(project: string, pageId: string): Promise<Finding[]> {
	const discovery = await waitFor("Caret's connection details", () => readDiscovery(project), 60_000)
	const raw = await callMcpTool(discovery, "run_design_checks", { pageId })
	// The reply is one JSON-RPC message, sent as JSON or inside an SSE "data:" line.
	const line = raw.split("\n").find((l) => l.includes('"result"')) ?? raw
	const envelope = JSON.parse(line.replace(/^data: /, "")) as { result?: { content?: Array<{ text?: string }> } }
	const text = envelope.result?.content?.[0]?.text ?? ""
	// The tool's own JSON comes first; Caret appends the foundation summary after it.
	const body = JSON.parse(text.split("\n\n<caret_foundation>")[0]) as { findings?: Finding[] }
	return (body.findings ?? []) as Finding[]
}

async function main(): Promise<void> {
	reapOrphanedBackends()
	await fs.stat("out/main/index.js").catch(() => {
		throw new Error("No build: run `npm run test:checks`, which builds first.")
	})
	await fs.rm(SHOTS, { recursive: true, force: true })
	await fs.mkdir(SHOTS, { recursive: true })
	const project = await buildProject()
	await writePage(project, "fade", FADE_PAGE)
	await writePage(project, "faint", FAINT_PAGE)
	const launched = await launchApp({ project, userData: await freshProfile(), logFile: path.join(SHOTS, "main.log") })
	let ok = false
	try {
		// The checks render pages through the preview, which a fresh project
		// first has to install; asked earlier, they could not render anything.
		await waitFor(
			"the preview to be ready",
			async () =>
				(await fs.readFile(path.join(SHOTS, "main.log"), "utf8")).includes("[design] session ready") ? true : null,
			300_000,
		)
		const fade = await checksFor(project, "fade")
		console.log(
			`fade, every finding: ${JSON.stringify(fade.map((f) => `${f.check}/${f.severity}: ${f.message.slice(0, 300)}`))}`,
		)
		const fadeContrast = fade.filter((finding) => finding.check === "contrast")
		console.log(`fade: ${fadeContrast.length} contrast finding(s)`)
		for (const finding of fadeContrast) console.log(`  - ${finding.message.split("\n").slice(-1)[0].trim()}`)
		const faint = await checksFor(project, "faint")
		const faintContrast = faint.filter((finding) => finding.check === "contrast")
		console.log(`faint: ${faintContrast.length} contrast finding(s)`)
		assert(
			fadeContrast.length === 0,
			"the fade-in page's real colours were reported as failing contrast (measured mid-animation)",
		)
		assert(faintContrast.length > 0, "genuinely faint text was not reported")
		ok = true
		console.log("\nPASS: animations were measured finished; genuinely faint text still fails")
	} catch (err) {
		console.log(`\nFAIL: ${err instanceof Error ? err.message : err}`)
	} finally {
		await launched.close()
		reapOrphanedBackends()
	}
	process.exitCode = ok ? 0 : 1
}

main()
	.catch((err) => {
		console.error(err instanceof Error ? err.message : err)
		process.exitCode = 1
	})
	.finally(() => setTimeout(() => process.exit(), 500))
