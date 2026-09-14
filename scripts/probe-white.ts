/**
 * The same cutout subject, asked for on plain white instead of a key colour.
 *
 * Settles whether a photographic grey object can be separated from white, which
 * is the objection to dropping chroma-key entirely. Costs one image call.
 */
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { resolveRasterConfig } from "../src/core/design/asset-library/raster/config"
import { GeminiImages } from "../src/core/design/asset-library/raster/gemini"

const SUBJECT = process.argv[2] || "a stainless steel ruler, 150mm, markings visible"

async function main(): Promise<void> {
	const prefsPath = path.join(os.homedir(), "Library/Application Support/Caret/preferences.json")
	const prefs = JSON.parse(await fs.readFile(prefsPath, "utf-8").catch(() => "{}"))
	const config = resolveRasterConfig({ vertexProject: prefs.vertexProject, vertexLocation: prefs.vertexLocation })
	if (!config) throw new Error("no raster credentials")

	const prompt = [
		`${SUBJECT}.`,
		"The whole subject is visible in frame, alone and centered.",
		"The background is pure flat white (#ffffff) filling every edge of the frame, and nothing else is in the picture.",
		"Soft even studio light from all sides. No shadow, no reflection, no vignette.",
	].join(" ")

	console.log("--- PROMPT ---\n" + prompt + "\n")
	const result = await new GeminiImages(config).generate({
		prompt,
		avoid: ["any cast shadow or reflection", "any second object, prop or hand", "the object cropped by the frame edge"],
		aspect: "1:1",
	})
	if (!result.ok) throw new Error(result.reason)

	const out = path.join(os.homedir(), "Desktop", "caret-white-probe.png")
	await fs.writeFile(out, result.bytes)
	console.log("SAVED:", out, result.mime, result.bytes.length, "bytes")
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
