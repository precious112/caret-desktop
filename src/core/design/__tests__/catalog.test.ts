import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import should from "should"

import { CATALOG, catalogImportPath, findCatalogComponent, parseCatalogImport } from "../catalog/catalog"
import { type CatalogLock, readCatalogLock, rebindHexClasses } from "../catalog/install"
import { catalogFindings, planSupply, scanCatalogImports } from "../catalog/supply"

const EMPTY_LOCK: CatalogLock = { version: 1, installed: [] }

function lockWith(...pairs: Array<[string, string]>): CatalogLock {
	return {
		version: 1,
		installed: pairs.map(([library, component]) => ({
			library,
			component,
			origin: "test",
			licence: "MIT",
			installedAt: "t",
			files: [],
			deps: [],
		})),
	}
}

describe("catalog data", () => {
	it("has unique library ids and unique component ids within each library", () => {
		const libraryIds = CATALOG.map((library) => library.id)
		new Set(libraryIds).size.should.equal(libraryIds.length)
		for (const library of CATALOG) {
			const ids = library.components.map((component) => component.id)
			new Set(ids).size.should.equal(ids.length, `${library.id} repeats a component id`)
		}
	})

	it("declares only clean licences — the user's ruling, encoded", () => {
		for (const library of CATALOG) {
			;["MIT", "Apache-2.0"].should.containEql(library.licence)
		}
	})

	it("every vendored component in the catalog exists in the shipped mirror", async () => {
		const manifest = JSON.parse(await fs.readFile(path.resolve("assets/catalog/manifest.json"), "utf-8"))
		for (const library of CATALOG) {
			if (library.tier !== "vendored") continue
			for (const component of library.components) {
				const entry = manifest.libraries?.[library.id]?.components?.[component.id]
				should(entry).not.be.undefined() // missing → re-run vendor-catalog for this id
				const file = path.resolve("assets/catalog", library.id, entry.file)
				;(await fs.readFile(file, "utf-8")).length.should.be.above(100)
			}
			// The licence must ride with the mirror.
			;(await fs.readFile(path.resolve("assets/catalog", library.id, "LICENSE"), "utf-8")).length.should.be.above(100)
		}
	})

	it("import paths round-trip through the parser", () => {
		const importPath = catalogImportPath("magicui", "marquee")
		importPath.should.equal("../../components/catalog/magicui/marquee")
		parseCatalogImport(importPath)?.should.eql({ libraryId: "magicui", componentId: "marquee" })
		should(parseCatalogImport("../../components/Button")).be.null()
	})
})

describe("supply planning", () => {
	const page = (imports: string[]) => imports.map((spec, i) => `import C${i} from "${spec}"`).join("\n")

	it("finds catalog imports and marks unknown ones", () => {
		const refs = scanCatalogImports(
			page([
				"../../components/catalog/magicui/marquee",
				"../../components/catalog/nope/nothing",
				"../../components/Button",
			]),
		)
		refs.should.have.length(2)
		refs[0].known.should.be.true()
		refs[1].known.should.be.false()
	})

	it("installs within budget: the first signature import wins the slot", () => {
		const source = page([
			"../../components/catalog/magicui/particles", // signature
			"../../components/catalog/magicui/marquee", // not signature
			"../../components/catalog/fancy/pixel-trail", // signature — over budget
		])
		const plan = planSupply(source, EMPTY_LOCK)
		plan.install.map((r) => r.componentId).should.eql(["particles", "marquee"])
		plan.overBudget.map((r) => r.componentId).should.eql(["pixel-trail"])
	})

	it("does not reinstall what the lock already has", () => {
		const source = page(["../../components/catalog/magicui/marquee"])
		planSupply(source, lockWith(["magicui", "marquee"])).install.should.have.length(0)
	})

	it("budget findings are errors the checker can feed back", () => {
		const source = page([
			"../../components/catalog/magicui/particles",
			"../../components/catalog/fancy/pixel-trail",
			"../../components/catalog/wrong/thing",
		])
		const findings = catalogFindings(source, "home", EMPTY_LOCK)
		findings
			.map((f) => f.check)
			.sort()
			.should.eql(["catalog-unknown", "restraint-budget"])
		findings.every((f) => f.severity === "error").should.be.true()
	})

	it("signature status comes from the catalog, not the import", () => {
		const found = findCatalogComponent("magicui", "particles")
		found?.component.signature.should.be.true()
		findCatalogComponent("magicui", "marquee")?.component.signature.should.be.false()
	})
})

describe("rebindHexClasses", () => {
	it("rebinds exact token matches and leaves everything else", () => {
		const out = rebindHexClasses('className="bg-[#0b7aff] text-[#123456] p-4"', (hex) =>
			hex.toLowerCase() === "#0b7aff" ? "brand-500" : null,
		)
		out.should.equal('className="bg-brand-500 text-[#123456] p-4"')
	})
})

describe("catalog lock", () => {
	it("reads an absent lock as empty", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lock-"))
		try {
			;(await readCatalogLock(dir)).installed.should.have.length(0)
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})
