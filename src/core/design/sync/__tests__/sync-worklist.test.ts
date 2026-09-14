import { expect } from "chai"
import { parseDesignChangedFiles } from "@/utils/git"
import { buildSyncPrompt } from "../sync-prompt"

describe("parseDesignChangedFiles", () => {
	it("parses name-status lines into path + status, mapping status codes", () => {
		const raw = ["M\t.caret/pages/landing/index.tsx", "A\t.caret/components/Nav.tsx", "D\t.caret/pages/old/index.tsx"].join(
			"\n",
		)
		const files = parseDesignChangedFiles(raw)
		expect(files).to.deep.equal([
			{ path: ".caret/pages/landing/index.tsx", status: "modified" },
			{ path: ".caret/components/Nav.tsx", status: "added" },
			{ path: ".caret/pages/old/index.tsx", status: "deleted" },
		])
	})

	it("drops binary image assets but keeps non-binary asset files", () => {
		const raw = [
			"A\t.caret/assets/Screenshot_2026-06-09.png",
			"M\t.caret/assets/photo.JPG",
			"A\t.caret/assets/icon.svg",
			"M\t.caret/pages/home/index.tsx",
		].join("\n")
		const files = parseDesignChangedFiles(raw)
		const paths = files.map((f) => f.path)
		expect(paths).to.not.include(".caret/assets/Screenshot_2026-06-09.png")
		expect(paths).to.not.include(".caret/assets/photo.JPG")
		expect(paths).to.include(".caret/assets/icon.svg")
		expect(paths).to.include(".caret/pages/home/index.tsx")
	})

	it("uses the new path for renames (last tab-separated field)", () => {
		const raw = "R100\t.caret/pages/a/index.tsx\t.caret/pages/b/index.tsx"
		const files = parseDesignChangedFiles(raw)
		expect(files).to.deep.equal([{ path: ".caret/pages/b/index.tsx", status: "renamed" }])
	})

	it("ignores blank lines and empty input", () => {
		expect(parseDesignChangedFiles("")).to.deep.equal([])
		expect(parseDesignChangedFiles("\n\n")).to.deep.equal([])
	})
})

describe("buildSyncPrompt", () => {
	// A cwd with no .caret/ — buildInventory degrades gracefully to "(none)".
	const cwd = "/tmp/does-not-exist-caret-sync-test"

	it("contains no inlined file/diff content and instructs reading the current source", async () => {
		const prompt = await buildSyncPrompt(cwd, {
			syncId: "test-sync",
			changedFiles: [{ path: ".caret/pages/landing/index.tsx", status: "modified" }],
			isFirstSync: false,
		})
		expect(prompt).to.include("SINGLE SOURCE OF TRUTH")
		expect(prompt).to.include("READ the current .caret/ source")
		// Instructs stripping caret-ids (editor metadata) from app code.
		expect(prompt).to.include("data-caret-id")
		expect(prompt).to.include("do NOT copy them into the application code")
		// No diff hunks.
		expect(prompt).to.not.include("@@")
		expect(prompt).to.not.include("diff --git")
	})

	it("renders a grouped worklist: pages by id, shared design separately", async () => {
		const prompt = await buildSyncPrompt(cwd, {
			syncId: "test-sync",
			changedFiles: [
				{ path: ".caret/pages/landing/index.tsx", status: "modified" },
				{ path: ".caret/pages/landing/meta.json", status: "modified" },
				{ path: ".caret/components/Nav.tsx", status: "added" },
				{ path: ".caret/tokens/foundation.json", status: "modified" },
			],
			isFirstSync: false,
		})
		expect(prompt).to.include("Pages")
		// Page collapses both its files into one id entry.
		expect(prompt).to.include(" - landing (modified)")
		expect(prompt).to.include("Shared design")
		expect(prompt).to.include(" - .caret/components/Nav.tsx (added)")
		expect(prompt).to.include(" - .caret/tokens/foundation.json (modified)")
	})

	it("marks the intent log as context-only when provided", async () => {
		const prompt = await buildSyncPrompt(cwd, {
			syncId: "test-sync",
			changedFiles: [{ path: ".caret/pages/home/index.tsx", status: "modified" }],
			isFirstSync: false,
			intentLog: "abc123 redesign hero\ndef456 revert hero",
		})
		expect(prompt).to.include("context only")
		expect(prompt).to.include("abc123 redesign hero")
	})

	it("handles an empty worklist (first sync) by telling the AI to reconcile the full design", async () => {
		const prompt = await buildSyncPrompt(cwd, { syncId: "test-sync", changedFiles: [], isFirstSync: true })
		expect(prompt).to.include("first sync")
		expect(prompt).to.include("ENTIRE current design layer")
	})

	it("splits authority: design owns presentation, the app owns its wiring, conflicts get surfaced", async () => {
		const prompt = await buildSyncPrompt(cwd, { syncId: "test-sync", changedFiles: [], isFirstSync: false })
		expect(prompt).to.include("AUTHORITY IS SPLIT")
		expect(prompt).to.include("KEEP the app's wiring exactly as you found it")
		expect(prompt).to.include("do not silently pick a winner")
	})

	it("demands page coverage with the two buckets and the ledger, in both audience variants", async () => {
		for (const audience of ["backend", "mcp"] as const) {
			const prompt = await buildSyncPrompt(cwd, { syncId: "test-sync", changedFiles: [], isFirstSync: false, audience })
			expect(prompt, audience).to.include("PAGE COVERAGE")
			expect(prompt, audience).to.include("SPECIFIED:")
			expect(prompt, audience).to.include("STUB:")
			expect(prompt, audience).to.include("never an invented API call")
			expect(prompt, audience).to.include(".caret/sync-notes.md")
		}
	})

	it("shapes the backend plan: batched defaults-marked questions, no per-page interrogation", async () => {
		const prompt = await buildSyncPrompt(cwd, {
			syncId: "test-sync",
			changedFiles: [],
			isFirstSync: false,
			audience: "backend",
		})
		expect(prompt).to.include("ONE reply can settle it")
		expect(prompt).to.include("each with a default marked")
		expect(prompt).to.include("Never interrogate page by page")
		expect(prompt).to.include("the marked defaults apply")
	})

	it("injects existing sync notes into the prompt, and omits the section when there are none", async () => {
		const os = await import("os")
		const path = await import("path")
		const fs = await import("fs/promises")
		const noted = await fs.mkdtemp(path.join(os.tmpdir(), "caret-sync-notes-"))
		await fs.mkdir(path.join(noted, ".caret"), { recursive: true })
		await fs.writeFile(
			path.join(noted, ".caret", "sync-notes.md"),
			"## Decisions\n- Stack: Svelte 5\n\n## Pages\n- log-a-brew: STUB (localStorage)",
		)
		try {
			const withNotes = await buildSyncPrompt(noted, { syncId: "s", changedFiles: [], isFirstSync: false })
			expect(withNotes).to.include("SYNC NOTES FROM EARLIER SYNCS")
			expect(withNotes).to.include("Stack: Svelte 5")
			expect(withNotes).to.include("log-a-brew: STUB (localStorage)")

			const without = await buildSyncPrompt(cwd, { syncId: "s", changedFiles: [], isFirstSync: false })
			expect(without).to.not.include("SYNC NOTES FROM EARLIER SYNCS")
		} finally {
			await fs.rm(noted, { recursive: true, force: true })
		}
	})
})
