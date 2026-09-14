/**
 * One real call to the raster lane, against a real model.
 *
 * The unit tests prove the adapter's shape against a mocked fetch. They cannot
 * prove that the endpoint exists, that the API is enabled on the project, that
 * ADC has the right scope, or that the model returns pixels rather than prose —
 * and every one of those has a distinct failure the user would otherwise meet
 * first. This is the cheapest thing that answers all four.
 *
 *   npx tsx scripts/probe-gemini.ts                       # Vertex via ADC
 *   npx tsx scripts/probe-gemini.ts --key $GEMINI_API_KEY # the shipped path
 *   npx tsx scripts/probe-gemini.ts --project P --location global
 *
 * It writes the image it gets back so the result can be *looked at*, which is
 * the only check that distinguishes "the call succeeded" from "the picture is
 * any good".
 */
import { execFileSync } from "child_process"
import * as fs from "fs/promises"
import * as path from "path"

import { GeminiImages } from "../src/core/design/asset-library/raster/gemini"
import { SLOP_TELLS } from "../src/core/design/asset-library/recipes"

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`)
	return index > -1 ? process.argv[index + 1] : undefined
}

/** The project `gcloud` is already pointed at, so the probe needs no arguments. */
function gcloudProject(): string | undefined {
	try {
		const value = execFileSync("gcloud", ["config", "get-value", "project"], { encoding: "utf-8" }).trim()
		return value && value !== "(unset)" ? value : undefined
	} catch {
		return undefined
	}
}

async function main(): Promise<void> {
	const apiKey = arg("key") ?? process.env.GEMINI_API_KEY
	const backend = apiKey ? "api-key" : "vertex"
	const project = arg("project") ?? process.env.GOOGLE_CLOUD_PROJECT ?? gcloudProject()
	const location = arg("location") ?? process.env.GOOGLE_CLOUD_LOCATION ?? "global"

	const client = new GeminiImages({ backend, apiKey, project, location, model: "flash-image" })

	const request = {
		// Deliberately a recipe-shaped prompt rather than a one-liner: what is
		// being checked is the request this lane will actually send.
		prompt:
			"An overhead photograph of a worn wooden workbench under low, warm side light. " +
			"Shallow depth of field, muted warm neutrals, deliberate empty space in the top-left third " +
			"so a headline can sit there. Shot on 35mm, natural imperfections left in.",
		avoid: SLOP_TELLS,
		aspect: "16:9",
	}

	const resolved = client.resolve(request)
	console.log(`backend  ${backend}${backend === "vertex" ? ` (${project} / ${location})` : ""}`)
	console.log(`model    ${resolved.model}`)
	console.log(`endpoint ${resolved.url}`)
	console.log("")

	const started = Date.now()
	const result = await client.generate(request)
	const seconds = ((Date.now() - started) / 1000).toFixed(1)

	if (!result.ok) {
		console.error(`FAILED after ${seconds}s${result.retryable ? " (retryable)" : ""}`)
		console.error(result.reason)
		process.exit(1)
	}

	const extension = result.mime.includes("jpeg") ? ".jpg" : result.mime.includes("webp") ? ".webp" : ".png"
	const out = path.resolve(arg("out") ?? `release/verify-shots/gemini-probe${extension}`)
	await fs.mkdir(path.dirname(out), { recursive: true })
	await fs.writeFile(out, result.bytes)

	console.log(`OK in ${seconds}s — ${result.bytes.length} bytes of ${result.mime}`)
	console.log(`wrote ${out}`)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
