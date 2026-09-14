/**
 * Finishes the interrupted viewer pipeline from its saved state.
 *
 *   npx tsx scripts/finish-viewer-model.ts
 *
 * The last run built and paid for the draft, got the optimizer's decision, and
 * then hit Tripo's credit floor on the convert. The draft's task id and the
 * decision are in `models/pending.json`, so once credits exist again this runs
 * **only the convert** (~5–10 credits) instead of re-paying for the whole
 * pipeline — which is the entire reason task ids started being saved.
 */
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { FoundationTokens, OptimizationDecision } from "../src/core/design"
import { convertWithinBudget, derivePalette, resolveTripoConfig, TripoClient } from "../src/core/design"

const OUT = path.join(os.homedir(), "dev/self-learning/caret-learning/models")

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

interface Pending {
	draftTaskId: string
	draftBytes: number
	subject: string
	decision: OptimizationDecision
}

async function main(): Promise<void> {
	const pending = JSON.parse(await fs.readFile(path.join(OUT, "pending.json"), "utf-8")) as Pending

	const config = resolveTripoConfig({
		apiKey: await fs.readFile(path.join(os.homedir(), ".caret-tripo-key"), "utf-8").then(
			(value) => value.trim(),
			() => undefined,
		),
	})
	if (!config) throw new Error("no Tripo key")
	const tripo = new TripoClient(config)

	console.log(`resuming from draft task ${pending.draftTaskId}`)
	console.log(`decision: ${pending.decision.faceLimit} faces, ${pending.decision.textureSize}px`)

	const optimized = await convertWithinBudget(tripo, pending.draftTaskId, pending.decision, (update) =>
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
				subject: pending.subject,
				draftBytes: pending.draftBytes,
				optimizedBytes: optimized.value.bytes.length,
				decision: optimized.value.applied,
				corrected: optimized.value.corrected ?? null,
				draftTaskId: pending.draftTaskId,
				palette: derivePalette(tokens),
			},
			null,
			2,
		),
	)
	await fs.rm(path.join(OUT, "pending.json"), { force: true })
	console.log("done — run scripts/build-model-viewer.ts next")
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
