/**
 * Real compression for a glb: Draco geometry + WebP textures, via
 * gltf-transform under SYSTEM NODE.
 *
 * This replaced Tripo's convert as the default shrinker because the two do
 * different things and only one of them is honest about it. Measured on the
 * bottle experiment (2026-08-31): the untouched 57MB draft compressed to
 * 4.6MB visually identical — inside the 3–5MB weight band — while Tripo's
 * convert at a similar size melted the label print and lumped the glass
 * ("cheap icing"). Compression encodes the same detail smaller; conversion
 * destroys detail to fit. Simplify stays OFF for the same reason.
 *
 * System node, not this process, for both of this file's native deps (sharp,
 * draco) — the same allocator lesson the matte worker paid for: Electron's
 * PartitionAlloc shim SIGTRAPs on native allocation patterns it dislikes,
 * and node is already a hard requirement of the design shell.
 */
import { spawn } from "child_process"
import * as fs from "fs/promises"
import { createRequire } from "module"
import * as os from "os"
import * as path from "path"

import { systemSpawnEnv } from "../../src/core/design/spawn-env"
import { Logger } from "../../src/shared/services/Logger"

const requireNative = createRequire(import.meta.url)

function cliPath(): string {
	// The package's `exports` hides package.json, so locate the bin from the
	// resolved entry (dist/cli.mjs) instead.
	const entry = requireNative.resolve("@gltf-transform/cli")
	return path.join(path.dirname(entry), "..", "bin", "cli.js")
}

export async function compressGlb(input: Buffer): Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: string }> {
	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "caret-glb-"))
	const inFile = path.join(scratch, "in.glb")
	const outFile = path.join(scratch, "out.glb")
	try {
		await fs.writeFile(inFile, input)
		const started = Date.now()
		const result = await new Promise<{ code: number | null; output: string }>((resolve) => {
			const child = spawn(
				"node",
				[
					cliPath(),
					"optimize",
					inFile,
					outFile,
					"--compress",
					"draco",
					"--texture-compress",
					"webp",
					"--simplify",
					"false",
				],
				{ stdio: ["ignore", "pipe", "pipe"], env: systemSpawnEnv() },
			)
			let output = ""
			child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()))
			child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()))
			child.on("error", (error) => resolve({ code: null, output: error.message }))
			child.on("exit", (code) => resolve({ code, output }))
		})
		if (result.code !== 0) {
			return { ok: false, reason: `gltf-transform exited ${result.code}: ${result.output.slice(-300)}` }
		}
		const bytes = await fs.readFile(outFile)
		Logger.info(
			`[glb] compressed ${Math.round(input.length / 1024)}KB → ${Math.round(bytes.length / 1024)}KB in ${((Date.now() - started) / 1000).toFixed(1)}s`,
		)
		return { ok: true, bytes }
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) }
	} finally {
		await fs.rm(scratch, { recursive: true, force: true }).catch(() => {})
	}
}
