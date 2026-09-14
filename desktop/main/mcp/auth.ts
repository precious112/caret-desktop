/**
 * Access control for the local MCP server.
 *
 * This server writes files in the user's repo, so leaving it unauthenticated on
 * localhost is not acceptable even though it never leaves the machine. Two
 * distinct attacks are in scope:
 *
 * 1. **Any other local process** — every process on the machine can reach
 *    127.0.0.1. A bearer token the caller must present closes this.
 * 2. **DNS rebinding** — a web page the user visits can be made to resolve a
 *    hostname to 127.0.0.1 and then issue requests to it from the browser, with
 *    the browser happily attaching credentials. Validating `Origin` and `Host`
 *    closes this, because a rebound request carries the attacker's origin.
 *
 * Neither check alone is sufficient: the token stops local processes but is
 * readable by a browser attack that can get the discovery file, and origin
 * checks stop browsers but not local processes.
 */
import { randomBytes } from "crypto"
import type { IncomingMessage } from "http"

/** Hostnames a request may claim to be addressed to. */
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

export function generateToken(): string {
	return randomBytes(32).toString("base64url")
}

export type AuthFailure = { ok: false; status: number; reason: string }
export type AuthResult = { ok: true } | AuthFailure

export function authorize(req: IncomingMessage, token: string): AuthResult {
	const origin = req.headers.origin
	if (origin !== undefined) {
		// A browser sent this. No browser has any business driving the design
		// layer, so any Origin at all is refused rather than allowlisted — an
		// allowlist would have to guess which origins are safe, and none are.
		return { ok: false, status: 403, reason: `Origin ${origin} is not permitted` }
	}

	const host = (req.headers.host ?? "").split(":")[0].toLowerCase()
	if (!ALLOWED_HOSTS.has(host)) {
		// A rebound request arrives with the attacker's hostname in Host.
		return { ok: false, status: 403, reason: `Host ${host || "(missing)"} is not permitted` }
	}

	const auth = req.headers.authorization ?? ""
	const presented = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : ""
	if (!presented || !timingSafeEqual(presented, token)) {
		return { ok: false, status: 401, reason: "Missing or invalid bearer token" }
	}

	return { ok: true }
}

/**
 * Constant-time string comparison. `===` on secrets leaks their length and
 * shared prefix through timing, which is enough to recover a token from a
 * process that can make many requests.
 */
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
	}
	return diff === 0
}
