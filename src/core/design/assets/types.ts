/**
 * The asset layer's data model.
 *
 * The design layer describes *how things look* and, until now, said nothing
 * about *what is in them* — so an agent asked for a hero section had no option
 * but a grey placeholder or a stock URL, and the user's own photographs could
 * not enter the design layer at all.
 *
 * An asset is a file plus the small amount of metadata that makes it usable
 * without opening it.
 */

/** What kind of thing this is, which decides how it is previewed and described. */
export type AssetKind = "image" | "vector" | "video" | "model"

/** Where an asset came from. Carried into the library UI and never inferred. */
export type AssetOrigin =
	| { type: "uploaded" }
	/** Written straight into `.caret/assets/` by a person or an agent. */
	| { type: "discovered" }
	| {
			type: "generated"
			/** Which lane produced it — see the Phase 6.7 four-lane split. */
			lane: "raster" | "generator" | "iconset" | "authored" | "model3d"
			/** Model id, generator id, or icon-set name. */
			producer: string
			/** Recipe that composed the request, when one did. */
			recipeId?: string
			/** The answers the user gave, so the choice is reproducible. */
			answers?: Record<string, string>
			/** The fully resolved request, for auditing what was actually asked. */
			resolved?: string
			/**
			 * What post-processing did, when it ran.
			 *
			 * Recorded because it is lossy and irreversible: the file in the repo is
			 * not the file the model returned, and somebody comparing them later
			 * deserves to know that a crop and a re-encode happened rather than
			 * assuming the model produced a 1.75:1 image at 200KB.
			 */
			postProcessed?: {
				from: { bytes: number; mime: string }
				to: { bytes: number; mime: string; width: number; height: number }
			}
			/**
			 * What producing this file cost, in the provider's own meter.
			 *
			 * Tokens or credits, never a currency — prices drift and Caret would be
			 * recording a guess; the meter the provider reported is a fact. Absent on
			 * the free lanes, where "producer is code" already says everything, and
			 * absent when the provider offered no way to know.
			 */
			cost?: {
				unit: "tokens" | "credits"
				/** Metered for the call that produced this file. */
				amount: number
				/**
				 * The whole generate-and-pick round that offered it, when known. The
				 * discarded variants were part of the price of this one.
				 */
				round?: { calls: number; amount: number }
				/** How the number was obtained, when it is a measurement, not a report. */
				note?: string
			}
	  }

export interface AssetEntry {
	/**
	 * The `@` name. Unique within a project, kebab-case.
	 *
	 * This is the identifier a person types, the visual editor autocompletes and
	 * an agent reads — one name across all three, which is the entire point.
	 */
	tag: string
	/** File name within `.caret/assets/`. */
	file: string
	kind: AssetKind
	mime: string
	/**
	 * Intrinsic size, or null when the format is one Caret cannot measure.
	 *
	 * Null is a real state rather than a failure to report: the user can fill it
	 * in, and the description carries the useful information regardless.
	 */
	width: number | null
	height: number | null
	bytes: number
	/** `sha256:…`, for dedupe and for detecting a changed file without reading it. */
	hash: string
	/** Alt text. Empty is allowed; the acceptance checker flags it, not the writer. */
	alt: string
	/**
	 * What this looks like, in plain language — "wide, dark, empty space top-left".
	 *
	 * The load-bearing field. `2400x1350` does not tell an agent whether a
	 * headline can sit on this image, and that is the only question that matters
	 * when placing it. Stored rather than re-derived, so it survives the session
	 * like every other decision in `.caret/`.
	 */
	description: string
	origin: AssetOrigin
	/** ISO 8601. */
	addedAt: string
	/** Seconds. Video only. */
	duration?: number
	/**
	 * Bounding box of the visibly opaque pixels (alpha ≥ 16), in intrinsic
	 * pixels. Present only when it insets meaningfully from the full frame —
	 * absence means the box center IS the visual center. A cutout PNG's frame
	 * includes its transparent margins, so anything aligning by rendered rect
	 * alone centers the margins, not the object. Cleared when the file's bytes
	 * change, like `poster`.
	 */
	opaqueBox?: { x: number; y: number; width: number; height: number }
	/**
	 * File name of the extracted poster frame, inside `.caret/assets/.posters/`.
	 *
	 * For kinds that cannot be handed over as pixels directly. A derived file
	 * rather than an asset with its own tag: a poster is not a design decision,
	 * it is a view of one, and giving it an `@` name would put two names on the
	 * same thing. Cleared when the source file's bytes change, so a replaced
	 * video never shows the old frame.
	 */
	poster?: string
}

export interface AssetIndex {
	version: 1
	assets: AssetEntry[]
}

export const EMPTY_ASSET_INDEX: AssetIndex = { version: 1, assets: [] }

/**
 * Extensions Caret recognises, mapped to kind and mime.
 *
 * An allowlist rather than a sniff: `.caret/assets/` is a directory in the
 * user's repo that anything can write to, and indexing whatever lands there
 * without a known type invites both nonsense entries and surprises at serve
 * time.
 */
export const ASSET_TYPES: Record<string, { kind: AssetKind; mime: string }> = {
	".png": { kind: "image", mime: "image/png" },
	".jpg": { kind: "image", mime: "image/jpeg" },
	".jpeg": { kind: "image", mime: "image/jpeg" },
	".gif": { kind: "image", mime: "image/gif" },
	".webp": { kind: "image", mime: "image/webp" },
	".avif": { kind: "image", mime: "image/avif" },
	".svg": { kind: "vector", mime: "image/svg+xml" },
	".mp4": { kind: "video", mime: "video/mp4" },
	".webm": { kind: "video", mime: "video/webm" },
	".mov": { kind: "video", mime: "video/quicktime" },
	".glb": { kind: "model", mime: "model/gltf-binary" },
	".gltf": { kind: "model", mime: "model/gltf+json" },
}

/** Kinds an agent can be handed as pixels rather than described in words. */
export function isViewable(kind: AssetKind): boolean {
	return kind === "image" || kind === "vector"
}
