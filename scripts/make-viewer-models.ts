/**
 * Produces a draft/optimized model pair for the learning viewer.
 *
 * The same pipeline the app runs — object-study image on Gemini, Tripo draft,
 * the LLM's optimization decision, Tripo convert — but saving every artifact to
 * disk, because the point of the viewer is comparing the two models the app
 * only reports as numbers.
 *
 *   npx tsx scripts/make-viewer-models.ts [--variant 2] [--out <dir>]
 */
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { FoundationTokens } from "../src/core/design"
import {
	composeVariants,
	convertWithinBudget,
	decideOptimization,
	derivePalette,
	disposeBackends,
	findAssetRecipe,
	GeminiImages,
	getBackend,
	resolveRasterConfig,
	resolveTripoConfig,
	TripoClient,
} from "../src/core/design"

const variantIndex = Number(process.argv[process.argv.indexOf("--variant") + 1] || 2)
const outIndex = process.argv.indexOf("--out")
const OUT = path.resolve(
	outIndex > -1 ? process.argv[outIndex + 1] : path.join(os.homedir(), "dev/self-learning/caret-learning/models"),
)

const tokens: FoundationTokens = {
	vibe: { description: "", tags: [] },
	color: {
		brand: { seed: "#2563eb", scale: {} },
		neutral: { character: "cool", scale: {} },
		semantic: { success: "#16a34a", warning: "#ca8a04", error: "#dc2626", info: "#2563eb" },
		surface: "light",
	},
	typography: { fontFamily: "Inter", fallback: "system-ui", scaleRatio: 1.25, baseSize: 16, scale: {} },
	spacing: { baseUnit: 4, scale: [0, 4, 8] },
	radius: { character: "soft", scale: [0, 4, 8] },
}

async function main(): Promise<void> {
	await fs.mkdir(OUT, { recursive: true })

	const tripoConfig = resolveTripoConfig({
		apiKey: await fs.readFile(path.join(os.homedir(), ".caret-tripo-key"), "utf-8").then(
			(value) => value.trim(),
			() => undefined,
		),
	})
	if (!tripoConfig) throw new Error("no Tripo key — ~/.caret-tripo-key or TRIPO_API_KEY")
	const tripo = new TripoClient(tripoConfig)

	// 1. The source image, through the same recipe the app uses.
	const recipe = findAssetRecipe("object-study")
	if (!recipe) throw new Error("no object-study recipe")
	const [variant] = composeVariants({ recipe, tokens, aspect: "1:1", count: variantIndex + 1 }).slice(variantIndex)
	if (variant.request.lane !== "raster") throw new Error("object-study is not raster")

	// --reuse-source skips Gemini when a saved source exists: iterating on the
	// optimization should not regenerate the object being optimized.
	const sourceFile = path.join(OUT, "source.png")
	let sourceBytes: Buffer
	if (process.argv.includes("--reuse-source")) {
		sourceBytes = await fs.readFile(sourceFile)
		console.log(`reusing source: ${Math.round(sourceBytes.length / 1024)}KB`)
	} else {
		const gemini = new GeminiImages(resolveRasterConfig() ?? { backend: "vertex", project: process.env.CARET_VERTEX_PROJECT })
		console.log("generating the source image…")
		const image = await gemini.generate({
			prompt: variant.request.prompt,
			avoid: variant.request.avoid,
			aspect: "1:1",
		})
		if (!image.ok) throw new Error(`source image: ${image.reason}`)
		sourceBytes = image.bytes
		await fs.writeFile(sourceFile, sourceBytes)
		console.log(`source: ${Math.round(sourceBytes.length / 1024)}KB → ${sourceFile}`)
	}

	// 2. The draft.
	const uploaded = await tripo.uploadImage(sourceBytes, "image/png")
	if (!uploaded.ok) throw new Error(`upload: ${uploaded.reason}`)
	console.log("tripo is building the draft…")
	const draft = await tripo.imageToModel(uploaded.value, "image/png", (update) =>
		process.stdout.write(`\r  ${update.stage} ${update.percent ?? ""}%   `),
	)
	if (!draft.ok) throw new Error(`draft: ${draft.reason}`)
	await fs.writeFile(path.join(OUT, "draft.glb"), draft.value.bytes)
	console.log(`\ndraft: ${Math.round(draft.value.bytes.length / 1024)}KB`)

	// 3. The decision, on the real backend.
	const backend = await getBackend("opencode")
	if (!backend) throw new Error("no bundled backend")
	console.log("asking the model how far to optimize…")
	const decision = await decideOptimization({
		backend,
		workingDirectory: process.cwd(),
		draftBytes: draft.value.bytes.length,
		intendedUse: "a decorative 3D object embedded in a product web page",
		sourceDescription: variant.request.prompt.slice(0, 120),
	})
	console.log(`decision: ${decision.faceLimit} faces, ${decision.textureSize}px — ${decision.reason}`)

	// 4. The optimized model, held to the 3–5MB band.
	console.log("tripo is applying it…")
	const optimized = await convertWithinBudget(tripo, draft.value.taskId, decision, (update) =>
		process.stdout.write(`\r  ${update.stage} ${update.percent ?? ""}%   `),
	)
	if (!optimized.ok) throw new Error(`\nconvert: ${optimized.reason}`)
	await fs.writeFile(path.join(OUT, "optimized.glb"), optimized.value.bytes)
	console.log(`\noptimized: ${Math.round(optimized.value.bytes.length / 1024)}KB`)
	if (optimized.value.corrected) console.log(`corrected: ${optimized.value.corrected}`)

	await fs.writeFile(
		path.join(OUT, "meta.json"),
		JSON.stringify(
			{
				subject: variant.request.prompt.split(",")[0],
				draftBytes: draft.value.bytes.length,
				optimizedBytes: optimized.value.bytes.length,
				decision: optimized.value.applied,
				corrected: optimized.value.corrected ?? null,
				// So the next tweak re-converts from this draft (~5 credits) instead
				// of paying for a whole new image_to_model (~25).
				draftTaskId: draft.value.taskId,
				palette: derivePalette(tokens),
			},
			null,
			2,
		),
	)
	console.log(`done — artifacts in ${OUT}`)
}

main()
	.catch((err) => {
		console.error(err)
		process.exitCode = 1
	})
	.finally(() => disposeBackends().catch(() => {}))
