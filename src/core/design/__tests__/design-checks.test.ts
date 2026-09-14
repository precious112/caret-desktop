import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import should from "should"

import {
	type CheckFinding,
	checkEnabled,
	defaultChecksConfigJson,
	filterByConfig,
	formatFeedback,
	metaFindings,
	pageIdsFromFiles,
	readChecksConfig,
	readChecksResults,
	shouldFeedBack,
	storeChecksResults,
	tailwindFindings,
} from "../design-checks"

function finding(check: string, severity: CheckFinding["severity"], pageId = "home"): CheckFinding {
	return { check, severity, message: `${check} fired`, pageId }
}

describe("design checks config", () => {
	let workspace: string

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), "checks-"))
		await fs.mkdir(path.join(workspace, ".caret"), { recursive: true })
	})

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true })
	})

	it("defaults every check to enabled, including unknown future ones", async () => {
		const config = await readChecksConfig(workspace)
		checkEnabled(config, "contrast").should.be.true()
		checkEnabled(config, "some-future-check").should.be.true()
	})

	it("a disabled check filters its findings out", async () => {
		await fs.writeFile(
			path.join(workspace, ".caret", "checks.json"),
			JSON.stringify({ version: 1, checks: { "border-on-everything": false } }),
		)
		const config = await readChecksConfig(workspace)
		const kept = filterByConfig([finding("border-on-everything", "warn"), finding("contrast", "error")], config)
		kept.should.have.length(1)
		kept[0].check.should.equal("contrast")
	})

	it("the seeded config is valid JSON naming every built-in check", () => {
		const seeded = JSON.parse(defaultChecksConfigJson())
		seeded.checks.contrast.should.be.true()
		seeded.checks["placeholder-box"].should.be.true()
		seeded.descriptions["identical-cards"].should.be.a.String()
	})
})

describe("feedback policy", () => {
	it("feeds back only when errors exist — warnings and info never cost a model turn", () => {
		shouldFeedBack([finding("missing-alt", "error")]).should.be.true()
		shouldFeedBack([finding("border-on-everything", "warn"), finding("missing-states", "info")]).should.be.false()
		shouldFeedBack([]).should.be.false()
	})

	it("formats feedback naming each error with its page and check", () => {
		const text = formatFeedback([finding("missing-alt", "error", "landing"), finding("border-on-everything", "warn")])
		text.should.containEql("[landing]")
		text.should.containEql("missing-alt")
		text.should.containEql("1 problem")
		text.should.not.containEql("border-on-everything")
	})

	it("a page-error finding is an error, so it reaches the agent that wrote the page", () => {
		// The whole point of the check: a page that error-cards must cost a
		// corrective turn, not sit as an info line nobody reads.
		shouldFeedBack([finding("page-error", "error")]).should.be.true()
	})
})

describe("tailwindFindings", () => {
	it("flags a second Tailwind import in a page stylesheet, with the file named", () => {
		const found = tailwindFindings(
			"home",
			[{ file: "pages/home/hero.css", content: '@import "tailwindcss";\n.x { color: red }' }],
			[],
		)
		found.should.have.length(1)
		found[0].check.should.equal("tailwind-setup")
		found[0].severity.should.equal("error")
		found[0].message.should.containEql("pages/home/hero.css")
	})

	it("flags a tailwind config file as an error naming the file", () => {
		const found = tailwindFindings("home", [], [".caret/tailwind.config.js"])
		found.should.have.length(1)
		found[0].severity.should.equal("error")
		found[0].message.should.containEql("tailwind.config.js")
	})

	it("stays quiet over ordinary stylesheets", () => {
		tailwindFindings("home", [{ file: "pages/home/hero.css", content: ".x { color: red }" }], []).should.have.length(0)
	})
})

describe("metaFindings", () => {
	const base = { id: "p", title: "P", type: "page", tags: [] }

	it("flags a page that declares only its happy path", () => {
		metaFindings({ ...base, states: [] })[0].check.should.equal("missing-states")
		metaFindings({ ...base, states: ["default"] })[0].severity.should.equal("info")
	})

	it("stays quiet when real states are declared", () => {
		metaFindings({ ...base, states: ["default", "empty", "error"] }).should.have.length(0)
	})
})

describe("pageIdsFromFiles", () => {
	it("extracts distinct page ids and skips variant takes and non-page files", () => {
		pageIdsFromFiles([
			"/w/.caret/pages/home/index.tsx",
			"/w/.caret/pages/home/meta.json",
			"/w/.caret/pages/about/index.tsx",
			"/w/.caret/pages/home--v2/index.tsx",
			"/w/.caret/components/Button.tsx",
			"/w/src/App.tsx",
		]).should.eql(["home", "about"])
	})
})

describe("results store", () => {
	let workspace: string

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), "checks-results-"))
		await fs.mkdir(path.join(workspace, ".caret"), { recursive: true })
	})

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true })
	})

	it("replaces results for re-checked pages and keeps the rest", async () => {
		await storeChecksResults(workspace, [
			{ pageId: "home", findings: [finding("missing-alt", "error", "home")], at: "t1" },
			{ pageId: "about", findings: [], at: "t1" },
		])
		await storeChecksResults(workspace, [{ pageId: "home", findings: [], at: "t2" }])

		const results = await readChecksResults(workspace)
		results.pages.should.have.length(2)
		results.pages.find((p) => p.pageId === "home")?.at.should.equal("t2")
		results.pages.find((p) => p.pageId === "home")?.findings.should.have.length(0)
		results.pages.find((p) => p.pageId === "about")?.at.should.equal("t1")
	})

	it("drops entries for pages that no longer exist when told what is live", async () => {
		await storeChecksResults(workspace, [
			{ pageId: "deleted-page", findings: [finding("missing-alt", "error", "deleted-page")], at: "t1" },
			{ pageId: "home", findings: [], at: "t1" },
		])
		await storeChecksResults(workspace, [{ pageId: "home", findings: [], at: "t2" }], ["home"])

		const results = await readChecksResults(workspace)
		results.pages.map((p) => p.pageId).should.eql(["home"])
	})

	it("survives a missing or corrupt results file", async () => {
		;(await readChecksResults(workspace)).pages.should.have.length(0)
		await fs.writeFile(path.join(workspace, ".caret", ".checks-results.json"), "{oops")
		;(await readChecksResults(workspace)).pages.should.have.length(0)
	})
})

describe("scaffold seeds checks.json", () => {
	it("ensureCaretDirectoryExists writes the versioned check list", async () => {
		const { ensureCaretDirectoryExists } = await import("../scaffold")
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "checks-scaffold-"))
		try {
			await ensureCaretDirectoryExists(workspace)
			const seeded = JSON.parse(await fs.readFile(path.join(workspace, ".caret", "checks.json"), "utf-8"))
			seeded.checks.contrast.should.be.true()
			const gitignore = await fs.readFile(path.join(workspace, ".caret", ".gitignore"), "utf-8")
			should(gitignore.includes("checks.json\n") && !gitignore.includes(".checks-results")).be.false()
			gitignore.should.containEql(".checks-results.json")
			gitignore
				.split("\n")
				.map((l) => l.trim())
				.should.not.containEql("checks.json")
		} finally {
			await fs.rm(workspace, { recursive: true, force: true })
		}
	})
})
