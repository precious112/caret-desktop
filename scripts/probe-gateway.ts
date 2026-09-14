/**
 * What the bundled server will tell Caret about providers, and what it will let
 * Caret change.
 *
 * The model picker needs three answers the docs do not give: does
 * `/config/providers` include providers you are NOT signed in to (so a door can
 * be shown), is there an auth-writing endpoint (so an API key can be pasted in
 * the app instead of in a terminal), and what shape does a model carry. Costs
 * nothing — no inference here.
 */
import { CARET_SERVER_CONFIG } from "../src/core/design/agent/opencode"
import { request } from "../src/core/design/agent/opencode/http"
import { ensureOpencodeServer, stopOpencodeServer } from "../src/core/design/agent/opencode/server"

async function main(): Promise<void> {
	const server = await ensureOpencodeServer(CARET_SERVER_CONFIG)
	console.log(`server up at ${server.url}`)

	// The OpenAPI document the server publishes — the authoritative list of what
	// Caret is allowed to ask for.
	const doc = await request<{ paths?: Record<string, Record<string, unknown>> }>(server, "/doc").catch(
		(err) => ({ paths: undefined, error: String(err) }) as never,
	)
	const paths = Object.keys(doc.paths ?? {})
	console.log(`\n=== ${paths.length} paths; the ones that touch auth, config or providers`)
	for (const path of paths.filter((p) => /auth|config|provider|model/i.test(p))) {
		console.log(`  ${path}  [${Object.keys(doc.paths?.[path] ?? {}).join(", ")}]`)
	}

	const providers = await request<{
		providers: Array<{ id: string; name?: string; models?: Record<string, unknown>; [key: string]: unknown }>
		default?: Record<string, string>
	}>(server, "/config/providers")

	console.log(`\n=== /config/providers returned ${providers.providers.length} provider(s)`)
	for (const provider of providers.providers) {
		const keys = Object.keys(provider).filter((k) => k !== "models")
		console.log(`  ${provider.id} (${provider.name ?? "?"}) — ${Object.keys(provider.models ?? {}).length} models`)
		console.log(`    non-model keys: ${keys.join(", ")}`)
	}
	console.log(`  default: ${JSON.stringify(providers.default)}`)

	// Is an unconnected provider listed at all? These are in the catalogue but
	// have no credential on this machine.
	const listed = new Set(providers.providers.map((p) => p.id))
	for (const id of ["openai", "kimi-for-coding", "zai-coding-plan", "anthropic", "opencode", "github-copilot"]) {
		console.log(`  offered door "${id}": ${listed.has(id) ? "LISTED" : "absent (needs a curated door)"}`)
	}

	// Does the server know about providers you are NOT signed in to, and does it
	// know how to sign in to them? If so Caret renders the real universe instead
	// of a list it has to curate and keep in step.
	for (const path of ["/provider/auth", "/provider", "/api/provider", "/api/model"]) {
		try {
			const body = await request<unknown>(server, path)
			const json = JSON.stringify(body)
			console.log(`\n=== GET ${path} — ${json.length} bytes`)
			if (Array.isArray(body)) {
				console.log(`  array of ${body.length}; first entry:`)
				console.log(`  ${JSON.stringify(body[0], null, 2).slice(0, 700)}`)
			} else if (body && typeof body === "object") {
				const record = body as Record<string, unknown>
				console.log(`  keys: ${Object.keys(record).slice(0, 24).join(", ")}`)
				const first = Object.entries(record)[0]
				if (first) console.log(`  ${first[0]} = ${JSON.stringify(first[1], null, 2).slice(0, 700)}`)
			}
			// Whichever of these knows the doors, say so plainly.
			for (const id of ["openai", "kimi-for-coding", "zai-coding-plan", "anthropic"]) {
				if (json.includes(`"${id}"`)) console.log(`  mentions "${id}": yes`)
			}
		} catch (err) {
			console.log(`\n=== GET ${path} — failed: ${err instanceof Error ? err.message : String(err)}`)
		}
	}

	const sample = providers.providers[0]
	if (sample?.models) {
		const [id, model] = Object.entries(sample.models)[0] ?? []
		console.log(`\n=== a model as the server describes it (${sample.id}/${id})`)
		console.log(JSON.stringify(model, null, 2).slice(0, 900))
	}
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
