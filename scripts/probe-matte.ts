/**
 * Runs the real BiRefNet cutout over a raw RGBA dump and writes it back.
 *
 * The unit tests hold down the maths; this holds down the model — the shipped
 * weights, the shipped preprocessing, the shipped unmixing, over a real
 * generation. Usage:
 *
 *   npx tsx scripts/probe-matte.ts in.rgba out.rgba WIDTH HEIGHT [modelPath]
 *
 * The model path defaults to where the app downloads it.
 */
import { readFileSync, writeFileSync } from "fs"
import { createRequire } from "module"
import { homedir } from "os"
import * as path from "path"

import { applyMatte, MATTE_MODEL, matteInputTensor } from "../src/core/design"

async function main() {
	const [, , input, output, w, h, modelArg] = process.argv
	const width = Number(w)
	const height = Number(h)
	const modelPath = modelArg ?? path.join(homedir(), "Library", "Application Support", "Caret", "models", MATTE_MODEL.name)

	const data = new Uint8Array(readFileSync(input))
	const image = { data, width, height, order: "rgba" as const }

	const ort = createRequire(import.meta.url)("onnxruntime-node")
	const started = Date.now()
	// "basic" is load-bearing: "all" and "disabled" both fail shape inference
	// on this export. See matte-infer.ts.
	const session = await ort.InferenceSession.create(modelPath, { graphOptimizationLevel: "basic" })
	console.log(
		`session open in ${((Date.now() - started) / 1000).toFixed(1)}s (input: ${session.inputNames}, output: ${session.outputNames})`,
	)

	const side = MATTE_MODEL.input
	const tensor = matteInputTensor(image, side)
	const ranAt = Date.now()
	const results = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", tensor, [1, 3, side, side]) })
	const mask = results[session.outputNames[0]].data as Float32Array
	console.log(`inference in ${((Date.now() - ranAt) / 1000).toFixed(1)}s`)

	const result = applyMatte(image, mask, side)
	if (!result.ok) {
		console.error("REFUSED:", result.reason)
		process.exit(1)
	}
	writeFileSync(output, Buffer.from(data.buffer, data.byteOffset, data.byteLength))
	console.log(`ACCEPTED — cut ${(result.cut * 100).toFixed(1)}% of the frame`)
}

void main()
