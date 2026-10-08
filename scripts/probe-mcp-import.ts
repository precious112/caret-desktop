/**
 * The MCP surface for code → design, driven by a real client against the built
 * app: get_import_worklist, write_design_file (and what it refuses),
 * create_page.importedFrom, and report_sync_mapping on imported pages — checked
 * AFTER the healer has run, because a mapping hashed before the heal reads as a
 * design change and the next sync would rewrite the app file it came from.
 *
 * Runs on a COPY of an existing-app project (default: ~/dev/test-frontend/
 * onboard-existing-app, a Next.js app router app) and a throwaway profile.
 * No model, no cost.
 *
 *   npm run build && npx tsx scripts/probe-mcp-import.ts [path/to/app]
 */
import { _electron as electron } from "playwright"
import * as child_process from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

const check = (name: string, ok: boolean, detail = "") =>
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)

async function main(): Promise<void> {
	const root = path.resolve(".")
	const SOURCE = process.argv[2] ?? path.join(os.homedir(), "dev/test-frontend/onboard-existing-app")
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "caret-mcp-import-"))
	await fs.cp(SOURCE, project, {
		recursive: true,
		filter: (src) => !src.includes("/.caret"),
	})
	child_process.execSync(
		"rm -rf .git && git init -q && git add -A && git -c user.email=t@l -c user.name=t commit -qm init --no-verify",
		{
			cwd: project,
		},
	)
	const userData = await fs.mkdtemp(path.join(os.tmpdir(), "caret-profile-"))
	await fs.writeFile(path.join(userData, "preferences.json"), JSON.stringify({ telemetryNoticeShown: true }))

	const app = await electron.launch({
		args: [path.join(root, "out/main/index.js"), `--user-data-dir=${userData}`, project],
		env: { ...process.env, NODE_ENV: "test", CARET_DISABLE_TELEMETRY: "1" },
		cwd: root,
	})

	let id = 1
	async function rpc(url: string, token: string, method: string, params?: unknown): Promise<any> {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, ...(params ? { params } : {}) }),
			signal: AbortSignal.timeout(60_000),
		})
		const text = await res.text()
		const payload = text.includes("data:")
			? text
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trim())
					.pop()
			: text
		return JSON.parse(payload ?? "null")
	}
	/** A tool's first text part, parsed as JSON when it is. */
	async function tool(url: string, token: string, name: string, args: Record<string, unknown> = {}): Promise<any> {
		const reply = await rpc(url, token, "tools/call", { name, arguments: args })
		const text = reply?.result?.content?.[0]?.text ?? JSON.stringify(reply?.error ?? reply)
		try {
			return { ...JSON.parse(text), isError: reply?.result?.isError === true }
		} catch {
			return { raw: text, isError: reply?.result?.isError === true }
		}
	}

	try {
		const chrome = await app.firstWindow()
		await chrome.waitForSelector('[data-testid="top-bar"]', { timeout: 60_000 })
		let discovery: { url: string; token: string } | null = null
		for (let i = 0; i < 60 && !discovery; i++) {
			discovery = JSON.parse(await fs.readFile(path.join(project, ".caret/.mcp.json"), "utf-8").catch(() => "null"))
			if (!discovery) await new Promise((r) => setTimeout(r, 500))
		}
		if (!discovery) throw new Error("no MCP discovery file")
		const { url, token } = discovery
		await rpc(url, token, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "import-probe", version: "0" },
		})
		await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
		})

		// 1. Discoverable.
		const listed = await rpc(url, token, "tools/list")
		const names: string[] = (listed?.result?.tools ?? []).map((t: { name: string }) => t.name)
		check(
			"tools/list carries get_import_worklist and write_design_file",
			names.includes("get_import_worklist") && names.includes("write_design_file"),
		)
		const createPage = (listed?.result?.tools ?? []).find((t: { name: string }) => t.name === "create_page")
		check(
			"create_page's schema accepts meta.importedFrom",
			JSON.stringify(createPage?.inputSchema ?? {}).includes("importedFrom"),
		)

		// 2. The worklist.
		const worklist = await tool(url, token, "get_import_worklist")
		const routes = (worklist.screens ?? []).map((s: { route: string }) => s.route)
		check(
			"get_import_worklist lists the five screens",
			["/", "/customers", "/orders", "/orders/[id]", "/settings"].every((r) => routes.includes(r)),
			routes.join(", "),
		)
		check(
			"…and the shared layout",
			JSON.stringify(worklist.shell) === JSON.stringify(["app/layout.tsx"]),
			JSON.stringify(worklist.shell),
		)
		check(
			"…and the steps, including recording the mapping",
			JSON.stringify(worklist.steps ?? []).includes("report_sync_mapping"),
		)

		// 3. write_design_file: the shell goes in, everything else is refused.
		const shellSource =
			'export default function AppShell({ children }: { children: React.ReactNode }) {\n  return <div className="min-h-screen bg-neutral-50"><aside className="w-60">Harbor</aside>{children}</div>\n}\n'
		const wrote = await tool(url, token, "write_design_file", { path: "layouts/AppShell.tsx", source: shellSource })
		const onDisk = await fs.readFile(path.join(project, ".caret/layouts/AppShell.tsx"), "utf-8").catch(() => "")
		check(
			"write_design_file writes a shared layout",
			wrote.ok === true && onDisk.includes("AppShell"),
			JSON.stringify(wrote).slice(0, 120),
		)
		for (const bad of [
			"pages/home/index.tsx",
			"components/catalog/magic/Button.tsx",
			"../../outside.tsx",
			"layouts/../../../outside.tsx",
			"layouts/AppShell.js",
			"tokens/foundation.json",
		]) {
			const refused = await tool(url, token, "write_design_file", { path: bad, source: "x" })
			check(
				`write_design_file refuses ${bad}`,
				refused.isError === true && refused.ok === false,
				(refused.error ?? refused.raw ?? "").slice(0, 90),
			)
		}
		const escaped = await fs
			.stat(path.join(os.tmpdir(), "outside.tsx"))
			.then(() => true)
			.catch(() => false)
		check("nothing was written outside the design layer", !escaped)

		// 4. create_page with importedFrom, then the mapping, as the worklist says.
		const settings = (worklist.screens ?? []).find((s: { route: string }) => s.route === "/settings")
		const pageSource =
			'import AppShell from "../../layouts/AppShell"\n\nexport default function Settings() {\n  return (\n    <AppShell>\n      <main className="p-8"><h1 className="text-2xl font-semibold">Settings</h1><p>Store name</p></main>\n    </AppShell>\n  )\n}\n'
		const created = await tool(url, token, "create_page", {
			pageId: settings.id,
			source: pageSource,
			meta: { title: "Settings", type: "page", states: ["default"], tags: ["settings"], importedFrom: settings.appPaths },
		})
		check("create_page accepts the imported page", created.ok === true, JSON.stringify(created).slice(0, 120))
		const meta = JSON.parse(
			await fs.readFile(path.join(project, `.caret/pages/${settings.id}/meta.json`), "utf-8").catch(() => "{}"),
		)
		check(
			"meta.json keeps importedFrom",
			JSON.stringify(meta.importedFrom) === JSON.stringify(settings.appPaths),
			JSON.stringify(meta.importedFrom),
		)

		const mapped = await tool(url, token, "report_sync_mapping", {
			mappings: [
				{ designPath: `.caret/pages/${settings.id}/index.tsx`, appPaths: settings.appPaths },
				{ designPath: ".caret/layouts/AppShell.tsx", appPaths: worklist.shell },
			],
		})
		check(
			"report_sync_mapping records both",
			mapped.ok === true && mapped.recorded === 2,
			JSON.stringify(mapped).slice(0, 120),
		)

		// The healer adds caret-ids a moment after a page lands. If that changes the
		// file AFTER the mapping was hashed, the next sync sees a design change and
		// would rewrite the app file the page was imported from.
		await new Promise((r) => setTimeout(r, 6_000))
		const healed = await fs.readFile(path.join(project, `.caret/pages/${settings.id}/index.tsx`), "utf-8")
		const drift = await tool(url, token, "get_drift")
		const entries = (drift.entries ?? []).map(
			(e: { designPath: string; classification: string }) => `${e.designPath}=${e.classification}`,
		)
		check(
			"after the healer has run, the imported page and shell read clean",
			(drift.entries ?? []).length === 2 &&
				(drift.entries ?? []).every((e: { classification: string }) => e.classification === "clean"),
			`${entries.join(", ")}${healed.includes("data-caret-id") ? " (page was healed)" : ""}`,
		)

		// 4b. An agent that writes the page with its OWN file tool and reports at once.
		const orders = (worklist.screens ?? []).find((s: { route: string }) => s.route === "/orders")
		await fs.mkdir(path.join(project, `.caret/pages/${orders.id}`), { recursive: true })
		await fs.writeFile(
			path.join(project, `.caret/pages/${orders.id}/index.tsx`),
			'export default function Orders() {\n  return <main className="p-8"><h1 className="text-2xl">Orders</h1><p>#1001</p></main>\n}\n',
		)
		const mappedDirect = await tool(url, token, "report_sync_mapping", {
			mappings: [{ designPath: `.caret/pages/${orders.id}/index.tsx`, appPaths: orders.appPaths }],
		})
		await new Promise((r) => setTimeout(r, 6_000))
		const driftDirect = await tool(url, token, "get_drift")
		const ordersEntry = (driftDirect.entries ?? []).find((e: { designPath: string }) =>
			e.designPath.includes(`/${orders.id}/`),
		)
		check(
			"a page written with the agent's own tool and reported at once also reads clean",
			mappedDirect.ok === true && ordersEntry?.classification === "clean",
			ordersEntry?.classification,
		)

		// 5. The worklist stops offering what is already in.
		const again = await tool(url, token, "get_import_worklist")
		const stillOffered = (again.screens ?? []).some((s: { route: string }) => s.route === "/settings")
		check(
			"the imported screen is no longer offered",
			!stillOffered && again.alreadyImported >= 1,
			`alreadyImported=${again.alreadyImported}`,
		)
	} finally {
		await app.close().catch(() => {})
		await fs.rm(project, { recursive: true, force: true })
		await fs.rm(userData, { recursive: true, force: true })
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
