/**
 * # Network access
 *
 * **Do** use `import { fetch } from "@/shared/net"` instead of the global
 * `fetch`, and spread `getAxiosSettings()` into any axios call.
 *
 * The reason is proxies. Node's global `fetch` ignores `HTTP_PROXY`,
 * `HTTPS_PROXY` and `NO_PROXY`, so on a corporate network every request from
 * the main process fails with an opaque connection error while the same URL
 * loads fine in a browser. Routing through undici's `EnvHttpProxyAgent`
 * honours those variables, which is what people already expect from every
 * other CLI on their machine.
 *
 * Renderer code should use the browser's global `fetch`: Chromium applies the
 * system proxy itself.
 *
 * ## Testing
 *
 * ```ts
 * await mockFetchForTesting(myMock, async () => {
 *   await somethingThatFetches()
 * })
 * // the real fetch is restored once the callback settles, throw or not
 * ```
 */
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici"

type FetchFn = typeof globalThis.fetch

let cachedAgent: EnvHttpProxyAgent | undefined

/**
 * Built on first use, not at import time: reading the proxy environment during
 * module load would capture it before the app has applied the user's own
 * preference.
 */
function proxyAgent(): EnvHttpProxyAgent {
	cachedAgent ??= new EnvHttpProxyAgent()
	return cachedAgent
}

const realFetch = ((input: any, init?: any) =>
	undiciFetch(input, { ...init, dispatcher: proxyAgent() })) as unknown as FetchFn

/** Swapped out only by {@link mockFetchForTesting}. */
let activeFetch: FetchFn = realFetch

/** Proxy-aware `fetch`, same signature as the global one. */
export const fetch: FetchFn = ((input: any, init?: any) => activeFetch(input, init)) as FetchFn

/**
 * Settings to spread into axios calls so they follow the same proxy rules.
 *
 * Empty today, because axios already reads the proxy environment variables on
 * Node. It exists so call sites have one obvious thing to do, and so that if
 * that ever stops being true there is a single place to fix rather than every
 * request in the codebase.
 */
export function getAxiosSettings(): Record<string, unknown> {
	return {}
}

/** Runs `body` with `mock` in place of the real fetch, then restores it. */
export async function mockFetchForTesting<T>(mock: FetchFn, body: () => T | Promise<T>): Promise<T> {
	const previous = activeFetch
	activeFetch = mock
	try {
		return await body()
	} finally {
		activeFetch = previous
	}
}
