/**
 * A stand-in for Google's image API, for testing the generate screen in the
 * real app without spending anything.
 *
 * The app is pointed at it with `CARET_TEST_IMAGE_SERVICE=<url>` (development
 * builds only), and then every image call goes through Caret's own client,
 * queue, retries and keying exactly as it would to Google. Only the far end
 * is different.
 *
 * Each picture is made on the spot and is visibly different from the last: a
 * colour from the call number and a label naming the call. A call that sends
 * a reference picture gets that picture back, tinted and labelled, so a test
 * can see a branch really started from its parent. A prompt asking for a
 * white background gets a subject on pure white, so keying works on it.
 *
 * Markers in the prompt make it misbehave on purpose:
 * - `[[busy-once]]`: answers 429 the first time, then a picture.
 * - `[[refuse]]`: answers in words with no picture, as a refusal does.
 * - `[[fail]]`: answers 500 every time.
 * - `[[slow]]`: takes four seconds.
 *
 * Every call is recorded (`GET /__calls`) so a test can check exactly what
 * Caret sent: the prompt, the references, the shape.
 */
import { createHash } from "crypto"
import * as http from "http"
import sharp from "sharp"

export interface RecordedCall {
	n: number
	model: string
	prompt: string
	aspect: string
	/** sha256 of each reference picture sent, in order. */
	references: string[]
	status: number
	at: number
}

const SIZES: Record<string, [number, number]> = {
	"1:1": [512, 512],
	"3:2": [612, 408],
	"16:9": [640, 360],
	"4:5": [480, 600],
	"21:9": [672, 288],
	"9:16": [360, 640],
}

function hash(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex")
}

/**
 * A picture for call n. Shapes only, no text: drawing text needs a font
 * cache, which can take minutes to build on a fresh machine and stalls the
 * call. The call number is drawn as a row of blocks instead.
 */
async function makePicture(n: number, aspect: string, prompt: string, reference: Buffer | null): Promise<Buffer> {
	const [width, height] = SIZES[aspect] ?? [512, 512]
	const hue = (n * 67) % 360
	const onWhite = /pure flat white/i.test(prompt)
	const blocks = Array.from(
		{ length: Math.min(n, 12) },
		(_, i) => `<rect x="${16 + i * 22}" y="16" width="16" height="16" fill="${onWhite ? "#555" : "#fff"}"/>`,
	).join("")
	if (reference) {
		const base = await sharp(reference).resize(width, height, { fit: "cover" }).png().toBuffer()
		const overlay = Buffer.from(
			`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
				`<rect width="100%" height="100%" fill="hsl(${hue},70%,50%)" fill-opacity="${onWhite ? 0 : 0.25}"/>` +
				`<rect x="0" y="${height - 12}" width="${width}" height="12" fill="hsl(${hue},70%,40%)"/>${blocks}</svg>`,
		)
		return sharp(base)
			.composite([{ input: overlay }])
			.png()
			.toBuffer()
	}
	const svg = onWhite
		? `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#ffffff"/>` +
			`<circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) * 0.3}" fill="hsl(${hue},65%,45%)"/>${blocks}</svg>`
		: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
			`<stop offset="0" stop-color="hsl(${hue},60%,35%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},60%,60%)"/></linearGradient></defs>` +
			`<rect width="100%" height="100%" fill="url(#g)"/>${blocks}</svg>`
	return sharp(Buffer.from(svg)).png().toBuffer()
}

export async function startFakeImageService(options: { port?: number } = {}): Promise<{
	url: string
	calls(): RecordedCall[]
	reset(): void
	close(): Promise<void>
}> {
	const calls: RecordedCall[] = []
	const busySeen = new Set<string>()
	let n = 0

	const server = http.createServer((req, res) => {
		if (req.method === "GET" && req.url === "/__calls") {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify(calls))
			return
		}
		if (req.method === "POST" && req.url === "/__reset") {
			calls.length = 0
			busySeen.clear()
			res.writeHead(204).end()
			return
		}
		const match = req.url?.match(/\/v1beta\/models\/([^:]+):generateContent/)
		if (req.method !== "POST" || !match) {
			res.writeHead(404).end()
			return
		}
		const chunks: Buffer[] = []
		req.on("data", (chunk) => chunks.push(chunk))
		req.on("end", async () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
			const parts = (body.contents?.[0]?.parts ?? []) as Array<{
				text?: string
				inlineData?: { mimeType: string; data: string }
			}>
			const prompt = parts.find((part) => part.text)?.text ?? ""
			const references = parts.filter((part) => part.inlineData).map((part) => Buffer.from(part.inlineData!.data, "base64"))
			const aspect = body.generationConfig?.imageConfig?.aspectRatio ?? "1:1"
			const record: RecordedCall = {
				n: ++n,
				model: match[1],
				prompt,
				aspect,
				references: references.map(hash),
				status: 200,
				at: Date.now(),
			}
			calls.push(record)
			const reply = (status: number, payload: unknown) => {
				record.status = status
				res.writeHead(status, { "content-type": "application/json" })
				res.end(JSON.stringify(payload))
			}
			try {
				if (prompt.includes("[[fail]]")) return reply(500, { error: { message: "The test service was told to fail." } })
				const busyKey = prompt + references.map(hash).join()
				if (prompt.includes("[[busy-once]]") && !busySeen.has(busyKey)) {
					busySeen.add(busyKey)
					return reply(429, { error: { message: "Resource has been exhausted (test service, once)." } })
				}
				if (prompt.includes("[[refuse]]")) {
					return reply(200, {
						candidates: [{ content: { parts: [{ text: "I can't make that picture (test service refusal)." }] } }],
					})
				}
				if (prompt.includes("[[slow]]")) await new Promise((resolve) => setTimeout(resolve, 4000))
				else await new Promise((resolve) => setTimeout(resolve, 250))
				// The caller gave up (a cancelled take): nothing to answer.
				if (res.destroyed || req.socket.destroyed) return
				const picture = await makePicture(record.n, aspect, prompt, references[0] ?? null)
				reply(200, {
					candidates: [
						{ content: { parts: [{ inlineData: { mimeType: "image/png", data: picture.toString("base64") } }] } },
					],
					usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 1290, totalTokenCount: 1390 },
				})
			} catch (err) {
				reply(500, { error: { message: `test service error: ${err}` } })
			}
		})
	})

	await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve))
	const address = server.address() as { port: number }
	return {
		url: `http://127.0.0.1:${address.port}`,
		calls: () => [...calls],
		reset: () => {
			calls.length = 0
			busySeen.clear()
		},
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	}
}

/** Picture bytes as the service hashes them, for comparing references. */
export function pictureHash(dataUrlOrBase64: string): string {
	const base64 = dataUrlOrBase64.includes(",") ? dataUrlOrBase64.split(",")[1] : dataUrlOrBase64
	return hash(Buffer.from(base64, "base64"))
}

if (process.argv[1]?.endsWith("fake-image-service.ts")) {
	startFakeImageService({ port: Number(process.argv[2]) || 0 }).then((service) =>
		console.log(`fake image service at ${service.url}`),
	)
}
