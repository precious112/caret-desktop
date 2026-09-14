/**
 * Does this backend actually pass an image to the model?
 *
 *   npx tsx scripts/probe-vision.ts [opencode] [--model <id>]
 *
 * The question is not academic. A removed Claude adapter used to append
 * `"(Caret attached 2 screenshot(s).)"` to the prompt and then discard them, so
 * every caller believed it had sent a picture and the model confidently
 * described one it had never seen. The overlay editor shipped on top of that.
 *
 * The test is designed so a model **cannot** pass by guessing: it is shown a
 * flat rectangle in a colour picked at random from a set no prompt mentions, and
 * asked to name it. Right answer means the pixels arrived. Wrong answer, or a
 * refusal, means they did not — and either way the loop that depends on this
 * should say so rather than run blind.
 */
import { deflateSync } from "zlib"

import { disposeBackends, getBackend } from "../src/core/design/agent/registry"

/** Colours far enough apart that a wrong answer is unambiguous. */
const COLOURS: Array<{ name: string; rgb: [number, number, number] }> = [
	{ name: "red", rgb: [220, 30, 30] },
	{ name: "green", rgb: [30, 170, 60] },
	{ name: "blue", rgb: [30, 60, 220] },
	{ name: "yellow", rgb: [235, 205, 40] },
	{ name: "purple", rgb: [130, 40, 190] },
]

/** A flat PNG of one colour, built by hand so this needs no image library. */
function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		return c >>> 0
	})
	const crc = (buffer: Buffer) => {
		let c = 0xffffffff
		for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
		return (c ^ 0xffffffff) >>> 0
	}
	const chunk = (type: string, data: Buffer) => {
		const length = Buffer.alloc(4)
		length.writeUInt32BE(data.length)
		const body = Buffer.concat([Buffer.from(type, "ascii"), data])
		const checksum = Buffer.alloc(4)
		checksum.writeUInt32BE(crc(body))
		return Buffer.concat([length, body, checksum])
	}

	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(width, 0)
	ihdr.writeUInt32BE(height, 4)
	ihdr[8] = 8
	ihdr[9] = 2

	const raw = Buffer.alloc(height * (width * 3 + 1))
	for (let y = 0; y < height; y++) {
		const row = y * (width * 3 + 1)
		raw[row] = 0
		for (let x = 0; x < width; x++) {
			raw[row + 1 + x * 3] = r
			raw[row + 2 + x * 3] = g
			raw[row + 3 + x * 3] = b
		}
	}

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	])
}

async function main(): Promise<void> {
	const id = (process.argv[2] ?? "opencode") as "opencode"
	const modelIndex = process.argv.indexOf("--model")
	const model = modelIndex > -1 ? process.argv[modelIndex + 1] : undefined

	const backend = await getBackend(id)
	if (!backend) {
		console.error(`No such backend: ${id}`)
		process.exit(1)
	}

	const availability = await backend.availability()
	console.log(`backend  ${backend.displayName} — ${availability.detail}`)
	if (!availability.ready) process.exit(1)

	// Chosen here rather than fixed, so a model that memorised a previous run
	// still cannot pass without looking.
	const chosen = COLOURS[Math.floor(Math.random() * COLOURS.length)]
	const png = solidPng(256, 256, chosen.rgb)
	console.log(`model    ${model ?? "(backend default)"}`)
	console.log(`showing  a flat ${chosen.name} square (${png.length} bytes)\n`)

	const session = await backend.startSession({
		workingDirectory: process.cwd(),
		mode: "read-only",
		model,
		title: "caret vision probe",
	})

	let answer = ""
	try {
		for await (const event of session.send({
			text: "One word only. What colour is the attached image? If no image reached you, reply exactly: NO-IMAGE",
			images: [`data:image/png;base64,${png.toString("base64")}`],
		})) {
			if (event.type === "text" || event.type === "done") answer += event.text
			if (event.type === "error") console.error(`error: ${event.message}`)
		}
	} finally {
		await session.close().catch(() => {})
		// Against the opencode backend, close() ends the session but the server
		// child survives — and a leaked agent loop polls the provider forever.
		await disposeBackends().catch(() => {})
	}

	const said = answer.trim().toLowerCase()
	console.log(`answered "${answer.trim().slice(0, 120)}"`)

	if (said.includes(chosen.name)) {
		console.log(`\nPASS — the pixels reached the model.`)
		process.exit(0)
	}
	console.log(`\nFAIL — expected "${chosen.name}". This backend does not pass images to this model.`)
	process.exit(1)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
