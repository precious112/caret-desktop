/**
 * The component and reference libraries the AI can search, as MCP servers.
 *
 * Users install and configure nothing: each library is ready, needs one browser
 * sign-in, or needs a pasted key, and Caret adds it to the project's OpenCode
 * instance itself. Only read and search tools are ever switched on — 21st.dev's
 * server alone offers 51 tools, including deleting components and editing your
 * profile — and that allowlist also keeps a library's odd tool schemas away
 * from providers that reject a whole turn over one of them.
 */

import { REGISTRIES } from "../catalog/registries"

export { REGISTRIES }

export type LibraryId = "shadcn" | "aceternity" | "lazyweb" | "gummble" | "twentyfirst"

/** How a library is unlocked. */
export type LibraryAccess =
	/** Nothing to set up. */
	| "none"
	/** A free token Caret requests itself, no sign-up. */
	| "free-token"
	/** One browser sign-in (MCP OAuth, run by the OpenCode server). */
	| "sign-in"
	/** The user pastes a key from the library's site. */
	| "key"

export interface LibraryDefinition {
	id: LibraryId
	name: string
	/** What it gives the designer, in the backend tab's words. */
	gives: string
	kind: "components" | "inspiration"
	access: LibraryAccess
	/** Where the user gets a key or account, for "paste a key" and "sign in" rows. */
	site?: string
	/** The tool names the server itself uses; OpenCode prefixes them `<id>_`. */
	allowedTools: string[]
}

export const LIBRARIES: readonly LibraryDefinition[] = [
	{
		id: "shadcn",
		name: "shadcn registries",
		gives: "Components, blocks and templates from shadcn/ui, Magic UI, Aceternity's free items, Smooth UI and Kokonut UI",
		kind: "components",
		access: "none",
		allowedTools: [
			"search_items_in_registries",
			"list_items_in_registries",
			"view_items_in_registries",
			"get_item_examples_from_registries",
		],
	},
	{
		id: "aceternity",
		name: "Aceternity UI",
		gives: "Animated components and blocks",
		kind: "components",
		access: "none",
		site: "https://ui.aceternity.com",
		allowedTools: ["search_components", "get_component_info", "list_categories"],
	},
	{
		id: "lazyweb",
		name: "Lazyweb",
		gives: "Real marketing pages and app screens, with descriptions",
		kind: "inspiration",
		access: "free-token",
		site: "https://www.lazyweb.com",
		allowedTools: ["lazyweb_discover_tools", "lazyweb_execute"],
	},
	{
		id: "gummble",
		name: "Gummble",
		gives: "300,000+ screens, flows, microcopy and website sections",
		kind: "inspiration",
		access: "sign-in",
		site: "https://gummble.com",
		allowedTools: [
			"gummble_search_screens",
			"gummble_search_sections",
			"gummble_search_patterns",
			"gummble_search_apps",
			"gummble_search_flows",
			"gummble_search_microcopy",
			"gummble_find_similar_screens",
			"gummble_get_screen_detail",
			"gummble_get_screen_details_batch",
			"gummble_get_flow_screens",
		],
	},
	{
		id: "twentyfirst",
		name: "21st.dev",
		gives: "12,000+ components, plus themes and templates",
		kind: "components",
		access: "key",
		site: "https://21st.dev",
		allowedTools: ["search", "get_inspiration"],
	},
]

export function libraryById(id: string): LibraryDefinition | undefined {
	return LIBRARIES.find((library) => library.id === id)
}

/** The pinned packages behind the two local servers: a library update is a Caret update. */
export const SHADCN_PACKAGE = "shadcn@4.21.4"
export const ACETERNITY_PACKAGE = "aceternityui-mcp@1.0.2"

export interface McpLocalConfig {
	type: "local"
	command: string[]
	environment?: Record<string, string>
	enabled: boolean
	timeout?: number
}

export interface McpRemoteConfig {
	type: "remote"
	url: string
	headers?: Record<string, string>
	enabled: boolean
	timeout?: number
}

export type McpConfig = McpLocalConfig | McpRemoteConfig

export interface ConfigContext {
	/** `npx` (or `npx.cmd` on Windows). */
	npx: string
	/** PATH that finds node and npx even when Caret was launched from Finder. */
	path?: string
	/** Caret's own folder holding the shadcn registry list (`components.json`). */
	shadcnDir: string
	/** The credential, for libraries that need one. */
	credential?: string
}

/** Searching a library is slow on a cold start (npx fetches the package); give it room. */
const TIMEOUT_MS = 60_000

/** The MCP server entry for one library, or null when it still needs a credential. */
export function mcpConfigFor(id: LibraryId, context: ConfigContext): McpConfig | null {
	const environment = context.path ? { PATH: context.path } : undefined
	switch (id) {
		case "shadcn":
			return {
				type: "local",
				command: [context.npx, "-y", SHADCN_PACKAGE, "mcp", "--cwd", context.shadcnDir],
				...(environment ? { environment } : {}),
				enabled: true,
				timeout: TIMEOUT_MS,
			}
		case "aceternity":
			return {
				type: "local",
				command: [context.npx, "-y", ACETERNITY_PACKAGE],
				...(environment ? { environment } : {}),
				enabled: true,
				timeout: TIMEOUT_MS,
			}
		case "lazyweb":
			if (!context.credential) return null
			return {
				type: "remote",
				url: "https://www.lazyweb.com/mcp",
				headers: { Authorization: `Bearer ${context.credential}` },
				enabled: true,
				timeout: TIMEOUT_MS,
			}
		case "gummble":
			// OpenCode runs the OAuth flow and keeps the tokens; no header here.
			return { type: "remote", url: "https://mcp.gummble.com/mcp", enabled: true, timeout: TIMEOUT_MS }
		case "twentyfirst":
			if (!context.credential) return null
			return {
				type: "remote",
				url: "https://21st.dev/api/mcp",
				headers: { "x-api-key": context.credential },
				enabled: true,
				timeout: TIMEOUT_MS,
			}
	}
}

/** The registry list the shadcn MCP reads, written into Caret's own folder. */
export function shadcnComponentsJson(): string {
	return `${JSON.stringify(
		{
			$schema: "https://ui.shadcn.com/schema.json",
			style: "new-york",
			rsc: false,
			tsx: true,
			tailwind: { config: "", css: "src/index.css", baseColor: "neutral", cssVariables: true },
			aliases: { components: "@/components", utils: "@/lib/utils", ui: "@/components/ui" },
			registries: Object.fromEntries(Object.entries(REGISTRIES).filter(([name]) => name !== "@shadcn")),
		},
		null,
		"\t",
	)}\n`
}

/**
 * The tool switches for a project: every library's tools off, then the allowed
 * read/search tools of the libraries that are usable right now back on. Globs
 * first, names after — the later key wins.
 */
export function libraryToolPolicy(usable: ReadonlySet<LibraryId>): Record<string, boolean> {
	const policy: Record<string, boolean> = {}
	for (const library of LIBRARIES) policy[`${library.id}_*`] = false
	for (const library of LIBRARIES) {
		if (!usable.has(library.id)) continue
		for (const tool of library.allowedTools) policy[`${library.id}_${tool}`] = true
	}
	return policy
}

/** Which library a prefixed tool name belongs to (`lazyweb_lazyweb_execute` → lazyweb). */
export function libraryOfTool(tool: string): LibraryId | null {
	const library = LIBRARIES.find((l) => tool.startsWith(`${l.id}_`))
	return library?.id ?? null
}

/** Whether a prefixed tool belongs to a component library or an inspiration library. */
export function kindOfLibraryTool(tool: string): "components" | "inspiration" | null {
	const id = libraryOfTool(tool)
	return id ? (libraryById(id)?.kind ?? null) : null
}

/**
 * Does a tool failure mean the library should rest? Rate limits, quotas,
 * timeouts and lost sign-ins do; a bad argument the model sent does not — the
 * model can fix that itself on the next call.
 */
export function isLibraryOutage(error: string): "rate-limit" | "auth" | "unavailable" | null {
	const text = error.toLowerCase()
	if (/\b429\b|rate.?limit|too many requests|quota|limit reached|retry.?after/.test(text)) return "rate-limit"
	if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid.?token|needs.?auth|expired/.test(text)) return "auth"
	if (
		/timed? ?out|timeout|econnrefused|econnreset|enotfound|\b50[234]\b|service unavailable|bad gateway|socket hang up|fetch failed/.test(
			text,
		)
	) {
		return "unavailable"
	}
	return null
}
