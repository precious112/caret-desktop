import should from "should"

import { toolsFor } from "../../agent/opencode"
import {
	isLibraryOutage,
	LIBRARIES,
	type LibraryId,
	libraryOfTool,
	libraryToolPolicy,
	mcpConfigFor,
	REGISTRIES,
	shadcnComponentsJson,
} from "../libraries"

const context = { npx: "npx", shadcnDir: "/caret/shadcn" }

describe("design pass · libraries", () => {
	it("hides every library tool, then re-allows only the usable libraries' read tools, globs first", () => {
		const policy = libraryToolPolicy(new Set<LibraryId>(["twentyfirst"]))
		const keys = Object.keys(policy)
		keys.slice(0, LIBRARIES.length)
			.every((k) => k.endsWith("_*"))
			.should.be.true()
		Object.values(policy)
			.slice(0, LIBRARIES.length)
			.every((v) => v === false)
			.should.be.true()
		policy.twentyfirst_search.should.be.true()
		policy.twentyfirst_get_inspiration.should.be.true()
		should(policy.twentyfirst_delete_component).be.undefined()
		should(policy.shadcn_search_items_in_registries).be.undefined()
		keys.indexOf("twentyfirst_*").should.be.below(keys.indexOf("twentyfirst_search"))
	})

	it("never allows a write or install tool", () => {
		for (const library of LIBRARIES) {
			for (const tool of library.allowedTools)
				tool.should.not.match(/delete|create|update|install|add_command|publish|edit|write/)
		}
	})

	it("needs a credential for Lazyweb and 21st.dev, and none for the rest", () => {
		should(mcpConfigFor("twentyfirst", context)).be.null()
		should(mcpConfigFor("lazyweb", context)).be.null()
		mcpConfigFor("twentyfirst", { ...context, credential: "k" })!.should.containDeep({
			type: "remote",
			headers: { "x-api-key": "k" },
		})
		mcpConfigFor("lazyweb", { ...context, credential: "t" })!.should.containDeep({ headers: { Authorization: "Bearer t" } })
		mcpConfigFor("gummble", context)!.should.containDeep({ type: "remote", url: "https://mcp.gummble.com/mcp" })
		const shadcn = mcpConfigFor("shadcn", context)!
		shadcn.should.containDeep({ type: "local" })
		;(shadcn as { command: string[] }).command.should.containEql("--cwd")
		;(shadcn as { command: string[] }).command.should.containEql("/caret/shadcn")
	})

	it("names the library a prefixed tool belongs to", () => {
		should(libraryOfTool("lazyweb_lazyweb_execute")).equal("lazyweb")
		should(libraryOfTool("twentyfirst_search")).equal("twentyfirst")
		should(libraryOfTool("caret_view_reference")).be.null()
	})

	it("tells an outage from a bad argument", () => {
		should(isLibraryOutage("HTTP 429 Too Many Requests")).equal("rate-limit")
		should(isLibraryOutage("Daily quota reached")).equal("rate-limit")
		should(isLibraryOutage("401 Unauthorized")).equal("auth")
		should(isLibraryOutage("MCP error -32001: Request timed out")).equal("unavailable")
		should(isLibraryOutage("fetch failed")).equal("unavailable")
		should(isLibraryOutage("Invalid arguments: query is required")).be.null()
	})

	it("gives the shadcn MCP the same registries the installer fetches from", () => {
		const json = JSON.parse(shadcnComponentsJson())
		for (const [name, url] of Object.entries(REGISTRIES)) {
			if (name === "@shadcn") continue
			json.registries[name].should.equal(url)
		}
	})
})

describe("design pass · tool switches per prompt", () => {
	it("lets a later layer's key win and also come later", () => {
		const merged = toolsFor("/p", { "lazyweb_*": false, bash: false }, { bash: true, "lazyweb_*": true })
		merged.should.eql({ "lazyweb_*": true, bash: true })
		Object.keys(toolsFor("/p", { a: false, b: false }, { a: true })).should.eql(["b", "a"])
	})
})
