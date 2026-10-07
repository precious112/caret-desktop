/**
 * Code → design import, pinned at its two load-bearing promises:
 *
 * 1. **It finds the app's screens, and only screens.** Layouts, API routes,
 *    private folders and an SPA's mount `index.html` are not pages; a screen
 *    already in the design layer is not offered twice.
 * 2. **An imported page reads CLEAN to the sync.** Its mapping is recorded the
 *    moment it lands, after it is healed — otherwise the next design→app sync
 *    treats it as a new design and writes it back into the app.
 */
import { strict as assert } from "assert"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { CodingBackend } from "../../agent/backend"
import { readPageMeta } from "../../page-meta"
import {
	type ImportProgress,
	pageIdOf,
	runAppImport,
	SHELL_DESIGN_PATH,
	screenImportPrompt,
	surveyAppScreens,
	surveyScreensWithModel,
	titleOf,
} from "../app-import"
import { computeDrift } from "../drift"
import { readManifest, recordMappings } from "../mapping-manifest"

async function project(files: Record<string, string>): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "caret-import-"))
	for (const [relative, content] of Object.entries(files)) {
		const full = path.join(root, relative)
		await fs.mkdir(path.dirname(full), { recursive: true })
		await fs.writeFile(full, content)
	}
	return root
}

const PAGE = "export default function P() { return <main /> }\n"

describe("app import: finding screens", () => {
	it("reads a Next.js app router: groups vanish, private folders and slots are not screens", async () => {
		const root = await project({
			"app/layout.tsx": PAGE,
			"app/page.tsx": PAGE,
			"app/(marketing)/pricing/page.tsx": PAGE,
			"app/orders/[id]/page.tsx": PAGE,
			"app/settings/billing/page.tsx": PAGE,
			"app/_components/Nav.tsx": PAGE,
			"app/_drafts/page.tsx": PAGE,
			"app/@modal/page.tsx": PAGE,
			"app/api/route.ts": "export const GET = () => null",
		})
		const survey = await surveyAppScreens(root)
		assert.equal(survey.found, "routes")
		assert.deepEqual(
			survey.screens.map((screen) => screen.route),
			["/", "/orders/[id]", "/pricing", "/settings/billing"],
		)
		assert.deepEqual(
			survey.screens.map((screen) => screen.id),
			["home", "orders-id", "pricing", "settings-billing"],
		)
		assert.deepEqual(survey.shell, ["app/layout.tsx"])
		await fs.rm(root, { recursive: true, force: true })
	})

	it("reads a pages router without _app, _document or api routes", async () => {
		const root = await project({
			"src/pages/_app.tsx": PAGE,
			"src/pages/_document.tsx": PAGE,
			"src/pages/index.tsx": PAGE,
			"src/pages/about.tsx": PAGE,
			"src/pages/api/hello.ts": "export default () => null",
		})
		const survey = await surveyAppScreens(root)
		assert.deepEqual(
			survey.screens.map((screen) => screen.appPaths[0]),
			["src/pages/index.tsx", "src/pages/about.tsx"],
		)
		assert.deepEqual(survey.shell, ["src/pages/_app.tsx"])
		await fs.rm(root, { recursive: true, force: true })
	})

	it("treats a plain site's html files as screens, but not an SPA's mount point", async () => {
		const site = await project({ "index.html": "<h1>Home</h1>", "contact.html": "<h1>Contact</h1>" })
		assert.deepEqual(
			(await surveyAppScreens(site)).screens.map((screen) => screen.id),
			["home", "contact"],
		)
		const spa = await project({
			"index.html": '<div id="root"></div><script type="module" src="/src/main.tsx"></script>',
			"src/App.tsx": PAGE,
		})
		const survey = await surveyAppScreens(spa)
		assert.equal(survey.found, "none", "an SPA's mount index.html was offered as a screen")
		await fs.rm(site, { recursive: true, force: true })
		await fs.rm(spa, { recursive: true, force: true })
	})

	it("never offers a screen twice: mapped or already imported files are counted, not listed", async () => {
		const root = await project({
			"app/page.tsx": PAGE,
			"app/about/page.tsx": PAGE,
			"app/team/page.tsx": PAGE,
			".caret/pages/home/index.tsx": PAGE,
			".caret/pages/team/index.tsx": PAGE,
			".caret/pages/team/meta.json": JSON.stringify({ title: "Team", importedFrom: ["app/team/page.tsx"] }),
		})
		await recordMappings(root, [{ designPath: ".caret/pages/home/index.tsx", appPaths: ["app/page.tsx"] }], null)
		const survey = await surveyAppScreens(root)
		assert.deepEqual(
			survey.screens.map((screen) => screen.appPaths[0]),
			["app/about/page.tsx"],
		)
		assert.equal(survey.alreadyImported, 2)
		await fs.rm(root, { recursive: true, force: true })
	})

	it("never collides with an existing design page's id", async () => {
		const root = await project({ "app/page.tsx": PAGE, ".caret/pages/home/index.tsx": PAGE })
		const survey = await surveyAppScreens(root)
		assert.equal(survey.screens[0].id, "home-2", "the import would have overwritten an existing page")
		await fs.rm(root, { recursive: true, force: true })
	})

	it("names and ids routes readably", () => {
		assert.equal(titleOf([]), "Home")
		assert.equal(titleOf(["settings", "billing"]), "Settings billing")
		assert.equal(titleOf(["orders", "[id]"]), "Orders detail")
		assert.equal(pageIdOf(["orders", "[id]"]), "orders-id")
		assert.equal(pageIdOf([]), "home")
	})

	it("believes only files that exist and belong to the app when a model lists the screens", async () => {
		const root = await project({ "src/App.tsx": PAGE, "src/screens/Inbox.tsx": PAGE, "src/Shell.tsx": PAGE })
		const backend = {
			id: "opencode",
			async structured() {
				return {
					value: {
						screens: [
							{ title: "Inbox", route: "inbox", files: ["src/screens/Inbox.tsx", "node_modules/x/index.js"] },
							{ title: "Ghost", route: "/ghost", files: ["src/screens/Ghost.tsx"] },
							{ title: "Escape", files: ["../outside.tsx"] },
						],
						shell: ["src/Shell.tsx", ".caret/layouts/AppShell.tsx"],
					},
					emulated: false,
				}
			},
		} as unknown as CodingBackend
		const survey = await surveyScreensWithModel({ projectPath: root, backend })
		assert.deepEqual(
			survey.screens.map((screen) => [screen.id, screen.route, screen.appPaths]),
			[["inbox", "/inbox", ["src/screens/Inbox.tsx"]]],
		)
		assert.deepEqual(survey.shell, ["src/Shell.tsx"])
		await fs.rm(root, { recursive: true, force: true })
	})
})

describe("app import: the run", () => {
	/** Stands in for the lane: writes what the agent would, or fails on cue. */
	function fakeRun(root: string, failOn = new Set<string>()) {
		const calls: string[] = []
		return {
			calls,
			run: async (id: string, prompt: string) => {
				calls.push(id)
				if (failOn.has(id)) throw new Error("the provider stream died")
				if (id === "app-shell") {
					await fs.mkdir(path.join(root, ".caret/layouts"), { recursive: true })
					await fs.writeFile(path.join(root, SHELL_DESIGN_PATH), PAGE)
					return
				}
				assert.match(prompt, /importedFrom/)
				const dir = path.join(root, ".caret/pages", id)
				await fs.mkdir(dir, { recursive: true })
				await fs.writeFile(path.join(dir, "index.tsx"), `${PAGE}// ${id}\n`)
			},
		}
	}

	it("imports the shell first, then every screen, and every result reads clean to the sync", async () => {
		const root = await project({ "app/layout.tsx": PAGE, "app/page.tsx": PAGE, "app/about/page.tsx": PAGE })
		const survey = await surveyAppScreens(root)
		const fake = fakeRun(root)
		// A heal that really rewrites the file: hashing before it would leave the
		// page reading "forward" — the bug this ordering exists to prevent.
		const heal = async (file: string) => {
			const content = await fs.readFile(file, "utf-8")
			if (!content.includes("healed")) await fs.writeFile(file, `${content}// healed\n`)
		}
		const result = await runAppImport({
			projectPath: root,
			screens: survey.screens,
			shell: survey.shell,
			run: fake.run,
			onProgress: () => {},
			head: null,
			heal,
		})

		assert.equal(fake.calls[0], "app-shell", "pages were imported before the shell they wrap themselves in")
		assert.equal(result.state, "finished")
		assert.ok(result.screens.every((screen) => screen.status === "done"))

		const drift = await computeDrift(root)
		assert.equal(drift.entries.length, 3, "a page or the shell landed without a mapping")
		assert.equal(drift.forward, 0, "an imported page reads as a design change — the next sync would rewrite the app")
		assert.equal(drift.clean, 3)

		const meta = await readPageMeta(root, "about")
		assert.deepEqual(meta?.importedFrom, ["app/about/page.tsx"])
		assert.equal(meta?.title, "About")
		await fs.rm(root, { recursive: true, force: true })
	})

	it("tells pages to wrap themselves in the shell only when the shell exists", () => {
		const screen = { id: "about", title: "About", route: "/about", appPaths: ["app/about/page.tsx"] }
		assert.match(screenImportPrompt(screen, true), /layouts\/AppShell/)
		assert.doesNotMatch(screenImportPrompt(screen, false), /layouts\/AppShell/)
		assert.match(screenImportPrompt(screen, false), /Never edit the app's files/)
	})

	it("keeps going when one screen fails, and records nothing for it", async () => {
		const root = await project({ "app/page.tsx": PAGE, "app/about/page.tsx": PAGE, "app/team/page.tsx": PAGE })
		const survey = await surveyAppScreens(root)
		const seen: ImportProgress[] = []
		const result = await runAppImport({
			projectPath: root,
			screens: survey.screens,
			shell: [],
			run: fakeRun(root, new Set(["about"])).run,
			onProgress: (progress) => seen.push(progress),
			head: null,
			heal: async () => {},
		})
		const byId = Object.fromEntries(result.screens.map((screen) => [screen.id, screen]))
		assert.equal(byId.about.status, "failed")
		assert.match(byId.about.error ?? "", /stream died/)
		assert.equal(byId.home.status, "done")
		assert.equal(byId.team.status, "done")
		const mapped = (await readManifest(root)).entries.map((entry) => entry.designPath).sort()
		assert.deepEqual(mapped, [".caret/pages/home/index.tsx", ".caret/pages/team/index.tsx"])
		assert.ok(
			seen.some((progress) => progress.screens.some((screen) => screen.status === "working")),
			"progress never said anything was in flight",
		)
		await fs.rm(root, { recursive: true, force: true })
	})

	it("fails a screen whose agent finished without writing the page", async () => {
		const root = await project({ "app/page.tsx": PAGE })
		const survey = await surveyAppScreens(root)
		const result = await runAppImport({
			projectPath: root,
			screens: survey.screens,
			shell: [],
			run: async () => {},
			onProgress: () => {},
			head: null,
			heal: async () => {},
		})
		assert.equal(result.screens[0].status, "failed")
		assert.match(result.screens[0].error ?? "", /without writing the page/)
		assert.equal((await readManifest(root)).entries.length, 0)
		await fs.rm(root, { recursive: true, force: true })
	})
})
