/**
 * Runs the REAL matte worker — the same source string the app writes, spawned
 * the same way (system node) — over a raw RGBA dump, TWICE through one
 * worker.
 *
 * Twice is the point: the field failures were second-run failures. The
 * in-process version crashed the app on the first cutout; the
 * ELECTRON_RUN_AS_NODE version passed its first inference and SIGTRAPed on
 * the second, so a probe that sends one job certifies nothing about a
 * resident worker.
 *
 *   npx tsx scripts/probe-matte-worker.ts in.rgba out.rgba WIDTH HEIGHT
 */
import { spawn } from "child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "fs"
import { createRequire } from "module"
import { homedir, tmpdir } from "os"
import * as path from "path"

import { MATTE_WORKER_SOURCE } from "../desktop/main/matte-worker-source"
import { applyMatte, MATTE_MODEL, matteInputTensor } from "../src/core/design"

const nativeRequire = createRequire(import.meta.url)

async function main() {
	const [, , input, output, w, h] = process.argv
	const width = Number(w)
	const height = Number(h)
	const image = { data: new Uint8Array(readFileSync(input)), width, height, order: "rgba" as const }

	const scratch = mkdtempSync(path.join(tmpdir(), "matte-probe-"))
	const workerPath = path.join(scratch, "matte-worker.cjs")
	writeFileSync(workerPath, MATTE_WORKER_SOURCE)

	const child = spawn("node", [workerPath], { stdio: ["pipe", "pipe", "inherit"] })
	child.on("exit", (code, signal) => {
		console.error(`the worker died (${signal ?? code}) — the resident shape does not hold`)
		process.exit(1)
	})

	const replies: Array<(reply: { ok: boolean; stage?: string; reason?: string }) => void> = []
	let buffered = ""
	child.stdout.on("data", (chunk: Buffer) => {
		buffered += chunk.toString()
		let cut = buffered.indexOf("\n")
		while (cut >= 0) {
			const line = buffered.slice(0, cut)
			buffered = buffered.slice(cut + 1)
			cut = buffered.indexOf("\n")
			replies.shift()?.(JSON.parse(line))
		}
	})

	const side = MATTE_MODEL.input
	const tensor = matteInputTensor(image, side)

	const runOnce = async (round: number): Promise<Float32Array> => {
		const tensorFile = path.join(scratch, `job-${round}.in`)
		const maskFile = path.join(scratch, `job-${round}.out`)
		writeFileSync(tensorFile, Buffer.from(tensor.buffer, tensor.byteOffset, tensor.byteLength))
		const started = Date.now()
		const reply = await new Promise<{ ok: boolean; stage?: string; reason?: string }>((resolve) => {
			replies.push(resolve)
			child.stdin.write(
				`${JSON.stringify({
					id: `probe-${round}`,
					ortPath: nativeRequire.resolve("onnxruntime-node"),
					modelPath: path.join(homedir(), "Library", "Application Support", "Caret", "models", MATTE_MODEL.name),
					tensorFile,
					maskFile,
					side,
				})}\n`,
			)
		})
		console.log(`round ${round} replied in ${((Date.now() - started) / 1000).toFixed(1)}s:`, JSON.stringify(reply))
		if (!reply.ok) process.exit(1)
		const raw = readFileSync(maskFile)
		return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length))
	}

	// The second round through the SAME worker is the regression under test.
	await runOnce(1)
	const mask = await runOnce(2)

	const result = applyMatte(image, mask, side)
	child.removeAllListeners("exit")
	child.stdin.end()
	if (!result.ok) {
		console.error("REFUSED:", result.reason)
		process.exit(1)
	}
	writeFileSync(output, Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength))
	console.log(`ACCEPTED after two rounds in one worker — cut ${(result.cut * 100).toFixed(1)}% of the frame`)
	process.exit(0)
}

void main()
