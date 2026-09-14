/**
 * The playground's exploration tree: N takes per round, rendered live, chosen
 * by pointing — and any chosen direction can be pushed another round deeper.
 *
 * For anything that cannot be said precisely in words ("make it feel more
 * premium"), one attempt is a coin flip. Instead Caret copies the branch point
 * N times, runs one independent unattended edit per copy — each pushed toward
 * a different reading of the same instruction — and the user picks the one
 * that looks right. Pointing needs no design vocabulary, which is exactly
 * right for the developer this product is for. An exploration can start from
 * an existing page (settling replaces it) or from nothing but a name
 * (settling adds a new page to the canvas).
 *
 * Takes are REAL pages (`.caret/pages/<rootId>--v<n>/…`): the canvas renders
 * them in live iframes with zero new machinery, the healer stamps their
 * caret-ids, and the winner is applied by copying its source over the root.
 * They are transient — gitignored via the `pages/*--v<n>` pattern so an
 * in-flight exploration never enters a sync worklist — and the tree's state
 * lives in `.caret/.variants.json` (scratch, gitignored, healer-ignored).
 *
 * Deletion safety: everything here is `fs.rm` on paths that MUST resolve
 * strictly inside `.caret/pages/` — {@link safeNodeDir} refuses any id that
 * is not a single plain path segment, so a corrupted scratch file or a
 * malicious external id can never point a removal outside the project.
 */
import * as fs from "fs/promises"
import * as path from "path"

import { runExclusive, writeFileAtomic } from "./file-mutation-queue"

export type ExploreNodeStatus = "working" | "ready" | "failed" | "cancelled"

export interface ExploreNode {
	/** The take's page id (`home--v4`) — also its directory and route. Flat at any depth; the tree lives in `parentId`. */
	id: string
	/** Another node's id, or the exploration's root pageId for round 1. */
	parentId: string
	/** The instruction THIS node's round ran under. */
	instruction: string
	/** The full divergence hint fed to the take's prompt. */
	angle: string
	/** What the card shows for the angle: "Restrained", "Bolder", "Structural", "App's version", "External". */
	angleLabel: string
	/** "Take 1", "Take 2" … what the playground labels the card. */
	label: string
	status: ExploreNodeStatus
	error?: string
	/** When this take's generation started — the card's elapsed ticker reads it. */
	startedAt: string
}

export interface Exploration {
	version: 2
	/** "page": takes on an existing page, settling replaces it. "new": a page that doesn't exist yet, settling adds it. */
	mode: "page" | "new"
	/** The root page id — an existing page, or the new page's would-be id. */
	pageId: string
	/** For `mode:"new"`: the page name the user gave, verbatim. */
	title?: string
	/** The round-1 instruction, for the playground header. */
	instruction: string
	startedAt: string
	/** Who produced the takes — Caret's own runner, or an external agent via MCP. */
	source: "caret" | "external"
	/** What settling means. "explore": takes on an instruction (the default).
	 * "drift-proposal": the take is the app's current truth translated back to
	 * design — accepting refreshes the sync mapping (Phase 9 reverse sync). */
	kind?: "explore" | "drift-proposal"
	/** For drift proposals: the app files whose truth the take reflects. */
	proposalAppPaths?: string[]
	/** Monotonic counter for `--v<n>` naming — never reused within one exploration. */
	nextTake: number
	nodes: ExploreNode[]
}

export const VARIANT_SCRATCH_FILE = ".variants.json"

/** How many takes a round produces. Three is enough spread to pick from and few enough to compare at a glance. */
export const VARIANT_COUNT = 3

/**
 * Each take reads the same instruction through a different lens. The hints are
 * about *approach*, never about style specifics — the foundation and rules
 * decide style; the lens only stops three runs collapsing into one answer.
 */
export const VARIANT_ANGLES = [
	"Take the most restrained, conventional reading of the instruction — the safe interpretation done cleanly.",
	"Take a bolder reading — push the visual direction noticeably further than the cautious version would.",
	"Take a structural reading — reorganize or re-compose rather than restyle, if the instruction allows it.",
]

/** What the cards show for each of {@link VARIANT_ANGLES}, index for index. */
export const ANGLE_LABELS = ["Restrained", "Bolder", "Structural"]

/** The canned instruction a one-click "Push further" round runs under. */
export const PUSH_FURTHER_INSTRUCTION = "Push this direction noticeably further."

function scratchPath(workspacePath: string): string {
	return path.join(workspacePath, ".caret", VARIANT_SCRATCH_FILE)
}

function pagesDir(workspacePath: string): string {
	return path.join(workspacePath, ".caret", "pages")
}

export function variantPageId(pageId: string, n: number): string {
	return `${pageId}--v${n}`
}

/**
 * The only way this module turns an id into a directory. Ids come from the
 * scratch file, from Caret's own counter, or from an external agent over MCP —
 * the last two make this a trust boundary: the id must be one plain path
 * segment and the resolved directory must sit strictly inside `.caret/pages/`,
 * or nothing is touched.
 */
function safeNodeDir(workspacePath: string, id: string): string {
	const root = path.resolve(pagesDir(workspacePath))
	if (!id || id === "." || id === ".." || path.basename(id) !== id) {
		throw new Error(`"${id}" is not a valid page id.`)
	}
	const dir = path.resolve(root, id)
	if (dir === root || !dir.startsWith(root + path.sep)) {
		throw new Error(`"${id}" is not a valid page id.`)
	}
	return dir
}

export async function readExploration(workspacePath: string): Promise<Exploration | null> {
	try {
		const raw = JSON.parse(await fs.readFile(scratchPath(workspacePath), "utf-8"))
		if (raw?.version !== 2 || typeof raw.pageId !== "string" || !Array.isArray(raw.nodes)) return null
		return raw as Exploration
	} catch {
		return null
	}
}

async function writeExploration(workspacePath: string, exploration: Exploration): Promise<void> {
	const target = scratchPath(workspacePath)
	await runExclusive(target, () => writeFileAtomic(target, JSON.stringify(exploration, null, 2)))
}

async function copyDir(from: string, to: string): Promise<void> {
	await fs.rm(to, { recursive: true, force: true })
	await fs.cp(from, to, { recursive: true })
}

/** What a `mode:"new"` exploration's takes start from before the model has touched them. */
function stubPageSource(title: string): string {
	return [
		`export default function Page() {`,
		`\treturn (`,
		`\t\t<main className="min-h-screen flex items-center justify-center">`,
		`\t\t\t<p className="text-sm opacity-50">${title.replace(/[<>{}]/g, "")} — generating…</p>`,
		`\t\t</main>`,
		`\t)`,
		`}`,
		``,
	].join("\n")
}

export interface CreateExplorationOptions {
	/** Defaults to "page". */
	mode?: "page" | "new"
	/** `mode:"page"`: the existing page to explore. */
	pageId?: string
	/** `mode:"new"`: the new page's name ("Pricing"); its id is the slug. */
	name?: string
	instruction: string
	count?: number
	kind?: "explore" | "drift-proposal"
	proposalAppPaths?: string[]
	/** Single-take label override — the drift proposal's "App's version". */
	label?: string
}

/**
 * Opens an exploration and spawns its first round. Refuses when one is already
 * open — one exploration per project keeps cost and attention bounded, and two
 * concurrent picks over one scratch file would corrupt both.
 */
export async function createExploration(workspacePath: string, opts: CreateExplorationOptions): Promise<Exploration> {
	const existing = await readExploration(workspacePath)
	if (existing) {
		throw new Error(
			`An exploration for "${existing.pageId}" is already open — settle it or discard it before starting another.`,
		)
	}

	const mode = opts.mode ?? "page"
	let pageId: string
	let title: string | undefined
	if (mode === "page") {
		if (!opts.pageId) throw new Error("An exploration of an existing page needs its page id.")
		pageId = opts.pageId
		await fs.access(path.join(safeNodeDir(workspacePath, pageId), "index.tsx"))
	} else {
		if (!opts.name?.trim()) throw new Error("A new-page exploration needs a name.")
		title = opts.name.trim()
		pageId = title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
		if (!pageId) throw new Error(`"${opts.name}" doesn't reduce to a usable page id.`)
		const wouldBe = safeNodeDir(workspacePath, pageId)
		const taken = await fs.access(wouldBe).then(
			() => true,
			() => false,
		)
		if (taken) throw new Error(`A page named "${pageId}" already exists — explore it instead, or pick another name.`)
	}

	const exploration: Exploration = {
		version: 2,
		mode,
		pageId,
		...(title ? { title } : {}),
		instruction: opts.instruction,
		startedAt: new Date().toISOString(),
		source: "caret",
		...(opts.kind ? { kind: opts.kind } : {}),
		...(opts.proposalAppPaths ? { proposalAppPaths: opts.proposalAppPaths } : {}),
		nextTake: 1,
		nodes: [],
	}
	await writeExploration(workspacePath, exploration)

	try {
		await spawnRound(workspacePath, pageId, opts.instruction, { count: opts.count, label: opts.label })
	} catch (err) {
		// A failed first round must not leave a half-open exploration blocking the
		// one-per-project rule.
		await discardExploration(workspacePath).catch(() => {})
		throw err
	}
	return (await readExploration(workspacePath)) as Exploration
}

/**
 * Copies the branch point into `count` fresh take directories and records the
 * round. `fromId` is the exploration's root page or any `ready` node — you
 * branch from something you can see, never from a take still being written.
 */
export async function spawnRound(
	workspacePath: string,
	fromId: string,
	instruction: string,
	opts: { count?: number; label?: string } = {},
): Promise<ExploreNode[]> {
	const exploration = await readExploration(workspacePath)
	if (!exploration) throw new Error("No exploration is open.")

	const isRoot = fromId === exploration.pageId
	if (!isRoot) {
		const from = exploration.nodes.find((n) => n.id === fromId)
		if (!from) throw new Error(`"${fromId}" is not part of this exploration.`)
		if (from.status !== "ready") throw new Error(`"${fromId}" isn't ready to branch from yet.`)
	}

	const sourceDir = safeNodeDir(workspacePath, fromId)
	const sourceExists = await fs.access(path.join(sourceDir, "index.tsx")).then(
		() => true,
		() => false,
	)
	// The one case with nothing to copy: round 1 of a new-page exploration.
	const scaffold = !sourceExists && isRoot && exploration.mode === "new"
	if (!sourceExists && !scaffold) throw new Error(`"${fromId}" has no page source to branch from.`)

	const sourceMeta: Record<string, unknown> = sourceExists
		? JSON.parse(await fs.readFile(path.join(sourceDir, "meta.json"), "utf-8").catch(() => "{}"))
		: { title: exploration.title ?? exploration.pageId, type: "page", states: [], tags: [] }

	const count = opts.count ?? VARIANT_COUNT
	const spawned: ExploreNode[] = []
	for (let i = 0; i < count; i++) {
		const n = exploration.nextTake++
		const id = variantPageId(exploration.pageId, n)
		const dir = safeNodeDir(workspacePath, id)
		if (scaffold) {
			await fs.rm(dir, { recursive: true, force: true })
			await fs.mkdir(dir, { recursive: true })
			await writeFileAtomic(path.join(dir, "index.tsx"), stubPageSource(String(sourceMeta.title ?? exploration.pageId)))
		} else {
			await copyDir(sourceDir, dir)
		}
		const label = opts.label ?? `Take ${n}`
		await writeFileAtomic(
			path.join(dir, "meta.json"),
			JSON.stringify(
				{
					...sourceMeta,
					id,
					title: `${sourceMeta.title ?? exploration.pageId} — ${opts.label ?? `take ${n}`}`,
					variantOf: exploration.pageId,
				},
				null,
				2,
			),
		)
		spawned.push({
			id,
			parentId: fromId,
			instruction,
			angle: opts.label ? "external" : VARIANT_ANGLES[i % VARIANT_ANGLES.length],
			angleLabel: opts.label ?? ANGLE_LABELS[i % ANGLE_LABELS.length],
			label,
			status: "working",
			startedAt: new Date().toISOString(),
		})
	}

	exploration.nodes.push(...spawned)
	await writeExploration(workspacePath, exploration)
	return spawned
}

/**
 * Registers take pages an EXTERNAL agent already wrote (the MCP path).
 * Validates each page actually has renderable source before showing a pick.
 */
export async function registerExternalRound(
	workspacePath: string,
	pageId: string,
	variantIds: string[],
	instruction: string,
): Promise<Exploration> {
	const existing = await readExploration(workspacePath)
	if (existing) {
		throw new Error(`An exploration for "${existing.pageId}" is already open — resolve it first.`)
	}
	await fs.access(path.join(safeNodeDir(workspacePath, pageId), "index.tsx"))
	for (const id of variantIds) {
		await fs.access(path.join(safeNodeDir(workspacePath, id), "index.tsx"))
	}

	// The counter must clear every registered id so a later deepening round
	// never reuses a directory the external agent named.
	let maxTake = 0
	for (const id of variantIds) {
		const match = /--v(\d+)$/.exec(id)
		if (match) maxTake = Math.max(maxTake, Number(match[1]))
	}

	const startedAt = new Date().toISOString()
	const exploration: Exploration = {
		version: 2,
		mode: "page",
		pageId,
		instruction,
		startedAt,
		source: "external",
		nextTake: maxTake + 1,
		nodes: variantIds.map((id, i) => ({
			id,
			parentId: pageId,
			instruction,
			angle: "external",
			angleLabel: "External",
			label: `Take ${i + 1}`,
			status: "ready" as const,
			startedAt,
		})),
	}
	await writeExploration(workspacePath, exploration)
	return exploration
}

export async function updateNodeStatus(
	workspacePath: string,
	nodeId: string,
	status: ExploreNodeStatus,
	error?: string,
): Promise<void> {
	const exploration = await readExploration(workspacePath)
	if (!exploration) return
	const node = exploration.nodes.find((n) => n.id === nodeId)
	if (!node) return
	node.status = status
	node.error = error
	await writeExploration(workspacePath, exploration)
}

/**
 * Removes every take directory and the scratch. Registering an exploration —
 * Caret's own copies or an external agent's via `propose_variants` — hands the
 * take pages to the playground: they exist to be compared, and whichever way
 * the pick resolves they are cleaned up rather than left as invisible clutter.
 */
export async function discardExploration(workspacePath: string): Promise<void> {
	const exploration = await readExploration(workspacePath)
	if (exploration) {
		for (const node of exploration.nodes) {
			await fs.rm(safeNodeDir(workspacePath, node.id), { recursive: true, force: true })
		}
	}
	await fs.rm(scratchPath(workspacePath), { force: true })
}

/**
 * Settles the exploration on one leaf. `mode:"page"`: its source replaces the
 * root page's, the meta keeps the ORIGINAL identity (id and title are not part
 * of the take). `mode:"new"`: it becomes the page — copied to the root id with
 * a real identity and no `variantOf`, so it joins the canvas. Either way the
 * whole tree is cleaned up.
 */
export async function applyLeaf(workspacePath: string, nodeId: string): Promise<void> {
	const exploration = await readExploration(workspacePath)
	if (!exploration) throw new Error("No exploration is open.")
	const chosen = exploration.nodes.find((n) => n.id === nodeId)
	if (!chosen) throw new Error(`"${nodeId}" is not one of the open takes.`)
	if (chosen.status !== "ready") throw new Error(`"${nodeId}" isn't finished — it can't be applied yet.`)

	const rootDir = safeNodeDir(workspacePath, exploration.pageId)
	const chosenDir = safeNodeDir(workspacePath, nodeId)

	if (exploration.mode === "new") {
		const taken = await fs.access(rootDir).then(
			() => true,
			() => false,
		)
		if (taken) {
			throw new Error(
				`A page named "${exploration.pageId}" appeared while this exploration was open — discard the exploration or rename that page.`,
			)
		}
		const takeMeta = JSON.parse(await fs.readFile(path.join(chosenDir, "meta.json"), "utf-8").catch(() => "{}"))
		delete takeMeta.variantOf
		await copyDir(chosenDir, rootDir)
		await writeFileAtomic(
			path.join(rootDir, "meta.json"),
			JSON.stringify({ ...takeMeta, id: exploration.pageId, title: exploration.title ?? exploration.pageId }, null, 2),
		)
	} else {
		const originalMeta = await fs.readFile(path.join(rootDir, "meta.json"), "utf-8").catch(() => null)
		await copyDir(chosenDir, rootDir)
		if (originalMeta) {
			await writeFileAtomic(path.join(rootDir, "meta.json"), originalMeta)
		}
	}

	for (const node of exploration.nodes) {
		await fs.rm(safeNodeDir(workspacePath, node.id), { recursive: true, force: true })
	}
	await fs.rm(scratchPath(workspacePath), { force: true })
}
