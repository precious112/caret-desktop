/**
 * What Caret can see, printed.
 *
 * The Backend panel answers this too, but it needs the app running and a project
 * open, and the question it answers ("is my subscription detected?") is exactly
 * the one you want a fast, unambiguous answer to. This runs the same
 * `availability()` the app runs, plus — for the bundled backend — the provider
 * and model catalogue behind it, so a missing subscription is distinguishable
 * from a missing model.
 *
 * Costs nothing: no turn is ever run.
 *
 *   npm run backends
 */

import { CARET_SERVER_CONFIG, OpencodeBackend } from "../src/core/design/agent/opencode"
import { resolveOpencodeBinary } from "../src/core/design/agent/opencode/binary"
import { request } from "../src/core/design/agent/opencode/http"
import type { OpencodeProvidersResponse } from "../src/core/design/agent/opencode/protocol"
import { ensureOpencodeServer, stopOpencodeServer } from "../src/core/design/agent/opencode/server"
import { getBackend, probeBackends } from "../src/core/design/agent/registry"

async function main(): Promise<void> {
	console.log("Backends\n")

	for (const report of await probeBackends()) {
		const state = report.ready ? "ready" : report.installed ? "needs sign-in" : "not installed"

		console.log(`  ${report.displayName.padEnd(20)} ${state.padEnd(14)} ${report.detail}`)
		if (report.remedy?.command) console.log(`  ${" ".repeat(20)} → ${report.remedy.label}: ${report.remedy.command}`)
	}

	// The bundled backend's catalogue. This is where a subscription shows up, and
	// it is the difference between "signed in" and "signed in to something that
	// offers the model you asked for".
	const binary = resolveOpencodeBinary()
	if (!binary) {
		console.log("\nThe bundled backend binary is missing from this build.")
		return
	}

	console.log(`\nBundled backend: ${binary}`)

	// The models the backend can name, so "is my subscription detected" and "can
	// Caret see the model I want" are answered in one place.
	for (const id of ["opencode"] as const) {
		const groups = await getBackend(id)
			.listModels?.()
			.catch(() => [])
		if (!groups?.length) continue
		console.log(`\n${getBackend(id).displayName} models`)
		for (const group of groups) {
			console.log(`  ${group.providerName}`)
			for (const model of group.models) console.log(`      ${model.id.padEnd(30)} ${model.free ? "no cost" : ""}`)
		}
	}

	const server = await ensureOpencodeServer(CARET_SERVER_CONFIG)
	const providers = await request<OpencodeProvidersResponse>(server, "/config/providers")

	console.log("\nProviders it can reach\n")
	for (const provider of providers.providers) {
		const models = Object.entries(provider.models ?? {})
		const free = models.filter(([, model]) => model.cost?.input === 0 && model.cost?.output === 0).length
		console.log(`  ${provider.name ?? provider.id} (${provider.id}) — ${models.length} model(s), ${free} at no cost`)
		for (const [id, model] of models) {
			const cost = model.cost
			const price = cost && (cost.input || cost.output) ? `$${cost.input}/$${cost.output} per Mtok` : "no cost"
			console.log(`      ${provider.id}/${id.padEnd(28)} ${price}`)
		}
	}

	if (providers.providers.length === 0) {
		console.log("  (none — sign in with `opencode auth login`, or add an API key)")
	}

	console.log(`\nDefault: ${JSON.stringify(providers.default)}`)
	await new OpencodeBackend().dispose?.()
}

main()
	.catch((err) => {
		console.error(err instanceof Error ? err.message : String(err))
		process.exitCode = 1
	})
	.finally(() => stopOpencodeServer().then(() => process.exit(process.exitCode ?? 0)))
