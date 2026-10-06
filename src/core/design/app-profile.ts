/**
 * Does this folder already hold an app, and where does its look live?
 *
 * Deterministic on purpose, and deliberately shallow. It answers one question
 * the entry screen needs before anything else is drawn: "is there app code
 * here?" — a fresh folder is asked what it is going to be, an existing app is
 * offered "use what my app already has". It does NOT extract tokens: that
 * takes judgement (which of forty hex values is the brand?) and is the
 * model's job in the from-app interview. The style sources listed here are
 * only a head start the model is handed, never the answer.
 *
 * Bounded, because it runs on every project open: a capped breadth-first walk
 * that never enters dependency, build or VCS directories, and never `.caret/`
 * — the design layer is not the app.
 */
import * as fs from "fs/promises"
import * as path from "path"

export interface AppProfile {
	/** Display name of the framework when package.json names one, else null. */
	framework: string | null
	/** Styling systems worth naming ("Tailwind"), detected, never assumed. */
	styling: string[]
	/** Repo-relative files that probably declare the look: configs, theme files, stylesheets with variables. */
	styleSources: string[]
}

/** Never walked: dependencies, build output, VCS, and Caret's own layer. */
const SKIP_DIRS = new Set([
	".caret",
	".git",
	".hg",
	".svn",
	"node_modules",
	"bower_components",
	"dist",
	"build",
	"out",
	".next",
	".nuxt",
	".svelte-kit",
	".astro",
	".output",
	".vercel",
	".turbo",
	".cache",
	"coverage",
	"vendor",
	"target",
	"__pycache__",
	".venv",
	"venv",
])

/** Files whose presence means a UI exists. Stylesheets alone do not make an app. */
const UI_EXTENSIONS = new Set([".tsx", ".jsx", ".vue", ".svelte", ".astro", ".html"])

const STYLESHEET_EXTENSIONS = new Set([".css", ".scss", ".sass", ".less"])

/** Most-specific first: Next before React, Nuxt before Vue, SvelteKit before Svelte. */
const FRAMEWORKS: ReadonlyArray<{ dependency: string; name: string }> = [
	{ dependency: "next", name: "Next.js" },
	{ dependency: "nuxt", name: "Nuxt" },
	{ dependency: "@remix-run/react", name: "Remix" },
	{ dependency: "@sveltejs/kit", name: "SvelteKit" },
	{ dependency: "astro", name: "Astro" },
	{ dependency: "@angular/core", name: "Angular" },
	{ dependency: "solid-js", name: "SolidJS" },
	{ dependency: "vue", name: "Vue" },
	{ dependency: "svelte", name: "Svelte" },
	{ dependency: "react-native", name: "React Native" },
	{ dependency: "react", name: "React" },
]

const STYLING: ReadonlyArray<{ dependency: string; name: string }> = [
	{ dependency: "tailwindcss", name: "Tailwind" },
	{ dependency: "styled-components", name: "styled-components" },
	{ dependency: "@emotion/react", name: "Emotion" },
	{ dependency: "@mui/material", name: "Material UI" },
	{ dependency: "@chakra-ui/react", name: "Chakra UI" },
	{ dependency: "@mantine/core", name: "Mantine" },
	{ dependency: "bootstrap", name: "Bootstrap" },
	{ dependency: "sass", name: "Sass" },
]

const TAILWIND_CONFIG = /^tailwind\.config\.(js|cjs|mjs|ts|cts|mts)$/
const THEME_FILE = /^(theme|tokens|design-tokens|colors)\.(ts|js|mjs|json)$/
/** A stylesheet only counts as a style source when it declares something. */
const DECLARES_LOOK = /:root\s*\{|@theme\b|--[a-z][\w-]*\s*:|@tailwind\b|@import\s+["']tailwindcss/

const MAX_ENTRIES = 4000
const MAX_DEPTH = 5
const MAX_STYLE_SOURCES = 8
const MAX_SNIFF_BYTES = 64 * 1024

/**
 * Returns null when there is no app code in the folder — a fresh project.
 * Never throws: an unreadable folder is reported as "no app", which only
 * costs the from-app door, never the project.
 */
export async function detectAppProfile(projectPath: string): Promise<AppProfile | null> {
	const deps = await readDependencies(projectPath)
	const framework = FRAMEWORKS.find((entry) => deps.has(entry.dependency))?.name ?? null
	const styling = STYLING.filter((entry) => deps.has(entry.dependency)).map((entry) => entry.name)

	const { uiFiles, tailwindConfigs, themeFiles, stylesheets } = await walk(projectPath)
	if (!framework && uiFiles === 0) return null

	const styleSources: string[] = [...tailwindConfigs, ...themeFiles]
	let importsTailwind = false
	for (const sheet of stylesheets) {
		if (styleSources.length >= MAX_STYLE_SOURCES) break
		const head = await sniff(path.join(projectPath, sheet))
		if (!DECLARES_LOOK.test(head)) continue
		styleSources.push(sheet)
		if (/@tailwind\b|@import\s+["']tailwindcss/.test(head)) importsTailwind = true
	}

	if (!styling.includes("Tailwind") && (tailwindConfigs.length > 0 || importsTailwind)) styling.unshift("Tailwind")

	return { framework, styling, styleSources: styleSources.slice(0, MAX_STYLE_SOURCES) }
}

async function readDependencies(projectPath: string): Promise<Set<string>> {
	try {
		const pkg = JSON.parse(await fs.readFile(path.join(projectPath, "package.json"), "utf-8")) as Record<string, unknown>
		const names = new Set<string>()
		for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
			const block = pkg[field]
			if (block && typeof block === "object") for (const name of Object.keys(block)) names.add(name)
		}
		return names
	} catch {
		return new Set()
	}
}

/** Breadth-first, so the root's configs are always seen before the entry cap bites. */
async function walk(projectPath: string): Promise<{
	uiFiles: number
	tailwindConfigs: string[]
	themeFiles: string[]
	stylesheets: string[]
}> {
	let uiFiles = 0
	const tailwindConfigs: string[] = []
	const themeFiles: string[] = []
	const stylesheets: string[] = []

	let seen = 0
	let frontier: Array<{ dir: string; depth: number }> = [{ dir: "", depth: 0 }]
	while (frontier.length > 0 && seen < MAX_ENTRIES) {
		const next: typeof frontier = []
		for (const { dir, depth } of frontier) {
			let entries: import("fs").Dirent[]
			try {
				entries = await fs.readdir(path.join(projectPath, dir), { withFileTypes: true })
			} catch {
				continue
			}
			for (const entry of entries) {
				if (++seen > MAX_ENTRIES) break
				const relative = dir ? `${dir}/${entry.name}` : entry.name
				if (entry.isDirectory()) {
					if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".") && depth < MAX_DEPTH) {
						next.push({ dir: relative, depth: depth + 1 })
					}
					continue
				}
				if (!entry.isFile()) continue
				const extension = path.extname(entry.name).toLowerCase()
				if (UI_EXTENSIONS.has(extension)) uiFiles++
				if (TAILWIND_CONFIG.test(entry.name)) tailwindConfigs.push(relative)
				else if (THEME_FILE.test(entry.name)) themeFiles.push(relative)
				else if (STYLESHEET_EXTENSIONS.has(extension)) stylesheets.push(relative)
			}
		}
		frontier = next
	}
	return { uiFiles, tailwindConfigs, themeFiles, stylesheets }
}

async function sniff(file: string): Promise<string> {
	try {
		const handle = await fs.open(file, "r")
		try {
			const buffer = Buffer.alloc(MAX_SNIFF_BYTES)
			const { bytesRead } = await handle.read(buffer, 0, MAX_SNIFF_BYTES, 0)
			return buffer.subarray(0, bytesRead).toString("utf-8")
		} finally {
			await handle.close()
		}
	} catch {
		return ""
	}
}
