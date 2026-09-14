/**
 * Where the cutout model lives, and how it gets there.
 *
 * Cutting a subject out of a photograph is a segmentation problem, not a
 * thresholding one. Every threshold Caret tried failed on the same thing:
 * polished metal has specular highlights brighter than any background cutoff,
 * so a paperclip came back with holes bitten out of its own wire. remove.bg and
 * everything like it run a learned model instead, and the open equivalents are
 * the dichotomous-segmentation family. BiRefNet is the one built for exactly
 * this — thin structures at high resolution — it scores highest of the three on
 * DIS5K, and it is MIT for both code and weights.
 *
 * **It is not bundled, and it is fetched unconditionally at first project
 * open.** Not on first use, and not gated on credentials being present: both of
 * those start the download at the moment somebody decides they want a cutout,
 * which is precisely the moment it is in the way. Adding an API key *is* the
 * declaration of intent, so waiting for one guarantees the wait is visible.
 * Starting at first open instead buys the whole of someone's first session —
 * the foundation interview, the first pages — and by the time they reach the
 * asset generator it is almost always already there. Someone who goes straight
 * to a cutout on a slow connection sees progress; that case is real, and it is
 * the only one. Anyone who wants to opt out gets a preference, not a guess made
 * on their behalf.
 *
 * **Presence is not readiness.** Three separate outages in this project came
 * from trusting a marker instead of the artefact: a cached `node_modules` with
 * no vite binary, an install manifest without the tree, a dependency listed but
 * absent. A 214MB download interrupted at 200MB leaves a file that exists, has
 * a plausible name, and cannot be loaded. So the size is checked against what
 * the server said, and the only proof that counts is the runtime opening it.
 */
import type { Stats } from "fs"

/** The MIT-licensed general model, tiny Swin backbone. 214MB. */
export const MATTE_MODEL = {
	name: "BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx",
	url: "https://github.com/ZhengPeng7/BiRefNet/releases/download/v1/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx",
	/**
	 * Exactly what the release serves, measured rather than rounded off the page.
	 * A file shorter than this is a truncated download.
	 */
	bytes: 224_005_088,
	/** Square input the network was exported for. */
	input: 1024,
} as const

export type ModelState =
	| { status: "ready"; path: string }
	| { status: "absent" }
	| { status: "downloading"; received: number; total: number }
	| { status: "failed"; reason: string }

/**
 * Whether a file on disk is plausibly the model.
 *
 * Deliberately only *plausibly*: this is the cheap check that runs at startup.
 * A file of the right size can still be corrupt, and the expensive proof —
 * asking the runtime to open it — happens once, at first use, where its cost is
 * lost in the inference anyway.
 */
export function looksComplete(stats: Stats | null): boolean {
	return Boolean(stats?.isFile()) && stats!.size === MATTE_MODEL.bytes
}

/** 214MB in the release notes; this is what the server actually sends. */
export const MATTE_MODEL_MB = Math.round(MATTE_MODEL.bytes / 1_000_000)

/** How far along a download is, for a progress line that does not lie. */
export function progressOf(received: number, total: number): { fraction: number; label: string } {
	const known = total > 0 ? total : MATTE_MODEL.bytes
	const fraction = Math.max(0, Math.min(1, received / known))
	const mb = (bytes: number) => Math.round(bytes / 1_000_000)
	return { fraction, label: `${mb(received)} of ${mb(known)}MB` }
}
