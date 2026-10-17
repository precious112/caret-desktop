import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import should from "should"

import {
	applyLeaf,
	createExploration,
	discardExploration,
	markNodeStarted,
	readExploration,
	registerExternalRound,
	spawnRound,
	updateNodeStatus,
	VARIANT_COUNT,
} from "../variants"

const PAGE = `export default function Home() { return <h1>Original</h1> }`

describe("the playground's exploration tree", () => {
	let workspace: string
	let pagesDir: string

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), "variants-"))
		pagesDir = path.join(workspace, ".caret", "pages")
		await fs.mkdir(path.join(pagesDir, "home"), { recursive: true })
		await fs.writeFile(path.join(pagesDir, "home", "index.tsx"), PAGE)
		await fs.writeFile(
			path.join(pagesDir, "home", "meta.json"),
			JSON.stringify({ id: "home", title: "Home", type: "page", states: [], tags: ["landing"] }),
		)
	})

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true })
	})

	it("copies the page N times with variant metas, and refuses a second concurrent exploration", async () => {
		const exploration = await createExploration(workspace, { pageId: "home", instruction: "make it feel premium" })
		exploration.nodes.should.have.length(VARIANT_COUNT)

		for (const [i, node] of exploration.nodes.entries()) {
			node.status.should.equal("working")
			node.parentId.should.equal("home")
			node.angleLabel.should.be.oneOf(["Restrained", "Bolder", "Structural"])
			const source = await fs.readFile(path.join(pagesDir, node.id, "index.tsx"), "utf-8")
			source.should.equal(PAGE)
			const meta = JSON.parse(await fs.readFile(path.join(pagesDir, node.id, "meta.json"), "utf-8"))
			meta.variantOf.should.equal("home")
			meta.id.should.equal(node.id)
			meta.title.should.containEql(`take ${i + 1}`)
		}

		await createExploration(workspace, { pageId: "home", instruction: "again" }).should.be.rejectedWith(/already open/)
	})

	it("a deepening round branches from a ready node, keeps variantOf pointing at the root, and never reuses a take number", async () => {
		const exploration = await createExploration(workspace, { pageId: "home", instruction: "premium" })
		const from = exploration.nodes[1]
		await fs.writeFile(
			path.join(pagesDir, from.id, "index.tsx"),
			`export default function Home() { return <h1>Direction two</h1> }`,
		)

		await spawnRound(workspace, from.id, "push further").should.be.rejectedWith(/isn't ready/)
		await updateNodeStatus(workspace, from.id, "ready")
		const round = await spawnRound(workspace, from.id, "push further")

		round.should.have.length(VARIANT_COUNT)
		const allIds = new Set((await readExploration(workspace))?.nodes.map((n) => n.id))
		allIds.size.should.equal(VARIANT_COUNT * 2)
		for (const node of round) {
			node.parentId.should.equal(from.id)
			const source = await fs.readFile(path.join(pagesDir, node.id, "index.tsx"), "utf-8")
			source.should.containEql("Direction two")
			const meta = JSON.parse(await fs.readFile(path.join(pagesDir, node.id, "meta.json"), "utf-8"))
			meta.variantOf.should.equal("home")
		}
	})

	it("applying a deep leaf replaces the original's source, keeps its meta identity, and cleans the whole tree", async () => {
		const exploration = await createExploration(workspace, { pageId: "home", instruction: "bolder" })
		const chosen = exploration.nodes[1]
		await fs.writeFile(
			path.join(pagesDir, chosen.id, "index.tsx"),
			`export default function Home() { return <h1>Take two</h1> }`,
		)
		await updateNodeStatus(workspace, chosen.id, "ready")
		const round = await spawnRound(workspace, chosen.id, "further")
		const leaf = round[0]
		await fs.writeFile(
			path.join(pagesDir, leaf.id, "index.tsx"),
			`export default function Home() { return <h1>Deep take</h1> }`,
		)
		await applyLeaf(workspace, leaf.id).should.be.rejectedWith(/isn't finished/)
		await updateNodeStatus(workspace, leaf.id, "ready")

		await applyLeaf(workspace, leaf.id)

		const source = await fs.readFile(path.join(pagesDir, "home", "index.tsx"), "utf-8")
		source.should.containEql("Deep take")
		const meta = JSON.parse(await fs.readFile(path.join(pagesDir, "home", "meta.json"), "utf-8"))
		meta.id.should.equal("home")
		meta.title.should.equal("Home")
		should(meta.variantOf).be.undefined()

		const remaining = await fs.readdir(pagesDir)
		remaining.should.eql(["home"])
		should(await readExploration(workspace)).be.null()
	})

	it("a new-page exploration scaffolds stub takes and settling adds the page to the canvas", async () => {
		const exploration = await createExploration(workspace, {
			mode: "new",
			name: "Pricing Page",
			instruction: "a simple three-tier pricing page",
		})
		exploration.pageId.should.equal("pricing-page")
		exploration.mode.should.equal("new")

		// The root page itself must not exist while exploring — only the takes.
		await fs
			.access(path.join(pagesDir, "pricing-page"))
			.then(() => {
				throw new Error("root page should not exist during the exploration")
			})
			.catch(() => {})
		for (const node of exploration.nodes) {
			const meta = JSON.parse(await fs.readFile(path.join(pagesDir, node.id, "meta.json"), "utf-8"))
			meta.variantOf.should.equal("pricing-page")
		}

		const chosen = exploration.nodes[0]
		await fs.writeFile(
			path.join(pagesDir, chosen.id, "index.tsx"),
			`export default function Pricing() { return <h1>Three tiers</h1> }`,
		)
		await updateNodeStatus(workspace, chosen.id, "ready")
		await applyLeaf(workspace, chosen.id)

		const source = await fs.readFile(path.join(pagesDir, "pricing-page", "index.tsx"), "utf-8")
		source.should.containEql("Three tiers")
		const meta = JSON.parse(await fs.readFile(path.join(pagesDir, "pricing-page", "meta.json"), "utf-8"))
		meta.id.should.equal("pricing-page")
		meta.title.should.equal("Pricing Page")
		should(meta.variantOf).be.undefined()
		const remaining = await fs.readdir(pagesDir)
		remaining.sort().should.eql(["home", "pricing-page"])
	})

	it("a new-page exploration refuses a name whose page already exists", async () => {
		await createExploration(workspace, { mode: "new", name: "Home", instruction: "x" }).should.be.rejectedWith(
			/already exists/,
		)
	})

	it("discard removes every take and the scratch, leaving the original untouched", async () => {
		const exploration = await createExploration(workspace, { pageId: "home", instruction: "anything" })
		await discardExploration(workspace)
		;(await fs.readFile(path.join(pagesDir, "home", "index.tsx"), "utf-8")).should.equal(PAGE)
		should(await readExploration(workspace)).be.null()
		const remaining = await fs.readdir(pagesDir)
		remaining.should.eql(["home"])
		exploration.nodes.should.have.length(VARIANT_COUNT)
	})

	it("registers external takes only when every named page actually exists, and counts past their numbering", async () => {
		await fs.mkdir(path.join(pagesDir, "home--v1"), { recursive: true })
		await fs.writeFile(path.join(pagesDir, "home--v1", "index.tsx"), PAGE)

		await registerExternalRound(workspace, "home", ["home--v1", "home--v2"], "explore").should.be.rejected()

		await fs.mkdir(path.join(pagesDir, "home--v2"), { recursive: true })
		await fs.writeFile(path.join(pagesDir, "home--v2", "index.tsx"), PAGE)
		const exploration = await registerExternalRound(workspace, "home", ["home--v1", "home--v2"], "explore")
		exploration.source.should.equal("external")
		exploration.nextTake.should.equal(3)
		exploration.nodes.every((n) => n.status === "ready").should.be.true()
		exploration.nodes.every((n) => n.angleLabel === "External").should.be.true()
	})

	it("refuses ids that would resolve outside the pages directory, before touching anything", async () => {
		const outside = path.join(workspace, "victim")
		await fs.mkdir(outside, { recursive: true })
		await fs.writeFile(path.join(outside, "index.tsx"), PAGE)

		await registerExternalRound(workspace, "home", ["../../victim"], "attack").should.be.rejectedWith(/not a valid page id/)
		await registerExternalRound(workspace, "../victim", ["home--v1"], "attack").should.be.rejectedWith(/not a valid page id/)

		// A hand-corrupted scratch must not let discard escape either.
		await fs.writeFile(
			path.join(workspace, ".caret", ".variants.json"),
			JSON.stringify({
				version: 2,
				mode: "page",
				pageId: "home",
				instruction: "x",
				startedAt: new Date().toISOString(),
				source: "caret",
				nextTake: 2,
				nodes: [
					{
						id: "../victim",
						parentId: "home",
						instruction: "x",
						angle: "a",
						angleLabel: "A",
						label: "Take 1",
						status: "ready",
						startedAt: new Date().toISOString(),
					},
				],
			}),
		)
		await discardExploration(workspace).should.be.rejectedWith(/not a valid page id/)
		await fs.access(path.join(outside, "index.tsx"))
	})

	it("records take failures and cancellations without disturbing the others", async () => {
		const exploration = await createExploration(workspace, { pageId: "home", instruction: "x" })
		await updateNodeStatus(workspace, exploration.nodes[0].id, "failed", "model refused")
		await updateNodeStatus(workspace, exploration.nodes[1].id, "cancelled")

		const stored = await readExploration(workspace)
		stored?.nodes[0].status.should.equal("failed")
		stored?.nodes[0].error?.should.equal("model refused")
		stored?.nodes[1].status.should.equal("cancelled")
		stored?.nodes[2].status.should.equal("working")
	})

	it("a leftover version-1 scratch reads as no exploration", async () => {
		await fs.writeFile(
			path.join(workspace, ".caret", ".variants.json"),
			JSON.stringify({ version: 1, pageId: "home", variants: [] }),
		)
		should(await readExploration(workspace)).be.null()
	})

	describe("as a branching board", () => {
		async function readyAll(): Promise<void> {
			const open = await readExploration(workspace)
			for (const node of open!.nodes) await updateNodeStatus(workspace, node.id, "ready")
		}

		it("two branches started at the same moment get their own takes and folders", async () => {
			const exploration = await createExploration(workspace, { pageId: "home", instruction: "premium" })
			await readyAll()
			const [a, b] = await Promise.all([
				spawnRound(workspace, exploration.nodes[0].id, "warmer"),
				spawnRound(workspace, exploration.nodes[2].id, "darker"),
			])
			const ids = [...a, ...b].map((node) => node.id)
			new Set(ids).size.should.equal(6)
			const open = (await readExploration(workspace))!
			open.nodes.should.have.length(9)
			open.nextTake.should.equal(10)
			for (const node of a) node.parentId.should.equal(exploration.nodes[0].id)
			for (const node of b) node.parentId.should.equal(exploration.nodes[2].id)
			;(a[0].round !== b[0].round).should.be.true()
		})

		it("a take finishing while a branch is being copied stays finished", async () => {
			const exploration = await createExploration(workspace, { pageId: "home", instruction: "premium" })
			await updateNodeStatus(workspace, exploration.nodes[0].id, "ready")
			const branching = spawnRound(workspace, exploration.nodes[0].id, "warmer")
			const finishing = updateNodeStatus(workspace, exploration.nodes[1].id, "ready")
			await Promise.all([branching, finishing])
			const open = (await readExploration(workspace))!
			open.nodes.find((node) => node.id === exploration.nodes[1].id)!.status.should.equal("ready")
		})

		it("branches one take twice and the original again, records the round and strength, and keeps titles short", async () => {
			const exploration = await createExploration(workspace, { pageId: "home", instruction: "premium" })
			await readyAll()
			const first = await spawnRound(workspace, exploration.nodes[1].id, "warmer", { strength: "subtle" })
			const second = await spawnRound(workspace, exploration.nodes[1].id, "a new layout", { strength: "strong" })
			const fresh = await spawnRound(workspace, "home", "a whole new direction")
			first[0].strength!.should.equal("subtle")
			second[0].strength!.should.equal("strong")
			;(first[0].round !== second[0].round).should.be.true()
			fresh[0].parentId.should.equal("home")
			for (const node of first) await updateNodeStatus(workspace, node.id, "ready")
			const deep = await spawnRound(workspace, first[0].id, "closer")
			const meta = JSON.parse(await fs.readFile(path.join(pagesDir, deep[0].id, "meta.json"), "utf-8"))
			meta.title.should.equal(`Home — take ${deep[0].id.split("--v")[1]}`)
		})

		it("a take's timer starts when its turn starts, not when it was queued", async () => {
			const exploration = await createExploration(workspace, { pageId: "home", instruction: "premium" })
			const queuedAt = exploration.nodes[0].startedAt
			await new Promise((resolve) => setTimeout(resolve, 20))
			await markNodeStarted(workspace, exploration.nodes[0].id)
			const open = (await readExploration(workspace))!
			;(Date.parse(open.nodes[0].startedAt) > Date.parse(queuedAt)).should.be.true()
			// A take that has already finished keeps its time.
			await updateNodeStatus(workspace, exploration.nodes[1].id, "ready")
			const before = (await readExploration(workspace))!.nodes[1].startedAt
			await markNodeStarted(workspace, exploration.nodes[1].id)
			;(await readExploration(workspace))!.nodes[1].startedAt.should.equal(before)
		})
	})
})
