/**
 * A generated result becoming an ordinary asset.
 *
 * The rule from §4.7's output handling: **a generated asset is an asset like any
 * other.** Same directory, same index, same `@tag`, same sync path — the only
 * thing that distinguishes it is `origin`, which records the model or generator,
 * the recipe, the answers the user gave and the fully resolved request. Anything
 * less would make provenance a UI label rather than a fact about the file.
 *
 * This deliberately goes through `reindexAssets` rather than constructing the
 * entry directly. The reindex is the one place that hashes bytes and probes
 * dimensions, and a second path that filled those in itself would drift from it
 * — the healer would then "correct" every generated asset on the next write.
 */
import * as fs from "fs/promises"
import * as path from "path"

import { runExclusive } from "../file-mutation-queue"
import { assetIndexPath, assetsDirectory, findAsset, readAssetIndex, reindexAssets, writeAssetIndex } from "./store"
import { deriveTag, uniqueTag, validateTag } from "./tags"
import type { AssetEntry, AssetOrigin } from "./types"

export type GeneratedOrigin = Extract<AssetOrigin, { type: "generated" }>

export interface GeneratedAssetInput {
	projectPath: string
	/** Preferred `@` name. Uniquified against what already exists. */
	tag: string
	/** Including the dot, and one of the types the asset layer recognises. */
	extension: string
	bytes: Buffer
	/** What it looks like — the load-bearing field, composed by the caller. */
	description: string
	alt: string
	origin: GeneratedOrigin
}

export type AddGeneratedResult = { ok: true; entry: AssetEntry } | { ok: false; reason: string }

/**
 * Writes a generated asset and records where it came from.
 *
 * The file is named after the tag so the reindex derives the same name back:
 * that is what keeps this path and the healed path in agreement about what an
 * asset is called, without this function having to reserve tags the healer does
 * not know about.
 */
export async function addGeneratedAsset(input: GeneratedAssetInput): Promise<AddGeneratedResult> {
	if (input.bytes.length === 0) return { ok: false, reason: "The generated asset was empty." }

	const directory = assetsDirectory(input.projectPath)
	await fs.mkdir(directory, { recursive: true })

	const existing = await readAssetIndex(input.projectPath)
	const desired = deriveTag(`${input.tag}${input.extension}`)
	const valid = validateTag(desired)
	if (!valid.ok) return { ok: false, reason: valid.reason }

	const tag = uniqueTag(
		desired,
		existing.assets.map((asset) => asset.tag),
	)
	const file = await freeName(directory, `${tag}${input.extension}`)
	await fs.writeFile(path.join(directory, file), input.bytes)

	// Everything derived — hash, dimensions, kind, mime — comes from here.
	await reindexAssets(input.projectPath)

	return runExclusive(assetIndexPath(input.projectPath), async () => {
		const index = await readAssetIndex(input.projectPath)
		const entry = index.assets.find((asset) => asset.file === file)
		if (!entry) {
			// The file was written and the reindex did not pick it up, which means
			// the extension is not one the asset layer serves. Saying so beats
			// leaving an orphan on disk that nothing references.
			await fs.rm(path.join(directory, file), { force: true })
			return { ok: false as const, reason: `${input.extension} is not a supported asset type.` }
		}

		entry.description = input.description
		entry.alt = input.alt
		entry.origin = input.origin
		await writeAssetIndex(input.projectPath, index)
		return { ok: true as const, entry }
	})
}

/** Reads back what was just written, for callers that want the fresh entry. */
export async function readGeneratedEntry(projectPath: string, tag: string): Promise<AssetEntry | undefined> {
	return findAsset(await readAssetIndex(projectPath), tag)
}

/**
 * A name nothing else in the directory is using.
 *
 * Generated assets collide more than uploaded ones do — "quiet-wash" is the
 * obvious name every time that recipe runs — so this is the common case here
 * rather than the rare one.
 */
async function freeName(directory: string, name: string): Promise<string> {
	const extension = path.extname(name)
	const base = name.slice(0, name.length - extension.length)

	for (let suffix = 0; suffix < 1000; suffix++) {
		const candidate = suffix === 0 ? name : `${base}-${suffix + 1}${extension}`
		try {
			await fs.access(path.join(directory, candidate))
		} catch {
			return candidate
		}
	}
	throw new Error(`Could not find a free file name based on "${name}".`)
}
