/**
 * The 3D lane's transport: Tripo's OpenAPI platform.
 *
 * Image → model, then a convert pass that applies the optimization parameters
 * an LLM chose. Tripo is a task queue, not a request/response API: create a
 * task, poll it, download what it produced. Minutes, not seconds — every caller
 * gets a progress callback, because a silent three-minute await reads as a hang.
 *
 * **Nothing here decides anything.** Which image, which face limit, which
 * texture size — those arrive decided. This file uploads, polls, downloads and
 * reports failures in the provider's own words, exactly like the Gemini
 * adapter, and for the same reason: "task failed" with the provider's sentence
 * attached names the fix; a paraphrase loses it.
 *
 * Field names follow the published OpenAPI spec. Where the spec and the live
 * service disagree, the live service wins — errors carry the raw response so a
 * mismatch is diagnosable from the message alone, not from a debugger.
 */
import { fetch } from "@/shared/net"

const BASE = "https://api.tripo3d.ai/v2/openapi"

/** How long each task type is allowed to take before Caret gives up on it. */
const TASK_TIMEOUT_MS: Record<string, number> = {
	image_to_model: 10 * 60 * 1000,
	// Measured at ~3 minutes in the bottle experiment; the ceiling leaves room
	// for detailed-quality queues without letting a dead task hold the lane.
	multiview_to_model: 15 * 60 * 1000,
	convert_model: 6 * 60 * 1000,
}

export interface TripoConfig {
	apiKey: string
}

export interface TripoProgress {
	stage: string
	/** Tripo's own 0–100, when it reports one. */
	percent?: number
}

export type TripoResult<T> = { ok: true; value: T } | { ok: false; reason: string; retryable: boolean }

export interface TripoModelOutput {
	/** The glb, downloaded — Tripo's output URLs are temporary and expire. */
	bytes: Buffer
	taskId: string
}

export class TripoClient {
	constructor(private readonly config: TripoConfig) {}

	/**
	 * Uploads an image and returns the token a task references it by.
	 *
	 * The multipart body is built by hand rather than through `FormData`, and
	 * that is a fix, not a preference: the global `FormData` handed to the npm
	 * undici that `@/shared/net` wraps serializes into something Tripo's server
	 * rejects with "one or more of your parameter is invalid" — while the same
	 * bytes with a hand-rolled boundary pass, through the same fetch. Proven
	 * side by side against the live API after two full runs died on it.
	 *
	 * `/upload`, not `/upload/sts`: both return an image_token, but only this
	 * one's token is valid as a task's `file_token` — the STS route pairs with
	 * S3 object references. The SDK's legacy token flow is the arbiter.
	 */
	async uploadImage(bytes: Buffer, mime: string): Promise<TripoResult<string>> {
		const extension = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg"
		const boundary = `----caret${bytes.length.toString(16)}${Math.random().toString(36).slice(2)}`
		const head = Buffer.from(
			`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="source.${extension}"\r\nContent-Type: ${mime}\r\n\r\n`,
		)
		const tail = Buffer.from(`\r\n--${boundary}--\r\n`)

		const response = await this.call("/upload", {
			method: "POST",
			headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
			body: Buffer.concat([head, bytes, tail]),
		})
		if (!response.ok) return response

		const token =
			(response.value as { image_token?: string; token?: string }).image_token ??
			(response.value as { token?: string }).token
		if (!token)
			return { ok: false, reason: `The upload returned no token: ${JSON.stringify(response.value)}`, retryable: false }
		return { ok: true, value: token }
	}

	/**
	 * Image → draft model. The heavy step, and the one that spends credits.
	 *
	 * `file.type` is always `"jpg"`, whatever the image actually is. That is not
	 * a bug here — the official SDK hardcodes it for every reference, PNGs
	 * included, and sending the honest value is what the live API rejects with
	 * "one or more of your parameter is invalid". Learned from a real 400: the
	 * first source this ran against was a WebP this codebase itself produced.
	 *
	 * The quality options are measured, not aspirational (bottle experiment,
	 * 2026-08-31): the old v2.5 single-view default washed a product label to a
	 * blank band; v3.1 with detailed texture+geometry and original_image
	 * alignment held the wordmark legibly. ~30 extra credits per model, and
	 * quality is the requirement — there is no cheap tier.
	 */
	private static readonly MODEL_VERSION = "v3.1-20260211"
	private static readonly QUALITY = {
		texture_quality: "detailed",
		geometry_quality: "detailed",
		texture_alignment: "original_image",
		pbr: true,
	} as const

	async imageToModel(
		fileToken: string,
		_mime: string,
		onProgress: (update: TripoProgress) => void,
	): Promise<TripoResult<TripoModelOutput>> {
		const created = await this.call("/task", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				type: "image_to_model",
				// Pinned like the SDK pins it, so a server-side default change never
				// silently alters what credits buy.
				model_version: TripoClient.MODEL_VERSION,
				file: { type: "jpg", file_token: fileToken },
				...TripoClient.QUALITY,
			}),
		})
		if (!created.ok) return created

		const taskId = (created.value as { task_id?: string }).task_id
		if (!taskId) return { ok: false, reason: `No task id in ${JSON.stringify(created.value)}`, retryable: false }

		return this.awaitModel(taskId, "image_to_model", onProgress)
	}

	/**
	 * Four views → draft model. The fidelity path.
	 *
	 * Reconstruction hallucinates every side it never saw — the field failure
	 * was a bottle whose back rendered as a blank band. Four views in Tripo's
	 * required order [front, left, back, right] pin the whole turnaround.
	 */
	async multiviewToModel(
		fileTokens: [string, string, string, string],
		onProgress: (update: TripoProgress) => void,
	): Promise<TripoResult<TripoModelOutput>> {
		const created = await this.call("/task", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				type: "multiview_to_model",
				model_version: TripoClient.MODEL_VERSION,
				files: fileTokens.map((token) => ({ type: "png", file_token: token })),
				...TripoClient.QUALITY,
			}),
		})
		if (!created.ok) return created

		const taskId = (created.value as { task_id?: string }).task_id
		if (!taskId) return { ok: false, reason: `No task id in ${JSON.stringify(created.value)}`, retryable: false }

		return this.awaitModel(taskId, "multiview_to_model", onProgress)
	}

	/**
	 * Applies the optimization parameters to an existing model task.
	 *
	 * The parameters were decided by an LLM from the draft's stats and the
	 * intended use — this call is where that decision becomes bytes.
	 */
	async convertModel(
		originalTaskId: string,
		options: { faceLimit: number; textureSize: number },
		onProgress: (update: TripoProgress) => void,
	): Promise<TripoResult<TripoModelOutput>> {
		const created = await this.call("/task", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				type: "convert_model",
				// "GLB" is not in the allowed set — GLTF, USDZ, FBX, OBJ, STL, 3MF —
				// however reasonable it looks next to an output that *is* a glb.
				format: "GLTF",
				original_model_task_id: originalTaskId,
				face_limit: options.faceLimit,
				texture_size: options.textureSize,
			}),
		})
		if (!created.ok) return created

		const taskId = (created.value as { task_id?: string }).task_id
		if (!taskId) return { ok: false, reason: `No task id in ${JSON.stringify(created.value)}`, retryable: false }

		return this.awaitModel(taskId, "convert_model", onProgress)
	}

	/**
	 * The wallet balance, in Tripo's own credits.
	 *
	 * Tripo's task responses carry no per-task price, so the only honest way to
	 * answer "what did that run cost" is to read the wallet before and after and
	 * record the difference as a measurement. Callers treat any failure here as
	 * "cost unknown" — a provenance nicety must never fail a run that already
	 * spent the money.
	 */
	async getBalance(): Promise<TripoResult<number>> {
		const response = await this.call("/user/balance", { method: "GET" })
		if (!response.ok) return response
		const balance = (response.value as { balance?: unknown }).balance
		if (typeof balance !== "number") {
			return {
				ok: false,
				reason: `The balance endpoint returned no number: ${JSON.stringify(response.value)}`,
				retryable: false,
			}
		}
		return { ok: true, value: balance }
	}

	/** Polls a task to completion and downloads the model it produced. */
	private async awaitModel(
		taskId: string,
		kind: string,
		onProgress: (update: TripoProgress) => void,
	): Promise<TripoResult<TripoModelOutput>> {
		const deadline = Date.now() + (TASK_TIMEOUT_MS[kind] ?? 5 * 60 * 1000)

		while (Date.now() < deadline) {
			const polled = await this.call(`/task/${taskId}`, { method: "GET" })
			if (!polled.ok) return polled

			const task = polled.value as {
				status?: string
				progress?: number
				output?: { pbr_model?: string; model?: string; base_model?: string }
			}

			if (task.status === "success") {
				// Preference order matters: pbr_model is the textured one.
				const url = task.output?.pbr_model ?? task.output?.model ?? task.output?.base_model
				if (!url) {
					return {
						ok: false,
						reason: `The task succeeded but returned no model URL: ${JSON.stringify(task.output)}`,
						retryable: false,
					}
				}
				onProgress({ stage: "Downloading the model" })
				return this.download(url, taskId)
			}

			if (
				task.status === "failed" ||
				task.status === "cancelled" ||
				task.status === "banned" ||
				task.status === "expired"
			) {
				return { ok: false, reason: `Tripo reported the task ${task.status}.`, retryable: false }
			}

			onProgress({
				stage: task.status === "queued" ? "Waiting in Tripo's queue" : "Tripo is building the model",
				percent: typeof task.progress === "number" ? task.progress : undefined,
			})
			await new Promise((resolve) => setTimeout(resolve, 3000))
		}

		return { ok: false, reason: `The ${kind} task did not finish within its time limit.`, retryable: true }
	}

	private async download(url: string, taskId: string): Promise<TripoResult<TripoModelOutput>> {
		try {
			const response = await fetch(url)
			if (!response.ok)
				return { ok: false, reason: `Downloading the model failed with ${response.status}.`, retryable: true }
			const bytes = Buffer.from(await response.arrayBuffer())
			if (bytes.length === 0) return { ok: false, reason: "The downloaded model was empty.", retryable: true }
			// A GLTF conversion can come back as a zip rather than a binary glb, and
			// a zip written to disk as `.glb` is an asset that renders nowhere and
			// says nothing. glb declares itself: the first four bytes are "glTF".
			if (bytes.length >= 4 && bytes.toString("ascii", 0, 4) !== "glTF") {
				return {
					ok: false,
					reason: `The downloaded file is not a binary glb (starts ${JSON.stringify(bytes.toString("ascii", 0, 4))}).`,
					retryable: false,
				}
			}
			return { ok: true, value: { bytes, taskId } }
		} catch (err) {
			return { ok: false, reason: err instanceof Error ? err.message : String(err), retryable: true }
		}
	}

	/**
	 * One call, with Tripo's envelope unwrapped and its errors carried whole —
	 * including which endpoint and what was sent. "One or more of your parameter
	 * is invalid" without naming the call burned two full e2e runs on guessing;
	 * the request body carries no secret (the key travels in a header), so
	 * echoing it costs nothing and names the fix.
	 */
	private async call(pathname: string, init: RequestInit): Promise<TripoResult<Record<string, unknown>>> {
		const sent = typeof init.body === "string" ? ` (sent ${init.body})` : ""
		let response: Response
		try {
			response = await fetch(`${BASE}${pathname}`, {
				...init,
				headers: { authorization: `Bearer ${this.config.apiKey}`, ...(init.headers as Record<string, string>) },
			})
		} catch (err) {
			return { ok: false, reason: err instanceof Error ? err.message : String(err), retryable: true }
		}

		const text = await response.text()
		let parsed: { code?: number; data?: Record<string, unknown>; message?: string; suggestion?: string }
		try {
			parsed = JSON.parse(text) as typeof parsed
		} catch {
			return {
				ok: false,
				reason: `${response.status} from Tripo ${pathname}: ${text.slice(0, 300)}${sent}`,
				retryable: response.status >= 500,
			}
		}

		if (!response.ok || (parsed.code !== undefined && parsed.code !== 0)) {
			// The provider's own message and its own suggestion, both — Tripo's
			// errors often carry a `suggestion` field that names the fix outright.
			const said = [parsed.message, parsed.suggestion].filter(Boolean).join(" — ")
			return {
				ok: false,
				reason: `${response.status} from Tripo ${pathname}${said ? `: ${said}` : `: ${text.slice(0, 300)}`}${sent}`,
				retryable: response.status === 429 || response.status >= 500,
			}
		}

		return { ok: true, value: parsed.data ?? {} }
	}
}

/**
 * Where the 3D lane's credentials come from. Same shape as the raster lane:
 * a stored secret is the shipped path, the environment is the test switch, and
 * null is the normal, non-error state of a machine with neither.
 */
export function resolveTripoConfig(
	sources: { apiKey?: string; env?: Record<string, string | undefined> } = {},
): TripoConfig | null {
	const env = sources.env ?? process.env
	const apiKey = sources.apiKey?.trim() || env.TRIPO_API_KEY?.trim()
	return apiKey ? { apiKey } : null
}

export const NO_TRIPO_REASON =
	"3D generation needs a Tripo API key, which you supply and pay for directly. " + "Everything else here works without one."
