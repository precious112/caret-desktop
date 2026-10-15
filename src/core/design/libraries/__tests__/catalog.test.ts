import should from "should"

import { mergeTools } from "../../agent/opencode"
import {
	connectionFor,
	isLibraryOutage,
	LIBRARIES,
	librarySearchParagraph,
	passedOnName,
	REGISTRIES,
	safeInputSchema,
	shadcnComponentsJson,
	splitPassedOnName,
} from "../catalog"

const context = { npx: "npx", shadcnDir: "/caret/shadcn" }

describe("libraries · the list", () => {
	it("never passes on a write or install tool", () => {
		for (const library of LIBRARIES) {
			for (const tool of library.allowedTools)
				tool.should.not.match(/delete|create|update|install|add_command|publish|edit|write/)
		}
	})

	it("needs a credential for Lazyweb and 21st.dev, and none for the rest", () => {
		should(connectionFor("twentyfirst", context)).be.null()
		should(connectionFor("lazyweb", context)).be.null()
		connectionFor("twentyfirst", { ...context, credential: "k" })!.should.containDeep({
			kind: "http",
			headers: { "x-api-key": "k" },
		})
		connectionFor("lazyweb", { ...context, credential: "t" })!.should.containDeep({ headers: { Authorization: "Bearer t" } })
		connectionFor("gummble", context)!.should.containDeep({ kind: "http", url: "https://mcp.gummble.com/mcp" })
		const shadcn = connectionFor("shadcn", context)!
		shadcn.should.containDeep({ kind: "stdio", command: "npx" })
		;(shadcn as { args: string[] }).args.should.containEql("--cwd")
		;(shadcn as { args: string[] }).args.should.containEql("/caret/shadcn")
	})

	it("names a passed-on tool after its library, and only recognises tools it passes on", () => {
		passedOnName("lazyweb", "lazyweb_execute").should.equal("lazyweb_lazyweb_execute")
		splitPassedOnName("lazyweb_lazyweb_execute", LIBRARIES)!.tool.should.equal("lazyweb_execute")
		splitPassedOnName("twentyfirst_search", LIBRARIES)!.library.id.should.equal("twentyfirst")
		should(splitPassedOnName("twentyfirst_delete_component", LIBRARIES)).be.null()
		should(splitPassedOnName("get_project", LIBRARIES)).be.null()
	})

	it("tells an outage from a bad argument", () => {
		should(isLibraryOutage("HTTP 429 Too Many Requests")).equal("rate-limit")
		should(isLibraryOutage("Daily quota reached")).equal("rate-limit")
		should(isLibraryOutage("401 Unauthorized")).equal("auth")
		should(isLibraryOutage("MCP error -32001: Request timed out")).equal("unavailable")
		should(isLibraryOutage("fetch failed")).equal("unavailable")
		should(isLibraryOutage("Invalid arguments: query is required")).be.null()
	})

	it("gives the shadcn library the same registries the installer fetches from", () => {
		const json = JSON.parse(shadcnComponentsJson())
		for (const [name, url] of Object.entries(REGISTRIES)) {
			if (name === "@shadcn") continue
			json.registries[name].should.equal(url)
		}
	})
})

describe("libraries · input formats made safe", () => {
	it("folds a top-level oneOf, anyOf or allOf into one plain object, nothing required", () => {
		for (const key of ["oneOf", "anyOf", "allOf"]) {
			const safe = safeInputSchema({
				type: "object",
				required: ["a"],
				[key]: [{ properties: { a: { type: "string" } } }, { properties: { b: { type: "number" } } }],
			})
			should(safe[key]).be.undefined()
			should(safe.required).be.undefined()
			should(safe.type).equal("object")
			Object.keys(safe.properties as object).should.eql(["a", "b"])
		}
	})

	it("leaves an ordinary format exactly as the library wrote it", () => {
		const schema = { type: "object", properties: { q: { type: "string" } }, required: ["q"] }
		safeInputSchema(schema).should.eql(schema)
	})
})

describe("libraries · the paragraph in the rules", () => {
	const shadcn = { id: "shadcn", name: "shadcn registries", kind: "components" as const }
	const lazyweb = { id: "lazyweb", name: "Lazyweb", kind: "inspiration" as const }

	it("is absent when no library is on", () => {
		should(librarySearchParagraph([])).be.null()
	})

	it("names exactly the libraries that are on, under components or references", () => {
		const text = librarySearchParagraph([shadcn, lazyweb])!
		text.should.match(/When you create a page, first search these libraries/)
		text.should.match(/Components: shadcn registries \(tools named `shadcn_…`\)\./)
		text.should.match(/References: Lazyweb \(tools named `lazyweb_…`\)\./)
		text.should.match(/foundation .* wins over a component's own styles/)
		librarySearchParagraph([shadcn])!.should.not.match(/References/)
		librarySearchParagraph([lazyweb])!.should.not.match(/Components/)
	})
})

describe("libraries · tool switches per prompt", () => {
	it("lets a later layer's key win and also come later", () => {
		mergeTools({ "lazyweb_*": false, bash: false }, { bash: true, "lazyweb_*": true }).should.eql({
			"lazyweb_*": true,
			bash: true,
		})
		Object.keys(mergeTools({ a: false, b: false }, { a: true })).should.eql(["b", "a"])
	})
})
