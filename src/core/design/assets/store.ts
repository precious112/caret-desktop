/**
 * Reading and writing `.caret/assets/index.json`.
 *
 * The index is the source of truth for tags, descriptions and provenance; the
 * files beside it are the source of truth for bytes. Reconciling the two is
 * `reindex`, which runs on any write into the directory regardless of who made
 * it — the same direct-write-and-heal model the pages use, for the same reason:
 * an agent with file tools will not route through an MCP tool, and reliability
 * cannot depend on it choosing to.
 */
import { createHash } from "crypto"
import * as fs from "fs/promises"
import * as path from "path"

import { runExclusive, writeFileAtomic } from "../file-mutation-queue"
import { probeDimensions } from "./probe"
import { deriveTag, uniqueTag, validateTag } from "./tags"
import { ASSET_TYPES, type AssetEntry, type AssetIndex, EMPTY_ASSET_INDEX } from "./types"

export const ASSETS_DIR = path.join(".caret", "assets")
const INDEX_FILE = "index.json"

/** Bytes above which the index is a poor place for the file, and git a worse one. */
export const LARGE_ASSET_BYTES = 10 * 1024 * 1024

export function assetsDirectory(projectPath: string): string {
	return path.join(projectPath, ASSETS_DIR)
}

/** Where extracted video poster frames live. Derived, gitignored, unindexed. */
export function postersDirectory(projectPath: string): string {
	return path.join(assetsDirectory(projectPath), ".posters")
}

export function posterPath(projectPath: string, entry: AssetEntry): string | null {
	return entry.poster ? path.join(postersDirectory(projectPath), entry.poster) : null
}

export function assetIndexPath(projectPath: string): string {
	return path.join(assetsDirectory(projectPath), INDEX_FILE)
}

/** The index as written, or an empty one. Never throws on a malformed file. */
export async function readAssetIndex(projectPath: string): Promise<AssetIndex> {
	try {
		const raw = await fs.readFile(assetIndexPath(projectPath), "utf-8")
		const parsed = JSON.parse(raw) as AssetIndex
		if (!Array.isArray(parsed?.assets)) return { ...EMPTY_ASSET_INDEX }
		return { version: 1, assets: parsed.assets.filter(isUsableEntry) }
	} catch {
		// A missing index is the normal state for a project that has no assets, and
		// a corrupt one is recoverable by reindexing. Neither deserves a throw from
		// a read.
		return { ...EMPTY_ASSET_INDEX }
	}
}

export async function writeAssetIndex(projectPath: string, index: AssetIndex): Promise<void> {
	const target = assetIndexPath(projectPath)
	await fs.mkdir(path.dirname(target), { recursive: true })

	// Sorted, so two machines that added the same assets in a different order
	// produce the same file. This lives in git and gets reviewed in PRs.
	const sorted = { version: 1 as const, assets: [...index.assets].sort((a, b) => a.tag.localeCompare(b.tag)) }
	await writeFileAtomic(target, `${JSON.stringify(sorted, null, 2)}\n`)
}

export function findAsset(index: AssetIndex, tag: string): AssetEntry | undefined {
	return index.assets.find((asset) => asset.tag === tag)
}

/** The public URL a page uses to reference an asset. */
export function assetUrl(entry: AssetEntry): string {
	return `/caret-assets/${entry.file}`
}

export interface ReindexResult {
	index: AssetIndex
	added: string[]
	removed: string[]
	updated: string[]
	/** Files present but not indexable, with the reason. */
	skipped: Array<{ file: string; reason: string }>
}

/**
 * Reconciles the index against what is actually on disk.
 *
 * Additive about metadata a human wrote: a file whose bytes changed keeps its
 * tag, alt and description, because those describe the *slot* rather than the
 * bytes, and losing a hand-written description to a re-export would be exactly
 * the kind of evaporating correction this project exists to prevent.
 */
export async function reindexAssets(projectPath: string): Promise<ReindexResult> {
	return runExclusive(assetIndexPath(projectPath), async () => {
		const directory = assetsDirectory(projectPath)
		const existing = await readAssetIndex(projectPath)
		const byFile = new Map(existing.assets.map((asset) => [asset.file, asset]))

		const result: ReindexResult = { index: { ...EMPTY_ASSET_INDEX }, added: [], removed: [], updated: [], skipped: [] }

		let names: string[]
		try {
			const entries = await fs.readdir(directory, { withFileTypes: true })
			names = entries.filter((entry) => entry.isFile() && entry.name !== INDEX_FILE).map((entry) => entry.name)
		} catch {
			return result
		}

		const assets: AssetEntry[] = []
		const taken = new Set<string>()

		for (const file of names.sort()) {
			const extension = path.extname(file).toLowerCase()
			const type = ASSET_TYPES[extension]
			if (!type) {
				result.skipped.push({ file, reason: `${extension || "no extension"} is not a supported asset type` })
				continue
			}

			const full = path.join(directory, file)
			let buffer: Buffer
			let bytes: number
			try {
				const stat = await fs.stat(full)
				bytes = stat.size
				// Only the header is needed for dimensions, and a 200MB video should
				// not be read into memory to find out it cannot be measured anyway.
				buffer = await readHead(full, 64 * 1024)
			} catch (err) {
				result.skipped.push({ file, reason: err instanceof Error ? err.message : String(err) })
				continue
			}

			const hash = `sha256:${createHash("sha256").update(buffer).update(String(bytes)).digest("hex").slice(0, 32)}`
			const previous = byFile.get(file)
			const size = probeDimensions(buffer, extension)

			const tag = previous?.tag ?? uniqueTag(deriveTag(file), taken)
			taken.add(tag)

			const entry: AssetEntry = {
				tag,
				file,
				kind: type.kind,
				mime: type.mime,
				width: size?.width ?? previous?.width ?? null,
				height: size?.height ?? previous?.height ?? null,
				bytes,
				hash,
				alt: previous?.alt ?? "",
				description: previous?.description ?? "",
				origin: previous?.origin ?? { type: "discovered" },
				addedAt: previous?.addedAt ?? new Date().toISOString(),
				...(previous?.duration !== undefined ? { duration: previous.duration } : {}),
				// Unlike the description, a poster describes the *bytes*. Carrying it
				// across a re-export would show the old frame for the new video, which
				// reads as a caching bug rather than as stale data.
				...(previous?.poster !== undefined && previous.hash === hash ? { poster: previous.poster } : {}),
				// Same rule: the opaque-pixel bound describes the bytes. A re-export
				// drops it and the enrichment pass measures the new bytes.
				...(previous?.opaqueBox !== undefined && previous.hash === hash ? { opaqueBox: previous.opaqueBox } : {}),
			}

			assets.push(entry)
			if (!previous) result.added.push(tag)
			else if (previous.hash !== hash) result.updated.push(tag)
		}

		const survivors = new Set(assets.map((asset) => asset.file))
		result.removed = existing.assets.filter((asset) => !survivors.has(asset.file)).map((asset) => asset.tag)

		result.index = { version: 1, assets }

		// Only write when something actually differs, so watch-and-heal does not
		// retrigger itself on its own write.
		if (result.added.length || result.removed.length || result.updated.length || existing.assets.length === 0) {
			if (assets.length > 0 || existing.assets.length > 0) await writeAssetIndex(projectPath, result.index)
		}
		return result
	})
}

/** Renames an asset's tag, refusing collisions and malformed names. */
export async function retagAsset(
	projectPath: string,
	from: string,
	to: string,
): Promise<{ ok: true; index: AssetIndex } | { ok: false; reason: string }> {
	const valid = validateTag(to)
	if (!valid.ok) return { ok: false, reason: valid.reason }

	return runExclusive(assetIndexPath(projectPath), async () => {
		const index = await readAssetIndex(projectPath)
		const entry = findAsset(index, from)
		if (!entry) return { ok: false as const, reason: `No asset tagged "${from}".` }
		if (from !== to && findAsset(index, to)) return { ok: false as const, reason: `"${to}" is already taken.` }

		entry.tag = to
		await writeAssetIndex(projectPath, index)
		return { ok: true as const, index }
	})
}

/**
 * Records measured opaque-pixel bounds for a batch of files, one write.
 *
 * The measuring happens in desktop main (Electron decodes the pixels); the
 * index mutation lives here so it shares the same lock and atomic write as
 * every other index change. `null` records "measured, nothing to store" by
 * clearing any stale bound; files absent from `boxes` are left untouched.
 */
export async function setOpaqueBoxes(
	projectPath: string,
	boxes: Map<string, { x: number; y: number; width: number; height: number } | null>,
): Promise<void> {
	if (boxes.size === 0) return
	return runExclusive(assetIndexPath(projectPath), async () => {
		const index = await readAssetIndex(projectPath)
		let changed = false
		for (const entry of index.assets) {
			if (!boxes.has(entry.file)) continue
			const box = boxes.get(entry.file) ?? undefined
			const same =
				(box === undefined && entry.opaqueBox === undefined) ||
				(box !== undefined &&
					entry.opaqueBox !== undefined &&
					box.x === entry.opaqueBox.x &&
					box.y === entry.opaqueBox.y &&
					box.width === entry.opaqueBox.width &&
					box.height === entry.opaqueBox.height)
			if (same) continue
			if (box === undefined) delete entry.opaqueBox
			else entry.opaqueBox = box
			changed = true
		}
		if (changed) await writeAssetIndex(projectPath, index)
	})
}

/**
 * Records an extracted poster frame for an asset that cannot show itself.
 *
 * The pixels come from the library's own `<video>` element — the browser
 * already decoded the frame to display it, so extracting it costs nothing and
 * needs no ffmpeg on the user's machine. What it buys is that `get_asset` can
 * hand an agent a look at a video instead of a sentence about one.
 */
export async function setPoster(
	projectPath: string,
	tag: string,
	png: Buffer,
): Promise<{ ok: true; entry: AssetEntry } | { ok: false; reason: string }> {
	return runExclusive(assetIndexPath(projectPath), async () => {
		const index = await readAssetIndex(projectPath)
		const entry = findAsset(index, tag)
		if (!entry) return { ok: false as const, reason: `No asset tagged "${tag}".` }

		// Named after the file rather than the tag: a rename must not orphan the
		// poster, and the file name is what the entry is keyed on internally.
		const name = `${entry.file}.png`
		const directory = postersDirectory(projectPath)
		await fs.mkdir(directory, { recursive: true })
		await fs.writeFile(path.join(directory, name), png)

		entry.poster = name
		await writeAssetIndex(projectPath, index)
		return { ok: true as const, entry }
	})
}

/** Updates the fields a person or an agent writes, leaving the file alone. */
export async function describeAsset(
	projectPath: string,
	tag: string,
	fields: { alt?: string; description?: string },
): Promise<{ ok: true; entry: AssetEntry } | { ok: false; reason: string }> {
	return runExclusive(assetIndexPath(projectPath), async () => {
		const index = await readAssetIndex(projectPath)
		const entry = findAsset(index, tag)
		if (!entry) return { ok: false as const, reason: `No asset tagged "${tag}".` }

		if (fields.alt !== undefined) entry.alt = fields.alt
		if (fields.description !== undefined) entry.description = fields.description
		await writeAssetIndex(projectPath, index)
		return { ok: true as const, entry }
	})
}

async function readHead(filePath: string, limit: number): Promise<Buffer> {
	const handle = await fs.open(filePath, "r")
	try {
		const buffer = Buffer.alloc(limit)
		const { bytesRead } = await handle.read(buffer, 0, limit, 0)
		return buffer.subarray(0, bytesRead)
	} finally {
		await handle.close()
	}
}

function isUsableEntry(entry: unknown): entry is AssetEntry {
	const candidate = entry as AssetEntry
	return Boolean(candidate && typeof candidate.tag === "string" && typeof candidate.file === "string")
}
