/**
 * The component and reference libraries the AI can search, as MCP servers.
 *
 * Caret connects to each library itself and passes its search and read tools
 * on through Caret's own connection, so Caret's chat and every coding tool
 * connected to Caret see the same libraries, and keys never leave Caret. Users
 * install and configure nothing: each library is ready, needs one browser
 * sign-in, or needs a pasted key. Only read and search tools are passed on —
 * 21st.dev's server alone offers 51 tools, including deleting components and
 * editing your profile.
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
	/** One browser sign-in (MCP OAuth, run by Caret). */
	| "sign-in"
	/** The user pastes a key from the library's site. */
	| "key"

export interface LibraryDefinition {
	/** Also the prefix of its tools as Caret passes them on: `shadcn_search_items_in_registries`. */
	id: string
	name: string
	/** What it gives the AI, in the Libraries tab's words. */
	gives: string
	kind: "components" | "inspiration"
	access: LibraryAccess
	/** Where the user gets a key or account, for "paste a key" and "sign in" rows. */
	site?: string
	/** The tool names the server itself uses; only these are passed on. */
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

/** How Caret reaches one library: a local program it starts, or a hosted address. */
export type LibraryConnection =
	| { kind: "stdio"; command: string; args: string[]; env?: Record<string, string> }
	| { kind: "http"; url: string; headers?: Record<string, string> }

export interface ConnectionContext {
	/** `npx` (or `npx.cmd` on Windows). */
	npx: string
	/** PATH that finds node and npx even when Caret was launched from Finder. */
	path?: string
	/** Caret's own folder holding the shadcn registry list (`components.json`). */
	shadcnDir: string
	/** The credential, for libraries that need one. */
	credential?: string
}

/** How to reach one library, or null when it still needs a credential. */
export function connectionFor(id: string, context: ConnectionContext): LibraryConnection | null {
	const env = context.path ? { PATH: context.path } : undefined
	switch (id) {
		case "shadcn":
			return {
				kind: "stdio",
				command: context.npx,
				args: ["-y", SHADCN_PACKAGE, "mcp", "--cwd", context.shadcnDir],
				...(env ? { env } : {}),
			}
		case "aceternity":
			return { kind: "stdio", command: context.npx, args: ["-y", ACETERNITY_PACKAGE], ...(env ? { env } : {}) }
		case "lazyweb":
			if (!context.credential) return null
			return {
				kind: "http",
				url: "https://www.lazyweb.com/mcp",
				headers: { Authorization: `Bearer ${context.credential}` },
			}
		case "gummble":
			// The sign-in's tokens ride on the connection's own sign-in support, not a header.
			return { kind: "http", url: "https://mcp.gummble.com/mcp" }
		case "twentyfirst":
			if (!context.credential) return null
			return { kind: "http", url: "https://21st.dev/api/mcp", headers: { "x-api-key": context.credential } }
		default:
			return null
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

/** A library tool's name as Caret passes it on. */
export function passedOnName(libraryId: string, tool: string): string {
	return `${libraryId}_${tool}`
}

/** Which library a passed-on tool belongs to, and its own name there; null for Caret's own tools. */
export function splitPassedOnName(
	name: string,
	libraries: readonly LibraryDefinition[],
): { library: LibraryDefinition; tool: string } | null {
	for (const library of libraries) {
		if (!name.startsWith(`${library.id}_`)) continue
		const tool = name.slice(library.id.length + 1)
		if (library.allowedTools.includes(tool)) return { library, tool }
	}
	return null
}

/**
 * A tool's input format, made safe to pass on. Anthropic refuses a WHOLE turn
 * when any one tool's input format has `oneOf`, `anyOf` or `allOf` at the top
 * level (measured on Lazyweb's server), so those are folded into one plain
 * object: every variant's fields, none of them required. The library still
 * checks its own input and says what was wrong.
 */
export function safeInputSchema(schema: unknown): Record<string, unknown> {
	const input = schema && typeof schema === "object" ? (schema as Record<string, unknown>) : {}
	const variants = ["oneOf", "anyOf", "allOf"].flatMap((key) =>
		Array.isArray(input[key]) ? (input[key] as Array<Record<string, unknown>>) : [],
	)
	if (variants.length === 0) return { ...input, type: "object" }
	const { oneOf: _o, anyOf: _a, allOf: _l, required: _r, ...rest } = input
	const properties: Record<string, unknown> = { ...((input.properties as Record<string, unknown>) ?? {}) }
	for (const variant of variants) Object.assign(properties, (variant?.properties as Record<string, unknown>) ?? {})
	return { ...rest, type: "object", properties }
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

/**
 * The paragraph in the AI's rules that suggests searching the libraries, or
 * null when no library is on: then the rules don't mention libraries at all.
 * A suggestion only: nothing checks that a search happened.
 */
export function librarySearchParagraph(on: ReadonlyArray<Pick<LibraryDefinition, "id" | "name" | "kind">>): string | null {
	if (on.length === 0) return null
	const components = on.filter((library) => library.kind === "components")
	const references = on.filter((library) => library.kind === "inspiration")
	const named = (list: typeof on) => list.map((library) => `${library.name} (tools named \`${library.id}_…\`)`).join(", ")
	const lines = ["When you create a page, first search these libraries for things you can use."]
	if (components.length) lines.push(`Components: ${named(components)}.`)
	if (references.length) lines.push(`References: ${named(references)}.`)
	lines.push(
		"Use what fits the page and build the rest yourself. The project's foundation (fonts, colours, spacing) wins over a component's own styles.",
	)
	return lines.join(" ")
}
