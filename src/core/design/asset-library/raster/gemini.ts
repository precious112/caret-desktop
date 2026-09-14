/**
 * The raster lane's one adapter: Google's Gemini image models.
 *
 * Two backends behind one interface, exactly as §4.7 specifies:
 *
 * - **API key** — the shipped path. The user's own key, read from the OS
 *   keychain, never written into `.caret/`.
 * - **Vertex AI with `gcloud` ADC** — configured through env/prefs, absent from
 *   the UI. It exists so the project can be exercised against Vertex credits,
 *   and so the lane can be certified against a real model rather than a stub.
 *
 * The two differ in host, auth and path. That is the only reason this file
 * knows there are two; everything above it composes a request and gets back
 * pixels or a refusal that says why.
 *
 * **Why REST rather than `@google/genai`.** The plan says "one adapter over the
 * SDK, given Caret's proxy-aware `fetch` per the network rules" — and the SDK
 * has no hook for supplying one. Its `HttpOptions` carries headers, timeouts and
 * retries, and nothing else; every request goes through the global `fetch`,
 * which ignores `HTTP_PROXY`. Taking the SDK would mean the lane works on a
 * laptop and fails behind every corporate proxy, silently, with a connection
 * error that names nothing. So the transport is ours and only the auth is
 * Google's: `google-auth-library` mints the ADC token, `@/shared/net` makes the
 * call. The plan's intent survives; its mechanism could not.
 *
 * **Nothing here invents a prompt.** The prompt arrives fully composed by a
 * recipe, negative constraints included. This adapter's job is transport,
 * decoding and honest failure — deliberately not a place where a "helpful"
 * suffix could get added.
 */
import { fetch } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"

/** Which backend a configuration selects. */
export type GeminiBackend = "api-key" | "vertex"

export interface GeminiConfig {
	backend: GeminiBackend
	/** `api-key` only. */
	apiKey?: string
	/** `vertex` only. */
	project?: string
	/** `vertex` only. `global` is where the image models are served. */
	location?: string
	/**
	 * Model in Caret's own vocabulary, resolved to a provider id below.
	 *
	 * Named rather than free-form so a typo is a refusal here instead of a 404
	 * from a provider, which arrives with no indication of what was expected.
	 */
	model?: GeminiModel
}

export type GeminiModel = "flash-image" | "flash-image-legacy" | "pro-image"

/**
 * Measured 2026-09-03, and the reason the default moved.
 *
 * `gemini-2.5-flash-image` — the original nano banana — was the default for
 * months, and it is where the field's refinement complaints came from: given a
 * reference and the note "make it matte and crisp like folded sheet metal, not
 * rolled leather", it added a literal leather seam and grain. Google now says
 * it is no longer recommended. On the same reference with the same note,
 * `gemini-3.1-flash-image` (nano banana 2) produced the defined crease and
 * kept composition and light untouched — the refine contract, honoured.
 * `gemini-3-pro-image` (nano banana pro) obeys hardest but recomposes more
 * than a refine should, so it is offered rather than defaulted.
 * `caret-learning/model-probe` holds the three side by side.
 */
const MODEL_IDS: Record<GeminiModel, string> = {
	"flash-image": "gemini-3.1-flash-image",
	"flash-image-legacy": "gemini-2.5-flash-image",
	"pro-image": "gemini-3-pro-image",
}

/**
 * Vertex publishes the Gemini 3 image models on the GLOBAL endpoint only — a
 * regional location 404s with "Publisher model not found", which reads exactly
 * like the model does not exist (measured: us-central1 404s all three, global
 * serves all three). A project configured for a region must still reach them.
 */
const GLOBAL_ONLY_MODELS = new Set(["gemini-3.1-flash-image", "gemini-3-pro-image"])

/** The scope an ADC token needs to call Vertex. */
const VERTEX_SCOPE = "https://www.googleapis.com/auth/cloud-platform"

export interface ImageRequest {
	/** Fully composed by the recipe. Never edited here. */
	prompt: string
	/** Negative constraints, appended as their own instruction block. */
	avoid: string[]
	/** e.g. `16:9`. Passed to the model's own aspect control. */
	aspect: string
	/** Reference images, for "match this palette" and "the same style as this". */
	references?: Array<{ mime: string; base64: string }>
}

export type ImageResult =
	| { ok: true; mime: string; bytes: Buffer; model: string; resolved: string; usage?: ImageUsage }
	| { ok: false; reason: string; retryable: boolean }

/** What the provider metered for one call, as it reported it. For provenance. */
export interface ImageUsage {
	promptTokens: number
	outputTokens: number
	totalTokens: number
}

/* ── Pacing and retries ──────────────────────────────────────────────────
 *
 * The image quota is per-minute and small, and the agent legitimately asks
 * for many images at once — eight portraits fired in parallel produced four
 * instant 429s (field-measured, test4), and the agent then burned its own
 * turns doing traffic control. Retries are the harness's problem: every
 * request goes through one process-wide queue with spacing between calls,
 * and a retryable failure backs off and tries again INSIDE the queue slot,
 * so callers see success-that-took-longer, not quota noise. A non-retryable
 * failure (a refused prompt) is never retried — that spends money to be
 * told the same thing again. */

const PACING = {
	/** Gap between requests. The per-minute quota is the thing being respected. */
	minSpacingMs: 6_000,
	/** Backoff before each retry of a retryable failure. Length = max retries. */
	backoffMs: [4_000, 10_000, 20_000, 40_000],
	/** ±fraction of jitter on each backoff, so retries never re-synchronize. */
	jitter: 0.2,
	sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
	now: () => Date.now(),
}

/** Test hook (and tuning): override timing without touching the queue logic. */
export function configureRasterPacing(overrides: Partial<typeof PACING>): void {
	Object.assign(PACING, overrides)
}

let queueTail: Promise<void> = Promise.resolve()
let lastRequestAt = 0

/** One at a time, spaced apart — parallel callers queue instead of colliding. */
async function paced<T>(task: () => Promise<T>): Promise<T> {
	const previous = queueTail
	let release!: () => void
	queueTail = new Promise<void>((resolve) => {
		release = resolve
	})
	await previous
	try {
		const wait = lastRequestAt + PACING.minSpacingMs - PACING.now()
		if (wait > 0) await PACING.sleep(wait)
		return await task()
	} finally {
		lastRequestAt = PACING.now()
		release()
	}
}

export class GeminiImages {
	private readonly config: GeminiConfig

	constructor(config: GeminiConfig) {
		this.config = config
	}

	/** What this adapter would ask for, without asking. For provenance and tests. */
	resolve(request: ImageRequest): { model: string; prompt: string; url: string } {
		const model = MODEL_IDS[this.config.model ?? "flash-image"]
		return { model, prompt: composePrompt(request), url: this.endpoint(model) }
	}

	/**
	 * Generates one image — queued, spaced, and retried.
	 *
	 * Every failure is a `reason` a person can act on, and `retryable` says
	 * whether trying again could plausibly help — a quota error can, a refused
	 * prompt cannot. Retryable failures are retried HERE, with backoff, inside
	 * the queue slot; a `retryable: true` result reaching a caller means the
	 * whole budget was spent and the service is genuinely exhausted right now.
	 */
	async generate(request: ImageRequest): Promise<ImageResult> {
		return paced(async () => {
			let result = await this.generateOnce(request)
			for (let retry = 0; !result.ok && result.retryable && retry < PACING.backoffMs.length; retry++) {
				const base = PACING.backoffMs[retry]
				const jitter = base * PACING.jitter * (Math.random() * 2 - 1)
				await PACING.sleep(Math.max(0, Math.round(base + jitter)))
				result = await this.generateOnce(request)
			}
			return result
		})
	}

	private async generateOnce(request: ImageRequest): Promise<ImageResult> {
		const misconfigured = this.check()
		if (misconfigured) return { ok: false, reason: misconfigured, retryable: false }

		const { model, prompt, url } = this.resolve(request)

		let headers: Record<string, string>
		try {
			headers = await this.authHeaders()
		} catch (err) {
			return { ok: false, reason: authFailureReason(message(err)), retryable: false }
		}

		const body = {
			contents: [
				{
					role: "user",
					parts: [
						...(request.references ?? []).map((reference) => ({
							inlineData: { mimeType: reference.mime, data: reference.base64 },
						})),
						{ text: prompt },
					],
				},
			],
			generationConfig: {
				// Asked for explicitly. Without it these models will happily answer a
				// picture request in prose, which reads downstream as "no image" with
				// no indication that nothing was ever going to be produced.
				responseModalities: ["TEXT", "IMAGE"],
				imageConfig: { aspectRatio: request.aspect },
			},
		}

		let response: Response
		try {
			response = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: JSON.stringify(body),
			})
		} catch (err) {
			return { ok: false, reason: message(err), retryable: true }
		}

		const text = await response.text()
		if (!response.ok) {
			return {
				ok: false,
				// The provider's own message, trimmed. It names the enabled-API and
				// quota problems that are the two most common first failures, and a
				// paraphrase would lose exactly that.
				reason: `${response.status} from ${new URL(url).host}: ${extractError(text)}`,
				retryable: response.status === 429 || response.status >= 500,
			}
		}

		let parsed: GenerateContentResponse
		try {
			parsed = JSON.parse(text) as GenerateContentResponse
		} catch {
			return { ok: false, reason: "The provider returned something that is not JSON.", retryable: true }
		}

		const parts = parsed.candidates?.[0]?.content?.parts ?? []
		const image = parts.find((part) => part.inlineData?.data)
		if (!image?.inlineData?.data) {
			// A model that answers in words instead of pixels has usually refused,
			// and its sentence is the most useful thing available.
			const said = parts
				.map((part) => part.text)
				.filter(Boolean)
				.join(" ")
				.trim()
			return {
				ok: false,
				reason: said ? `The model returned no image and said: ${said}` : "The model returned no image and no reason.",
				retryable: false,
			}
		}

		return {
			ok: true,
			mime: image.inlineData.mimeType ?? "image/png",
			bytes: Buffer.from(image.inlineData.data, "base64"),
			model,
			resolved: prompt,
			usage: usageOf(parsed),
		}
	}

	/** Why this configuration cannot run, or null. */
	check(): string | null {
		if (this.config.backend === "api-key") {
			return this.config.apiKey?.trim()
				? null
				: "No Gemini API key is configured. Generated photographs need one; every other kind of asset does not."
		}
		if (!this.config.project?.trim()) {
			return "Vertex is selected but no Google Cloud project is set."
		}
		return null
	}

	private endpoint(model: string): string {
		if (this.config.backend === "api-key") {
			return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
		}
		// A configured region cannot serve the Gemini 3 image models, so those
		// route to global regardless of the project's preference — the
		// alternative is a 404 that reads as "no such model".
		const configured = this.config.location?.trim() || "global"
		const location = GLOBAL_ONLY_MODELS.has(model) ? "global" : configured
		// `global` has no regional prefix, and using one gets a 404 that reads like
		// the model does not exist.
		const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`
		return `https://${host}/v1/projects/${this.config.project}/locations/${location}/publishers/google/models/${model}:generateContent`
	}

	private async authHeaders(): Promise<Record<string, string>> {
		if (this.config.backend === "api-key") {
			return { "x-goog-api-key": this.config.apiKey ?? "" }
		}

		// Imported lazily so a build that never touches the raster lane — and every
		// unit test — neither loads it nor fails without it.
		const { GoogleAuth } = await import("google-auth-library")
		const auth = new GoogleAuth({ scopes: [VERTEX_SCOPE] })
		const token = await auth.getAccessToken()
		if (!token) {
			throw new Error("Application Default Credentials produced no token. Run `gcloud auth application-default login`.")
		}
		return { authorization: `Bearer ${token}` }
	}
}

interface GenerateContentResponse {
	candidates?: Array<{
		content?: { parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> }
	}>
	usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
}

/** The provider's usage report, or undefined when it sent none. */
function usageOf(parsed: GenerateContentResponse): ImageUsage | undefined {
	const meta = parsed.usageMetadata
	if (!meta || typeof meta.totalTokenCount !== "number") return undefined
	return {
		promptTokens: meta.promptTokenCount ?? 0,
		outputTokens: meta.candidatesTokenCount ?? 0,
		totalTokens: meta.totalTokenCount,
	}
}

/**
 * Prompt plus constraints, in that order.
 *
 * The `avoid` list is the documented slop tells, and it is appended rather than
 * woven in so it stays legible in the provenance record — somebody reading
 * `origin.resolved` months later can see exactly what was ruled out, which is
 * not true of a paragraph that had negatives edited into it.
 */
export function composePrompt(request: ImageRequest): string {
	if (request.avoid.length === 0) return request.prompt.trim()
	return `${request.prompt.trim()}\n\nDo not include: ${request.avoid.join("; ")}.`
}

/** The provider's `error.message`, or the raw body if it is not shaped that way. */
function extractError(body: string): string {
	try {
		const parsed = JSON.parse(body) as { error?: { message?: string } }
		return parsed.error?.message ?? body.slice(0, 300)
	} catch {
		return body.slice(0, 300)
	}
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

/**
 * An auth failure as a sentence a person can act on.
 *
 * The raw failure is Google's OAuth JSON — `{"error":"invalid_grant",
 * "error_description":"reauth related error (invalid_rapt)"…}` — and it used
 * to ship to the UI verbatim, three copies of it overflowing the take cards
 * (field screenshot, 2026-09-02, the user's exact words: "what's this?").
 * Google's session expiry is a routine event with a routine fix, and the
 * message's job is to name the fix. The raw detail still goes to the log.
 */
function authFailureReason(detail: string): string {
	Logger.warn(`[gemini] auth failure: ${detail}`)
	if (detail.includes("invalid_rapt") || detail.includes("invalid_grant")) {
		return (
			"Your Google Cloud sign-in has expired. Run `gcloud auth application-default login` in a terminal, " +
			"then generate again — or add a Gemini API key in Settings to stop depending on the sign-in."
		)
	}
	const brief = detail.length > 160 ? `${detail.slice(0, 160)}…` : detail
	return `Could not authenticate with the image service: ${brief}`
}
