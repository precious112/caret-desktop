import { strict as assert } from "assert"
import * as os from "os"

import type { CodingBackend, McpServerStatus } from "../../../src/core/design/agent/backend"
import { setOpencodeToolPolicy, toolsFor } from "../../../src/core/design/agent/opencode"
import { mockFetchForTesting } from "../../../src/shared/net"
import { DesignLibraries, REST_MS } from "../libraries/libraries"

/** An OpenCode instance's MCP routes, in memory: add, status, and a dispose that forgets everything. */
function fakeBackend() {
	const servers = new Map<string, Record<string, McpServerStatus>>()
	const added: string[] = []
	const mcp = {
		async status(directory: string) {
			return { ...(servers.get(directory) ?? {}) }
		},
		async add(directory: string, name: string) {
			added.push(name)
			const status = servers.get(directory) ?? {}
			status[name] = name === "gummble" ? { status: "needs_auth" } : { status: "connected" }
			servers.set(directory, status)
			return status
		},
		async connect(directory: string, name: string) {
			const status = servers.get(directory) ?? {}
			status[name] = { status: "connected" }
		},
		async disconnect(directory: string, name: string) {
			const status = servers.get(directory) ?? {}
			status[name] = { status: "disabled" }
		},
		async startAuth() {
			return { authorizationUrl: "https://example.com" }
		},
	}
	return { backend: { mcp } as unknown as CodingBackend, added, dispose: () => servers.clear() }
}

describe("the component and reference libraries", () => {
	// The manager installs a process-wide tool policy; leave none behind.
	after(() => setOpencodeToolPolicy(() => ({})))
	// Never reach the network: Lazyweb's free token request is answered here.
	const offline = (async () => new Response("offline", { status: 503 })) as unknown as typeof globalThis.fetch

	it("adds the libraries that need nothing, skips the ones that still need a key, and re-adds after an instance reset", async function () {
		this.timeout(20_000)
		await mockFetchForTesting(offline, async () => {
			const fake = fakeBackend()
			const libraries = new DesignLibraries(
				async () => fake.backend,
				() => os.tmpdir(),
			)
			const usable = await libraries.ensure("/p")
			assert.ok(usable.has("shadcn") && usable.has("aceternity"))
			assert.ok(!usable.has("twentyfirst"), "21st.dev has no key yet")
			assert.ok(!usable.has("gummble"), "Gummble is waiting for a sign-in")
			assert.ok(!fake.added.includes("twentyfirst"))

			// A credential change disposes the instance and its runtime servers go with it.
			fake.dispose()
			const before = fake.added.length
			await libraries.ensure("/p")
			assert.ok(fake.added.length > before, "nothing was re-added after the reset")
			assert.ok(libraries.usable("/p").has("shadcn"))
		})
	})

	it("rests a library that rate-limits, so the designer goes straight to another", async function () {
		this.timeout(20_000)
		await mockFetchForTesting(offline, async () => {
			const fake = fakeBackend()
			const libraries = new DesignLibraries(
				async () => fake.backend,
				() => os.tmpdir(),
			)
			await libraries.ensure("/p")
			libraries.noteToolCalls([
				{ tool: "shadcn_search_items_in_registries", ok: false, error: "HTTP 429 Too Many Requests" },
				{ tool: "aceternity_search_components", ok: false, error: "Invalid arguments: query is required" },
			])
			assert.ok(!libraries.usable("/p").has("shadcn"), "a rate-limited library kept being offered")
			assert.ok(libraries.usable("/p").has("aceternity"), "a bad argument rested a healthy library")
			assert.ok(REST_MS >= 60_000)
		})
	})

	it("hides a resting or switched-off library's tools from every prompt in the project", async function () {
		this.timeout(20_000)
		await mockFetchForTesting(offline, async () => {
			const fake = fakeBackend()
			const libraries = new DesignLibraries(
				async () => fake.backend,
				() => os.tmpdir(),
			)
			await libraries.ensure("/p")
			assert.equal(toolsFor("/p").shadcn_search_items_in_registries, true)
			libraries.noteToolCalls([{ tool: "shadcn_view_items_in_registries", ok: false, error: "rate limit reached" }])
			assert.equal(toolsFor("/p").shadcn_search_items_in_registries, undefined)
			assert.equal(toolsFor("/p")["shadcn_*"], false)
		})
	})
})
