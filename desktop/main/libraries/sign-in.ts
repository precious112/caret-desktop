/**
 * A library's browser sign-in (MCP OAuth), run by Caret.
 *
 * The library asks for a sign-in; Caret opens the user's browser on the
 * library's page and listens on a fixed loopback address for the page to send
 * the user back. The sign-in (the client registration and the tokens) is kept
 * in the OS keychain through `secrets.ts`, never in a project file.
 *
 * The loopback port is fixed because the library remembers the exact address
 * Caret registered with; a different port on the next sign-in would be refused.
 */
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import { shell } from "electron"
import { createServer } from "http"

import { fetch } from "../../../src/shared/net"
import { Logger } from "../../../src/shared/services/Logger"
import { getSecret, type SecretName, setSecret } from "../secrets"

const PORT = 43117
const REDIRECT = `http://127.0.0.1:${PORT}/callback`
const SIGN_IN_MS = 5 * 60_000

interface Stored {
	client?: OAuthClientInformationMixed
	tokens?: OAuthTokens
	verifier?: string
}

export class SignInAuth {
	private readonly secret: SecretName
	/** Only an interactive sign-in may open the browser; a background reconnect never does. */
	private interactive = false

	constructor(libraryId: "gummble") {
		this.secret = `${libraryId}SignIn` as SecretName
	}

	signedIn(): boolean {
		return Boolean(this.read().tokens?.access_token)
	}

	provider(): OAuthClientProvider {
		return {
			get redirectUrl() {
				return REDIRECT
			},
			get clientMetadata(): OAuthClientMetadata {
				return {
					client_name: "Caret",
					redirect_uris: [REDIRECT],
					grant_types: ["authorization_code", "refresh_token"],
					response_types: ["code"],
					token_endpoint_auth_method: "none",
				}
			},
			clientInformation: () => this.read().client,
			saveClientInformation: (client) => this.write({ client }),
			tokens: () => this.read().tokens,
			saveTokens: (tokens) => this.write({ tokens }),
			saveCodeVerifier: (verifier) => this.write({ verifier }),
			codeVerifier: () => this.read().verifier ?? "",
			redirectToAuthorization: async (url) => {
				if (!this.interactive) throw new Error("This library needs you to sign in again.")
				await shell.openExternal(url.toString())
			},
		}
	}

	/** Opens the browser, waits for the user to come back, and keeps the sign-in. */
	async signIn(serverUrl: string): Promise<{ ok: true } | { ok: false; error: string }> {
		const listening = waitForCode()
		try {
			await listening.ready
		} catch (err) {
			return {
				ok: false,
				error: `Caret could not listen for the sign-in (${err}). Close what is using port ${PORT} and try again.`,
			}
		}
		this.interactive = true
		try {
			const first = await auth(this.provider(), { serverUrl, fetchFn: fetch as never })
			if (first === "AUTHORIZED") return { ok: true }
			const code = await listening.code
			const second = await auth(this.provider(), { serverUrl, authorizationCode: code, fetchFn: fetch as never })
			return second === "AUTHORIZED" ? { ok: true } : { ok: false, error: "The sign-in did not finish." }
		} catch (err) {
			Logger.warn(`[libraries] sign-in failed: ${err}`)
			return { ok: false, error: err instanceof Error ? err.message : String(err) }
		} finally {
			this.interactive = false
			listening.stop()
		}
	}

	private read(): Stored {
		try {
			return JSON.parse(getSecret(this.secret) || "{}") as Stored
		} catch {
			return {}
		}
	}

	private async write(change: Stored): Promise<void> {
		const saved = await setSecret(this.secret, JSON.stringify({ ...this.read(), ...change }))
		if (!saved.ok) throw new Error(saved.error)
	}
}

/** A one-shot loopback listener for the page the browser is sent back to. */
function waitForCode(): { ready: Promise<void>; code: Promise<string>; stop(): void } {
	let deliver: (code: string) => void = () => {}
	let fail: (err: Error) => void = () => {}
	const code = new Promise<string>((resolve, reject) => {
		deliver = resolve
		fail = reject
	})
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", REDIRECT)
		if (url.pathname !== "/callback") {
			res.writeHead(404).end()
			return
		}
		const value = url.searchParams.get("code")
		const error = url.searchParams.get("error")
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
		res.end(
			value
				? '<p style="font-family:system-ui">Signed in. You can close this tab and go back to Caret.</p>'
				: `<p style="font-family:system-ui">The sign-in did not finish${error ? `: ${error}` : ""}. Go back to Caret and try again.</p>`,
		)
		if (value) deliver(value)
		else fail(new Error(error ?? "the sign-in was cancelled"))
	})
	const timer = setTimeout(() => fail(new Error("the sign-in timed out")), SIGN_IN_MS)
	const ready = new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(PORT, "127.0.0.1", () => resolve())
	})
	return {
		ready,
		code,
		stop: () => {
			clearTimeout(timer)
			server.close()
		},
	}
}
