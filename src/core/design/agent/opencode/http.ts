/**
 * A minimal HTTP client for the embedded server.
 *
 * `undici`'s fetch rather than `@/shared/net`'s: that wrapper routes through
 * `EnvHttpProxyAgent` so requests to the internet survive a corporate proxy,
 * and this endpoint is 127.0.0.1. A machine whose `HTTP_PROXY` is set without a
 * matching `NO_PROXY` would send loopback traffic to the proxy and fail, which
 * is the opposite of what that rule is for.
 */
import { Agent, fetch } from "undici"

import { BackendError } from "../backend"
import type { RunningServer } from "./server"

/**
 * A dispatcher with the clock turned off.
 *
 * undici gives up after five minutes without response headers, which is a sane
 * default for a web request and wrong for this one: the synchronous prompt route
 * holds the connection open for the *whole turn*, and a model reasoning hard can
 * exceed that easily. Hitting it surfaces as `UND_ERR_HEADERS_TIMEOUT`, which
 * names undici rather than the actual situation ("the model is still thinking").
 *
 * Long, not infinite. Disabling the deadline outright was tried and is worse: a
 * backend that dies mid-turn then hangs the caller forever with nothing to show
 * for it. Half an hour is longer than any real turn and still eventually admits
 * that something is wrong.
 */
const TURN_DEADLINE_MS = 30 * 60_000
const dispatcher = new Agent({ headersTimeout: TURN_DEADLINE_MS, bodyTimeout: TURN_DEADLINE_MS, keepAliveTimeout: 60_000 })

export interface RequestOptions {
	method?: "GET" | "POST" | "PUT" | "DELETE"
	/** Appended as query parameters; `undefined` values are dropped. */
	query?: Record<string, string | undefined>
	body?: unknown
	signal?: AbortSignal
}

export async function request<T>(server: RunningServer, path: string, options: RequestOptions = {}): Promise<T> {
	const response = await rawRequest(server, path, options)
	if (response.status === 204) return undefined as T
	return (await response.json()) as T
}

export async function rawRequest(server: RunningServer, path: string, options: RequestOptions = {}) {
	const url = new URL(server.url + path)
	for (const [key, value] of Object.entries(options.query ?? {})) {
		if (value !== undefined) url.searchParams.set(key, value)
	}

	const response = await fetch(url, {
		dispatcher,
		method: options.method ?? "GET",
		headers: {
			authorization: server.authorization,
			...(options.body === undefined ? {} : { "content-type": "application/json" }),
		},
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
		signal: options.signal,
	})

	if (!response.ok) {
		const detail = await response.text().catch(() => "")
		throw new BackendError(
			`The coding backend refused ${options.method ?? "GET"} ${path} (${response.status}). ${detail.slice(0, 400)}`,
		)
	}
	return response
}

/**
 * Opens a `text/event-stream` and returns an iterator over its JSON payloads.
 *
 * Deliberately **not** a plain async generator. A generator body does not run
 * until the first `next()`, so `subscribe(); postPrompt()` would in fact post
 * the prompt first and open the socket afterwards — losing every event the
 * server emits in between. On a fast turn that includes the `session.idle` that
 * ends it, and the caller then waits forever. Awaiting this function guarantees
 * the socket is open before anything is asked of the server.
 *
 * The framing is written out rather than pulled from a library because it is
 * four lines of spec, and this is the one place where a dropped event is a chat
 * that hangs.
 */
export async function openEventStream<T>(
	server: RunningServer,
	path: string,
	signal: AbortSignal,
	query?: Record<string, string | undefined>,
): Promise<AsyncIterable<T>> {
	const response = await rawRequest(server, path, { signal, query })
	return { [Symbol.asyncIterator]: () => readFrames<T>(response, signal) }
}

async function* readFrames<T>(response: Awaited<ReturnType<typeof rawRequest>>, _signal: AbortSignal) {
	if (!response.body) return

	const decoder = new TextDecoder()
	let buffer = ""

	// undici's body is an async-iterable ReadableStream at runtime; the DOM lib's
	// ReadableStream type does not declare that, so it is asserted rather than cast
	// through `any`.
	for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
		buffer += decoder.decode(chunk as Uint8Array, { stream: true })

		let boundary = buffer.indexOf("\n\n")
		while (boundary !== -1) {
			const frame = buffer.slice(0, boundary)
			buffer = buffer.slice(boundary + 2)
			boundary = buffer.indexOf("\n\n")

			const data = frame
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trim())
				.join("")
			if (!data) continue

			try {
				yield JSON.parse(data) as T
			} catch {
				// A frame we cannot parse is dropped rather than killing the stream:
				// the next event may well be the one that ends the turn.
			}
		}
	}
}
