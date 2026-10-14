import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import should from "should"

import { mockFetchForTesting } from "@/shared/net"
import { readCatalogLock } from "../install"
import {
	installComponentRef,
	namedExportOf,
	packagesOf,
	parse21stAnswer,
	parseComponentRef,
	rewriteAliases,
} from "../registry-install"

describe("registry install · refs and rewriting", () => {
	it("reads the two installable forms and nothing else", () => {
		should(parseComponentRef("@magicui/marquee")).eql({ kind: "registry", registry: "@magicui", name: "marquee" })
		should(parseComponentRef(" 21st:10635 ")).eql({ kind: "21st", id: "10635" })
		should(parseComponentRef("magicui/marquee")).be.null()
		should(parseComponentRef("@x/../../etc")).be.null()
		should(parseComponentRef("21st:abc")).be.null()
	})

	it("points each alias at where its target lands, relative to the file", () => {
		const source = [
			'import { cn } from "@/lib/utils"',
			'import { Button } from "@/components/ui/button"',
			"import { Marquee } from '@/components/magicui/marquee'",
			'import { useMeasure } from "@/hooks/use-measure"',
		].join("\n")
		const { content, needs } = rewriteAliases(source, "21st/10635")
		content.should.containEql('from "../../lib/utils"')
		content.should.containEql('from "../../ui/button"')
		content.should.containEql("from '../../magicui/marquee'")
		content.should.containEql('from "../../hooks/use-measure"')
		needs.should.eql(["lib/utils", "ui/button", "magicui/marquee", "hooks/use-measure"])
		rewriteAliases('import x from "@/components/ui/card"', "ui").content.should.containEql('from "./card"')
	})

	it("finds the npm packages a file needs, without React or relative files", () => {
		packagesOf(
			'import { motion } from "motion/react"\nimport * as S from "@radix-ui/react-slot"\nimport React from "react"\nimport x from "./y"',
		).should.eql(["motion", "@radix-ui/react-slot"])
	})

	it("reads 21st.dev's answer: the Component source, and the file name its demo imports", () => {
		const answer =
			'# Logs table\n\n## Component\n```tsx\nexport function LogsTable() {}\n```\n\n## Demo (usage)\n```tsx\nimport { LogsTable } from "@/components/ui/interactive-logs-table"\n```'
		should(parse21stAnswer(answer)).eql({ code: "export function LogsTable() {}\n", fileName: "interactive-logs-table" })
		should(parse21stAnswer("## Demo\nnothing")).be.null()
	})

	it("names the export to import when there is no default", () => {
		should(namedExportOf("export default function A() {}")).be.undefined()
		should(namedExportOf("const helper = 1\nexport function WorldMap() {}")).equal("WorldMap")
	})
})

describe("registry install · into a project", () => {
	let workspace: string

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), "caret-reginstall-"))
		await fs.mkdir(path.join(workspace, ".caret"), { recursive: true })
		await fs.writeFile(path.join(workspace, ".caret", "package.json"), "{}")
	})
	afterEach(() => fs.rm(workspace, { recursive: true, force: true }))

	const ITEMS: Record<string, unknown> = {
		"https://magicui.design/r/marquee.json": {
			dependencies: ["motion"],
			registryDependencies: ["button"],
			files: [
				{
					path: "registry/magicui/marquee.tsx",
					type: "registry:ui",
					content:
						'import { cn } from "@/lib/utils"\nimport { Button } from "@/components/ui/button"\nexport function Marquee() { return <div className="bg-[#123456]" /> }',
				},
			],
		},
		"https://ui.shadcn.com/r/styles/new-york-v4/button.json": {
			dependencies: ["@radix-ui/react-slot"],
			files: [
				{
					path: "registry/new-york-v4/ui/button.tsx",
					type: "registry:ui",
					content: 'import { cn } from "@/lib/utils"\nexport function Button() { return null }',
				},
			],
		},
	}

	it("installs an item with its shadcn dependency, records it, and installs nothing twice", async () => {
		const fetched: string[] = []
		const installed: string[][] = []
		const mock = (async (input: string) => {
			fetched.push(String(input))
			const body = ITEMS[String(input)]
			return new Response(body ? JSON.stringify(body) : "not found", { status: body ? 200 : 404 })
		}) as unknown as typeof globalThis.fetch

		const outcome = await mockFetchForTesting(mock, () =>
			installComponentRef(workspace, "@magicui/marquee", { installDeps: async (_ws, deps) => void installed.push(deps) }),
		)
		outcome.should.containDeep({ ok: true, importPath: "../../components/catalog/magicui/marquee", namedExport: "Marquee" })
		const catalog = path.join(workspace, ".caret", "components", "catalog")
		;(await fs.readFile(path.join(catalog, "magicui", "marquee.tsx"), "utf-8")).should.containEql('from "../lib/utils"')
		;(await fs.readFile(path.join(catalog, "magicui", "marquee.tsx"), "utf-8")).should.containEql('from "../ui/button"')
		;(await fs.readFile(path.join(catalog, "ui", "button.tsx"), "utf-8")).should.containEql('from "../lib/utils"')
		;(await fs.readFile(path.join(catalog, "lib", "utils.ts"), "utf-8")).should.containEql("twMerge")
		installed[0].should.eql(["@radix-ui/react-slot", "clsx", "motion", "tailwind-merge"])

		const lock = await readCatalogLock(workspace)
		lock.installed.length.should.equal(1)
		lock.installed[0].files[0].should.equal("magicui/marquee.tsx")

		const again = await mockFetchForTesting(mock, () =>
			installComponentRef(workspace, "@magicui/marquee", { installDeps: async () => {} }),
		)
		again.should.containDeep({ ok: true, alreadyInstalled: true, namedExport: "Marquee" })
		fetched.length.should.equal(2)
	})

	it("refuses an item that depends on something outside the known registries", async () => {
		const mock = (async () =>
			new Response(
				JSON.stringify({
					registryDependencies: ["https://evil.example/r/x.json"],
					files: [{ path: "a.tsx", content: "" }],
				}),
			)) as unknown as typeof globalThis.fetch
		const outcome = await mockFetchForTesting(mock, () =>
			installComponentRef(workspace, "@magicui/thing", { installDeps: async () => {} }),
		)
		outcome.ok.should.be.false()
		;(outcome as { reason: string }).reason.should.match(/outside the known registries/)
	})

	it("needs a key for 21st.dev, and says so", async () => {
		const outcome = await installComponentRef(workspace, "21st:10635")
		outcome.ok.should.be.false()
		;(outcome as { reason: string }).reason.should.match(/needs a key/)
	})
})
