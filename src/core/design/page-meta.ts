import * as fs from "fs/promises"
import * as path from "path"

import { Logger } from "@/shared/services/Logger"
import { writeFileAtomic } from "./file-mutation-queue"
import type { PageMeta } from "./types"

export async function readPageMeta(workspacePath: string, pageId: string): Promise<PageMeta | null> {
	const metaPath = path.join(workspacePath, ".caret", "pages", pageId, "meta.json")
	let content: string
	try {
		content = await fs.readFile(metaPath, "utf-8")
	} catch {
		return null
	}
	try {
		// Normalize: AI-written meta.json is often valid JSON but missing fields
		// (e.g. no `states`). Default every field so callers never hit undefined.
		const raw = (JSON.parse(content) ?? {}) as Partial<PageMeta>
		return {
			// **The directory is the identity, not `meta.json`'s claim about it.**
			// The folder name is the import path and the URL route, so a stored id
			// that disagrees is broken data that breaks quietly: the canvas card
			// renders and thumbnails but cannot be opened, `<a href="/id">` goes
			// nowhere, flow steps dangle, and `get_screenshot` misses. Preferring
			// the stored value was how AI-written meta.json silently did all four.
			id: pageId,
			title: typeof raw.title === "string" ? raw.title : pageId,
			type: typeof raw.type === "string" ? raw.type : "page",
			states: Array.isArray(raw.states) ? raw.states : [],
			tags: Array.isArray(raw.tags) ? raw.tags : [],
			// Load-bearing, not decorative: every "hide takes" exclusion — design
			// checks, the sync inventory, the rules context — filters on this.
			// Dropping it in normalization silently disabled all three (found as
			// ghost check findings for deleted take pages).
			...(typeof raw.variantOf === "string" && raw.variantOf ? { variantOf: raw.variantOf } : {}),
		}
	} catch (err) {
		Logger.warn(`[design] Page meta ${metaPath} is not valid JSON and will be ignored: ${err}`)
		return null
	}
}

export async function writePageMeta(workspacePath: string, pageId: string, meta: PageMeta): Promise<void> {
	const pageDir = path.join(workspacePath, ".caret", "pages", pageId)
	await fs.mkdir(pageDir, { recursive: true })
	await writeFileAtomic(path.join(pageDir, "meta.json"), JSON.stringify(meta, null, 2))
}

export async function listPages(workspacePath: string): Promise<PageMeta[]> {
	const pagesDir = path.join(workspacePath, ".caret", "pages")
	try {
		const entries = await fs.readdir(pagesDir, { withFileTypes: true })
		const pages: PageMeta[] = []

		for (const entry of entries) {
			if (!entry.isDirectory()) continue
			const meta = await readPageMeta(workspacePath, entry.name)
			if (meta) {
				pages.push(meta)
			} else {
				pages.push({
					id: entry.name,
					title: entry.name,
					type: "page",
					states: [],
					tags: [],
				})
			}
		}
		return pages
	} catch {
		return []
	}
}

export function validatePageMeta(obj: unknown): obj is PageMeta {
	if (!obj || typeof obj !== "object") return false
	const meta = obj as Record<string, unknown>
	if (typeof meta.id !== "string") return false
	if (typeof meta.title !== "string") return false
	if (typeof meta.type !== "string") return false
	if (!Array.isArray(meta.states)) return false
	if (!Array.isArray(meta.tags)) return false
	return true
}
