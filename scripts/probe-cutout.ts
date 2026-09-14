/**
 * One real cutout generation, saved to disk so a human can look at it.
 *
 * Every take was being refused with "0% of the border is near #00b140" and
 * there was no way to see what the model actually returned — the failed bytes
 * are dropped and only the message survives. That leaves nobody able to tell
 * whether the model ignored the instruction or the keyer is wrong about it,
 * which is not an acceptable place for a refusal to leave someone.
 *
 * Run: npx tsx scripts/probe-cutout.ts "a stainless steel ruler, markings visible"
 * Costs one image call on whatever credentials are configured.
 */
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { derivePalette } from "../src/core/design/asset-library/palette"
import { resolveRasterConfig } from "../src/core/design/asset-library/raster/config"
import { GeminiImages } from "../src/core/design/asset-library/raster/gemini"
import { composeAssetRequest } from "../src/core/design/asset-library/request"

const SUBJECT = process.argv[2] || "a stainless steel ruler, 150mm, markings visible"
const PROJECT = process.argv[3] || "/Users/apple/dev/test-frontend/test1"

async function main(): Promise<void> {
	const prefsPath = path.join(os.homedir(), "Library/Application Support/Caret/preferences.json")
	const prefs = JSON.parse(await fs.readFile(prefsPath, "utf-8").catch(() => "{}"))
	const config = resolveRasterConfig({
		vertexProject: prefs.vertexProject,
		vertexLocation: prefs.vertexLocation,
	})
	if (!config) {
		console.error("No raster credentials resolved — nothing to probe.")
		process.exit(1)
	}
	console.log(`backend: ${config.backend}`, JSON.stringify(config))

	const tokens = JSON.parse(await fs.readFile(path.join(PROJECT, ".caret/tokens/foundation.json"), "utf-8"))
	const palette = derivePalette(tokens)

	const request = composeAssetRequest(
		{ kind: "image", text: SUBJECT, transparent: true },
		{ palette, aspect: "1:1", variant: 0, tags: [] },
	)
	if (request.lane !== "raster") throw new Error("not a raster request")

	console.log("\n--- PROMPT SENT ---\n" + request.prompt)

	const client = new GeminiImages(config)
	console.log("\ngenerating…")
	const result = await client.generate({ prompt: request.prompt, avoid: request.avoid, aspect: request.aspect })

	if (!result.ok) {
		console.error("\nGENERATION FAILED:", result.reason)
		process.exit(1)
	}

	const out = path.join(os.homedir(), "Desktop", `caret-cutout-probe.${result.mime.includes("png") ? "png" : "jpg"}`)
	await fs.writeFile(out, result.bytes)
	console.log(`\nSAVED: ${out}`)
	console.log(`mime: ${result.mime}  bytes: ${result.bytes.length}  model: ${result.model}`)
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
