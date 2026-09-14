/**
 * Can this model actually see an image?
 *
 * Asked by experiment rather than answered from a list, and the reason is a bug
 * this project shipped: the Claude adapter appended
 * `"(Caret attached 2 screenshot(s).)"` to the prompt and discarded the images,
 * so every caller believed it had sent a picture and the model confidently
 * described one it had never seen. A hardcoded capability table would have said
 * "yes, Claude sees images" and been right about the model and wrong about the
 * path the image took — which is the failure that matters.
 *
 * So the probe tests the **whole path**: adapter, transport, provider, model. A
 * flat square in a colour chosen at random, and a model that cannot see it has
 * an explicit `NO-IMAGE` answer available, so a wrong answer is a wrong answer
 * rather than a refusal misread as a failure.
 *
 * One tiny turn, cached by backend and model. The cache is the caller's — this
 * module has no storage, because the design core does not own preferences.
 */
import { deflateSync } from "zlib"

import type { CodingBackend } from "./backend"

/** Colours far enough apart that a wrong answer is unambiguous. */
const COLOURS: Array<{ name: string; rgb: [number, number, number] }> = [
	{ name: "red", rgb: [220, 30, 30] },
	{ name: "green", rgb: [30, 170, 60] },
	{ name: "blue", rgb: [30, 60, 220] },
	{ name: "yellow", rgb: [235, 205, 40] },
	{ name: "purple", rgb: [130, 40, 190] },
]

export type VisionVerdict =
	| { sees: true }
	/** Named so the surface can say what to do, not merely that something failed. */
	| { sees: false; reason: string }

export interface VisionProbeOptions {
	backend: CodingBackend
	workingDirectory: string
	model?: string
	/** Injected in tests so the expected answer is not a coin flip. */
	pick?: number
}

/**
 * Sends one image and asks what colour it is.
 *
 * Read-only and toolless by construction — it is a question, not work — and the
 * session is closed whatever happens, because a leaked session on some backends
 * keeps an agent loop polling a provider indefinitely.
 */
export async function probeVision(options: VisionProbeOptions): Promise<VisionVerdict> {
	const chosen = COLOURS[(options.pick ?? Math.floor(Math.random() * COLOURS.length)) % COLOURS.length]
	const png = solidPng(256, 256, chosen.rgb)

	let session: Awaited<ReturnType<CodingBackend["startSession"]>> | null = null
	let answer = ""
	let failure = ""

	try {
		session = await options.backend.startSession({
			workingDirectory: options.workingDirectory,
			mode: "read-only",
			model: options.model,
			title: "caret vision check",
		})

		for await (const event of session.send({
			text: "One word only. What colour is the attached image? If no image reached you, reply exactly: NO-IMAGE",
			images: [`data:image/png;base64,${png.toString("base64")}`],
		})) {
			if (event.type === "text" || event.type === "done") answer += event.text
			if (event.type === "error") failure ||= event.message
		}
	} catch (err) {
		return { sees: false, reason: `The check could not run: ${err instanceof Error ? err.message : String(err)}` }
	} finally {
		await session?.close().catch(() => {})
	}

	if (answer.trim().toLowerCase().includes(chosen.name)) return { sees: true }

	return {
		sees: false,
		reason: failure
			? `This model could not be shown an image: ${failure}`
			: `This model did not see an image Caret sent it — asked to name the colour of a plain ${chosen.name} square, it answered "${answer.trim().slice(0, 60) || "nothing"}". Pick a model that accepts images.`,
	}
}

/**
 * A flat PNG of one colour.
 *
 * Written out rather than pulled from a dependency: the design core is
 * host-free by construction, and this needs to work identically in a unit test,
 * in the app, and in a script.
 */
export function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
	const table = Array.from({ length: 256 }, (_, n) => {
		let c = n
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		return c >>> 0
	})
	const crc = (buffer: Buffer) => {
		let c = 0xffffffff
		for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8)
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
