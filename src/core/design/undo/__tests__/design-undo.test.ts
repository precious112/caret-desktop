import { execFileSync } from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import "should"

import { captureUndoStep, listUndoSteps, redoStep, undoLastStep } from "../design-undo"

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" })
}

describe("design undo — one stack for every design-layer actor", () => {
	let dir: string
	let pagePath: string

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "design-undo-"))
		git(dir, "init", "-q")
		git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root")
		await fs.mkdir(path.join(dir, ".caret", "pages", "home"), { recursive: true })
		pagePath = path.join(dir, ".caret", "pages", "home", "index.tsx")
		await fs.writeFile(pagePath, `<h1 data-caret-id="t">Original</h1>\n`)
	})
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("undoes the last edit, restoring exactly the changed file", async () => {
		await captureUndoStep(dir, "text edit on t")
		await fs.writeFile(pagePath, `<h1 data-caret-id="t">Changed</h1>\n`)

		const result = await undoLastStep(dir)
		result.undone.should.be.true()
		result.label?.should.equal("text edit on t")
		result.changed.should.containEql(".caret/pages/home/index.tsx")
		;(await fs.readFile(pagePath, "utf-8")).should.containEql("Original")
	})

	it("repeated undo WALKS BACK through the history — never ping-pongs", async () => {
		// The first model pushed the pre-undo state back on top, so a second ⌘Z
		// restored what the first had just removed: black ↔ blue forever, with
		// everything older buried. Found in the field the first time someone
		// leaned on multi-undo. Three edits must unwind in order.
		await captureUndoStep(dir, "edit one")
		await fs.writeFile(pagePath, `v2\n`)
		await captureUndoStep(dir, "edit two")
		await fs.writeFile(pagePath, `v3\n`)
		await captureUndoStep(dir, "edit three")
		await fs.writeFile(pagePath, `v4\n`)

		const u1 = await undoLastStep(dir)
		u1.label?.should.equal("edit three")
		;(await fs.readFile(pagePath, "utf-8")).should.equal("v3\n")

		const u2 = await undoLastStep(dir)
		u2.label?.should.equal("edit two")
		;(await fs.readFile(pagePath, "utf-8")).should.equal("v2\n")

		const u3 = await undoLastStep(dir)
		u3.label?.should.equal("edit one")
		;(await fs.readFile(pagePath, "utf-8")).should.containEql("Original")

		const u4 = await undoLastStep(dir)
		u4.undone.should.be.false()
		u4.error?.should.containEql("Nothing to undo")
	})

	it("redo walks forward again, all the way to the live state", async () => {
		await captureUndoStep(dir, "edit one")
		await fs.writeFile(pagePath, `v2\n`)
		await captureUndoStep(dir, "edit two")
		await fs.writeFile(pagePath, `v3\n`)

		await undoLastStep(dir)
		await undoLastStep(dir)
		;(await fs.readFile(pagePath, "utf-8")).should.containEql("Original")

		const r1 = await redoStep(dir)
		r1.undone.should.be.true()
		r1.label?.should.equal("edit one")
		;(await fs.readFile(pagePath, "utf-8")).should.equal("v2\n")

		const r2 = await redoStep(dir)
		r2.undone.should.be.true()
		r2.label?.should.equal("edit two")
		;(await fs.readFile(pagePath, "utf-8")).should.equal("v3\n")

		const r3 = await redoStep(dir)
		r3.undone.should.be.false()
		r3.error?.should.containEql("Nothing to redo")

		// Back at the live edge: a fresh undo starts a fresh walk.
		const u = await undoLastStep(dir)
		u.label?.should.equal("edit two")
		;(await fs.readFile(pagePath, "utf-8")).should.equal("v2\n")
	})

	it("a new edit while undone discards the redo future", async () => {
		await captureUndoStep(dir, "edit one")
		await fs.writeFile(pagePath, `v2\n`)
		await captureUndoStep(dir, "edit two")
		await fs.writeFile(pagePath, `v3\n`)

		await undoLastStep(dir) // back to v2
		await captureUndoStep(dir, "a different edit")
		await fs.writeFile(pagePath, `branch\n`)

		const r = await redoStep(dir)
		r.undone.should.be.false()
		r.error?.should.containEql("Nothing to redo")

		const u = await undoLastStep(dir)
		u.undone.should.be.true()
		;(await fs.readFile(pagePath, "utf-8")).should.equal("v2\n")
	})

	it("redo before any undo refuses honestly", async () => {
		await captureUndoStep(dir, "edit one")
		await fs.writeFile(pagePath, `v2\n`)
		const r = await redoStep(dir)
		r.undone.should.be.false()
		r.error?.should.containEql("Nothing to redo")
	})

	it("removes files the step's edit created", async () => {
		await captureUndoStep(dir, "agent turn: add an about page", "agent")
		const created = path.join(dir, ".caret", "pages", "about")
		await fs.mkdir(created, { recursive: true })
		await fs.writeFile(path.join(created, "index.tsx"), "<p>About</p>\n")

		const result = await undoLastStep(dir)
		result.undone.should.be.true()
		const gone = await fs
			.access(path.join(created, "index.tsx"))
			.then(() => false)
			.catch(() => true)
		gone.should.be.true()
	})

	it("coalesces no-op boundaries instead of stuttering the stack", async () => {
		await captureUndoStep(dir, "first")
		await captureUndoStep(dir, "second (nothing changed since first)")
		const steps = await listUndoSteps(dir)
		steps.length.should.equal(1)
		steps[0].label.should.equal("first")
	})

	it("pops a step whose edit never landed, and says nothing was undone", async () => {
		await captureUndoStep(dir, "an edit that then failed")
		const result = await undoLastStep(dir)
		result.undone.should.be.false()
		result.error?.should.containEql("Nothing to undo")
		;(await listUndoSteps(dir)).length.should.equal(0)
	})

	it("outside a git repo, capture is a no-op and undo refuses honestly", async () => {
		const bare = await fs.mkdtemp(path.join(os.tmpdir(), "design-undo-nogit-"))
		try {
			await fs.mkdir(path.join(bare, ".caret"), { recursive: true })
			await captureUndoStep(bare, "hopeful")
			const result = await undoLastStep(bare)
			result.undone.should.be.false()
		} finally {
			await fs.rm(bare, { recursive: true, force: true })
		}
	})

	it("works when .caret/.gitignore ignores the journal — the shape every scaffolded project has", async () => {
		// Regression: the capture used to name the journal as an :(exclude)
		// pathspec, and git REFUSES a pathspec that names a gitignored file —
		// so in every real project (where scaffold gitignores the journal)
		// capture failed and undo reported "could not read the design layer".
		await fs.writeFile(path.join(dir, ".caret", ".gitignore"), ".undo-journal.json\nnode_modules/\n")
		await captureUndoStep(dir, "text edit on t")
		await fs.writeFile(pagePath, `<h1 data-caret-id="t">Changed</h1>\n`)

		const result = await undoLastStep(dir)
		result.undone.should.be.true()
		;(await fs.readFile(pagePath, "utf-8")).should.containEql("Original")
	})

	it("never touches app files outside .caret/", async () => {
		const appFile = path.join(dir, "src-app.txt")
		await fs.writeFile(appFile, "app v1")
		await captureUndoStep(dir, "design edit")
		await fs.writeFile(pagePath, `<h1 data-caret-id="t">Changed</h1>\n`)
		await fs.writeFile(appFile, "app v2 — must survive the undo")

		const result = await undoLastStep(dir)
		result.undone.should.be.true()
		;(await fs.readFile(appFile, "utf-8")).should.equal("app v2 — must survive the undo")
	})
})
