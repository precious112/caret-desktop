/**
 * Code → design: bringing an existing app's screens into the design layer.
 *
 * The reverse of the ordinary sync, for the moment right after an existing
 * app's foundation is set: the app already HAS screens, and a design layer that
 * starts empty would have the user redraw what they built. Each screen is
 * translated by an agent into a design page, in the background, and its
 * mapping is recorded the moment it lands.
 *
 * **Recording the mapping is the load-bearing part, not bookkeeping.** An
 * imported page with no mapping looks, to the next design→app sync, like a
 * brand-new design waiting to be built — and the sync would write a second copy
 * of the screen into the app. Recorded with both hashes at import time, the
 * page reads clean: drift detection works from day one, and the forward sync
 * leaves it alone until someone changes it.
 *
 * Finding the screens is deterministic where the framework routes by file
 * (Next.js, SvelteKit, Nuxt, Astro, Remix, plain HTML) and a read-only model
 * survey otherwise — a React Router app declares its routes in code, and
 * reading code for meaning is the model's job, as in the from-app interview.
 */
import * as fs from "fs/promises"
import * as path from "path"

import type { CodingBackend, ReasoningEffort } from "../agent/backend"
import { listPages, readPageMeta, writePageMeta } from "../page-meta"
import { precomputeAndApply } from "../visual-editing/post-generation-hook"
import { readManifest, recordMappings } from "./mapping-manifest"

export interface ImportScreen {
	/** The design page id it becomes — unique against existing pages and the batch. */
	id: string
	title: string
	/** The URL it serves at, when the router says ("/orders/[id]"); null for a model-found screen with none. */
	route: string | null
	/** Repo-relative app files the screen is made of. The first is the screen's own file. */
	appPaths: string[]
}

export interface ImportSurvey {
	screens: ImportScreen[]
	/** App files that wrap every screen (root layout, _app, +layout) — imported once, first. */
	shell: string[]
	/** Screens already in the design layer (mapped or imported), left out of `screens`. */
	alreadyImported: number
	/** How the screens were found. `none`: no file-based router — a model survey is needed. */
	found: "routes" | "model" | "none"
}

/** Where the shared shell lands. One file, so pages import one stable path. */
export const SHELL_DESIGN_PATH = ".caret/layouts/AppShell.tsx"

const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	".caret",
	"dist",
	"build",
	"out",
	".next",
	".nuxt",
	".svelte-kit",
	".output",
	"coverage",
])
const MAX_SCREENS = 300

interface RouterSpec {
	/** Directories that hold routes, tried in order; all that exist are used. */
	roots: string[]
	/** Whether a file (by name, within the root) is a screen, and its route segments if so. */
	screen(relativeToRoot: string): string[] | null
	/** Files, relative to the root, that wrap every screen. */
	shell: string[]
}

const SCRIPT = /\.(tsx|jsx|ts|js)$/

/** Route segments for a directory path, dropping Next's organisational segments. */
function dirSegments(dir: string): string[] | null {
	const parts = dir.split("/").filter(Boolean)
	// Parallel-route slots and private folders are never screens of their own.
	if (parts.some((part) => part.startsWith("@") || part.startsWith("_"))) return null
	return parts.filter((part) => !(part.startsWith("(") && part.endsWith(")")))
}

const ROUTERS: RouterSpec[] = [
	{
		// Next.js app router.
		roots: ["app", "src/app"],
		screen: (file) => {
			const base = path.posix.basename(file)
			if (!/^page\.(tsx|jsx|ts|js|mdx)$/.test(base)) return null
			return dirSegments(path.posix.dirname(file) === "." ? "" : path.posix.dirname(file))
		},
		shell: ["layout.tsx", "layout.jsx", "layout.ts", "layout.js"],
	},
	{
		// Next.js pages router.
		roots: ["pages", "src/pages"],
		screen: (file) => {
			if (!SCRIPT.test(file) || file.startsWith("api/")) return null
			const parts = file.replace(SCRIPT, "").split("/")
			if (parts.some((part) => part.startsWith("_"))) return null
			if (parts[parts.length - 1] === "index") parts.pop()
			return parts
		},
		shell: ["_app.tsx", "_app.jsx", "_app.ts", "_app.js"],
	},
	{
		// SvelteKit.
		roots: ["src/routes"],
		screen: (file) =>
			path.posix.basename(file) === "+page.svelte"
				? dirSegments(path.posix.dirname(file) === "." ? "" : path.posix.dirname(file))
				: null,
		shell: ["+layout.svelte"],
	},
	{
		// Nuxt (3 and 4).
		roots: ["pages", "app/pages"],
		screen: (file) => {
			if (!file.endsWith(".vue")) return null
			const parts = file.replace(/\.vue$/, "").split("/")
			if (parts[parts.length - 1] === "index") parts.pop()
			return parts
		},
		shell: ["../layouts/default.vue", "../app.vue"],
	},
	{
		// Astro.
		roots: ["src/pages"],
		screen: (file) => {
			if (!file.endsWith(".astro")) return null
			const parts = file.replace(/\.astro$/, "").split("/")
			if (parts[parts.length - 1] === "index") parts.pop()
			return parts
		},
		shell: ["../layouts/Layout.astro", "../layouts/BaseLayout.astro"],
	},
	{
		// Remix flat routes.
		roots: ["app/routes"],
		screen: (file) => {
			if (file.includes("/") || !SCRIPT.test(file)) return null
			const name = file.replace(SCRIPT, "")
			if (name.startsWith("api.") || name.startsWith("resources.")) return null
			return name
				.split(".")
				.filter((part) => part !== "_index" && !part.startsWith("_"))
				.map((part) => (part.startsWith("$") ? `[${part.slice(1)}]` : part))
		},
		shell: ["../root.tsx", "../root.jsx"],
	},
]

async function exists(file: string): Promise<boolean> {
	return fs
		.stat(file)
		.then(() => true)
		.catch(() => false)
}

/** Every file under `dir`, repo-relative to `dir`, skipping dependency and build trees. */
async function filesUnder(dir: string, depth = 0): Promise<string[]> {
	if (depth > 8) return []
	let entries: import("fs").Dirent[]
	try {
		entries = await fs.readdir(dir, { withFileTypes: true })
	} catch {
		return []
	}
	const out: string[] = []
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue
			for (const nested of await filesUnder(path.join(dir, entry.name), depth + 1)) out.push(`${entry.name}/${nested}`)
		} else if (entry.isFile()) {
			out.push(entry.name)
		}
	}
	return out
}

/** "/" for the root; dynamic segments keep their brackets so the route reads as the app's own. */
export function routeOf(segments: string[]): string {
	return `/${segments.join("/")}`
}

/** "Orders / [id]" → "Order detail"-ish without guessing grammar: readable, never clever. */
export function titleOf(segments: string[]): string {
	if (segments.length === 0) return "Home"
	const words = segments.map((segment) =>
		segment
			.replace(/^\[+\.{0,3}|\]+$/g, "")
			.replace(/[-_]+/g, " ")
			.trim(),
	)
	const last = segments[segments.length - 1]
	const label = last.startsWith("[") && words.length > 1 ? `${words[words.length - 2]} detail` : words.join(" ")
	return label.charAt(0).toUpperCase() + label.slice(1)
}

/** Directory-safe page id from a route: "/settings/billing" → "settings-billing". */
export function pageIdOf(segments: string[]): string {
	const slug = segments
		.join("-")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
	return slug || "home"
}

/** Ids already used by design pages, or claimed earlier in this batch. */
function uniqueId(base: string, taken: Set<string>): string {
	let id = base
	for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
	taken.add(id)
	return id
}

/** App files the design layer already accounts for: recorded mappings and imported pages. */
async function accountedFor(projectPath: string): Promise<Set<string>> {
	const known = new Set<string>()
	for (const entry of (await readManifest(projectPath)).entries) for (const appPath of entry.appPaths) known.add(appPath)
	for (const page of await listPages(projectPath)) for (const appPath of page.importedFrom ?? []) known.add(appPath)
	return known
}

/**
 * The app's screens, found from its file-based router. Never throws; a folder
 * with no recognisable router reports `found: "none"`, and the caller decides
 * whether a model survey is worth running.
 */
export async function surveyAppScreens(projectPath: string): Promise<ImportSurvey> {
	const known = await accountedFor(projectPath)
	const taken = new Set((await listPages(projectPath)).map((page) => page.id))
	const screens: ImportScreen[] = []
	const shell: string[] = []
	const seenFiles = new Set<string>()
	let alreadyImported = 0

	for (const router of ROUTERS) {
		for (const root of router.roots) {
			const rootDir = path.join(projectPath, root)
			if (!(await exists(rootDir))) continue
			for (const candidate of router.shell) {
				const relative = path.posix.normalize(`${root}/${candidate}`)
				if (!shell.includes(relative) && (await exists(path.join(projectPath, relative)))) shell.push(relative)
			}
			for (const file of (await filesUnder(rootDir)).sort()) {
				const segments = router.screen(file)
				if (!segments) continue
				const appPath = `${root}/${file}`
				if (seenFiles.has(appPath)) continue
				seenFiles.add(appPath)
				if (known.has(appPath)) {
					alreadyImported++
					continue
				}
				if (screens.length >= MAX_SCREENS) continue
				screens.push({
					id: uniqueId(pageIdOf(segments), taken),
					title: titleOf(segments),
					route: routeOf(segments),
					appPaths: [appPath],
				})
			}
		}
	}

	if (screens.length === 0 && alreadyImported === 0) {
		const html = await staticHtmlScreens(projectPath, known, taken)
		if (html.screens.length || html.alreadyImported) {
			return { screens: byRoute(html.screens), shell: [], alreadyImported: html.alreadyImported, found: "routes" }
		}
	}

	return { screens: byRoute(screens), shell, alreadyImported, found: screens.length || alreadyImported ? "routes" : "none" }
}

/** The root route first, then by route — the order a person would walk them. */
function byRoute(screens: ImportScreen[]): ImportScreen[] {
	return screens.sort((a, b) => (a.route === "/" ? -1 : b.route === "/" ? 1 : (a.route ?? "").localeCompare(b.route ?? "")))
}

/** A plain multi-page site: each .html file is a screen — unless it is an SPA's mount shell. */
async function staticHtmlScreens(
	projectPath: string,
	known: Set<string>,
	taken: Set<string>,
): Promise<{ screens: ImportScreen[]; alreadyImported: number }> {
	const screens: ImportScreen[] = []
	let alreadyImported = 0
	for (const file of (await filesUnder(projectPath)).filter((f) => f.endsWith(".html")).sort()) {
		const head = await fs.readFile(path.join(projectPath, file), "utf-8").catch(() => "")
		// `<div id="root">` + a module script is a mount point, not a screen.
		if (/id=["'](root|app|__next)["']/.test(head) && /<script[^>]+type=["']module["']/.test(head)) continue
		if (known.has(file)) {
			alreadyImported++
			continue
		}
		const segments = file.replace(/\.html$/, "").split("/")
		if (segments[segments.length - 1] === "index") segments.pop()
		screens.push({
			id: uniqueId(pageIdOf(segments), taken),
			title: titleOf(segments),
			route: routeOf(segments),
			appPaths: [file],
		})
	}
	return { screens, alreadyImported }
}

const MODEL_SURVEY_SCHEMA = {
	type: "object",
	properties: {
		screens: {
			type: "array",
			items: {
				type: "object",
				properties: {
					title: { type: "string" },
					route: { type: "string" },
					files: { type: "array", items: { type: "string" } },
				},
				required: ["title", "files"],
			},
		},
		shell: { type: "array", items: { type: "string" } },
	},
	required: ["screens"],
} as const

/**
 * For apps that route in code. One read-only turn: the model finds the screens
 * and names their files; every file it names is checked to exist and to be the
 * app's own (never a dependency, never `.caret/`) before it is believed.
 */
export async function surveyScreensWithModel(input: {
	projectPath: string
	backend: CodingBackend
	model?: string
	effort?: ReasoningEffort
}): Promise<ImportSurvey> {
	const known = await accountedFor(input.projectPath)
	const taken = new Set((await listPages(input.projectPath)).map((page) => page.id))
	const result = await input.backend.structured<{
		screens?: Array<{ title?: string; route?: string; files?: string[] }>
		shell?: string[]
	}>({
		workingDirectory: input.projectPath,
		model: input.model,
		effort: input.effort,
		schema: MODEL_SURVEY_SCHEMA as unknown as Record<string, unknown>,
		systemPrompt: `You are listing the screens of an existing app so each can be redrawn as a design page.
Read the app with your tools (read, glob, grep, list); the working directory is the project.
Find where it declares its routes or views (a router config, a navigation stack, top-level
view components) and list every distinct SCREEN a user can reach — not every component.
For each: a short human title, its route if it has one, and the repo-relative files that
make up that screen (its own file first, then the components only it uses). Separately, list
the files that wrap every screen (app shell, navigation, header/footer) as \`shell\`.
Never list anything under node_modules, build output, or .caret/.`,
		prompt: "List this app's screens and its shell.",
	})

	const real = async (file: string): Promise<string | null> => {
		const relative = path.posix.normalize(file.replace(/^\.\//, ""))
		if (relative.startsWith("..") || path.isAbsolute(relative)) return null
		if (relative.split("/").some((part) => SKIP_DIRS.has(part))) return null
		return (await exists(path.join(input.projectPath, relative))) ? relative : null
	}

	const screens: ImportScreen[] = []
	let alreadyImported = 0
	for (const raw of result.value?.screens ?? []) {
		const files = (await Promise.all((raw.files ?? []).map(real))).filter((file): file is string => Boolean(file))
		if (files.length === 0 || !raw.title?.trim()) continue
		if (known.has(files[0])) {
			alreadyImported++
			continue
		}
		const route = raw.route?.trim() ? `/${raw.route.trim().replace(/^\/+/, "")}` : null
		const segments = route ? route.split("/").filter(Boolean) : [raw.title.trim()]
		screens.push({
			id: uniqueId(pageIdOf(segments), taken),
			title: raw.title.trim(),
			route,
			appPaths: [...new Set(files)],
		})
		if (screens.length >= MAX_SCREENS) break
	}
	const shell = (await Promise.all((result.value?.shell ?? []).map(real))).filter((file): file is string => Boolean(file))
	return { screens, shell: [...new Set(shell)], alreadyImported, found: "model" }
}

/* ── Prompts ──────────────────────────────────────────────────────────────── */

const FIDELITY = `- Reflect what the app SHOWS, faithfully — content, layout, hierarchy. The point is truth, not
  improvement: never redesign, modernise or "fix" it.
- Style from the foundation tokens in your instructions; where the app's value matches a token,
  use the token. Everything else follows the design layer's authoring rules.
- Data the app fetches, reads from a store or receives as props becomes realistic SAMPLE data
  inside the page — the design layer has no backend. A dynamic route shows one concrete example.
- Leave out mechanics with no visible result: data loading, auth checks, analytics, providers.
- Write ONLY the design files named below. Never edit the app's files (you may read them), and
  never touch other design pages.`

export function shellImportPrompt(shell: string[]): string {
	return `You are bringing an existing app into Caret's design layer, starting with the part every
screen shares.

The app's shell — the files that wrap every screen:
${shell.map((file) => `- ${file}`).join("\n")}

Read them (and the navigation/header/footer components they render) and write
\`${SHELL_DESIGN_PATH}\`: a default-exported \`AppShell\` component taking \`{ children }\`, that
draws the shared chrome around \`children\` exactly as the app does — navigation, header,
footer, sidebars. Omit providers, fonts loading and other wrappers that draw nothing.

${FIDELITY}`
}

export function screenImportPrompt(screen: ImportScreen, shellReady: boolean): string {
	const dir = `.caret/pages/${screen.id}`
	return `You are bringing one screen of an existing app into Caret's design layer.

The screen: "${screen.title}"${screen.route ? ` (served at ${screen.route})` : ""}.
Its app files — start with these, and follow their imports into the app's own components:
${screen.appPaths.map((file) => `- ${file}`).join("\n")}

Write:
- \`${dir}/index.tsx\` — the screen as a design page, default-exported.
- \`${dir}/meta.json\` — {"id": "${screen.id}", "title": ${JSON.stringify(screen.title)}, "type": "page",
  "states": [...], "tags": [...], "importedFrom": ${JSON.stringify(screen.appPaths)}}

${
	shellReady
		? `The app's shared chrome already exists as \`${SHELL_DESIGN_PATH}\`. Wrap the page in it
(\`import AppShell from "../../layouts/AppShell"\`) and draw only what is specific to this screen —
never a second copy of the navigation or header.`
		: "Draw the whole screen, including whatever navigation the app shows around it."
}

${FIDELITY}`
}

/* ── The run ──────────────────────────────────────────────────────────────── */

export type ImportItemStatus = "queued" | "working" | "done" | "failed" | "cancelled"

export interface ImportProgress {
	state: "idle" | "running" | "finished"
	shell: { appPaths: string[]; status: ImportItemStatus; error?: string } | null
	screens: Array<ImportScreen & { status: ImportItemStatus; error?: string }>
}

/** One background agent turn, as the import needs it — the lane's `run`, injected. */
export type RunImportTask = (id: string, prompt: string, displayPrompt: string, files: string[]) => Promise<void>

export class ImportCancelledError extends Error {
	constructor() {
		super("Cancelled.")
		this.name = "ImportCancelledError"
	}
}

/**
 * Runs an import: the shell first (pages depend on it), then every screen at
 * whatever concurrency the injected runner allows. Never throws for a single
 * screen's failure — the screen is marked and the rest carry on, because a
 * twelve-screen import that dies on screen three is worse than eleven pages.
 */
export async function runAppImport(input: {
	projectPath: string
	screens: ImportScreen[]
	shell: string[]
	run: RunImportTask
	onProgress(progress: ImportProgress): void
	/** The workspace HEAD for the mapping record; null with no repo. */
	head: string | null
	/**
	 * Brings a written design file to its settled form BEFORE it is hashed. The
	 * healer adds caret-ids to every new page a moment after it lands; hashed
	 * first, the page would read as a design change on the very next sync — and
	 * the forward sync would rewrite the app file it was just imported from.
	 * Idempotent, so the healer's own pass afterwards writes nothing.
	 */
	heal?: (absolutePath: string) => Promise<void>
}): Promise<ImportProgress> {
	const heal =
		input.heal ??
		(async (file: string) => {
			await precomputeAndApply(file)
		})
	// recordMappings is read-modify-write on one manifest; screens finishing
	// together would overwrite each other's entries and land unmapped — the
	// exact state that makes the next sync write a duplicate into the app. Its
	// writer already holds the file lock, which is not reentrant, so the
	// recording is serialized here instead.
	let recording: Promise<unknown> = Promise.resolve()
	const record = (designPath: string, appPaths: string[]) => {
		const next = recording.then(() => recordMappings(input.projectPath, [{ designPath, appPaths }], input.head))
		recording = next.catch(() => {})
		return next
	}
	const settle = async (designPath: string) => {
		await heal(path.join(input.projectPath, designPath)).catch(() => {
			// An unparseable file stays as written; its hash is still the truth.
		})
	}
	const progress: ImportProgress = {
		state: "running",
		shell: input.shell.length ? { appPaths: input.shell, status: "queued" } : null,
		screens: input.screens.map((screen) => ({ ...screen, status: "queued" as const })),
	}
	const emit = () => input.onProgress(structuredClone(progress))
	emit()

	let shellReady = await exists(path.join(input.projectPath, SHELL_DESIGN_PATH))
	if (progress.shell && !shellReady) {
		progress.shell.status = "working"
		emit()
		try {
			await input.run("app-shell", shellImportPrompt(input.shell), "Import the app's shared layout", [SHELL_DESIGN_PATH])
			if (!(await exists(path.join(input.projectPath, SHELL_DESIGN_PATH)))) {
				throw new Error(`the agent finished without writing ${SHELL_DESIGN_PATH}`)
			}
			await settle(SHELL_DESIGN_PATH)
			await record(SHELL_DESIGN_PATH, input.shell)
			progress.shell.status = "done"
			shellReady = true
		} catch (err) {
			progress.shell.status = err instanceof ImportCancelledError ? "cancelled" : "failed"
			progress.shell.error = err instanceof Error ? err.message : String(err)
		}
		emit()
	} else if (progress.shell) {
		progress.shell.status = "done"
	}

	await Promise.all(
		progress.screens.map(async (screen) => {
			if (progress.shell?.status === "cancelled") {
				screen.status = "cancelled"
				return
			}
			screen.status = "working"
			emit()
			try {
				const designPath = `.caret/pages/${screen.id}/index.tsx`
				await input.run(screen.id, screenImportPrompt(screen, shellReady), `Import "${screen.title}" from the app`, [
					designPath,
				])
				if (!(await exists(path.join(input.projectPath, designPath)))) {
					throw new Error("the agent finished without writing the page")
				}
				await finishPageMeta(input.projectPath, screen)
				await settle(designPath)
				await record(designPath, screen.appPaths)
				screen.status = "done"
			} catch (err) {
				screen.status = err instanceof ImportCancelledError ? "cancelled" : "failed"
				screen.error = err instanceof Error ? err.message : String(err)
			}
			emit()
		}),
	)

	progress.state = "finished"
	emit()
	return progress
}

/** The agent's meta.json, made true: provenance and title are Caret's to guarantee. */
async function finishPageMeta(projectPath: string, screen: ImportScreen): Promise<void> {
	const current = await readPageMeta(projectPath, screen.id)
	await writePageMeta(projectPath, screen.id, {
		id: screen.id,
		title: current?.title && current.title !== screen.id ? current.title : screen.title,
		type: current?.type ?? "page",
		states: current?.states.length ? current.states : ["default"],
		tags: current?.tags.length ? current.tags : ["imported"],
		importedFrom: screen.appPaths,
	})
}
