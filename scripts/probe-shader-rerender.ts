/**
 * Re-renders every shader already in the gallery against the CURRENT scaffold.
 *
 *   npx tsx scripts/probe-shader-rerender.ts
 *
 * The helpers are Caret's, not the model's, so improving them improves every
 * shader ever authored against them — exactly as it will in a real project,
 * where instances import the runner rather than embedding a copy of it. This
 * proves that property and costs nothing: the GLSL bodies are already on disk,
 * so no model turn is spent.
 */
import * as fs from "fs/promises"
import * as path from "path"

import { SHADER_CRITIQUE_TIMES } from "../src/core/design/asset-library/shader/authoring"
import { validateFragmentBody, validateUniformManifest } from "../src/core/design/asset-library/shader/preamble"
import { FRAME_SIZE, GALLERY_OUT, liveHtml, POSTER_SIZE, renderShader, writeGalleryIndex } from "./shader-render"

async function main(): Promise<void> {
	const dirents = await fs.readdir(GALLERY_OUT, { withFileTypes: true })
	let ok = 0
	let failed = 0

	for (const dirent of dirents) {
		if (!dirent.isDirectory()) continue
		const dir = path.join(GALLERY_OUT, dirent.name)
		const metaPath = path.join(dir, "shader.json")

		let meta: { brief: string; body: string; uniforms: unknown; rounds?: number; model?: string }
		try {
			meta = JSON.parse(await fs.readFile(metaPath, "utf-8"))
		} catch {
			continue
		}

		// Re-validated, not trusted: the body was written by a model and the
		// contract may have tightened since it was accepted.
		const bodyCheck = validateFragmentBody(meta.body)
		const manifest = validateUniformManifest(meta.uniforms)
		if (!bodyCheck.ok || !manifest.ok) {
			console.log(
				`✗ ${dirent.name}: no longer valid (${!bodyCheck.ok ? bodyCheck.reason : !manifest.ok ? manifest.reason : ""})`,
			)
			failed += 1
			continue
		}

		const shader = { body: meta.body, uniforms: manifest.uniforms }
		const frames = await renderShader(shader, FRAME_SIZE, SHADER_CRITIQUE_TIMES)
		if (!frames.ok) {
			console.log(`✗ ${dirent.name}: ${(frames.error ?? "").split("\n")[0]}`)
			failed += 1
			continue
		}

		for (const [index, frame] of frames.frames.entries()) {
			await fs.writeFile(path.join(dir, `frame-${SHADER_CRITIQUE_TIMES[index]}s.png`), frame)
		}
		const poster = await renderShader(shader, POSTER_SIZE, [2.0])
		if (poster.ok && poster.frames[0]) await fs.writeFile(path.join(dir, "poster.png"), poster.frames[0])
		await fs.writeFile(path.join(dir, "live.html"), liveHtml(shader), "utf-8")
		await fs.writeFile(metaPath, JSON.stringify({ ...meta, range: frames.range }, null, 2))

		const range = frames.range ? `${frames.range.min}..${frames.range.max}` : "?"
		console.log(`✓ ${dirent.name.slice(0, 46).padEnd(48)} range ${range}`)
		ok += 1
	}

	const total = await writeGalleryIndex()
	console.log(`\n${ok} re-rendered, ${failed} failed. index.html lists ${total}.`)
	console.log(`open ${path.join(GALLERY_OUT, "index.html")}`)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
