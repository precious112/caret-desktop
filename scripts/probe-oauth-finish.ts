/**
 * Who finishes a browser OAuth started over the server's API?
 *
 * A real sign-in produced "Authorization successful" in the browser and no
 * credential in auth.json: the loopback listener exchanged the code and
 * resolved an internal promise nobody was awaiting. The hypothesis this probe
 * tests: `POST /provider/{id}/oauth/callback` is that awaiter — it blocks
 * until the browser half lands, then persists. If true, Caret must call it
 * immediately after opening the URL, for auto flows too.
 *
 * No real sign-in needed: the loopback is fed a FAKE code with the real state
 * (parsed from the authorize URL), so the exchange fails — but WHEN the
 * callback call resolves, and with what, tells us who owns the finish.
 *
 *   npx tsx scripts/probe-oauth-finish.ts
 */
import { CARET_SERVER_CONFIG } from "../src/core/design/agent/opencode"
import { request } from "../src/core/design/agent/opencode/http"
import { ensureOpencodeServer, stopOpencodeServer } from "../src/core/design/agent/opencode/server"

async function main(): Promise<void> {
	const server = await ensureOpencodeServer(CARET_SERVER_CONFIG)

	const started = await request<{ url: string; method?: string; instructions?: string }>(
		server,
		"/provider/github-copilot/oauth/authorize",
		{ method: "POST", body: { method: 0 } },
	)
	console.log(`authorize returned method=${JSON.stringify(started.method)}`)
	console.log(`instructions: ${JSON.stringify(started.instructions ?? null)}`)

	// Fire the callback FIRST, unresolved — the hypothesis says it waits.
	let settledAt: number | null = null
	let outcome = "unsettled"
	const begun = Date.now()
	const finish = request<boolean>(server, "/provider/github-copilot/oauth/callback", {
		method: "POST",
		body: { method: 0, code: "" },
	}).then(
		(value) => {
			settledAt = Date.now() - begun
			outcome = `resolved ${JSON.stringify(value)}`
		},
		(err) => {
			settledAt = Date.now() - begun
			outcome = `rejected: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`
		},
	)

	await new Promise((resolve) => setTimeout(resolve, 5000))
	console.log(
		`after 5s with no browser action: ${outcome} ${settledAt !== null ? `(at ${settledAt}ms)` : "(still waiting — it IS the awaiter)"}`,
	)

	await Promise.race([finish, new Promise((resolve) => setTimeout(resolve, 10000))])
	console.log(
		`after 15s total: ${outcome} ${settledAt !== null ? `(at ${settledAt}ms)` : "(STILL waiting — the callback endpoint is the flow's awaiter)"}`,
	)
}

main().then(
	async () => {
		await stopOpencodeServer()
		process.exit(0)
	},
	async (err) => {
		console.error(err)
		await stopOpencodeServer()
		process.exit(1)
	},
)
