/**
 * What happens to a generated photograph before it becomes an asset.
 *
 * Three problems with what a model hands back, and all three land in the user's
 * git history if nobody fixes them:
 *
 * - **It is not the ratio it was composed for.** Gemini returns 1344×768 for a
 *   16:9 request — 1.75:1, not 1.778:1. Close enough to look fine and wrong
 *   enough that a full-bleed hero shows a seam.
 * - **It is enormous.** 1.4MB of PNG for one hero, committed, forever, times
 *   every variant anyone keeps.
 * - **It carries metadata nobody asked for.** Decoding to a bitmap and
 *   re-encoding drops all of it, which is the simplest correct EXIF strip there
 *   is.
 *
 * **No native dependency.** Skia does the resampling through `nativeImage` and
 * Chromium does the WebP encoding through a canvas, both of which are already in
 * the app. Adding `sharp` would mean an ABI rebuild per Electron version, on
 * every platform, for something the runtime already does.
 *
 * **AVIF is deliberately absent.** Chromium decodes it and does not encode it,
 * and `nativeImage` has no path to it either — so it needs a native encoder.
 * That is not a trade worth making for a second modern format while WebP is
 * supported everywhere that matters. Recorded in BACKLOG.md rather than
 * pretended at.
 *
 * SynthID survives all of this: it is in the pixels, not the metadata, and
 * stripping a model's own provenance watermark is not something a tool arguing
 * for honest output should do.
 */
import { BrowserWindow, nativeImage } from "electron"

import { removeFlatBackground } from "../../src/core/design"
import { Logger } from "../../src/shared/services/Logger"
import { matteCutout } from "./matte-infer"
import { getPrefs } from "./prefs"

export interface PostProcessed {
	bytes: Buffer
	mime: string
	extension: string
	width: number
	height: number
	/** What it weighed before, so the saving can be recorded and shown. */
	originalBytes: number
}

/**
 * Cuts the subject out of a generated photograph.
 *
 * The decision of what is subject belongs to the matte model (BiRefNet, see
 * `matte-infer.ts`) — a threshold cannot make it: shadows the image model
 * paints despite every instruction sit just under any white cutoff, and
 * specular highlights sit above it, so the threshold era shipped shadow
 * puddles and bit holes out of shiny objects. The white-flood keyer survives
 * only behind the explicit "skip the cutout model" preference, where the
 * 224MB download was declined and a rougher cut is the deal the user chose.
 *
 * This wrapper is only the Electron dance: decode to a bitmap, cut in place,
 * premultiply (what `createFromBitmap` expects), and hand back a PNG with real
 * alpha. A refusal is the cutter's own sentence — it names measured numbers,
 * and the caller shows it on the variant that earned it.
 */
export async function cutOutPhotograph(input: Buffer): Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: string }> {
	const image = nativeImage.createFromBuffer(input)
	const { width, height } = image.getSize()
	if (!width || !height) return { ok: false, reason: "The generated image could not be decoded for keying." }

	const bitmap = image.toBitmap()
	const frame = { data: bitmap, width, height, order: "bgra" as const }
	const keyed = getPrefs().skipCutoutModel ? removeFlatBackground(frame) : await matteCutout(frame)
	if (!keyed.ok) return keyed

	for (let i = 0; i < bitmap.length; i += 4) {
		const alpha = bitmap[i + 3]
		if (alpha === 255) continue
		bitmap[i] = (bitmap[i] * alpha) / 255
		bitmap[i + 1] = (bitmap[i + 1] * alpha) / 255
		bitmap[i + 2] = (bitmap[i + 2] * alpha) / 255
	}

	return { ok: true, bytes: nativeImage.createFromBitmap(bitmap, { width, height }).toPNG() }
}

/**
 * Crops to the requested ratio, resizes to fit, and re-encodes as WebP.
 *
 * Centre crop rather than letterbox: the recipes compose for a slot, and a bar
 * of background down two sides is not the picture that was asked for. The crop
 * is always the smaller correction — at most a few percent, because the model
 * was asked for this ratio and came close.
 *
 * `preserveAlpha` is for keyed cutouts: WebP through the canvas carries alpha
 * already, and the no-window fallback becomes PNG rather than JPEG — a JPEG
 * cutout is a cutout flattened onto black, which is worse than a bigger file.
 */
export async function postProcessPhotograph(
	input: Buffer,
	targetWidth: number,
	targetHeight: number,
	options?: { preserveAlpha?: boolean },
): Promise<PostProcessed> {
	const original = nativeImage.createFromBuffer(input)
	const size = original.getSize()

	if (!size.width || !size.height) {
		// Not decodable here — better to store exactly what came back than to
		// store nothing, so this degrades to a pass-through rather than a failure.
		Logger.warn("[image] a generated image could not be decoded; storing it unchanged")
		return { bytes: input, mime: "image/png", extension: ".png", width: 0, height: 0, originalBytes: input.length }
	}

	const wanted = targetWidth / targetHeight
	const actual = size.width / size.height

	let working = original
	if (Math.abs(actual - wanted) > 0.002) {
		const cropWidth = actual > wanted ? Math.round(size.height * wanted) : size.width
		const cropHeight = actual > wanted ? size.height : Math.round(size.width / wanted)
		working = original.crop({
			x: Math.round((size.width - cropWidth) / 2),
			y: Math.round((size.height - cropHeight) / 2),
			width: cropWidth,
			height: cropHeight,
		})
	}

	// Never upscaled. Enlarging a model's output adds no detail and a lot of
	// bytes, and the recipe's target is a ceiling rather than a demand.
	const finalWidth = Math.min(targetWidth, working.getSize().width)
	const resized = finalWidth < working.getSize().width ? working.resize({ width: finalWidth, quality: "best" }) : working
	const resizedSize = resized.getSize()

	const webp = await encodeWebp(resized.toPNG(), resizedSize.width, resizedSize.height)
	if (webp) {
		return {
			bytes: webp,
			mime: "image/webp",
			extension: ".webp",
			width: resizedSize.width,
			height: resizedSize.height,
			originalBytes: input.length,
		}
	}

	// WebP encoding needs a window, and a headless or mid-shutdown app may have
	// none. JPEG through Skia is the fallback: still far smaller than the PNG,
	// still stripped of metadata, and it needs nothing but the image itself.
	// Unless the alpha is the point — JPEG has none, so a cutout falls back to
	// PNG instead.
	if (options?.preserveAlpha) {
		return {
			bytes: resized.toPNG(),
			mime: "image/png",
			extension: ".png",
			width: resizedSize.width,
			height: resizedSize.height,
			originalBytes: input.length,
		}
	}
	return {
		bytes: resized.toJPEG(88),
		mime: "image/jpeg",
		extension: ".jpg",
		width: resizedSize.width,
		height: resizedSize.height,
		originalBytes: input.length,
	}
}

/**
 * Chromium's own WebP encoder, reached through a canvas in a hidden window.
 *
 * The window is created per call and destroyed after. A long-lived one would be
 * faster and would also be a renderer sitting around holding the user's
 * generated images for the life of the process, for the sake of a few hundred
 * milliseconds on an operation that already took fifteen seconds.
 */
async function encodeWebp(png: Buffer, width: number, height: number): Promise<Buffer | null> {
	let window: BrowserWindow | null = null
	try {
		window = new BrowserWindow({
			show: false,
			width: 16,
			height: 16,
			webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true },
		})
		await window.loadURL("data:text/html;charset=utf-8,<body></body>")

		const dataUrl = await window.webContents.executeJavaScript(
			`(async () => {
				const image = new Image()
				image.src = "data:image/png;base64,${png.toString("base64")}"
				await image.decode()
				const canvas = document.createElement("canvas")
				canvas.width = ${width}
				canvas.height = ${height}
				canvas.getContext("2d").drawImage(image, 0, 0, ${width}, ${height})
				return canvas.toDataURL("image/webp", 0.88)
			})()`,
		)

		if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/webp;base64,")) return null
		return Buffer.from(dataUrl.slice("data:image/webp;base64,".length), "base64")
	} catch (err) {
		Logger.warn(`[image] webp encoding failed, falling back to jpeg: ${err}`)
		return null
	} finally {
		window?.destroy()
	}
}
