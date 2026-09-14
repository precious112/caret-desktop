/**
 * Runs the shipped `removeFlatBackground` over a raw RGBA dump and writes it back.
 *
 * Deliberately the real function rather than a reimplementation: a probe that
 * approximates the algorithm proves nothing about the algorithm.
 */
import { readFileSync, writeFileSync } from "fs"

import { removeFlatBackground } from "../src/core/design/asset-library/raster/cutout"

const [, , input, output, w, h] = process.argv
const data = new Uint8Array(readFileSync(input))
const width = Number(w)
const height = Number(h)

const result = removeFlatBackground({ data, width, height, order: "rgba" })
if (!result.ok) {
	console.error("REFUSED:", result.reason)
	process.exit(1)
}
writeFileSync(output, Buffer.from(data))
console.log(`ACCEPTED — cut ${(result.cut * 100).toFixed(1)}% of the frame`)
