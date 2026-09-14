/**
 * What the agent is told when someone paints a region.
 *
 * Both facts here come from one failed edit in a real project. Asked to
 * retexture a notecard, the model was handed an accurate crop of that notecard
 * and the page source, searched for the *image* rather than the words in the
 * picture, found the same file used by two components, and edited the one
 * several screens above the region on screen. The crop was never the problem;
 * the prompt gave it no method for finding what it was looking at.
 *
 * The second fact is smaller and was costing every turn: the prompt closed by
 * naming `write_to_file`, which neither backend has.
 */
import { strict as assert } from "assert"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { AiEditRequestPayload, OverlayElementInfo } from "../../rendering-shell/messages"
import { buildVisualEditPrompt } from "../context-builder"

type OverlayPayload = AiEditRequestPayload & { elements?: OverlayElementInfo[] }

/** An overlay edit is the one with no element behind it: no line, no caret-id. */
function overlayPayload(overrides: Partial<OverlayPayload> = {}): OverlayPayload {
	return {
		instruction: "make this look like brown paper",
		filePath: "",
		lineNumber: 0,
		columnNumber: 0,
		componentName: "",
		caretId: "",
		componentStack: "",
		...overrides,
	} as OverlayPayload
}

describe("buildVisualEditPrompt", () => {
	let workspace: string

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), "caret-prompt-"))
	})

	afterEach(async () => {
		await fs.rm(workspace, { force: true, recursive: true })
	})

	it("tells an overlay edit to find the region by the text in the crop", async () => {
		const prompt = await buildVisualEditPrompt(overlayPayload(), workspace)

		assert.match(prompt, /text visible in the crop/i, "no instruction to read the words in the picture")
		assert.match(prompt, /search for those exact words/i, "did not say to search for them")
		assert.match(
			prompt,
			/Do not identify it by the graphic or by an image filename/i,
			"did not rule out the match that picked the wrong component",
		)
	})

	it("tells an overlay edit to follow the page's imports", async () => {
		// The section the user painted usually is not in the page at all — the page
		// composes it. Without this the agent edits the page or gives up.
		const prompt = await buildVisualEditPrompt(overlayPayload(), workspace)
		assert.match(prompt, /components it imports/i)
	})

	it("leaves a selected-element edit pinned to that element", async () => {
		// The inline path was never the broken one, and its narrowness is the point:
		// the user clicked a specific thing.
		const prompt = await buildVisualEditPrompt(overlayPayload({ caretId: "a-5", lineNumber: 36 }), workspace)

		assert.match(prompt, /selected a SPECIFIC element/i)
		assert.doesNotMatch(prompt, /text visible in the crop/i, "the overlay's search method leaked into the click path")
	})

	it("never names a tool the backends do not have", async () => {
		// OpenCode offers read/apply_patch/bash/grep/glob/edit/write/todowrite, and
		// the Claude backend has Write, not write_to_file. Naming one cost real
		// turns: the model hunted for it before improvising.
		for (const payload of [overlayPayload(), overlayPayload({ caretId: "a-5", lineNumber: 36 })]) {
			const prompt = await buildVisualEditPrompt(payload, workspace)
			assert.doesNotMatch(prompt, /write_to_file/, "the prompt still names a tool that does not exist")
			assert.match(prompt, /editing the file/i, "the prompt no longer says to apply the change")
		}
	})

	// ── measured geometry ────────────────────────────────────────────────────
	//
	// A model can see that a thing is off-center but not by how much — that is
	// the "move it right… no, back a bit" loop. Handing it the rects the canvas
	// measured turns the move into a subtraction it can state and defend.

	const clip = { caretId: "c42", tag: "img", rect: { x: 120, y: 40, width: 80, height: 120 }, src: "/caret-assets/clip.png" }
	const shirt = { caretId: "c17", tag: "img", rect: { x: 0, y: 0, width: 480, height: 520 }, src: "/caret-assets/shirt.png" }

	it("renders measured elements with numeric boxes and centers", async () => {
		const prompt = await buildVisualEditPrompt(overlayPayload({ elements: [clip, shirt] }), workspace)
		assert.match(prompt, /Caret measured the elements under the painted region/i)
		assert.match(prompt, /data-caret-id="c42".*box 80x120 at \(120,40\), center \(160,100\)/)
		assert.match(prompt, /data-caret-id="c17".*box 480x520 at \(0,0\), center \(240,260\)/)
		assert.match(prompt, /do the arithmetic/i, "the prompt does not say what the numbers are for")
		assert.match(prompt, /re-measure/i, "the prompt does not warn that the result will be checked")
	})

	it("switches the locate method to caret-ids when geometry is present", async () => {
		const prompt = await buildVisualEditPrompt(overlayPayload({ elements: [clip] }), workspace)
		assert.match(prompt, /locate elements by them, never by image filename/i)
		assert.doesNotMatch(prompt, /search for those exact words/i, "the text-anchoring fallback leaked into the measured path")
	})

	it("keeps the text-anchoring method when nothing was measured", async () => {
		const prompt = await buildVisualEditPrompt(overlayPayload({ elements: [] }), workspace)
		assert.match(prompt, /search for those exact words/i)
	})

	it("omits elements whose numbers are hostile rather than quoting them as fact", async () => {
		const bad = [
			{ caretId: "c1", tag: "img", rect: { x: Number.NaN, y: 0, width: 10, height: 10 } },
			{ caretId: "c2", tag: "img", rect: { x: 0, y: 0, width: -5, height: 10 } },
			{ caretId: "", tag: "img", rect: { x: 0, y: 0, width: 10, height: 10 } },
		]
		const prompt = await buildVisualEditPrompt(overlayPayload({ elements: bad as never }), workspace)
		assert.doesNotMatch(prompt, /NaN/, "a NaN reached the prompt")
		assert.doesNotMatch(prompt, /Caret measured/, "an all-hostile list still rendered a measured section")
	})

	it("adds the visual center for a cutout whose index carries an opaque box", async () => {
		// clip.png: 200x300 intrinsic, opaque pixels 100x200 offset to (60,40) —
		// margins 60/40 left/top vs 40/60 right/bottom, so the visual center is
		// right and up of the box center.
		await writeIndex(workspace, [
			{ tag: "clip", file: "clip.png", width: 200, height: 300, opaqueBox: { x: 60, y: 40, width: 100, height: 200 } },
		])
		// Rendered at 100x150 (half intrinsic, same aspect): scale 0.5, so the
		// opaque box maps to 50x100 at +30/+20 from the element origin (120,40):
		// visual center (120+30+25, 40+20+50) = (175,110).
		const el = { ...clip, rect: { x: 120, y: 40, width: 100, height: 150 } }
		const prompt = await buildVisualEditPrompt(overlayPayload({ elements: [el] }), workspace)
		assert.match(prompt, /opaque pixels occupy 50x100 within the box; visual center \(175,110\)/)
		assert.match(prompt, /center on the VISUAL center/i)
	})

	it("keeps quiet about visual center when object-fit distorted the mapping", async () => {
		await writeIndex(workspace, [
			{ tag: "clip", file: "clip.png", width: 200, height: 300, opaqueBox: { x: 60, y: 40, width: 100, height: 200 } },
		])
		// Rendered square from a 2:3 intrinsic — object-fit is cropping or
		// letterboxing, and the linear map would put the "visual center" on a
		// point that is not in the picture.
		const el = { ...clip, rect: { x: 120, y: 40, width: 150, height: 150 } }
		const prompt = await buildVisualEditPrompt(overlayPayload({ elements: [el] }), workspace)
		assert.doesNotMatch(prompt, /visual center/i)
	})

	it("keeps quiet about visual center for an asset with no opaque box", async () => {
		await writeIndex(workspace, [{ tag: "clip", file: "clip.png", width: 200, height: 300 }])
		const prompt = await buildVisualEditPrompt(overlayPayload({ elements: [clip] }), workspace)
		assert.doesNotMatch(prompt, /visual center/i)
	})
})

/** A minimal but honest asset index in the temp workspace. */
async function writeIndex(
	workspace: string,
	entries: Array<{
		tag: string
		file: string
		width: number
		height: number
		opaqueBox?: { x: number; y: number; width: number; height: number }
	}>,
): Promise<void> {
	const dir = path.join(workspace, ".caret", "assets")
	await fs.mkdir(dir, { recursive: true })
	const assets = entries.map((entry) => ({
		kind: "image",
		mime: "image/png",
		bytes: 1000,
		hash: `sha256:${entry.file}`,
		alt: "",
		description: "",
		origin: { type: "uploaded" },
		addedAt: "2026-01-01T00:00:00.000Z",
		...entry,
	}))
	await fs.writeFile(path.join(dir, "index.json"), JSON.stringify({ version: 1, assets }, null, 2))
}
