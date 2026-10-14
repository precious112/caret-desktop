import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import should from "should"

import { type CatalogLock, readCatalogLock, rebindHexClasses } from "../catalog/install"
import { catalogFindings, planSupply, registryRefFor, scanCatalogImports } from "../catalog/supply"

const EMPTY_LOCK: CatalogLock = { version: 1, installed: [] }

function lockWith(...files: string[]): CatalogLock {
	return {
		version: 1,
		installed: files.map((file) => ({
			library: file.split("/")[0],
			component: file.split("/")[1],
			origin: "test",
			licence: "MIT",
			installedAt: "t",
			files: [file],
			deps: [],
		})),
	}
}

describe("component supply", () => {
	it("maps a known registry's folder to its ref, and nothing else", () => {
		should(registryRefFor("magicui/marquee")).equal("@magicui/marquee")
		should(registryRefFor("ui/button")).equal("@shadcn/button")
		should(registryRefFor("aceternity/world-map")).equal("@aceternity/world-map")
		should(registryRefFor("fancy/text-scramble")).be.null()
		should(registryRefFor("21st/10635/logs-table")).be.null()
		should(registryRefFor("marquee")).be.null()
	})

	it("finds each catalog import once, with or without an extension", () => {
		const source = [
			'import { Marquee } from "../../components/catalog/magicui/marquee"',
			"import Map from '../../components/catalog/aceternity/world-map.tsx'",
			'import { Marquee as M2 } from "../../components/catalog/magicui/marquee"',
			'import Card from "../../components/Card"',
		].join("\n")
		scanCatalogImports(source, EMPTY_LOCK)
			.map((r) => r.target)
			.should.eql(["magicui/marquee", "aceternity/world-map"])
	})

	it("installs what a registry supplies, reports what nothing supplies, and leaves installed imports alone", () => {
		const source = [
			'import { Marquee } from "../../components/catalog/magicui/marquee"',
			'import X from "../../components/catalog/fancy/text-scramble"',
			'import Logs from "../../components/catalog/21st/10635/logs-table"',
		].join("\n")
		planSupply(source, EMPTY_LOCK).should.eql({
			install: ["@magicui/marquee"],
			unknown: ["fancy/text-scramble", "21st/10635/logs-table"],
		})
		planSupply(source, lockWith("magicui/marquee.tsx", "21st/10635/logs-table.tsx")).should.eql({
			install: [],
			unknown: ["fancy/text-scramble"],
		})
	})

	it("has no per-page budget: any number of components can be supplied", () => {
		const source = ["magicui/particles", "magicui/marquee", "aceternity/sparkles"]
			.map((t, i) => `import C${i} from "../../components/catalog/${t}"`)
			.join("\n")
		planSupply(source, EMPTY_LOCK).install.length.should.equal(3)
		catalogFindings(source, "home", EMPTY_LOCK).should.eql([])
	})

	it("names an unresolvable import as a design-check finding", () => {
		const findings = catalogFindings('import X from "../../components/catalog/fancy/x"', "home", EMPTY_LOCK)
		findings.map((f) => f.check).should.eql(["catalog-unknown"])
		findings[0].pageId.should.equal("home")
	})

	it("rebinds an arbitrary hex class to a foundation token when one matches exactly", () => {
		rebindHexClasses('<div className="bg-[#0b7aff] text-[#123456]" />', (hex) =>
			hex === "#0b7aff" ? "brand-500" : null,
		).should.equal('<div className="bg-brand-500 text-[#123456]" />')
	})

	it("reads a missing or broken lock as empty", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "caret-lock-"))
		;(await readCatalogLock(dir)).should.eql(EMPTY_LOCK)
		await fs.mkdir(path.join(dir, ".caret", "components", "catalog"), { recursive: true })
		await fs.writeFile(path.join(dir, ".caret", "components", "catalog", "catalog-lock.json"), "{not json")
		;(await readCatalogLock(dir)).should.eql(EMPTY_LOCK)
		await fs.rm(dir, { recursive: true, force: true })
	})
})
