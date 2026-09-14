import { describe, it } from "mocha"
import "should"

import { mockFetchForTesting } from "@/shared/net"
import { composePrompt, configureRasterPacing, GeminiImages } from "../asset-library/raster/gemini"

const request = {
	prompt: "An overhead photograph of a wooden workbench, low warm light, empty space top-left.",
	avoid: ["no lens flare", "no fake UI"],
	aspect: "16:9",
}

/** A `Response` shaped like the provider's, without reaching the network. */
function reply(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

const IMAGE_REPLY = {
	candidates: [
		{
			content: {
				parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from("pretend-png").toString("base64") } }],
			},
		},
	],
}

describe("the Gemini image adapter", () => {
	// Real pacing sleeps for minutes across the retry budget; tests exercise the
	// logic, not the clock.
	before(() => configureRasterPacing({ minSpacingMs: 0, backoffMs: [0, 0, 0, 0], jitter: 0 }))
	after(() => configureRasterPacing({ minSpacingMs: 6_000, backoffMs: [4_000, 10_000, 20_000, 40_000], jitter: 0.2 }))

	it("routes Vertex at the project and location, and the API key at the public host", () => {
		const vertex = new GeminiImages({ backend: "vertex", project: "proj-1", location: "global" })
		vertex
			.resolve(request)
			.url.should.equal(
				"https://aiplatform.googleapis.com/v1/projects/proj-1/locations/global/publishers/google/models/gemini-3.1-flash-image:generateContent",
			)

		// A regional prefix on `global` is a 404 that reads like the model does not
		// exist, which is the least useful failure available. The reverse is also
		// true and newer: Vertex serves the Gemini 3 image models ONLY on global,
		// so a configured region is overridden for them and honoured for the rest.
		const regional = new GeminiImages({
			backend: "vertex",
			project: "proj-1",
			location: "us-central1",
			model: "flash-image-legacy",
		})
		regional.resolve(request).url.should.startWith("https://us-central1-aiplatform.googleapis.com/")

		const regionalOnNew = new GeminiImages({ backend: "vertex", project: "proj-1", location: "us-central1" })
		regionalOnNew.resolve(request).url.should.containEql("/locations/global/")

		const key = new GeminiImages({ backend: "api-key", apiKey: "k" })
		key.resolve(request).url.should.startWith("https://generativelanguage.googleapis.com/")
	})

	it("refuses a configuration that cannot run, before spending anything", async () => {
		const noKey = new GeminiImages({ backend: "api-key" })
		const result = await noKey.generate(request)
		result.ok.should.be.false()
		// The refusal has to say the rest of the phase still works without a key,
		// or it reads as "generation is broken".
		;(result as { reason: string }).reason.should.match(/every other kind of asset does not/)

		const noProject = await new GeminiImages({ backend: "vertex" }).generate(request)
		noProject.ok.should.be.false()
		;(noProject as { reason: string }).reason.should.match(/no Google Cloud project/)
	})

	it("appends the slop constraints as their own block, never woven in", () => {
		const composed = composePrompt(request)
		composed.should.startWith(request.prompt)
		composed.should.endWith("Do not include: no lens flare; no fake UI.")
		// Legibility in the provenance record is the point: somebody reading
		// origin.resolved months later can see exactly what was ruled out.
		composePrompt({ ...request, avoid: [] }).should.equal(request.prompt)
	})

	it("asks for an image explicitly and passes the aspect through", async () => {
		let sent: Record<string, unknown> = {}
		await mockFetchForTesting(
			async (_input, init) => {
				sent = JSON.parse(String(init?.body)) as Record<string, unknown>
				return reply(IMAGE_REPLY)
			},
			async () => {
				await new GeminiImages({ backend: "api-key", apiKey: "k" }).generate(request)
			},
		)

		const config = sent.generationConfig as { responseModalities: string[]; imageConfig: { aspectRatio: string } }
		// Without this these models answer a picture request in prose, which reads
		// downstream as "no image" with no sign that none was ever coming.
		config.responseModalities.should.containEql("IMAGE")
		config.imageConfig.aspectRatio.should.equal("16:9")
	})

	it("returns the decoded pixels and what produced them", async () => {
		const result = await mockFetchForTesting(
			async () => reply(IMAGE_REPLY),
			async () => new GeminiImages({ backend: "api-key", apiKey: "k" }).generate(request),
		)

		result.ok.should.be.true()
		const success = result as { mime: string; bytes: Buffer; model: string; resolved: string }
		success.mime.should.equal("image/png")
		success.bytes.toString().should.equal("pretend-png")
		success.model.should.equal("gemini-3.1-flash-image")
		success.resolved.should.containEql("Do not include:")
	})

	it("carries the provider's usage report for provenance, and tolerates its absence", async () => {
		const metered = await mockFetchForTesting(
			async () =>
				reply({
					...IMAGE_REPLY,
					usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 1290, totalTokenCount: 1410 },
				}),
			async () => new GeminiImages({ backend: "api-key", apiKey: "k" }).generate(request),
		)
		metered.ok.should.be.true()
		const usage = (metered as { usage?: { promptTokens: number; outputTokens: number; totalTokens: number } }).usage
		usage!.totalTokens.should.equal(1410)
		usage!.outputTokens.should.equal(1290)

		// A provider that sends no meter yields no usage — never a zero that would
		// be recorded in provenance as "this was free".
		const unmetered = await mockFetchForTesting(
			async () => reply(IMAGE_REPLY),
			async () => new GeminiImages({ backend: "api-key", apiKey: "k" }).generate(request),
		)
		unmetered.ok.should.be.true()
		Boolean((unmetered as { usage?: unknown }).usage).should.be.false()
	})

	it("carries the provider's own words through, rather than paraphrasing them", async () => {
		const result = await mockFetchForTesting(
			async () =>
				reply({ error: { message: "Vertex AI API has not been used in project 1 before or it is disabled." } }, 403),
			async () => new GeminiImages({ backend: "api-key", apiKey: "k" }).generate(request),
		)

		result.ok.should.be.false()
		// "has not been used ... or it is disabled" is the single most common first
		// failure, and it tells the user precisely what to click. A paraphrase loses it.
		;(result as { reason: string }).reason.should.containEql("has not been used")
		;(result as { retryable: boolean }).retryable.should.be.false()
	})

	it("marks quota and upstream failures retryable, and refusals not", async () => {
		const quota = await mockFetchForTesting(
			async () => reply({ error: { message: "Quota exceeded" } }, 429),
			async () => new GeminiImages({ backend: "api-key", apiKey: "k" }).generate(request),
		)
		;(quota as { retryable: boolean }).retryable.should.be.true()

		const refused = await mockFetchForTesting(
			async () => reply({ candidates: [{ content: { parts: [{ text: "I can't make that." }] } }] }),
			async () => new GeminiImages({ backend: "api-key", apiKey: "k" }).generate(request),
		)
		refused.ok.should.be.false()
		;(refused as { retryable: boolean }).retryable.should.be.false()
		// Retrying a refusal burns money to be told the same thing again.
		;(refused as { reason: string }).reason.should.containEql("I can't make that.")
	})

	it("treats a network failure as retryable rather than as a refusal", async () => {
		const result = await mockFetchForTesting(
			async () => {
				throw new Error("ECONNRESET")
			},
			async () => new GeminiImages({ backend: "api-key", apiKey: "k" }).generate(request),
		)
		result.ok.should.be.false()
		;(result as { retryable: boolean }).retryable.should.be.true()
	})

	// ── pacing and retries: the quota bugs, held down ──────────────────────
	// Field-measured (test4): eight portraits fired in parallel produced four
	// instant 429s, and the agent burned its turns doing traffic control.

	it("retries a 429 with backoff and succeeds — the caller never sees the throttle", async () => {
		let calls = 0
		const result = await mockFetchForTesting(
			async () => {
				calls++
				return calls < 3 ? reply({ error: { message: "Resource exhausted" } }, 429) : reply(IMAGE_REPLY)
			},
			async () => new GeminiImages({ backend: "api-key", apiKey: "k" }).generate(request),
		)
		result.ok.should.be.true()
		calls.should.equal(3)
	})

	it("spends the whole budget on persistent 429s, then reports retryable exhaustion", async () => {
		let calls = 0
		const result = await mockFetchForTesting(
			async () => {
				calls++
				return reply({ error: { message: "Resource exhausted" } }, 429)
			},
			async () => new GeminiImages({ backend: "api-key", apiKey: "k" }).generate(request),
		)
		result.ok.should.be.false()
		;(result as { retryable: boolean }).retryable.should.be.true()
		calls.should.equal(5) // the initial call + the full backoff ladder
	})

	it("never retries a refusal — that spends money to be told the same thing again", async () => {
		let calls = 0
		const result = await mockFetchForTesting(
			async () => {
				calls++
				return reply({ error: { message: "Prompt was blocked." } }, 400)
			},
			async () => new GeminiImages({ backend: "api-key", apiKey: "k" }).generate(request),
		)
		result.ok.should.be.false()
		;(result as { retryable: boolean }).retryable.should.be.false()
		calls.should.equal(1)
	})

	it("serializes parallel requests — a burst becomes a queue, never a collision", async () => {
		let inFlight = 0
		let peak = 0
		await mockFetchForTesting(
			async () => {
				inFlight++
				peak = Math.max(peak, inFlight)
				await new Promise((resolve) => setTimeout(resolve, 15))
				inFlight--
				return reply(IMAGE_REPLY)
			},
			async () => {
				const client = new GeminiImages({ backend: "api-key", apiKey: "k" })
				await Promise.all([client.generate(request), client.generate(request), client.generate(request)])
			},
		)
		peak.should.equal(1)
	})
})
