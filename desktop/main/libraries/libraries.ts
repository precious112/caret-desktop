/**
 * The component and reference libraries, connected by Caret itself.
 *
 * Caret is the one client of every library: it starts the local ones
 * (shadcn, Aceternity), connects to the hosted ones (Lazyweb, Gummble,
 * 21st.dev) with the user's key or sign-in, and passes their read and search
 * tools on through its own connection (`server.ts`). Caret's chat and any
 * coding tool connected to Caret therefore see the same libraries through the
 * same path, and keys never leave Caret.
 *
 * One manager for the app: a library resting after a rate limit is resting for
 * every project, and one connection per library serves them all.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js"
import { app } from "electron"
import * as fs from "fs/promises"
import * as path from "path"

import {
	connectionFor,
	isLibraryOutage,
	LIBRARIES,
	type LibraryConnection,
	type LibraryDefinition,
	passedOnName,
	safeInputSchema,
	shadcnComponentsJson,
	splitPassedOnName,
} from "../../../src/core/design/libraries/catalog"
import { systemSpawnEnv } from "../../../src/core/design/spawn-env"
import { fetch } from "../../../src/shared/net"
import { Logger } from "../../../src/shared/services/Logger"
import type { LibraryWire } from "../../shared/ipc"
import { capture } from "../analytics"
import { getPrefs, setPref } from "../prefs"
import { getSecret, type SecretName, setSecret } from "../secrets"
import { SignInAuth } from "./sign-in"

/** How long a library that rate-limited or failed sits out. */
export const REST_MS = 15 * 60_000

/** How long a tool list waits for a library still connecting before answering without it. */
const LIST_WAIT_MS = 8_000

/** A library tool call's ceiling: a hosted search can be slow, never this slow. */
const CALL_MS = 120_000

const SECRET_OF: Record<string, SecretName> = { lazyweb: "lazywebToken", twentyfirst: "twentyfirstApiKey" }

const LAZYWEB_TOKEN_URL = "https://www.lazyweb.com/api/mcp/install-token?install_channel=caret"

/** One live connection to a library. */
export interface LiveLibrary {
	tools: Tool[]
	call(tool: string, args: Record<string, unknown>): Promise<CallToolResult>
	close(): Promise<void>
}

export interface LibraryHubOptions {
	/** Libraries beyond the built-in list (the development-only test library). */
	extra?: Array<{ definition: LibraryDefinition; connection: LibraryConnection }>
	/** Opens a connection; tests replace it. */
	open?: (connection: LibraryConnection, definition: LibraryDefinition, auth: SignInAuth | null) => Promise<LiveLibrary>
	/** Caret's own data folder, where the shadcn registry list lives. */
	dataDir?: () => string
	/** Which libraries are installed and which are off per project; Caret's preferences unless a test says otherwise. */
	choices?: LibraryChoices
}

/**
 * The user's library choices: what is installed (for every project), and what
 * is switched off in each project.
 */
export interface LibraryChoices {
	/** Undefined until the user installs or removes one: then the default set applies. */
	installed(): string[] | undefined
	setInstalled(ids: string[]): Promise<void>
	offIn(projectPath: string): string[]
	setOffIn(projectPath: string, ids: string[]): Promise<void>
}

/** Installed until the user says otherwise: the libraries that need no account. */
export const DEFAULT_INSTALLED = ["shadcn", "aceternity", "lazyweb"]

const PREFS_CHOICES: LibraryChoices = {
	installed: () => getPrefs().librariesInstalled,
	setInstalled: (ids) => setPref("librariesInstalled", ids),
	offIn: (projectPath) => getPrefs().librariesOff[projectPath] ?? [],
	setOffIn: (projectPath, ids) => setPref("librariesOff", { ...getPrefs().librariesOff, [projectPath]: ids }),
}

type Connecting = {
	state: "connecting" | "ready" | "failed" | "sign-in" | "key"
	live?: LiveLibrary
	error?: string
	ready: Promise<void>
}

export class LibraryHub {
	private readonly connections = new Map<string, Connecting>()
	private readonly resting = new Map<string, { until: number; why: string }>()
	private readonly listeners = new Set<(projectPath: string | null) => void>()
	private readonly extra: NonNullable<LibraryHubOptions["extra"]>
	/** A free Lazyweb token when the keychain cannot store one: good for this run. */
	private lazywebInMemory = ""
	private shadcnDir = ""
	private readonly gummble = new SignInAuth("gummble")

	private readonly choices: LibraryChoices

	constructor(private readonly options: LibraryHubOptions = {}) {
		this.extra = options.extra ?? []
		this.choices = options.choices ?? PREFS_CHOICES
	}

	/** Every library Caret knows, built-in first. */
	definitions(): LibraryDefinition[] {
		return [...LIBRARIES, ...this.extra.map((e) => e.definition)]
	}

	definition(id: string): LibraryDefinition | undefined {
		return this.definitions().find((library) => library.id === id)
	}

	/**
	 * Called whenever which libraries are usable may have changed (the rules
	 * depend on it): for one project, or null for every project.
	 */
	onChange(listener: (projectPath: string | null) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	private changed(projectPath: string | null = null): void {
		for (const listener of this.listeners) {
			try {
				listener(projectPath)
			} catch (err) {
				Logger.warn(`[libraries] change listener failed: ${err}`)
			}
		}
	}

	/** Installed libraries, for every project. The development-only test library is always installed. */
	installedIds(): string[] {
		const chosen = this.choices.installed() ?? DEFAULT_INSTALLED
		return [...chosen.filter((id) => this.definition(id)), ...this.extra.map((e) => e.definition.id)]
	}

	async install(id: string): Promise<void> {
		if (!this.definition(id) || this.installedIds().includes(id)) return
		await this.choices.setInstalled([...(this.choices.installed() ?? DEFAULT_INSTALLED), id])
		Logger.info(`[libraries] installed ${id}`)
		capture("library_installed", { library: id })
		void this.warm()
		this.changed()
	}

	async uninstall(id: string): Promise<void> {
		await this.choices.setInstalled((this.choices.installed() ?? DEFAULT_INSTALLED).filter((other) => other !== id))
		await this.disconnect(id)
		Logger.info(`[libraries] removed ${id}`)
		this.changed()
	}

	/** Installed, and not switched off in this project (with no project: installed). */
	enabled(id: string, projectPath: string | null): boolean {
		if (!this.installedIds().includes(id)) return false
		return !projectPath || !this.choices.offIn(projectPath).includes(id)
	}

	async setEnabled(projectPath: string, id: string, on: boolean): Promise<void> {
		const off = new Set(this.choices.offIn(projectPath))
		if (on) off.delete(id)
		else off.add(id)
		await this.choices.setOffIn(projectPath, [...off])
		if (on) void this.warm()
		this.changed(projectPath)
	}

	/**
	 * Libraries that are on in this project and have what they need (a key, a
	 * sign-in). Whether they answer right now does not matter here: this is
	 * what the rules name.
	 */
	async onLibraries(projectPath: string | null): Promise<LibraryDefinition[]> {
		const result: LibraryDefinition[] = []
		for (const library of this.definitions()) {
			if (!this.enabled(library.id, projectPath)) continue
			if (library.access === "key" && !(await this.credential(library.id))) continue
			if (library.access === "sign-in" && !this.signInFor(library.id)?.signedIn()) continue
			result.push(library)
		}
		return result
	}

	/** Starts connecting every installed library, so the first tool list finds them ready. */
	async warm(): Promise<void> {
		for (const library of await this.onLibraries(null)) void this.connect(library).catch(() => {})
	}

	/** The tools to pass on in this project: each usable library's allowed tools, renamed and made safe. */
	async tools(projectPath: string | null): Promise<Tool[]> {
		const libraries = (await this.onLibraries(projectPath)).filter((library) => !this.isResting(library.id))
		const lists = await Promise.all(
			libraries.map(async (library) => {
				const pending = this.connect(library).catch(() => null)
				const live = await Promise.race([
					pending,
					new Promise<null>((resolve) => setTimeout(() => resolve(null), LIST_WAIT_MS)),
				])
				if (!live) return []
				return live.tools
					.filter((tool) => library.allowedTools.includes(tool.name))
					.map(
						(tool): Tool => ({
							name: passedOnName(library.id, tool.name),
							description: `${library.name}: ${tool.description ?? ""}`.trim(),
							inputSchema: safeInputSchema(tool.inputSchema) as Tool["inputSchema"],
						}),
					)
			}),
		)
		return lists.flat()
	}

	/** Whether a tool name is a library tool Caret passes on. */
	owns(name: string): boolean {
		return splitPassedOnName(name, this.definitions()) !== null
	}

	/** Calls a passed-on tool. A rate limit, lost sign-in or outage rests the library. */
	async call(projectPath: string | null, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
		const split = splitPassedOnName(name, this.definitions())
		if (!split) return errorResult(`${name} is not a library tool.`)
		const { library, tool } = split
		if (!this.enabled(library.id, projectPath)) return errorResult(`${library.name} is switched off in Caret.`)
		const rest = this.restOf(library.id)
		if (rest) return errorResult(`${library.name} is resting after a ${rest}; use another library or build it yourself.`)
		try {
			const live = await this.connect(library)
			const result = await live.call(tool, args)
			if (result.isError) this.noteFailure(library, textOf(result))
			return result
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			this.noteFailure(library, message)
			return errorResult(`${library.name} failed: ${message}`)
		}
	}

	private noteFailure(library: LibraryDefinition, error: string): void {
		const outage = isLibraryOutage(error)
		if (!outage) return
		if (!this.resting.has(library.id)) capture("library_failure", { library: library.id, kind: outage })
		this.resting.set(library.id, { until: Date.now() + REST_MS, why: outage })
		Logger.info(`[libraries] ${library.id} rests for ${REST_MS / 60_000} minutes: ${outage}`)
		void this.disconnect(library.id)
		this.changed()
	}

	private restOf(id: string): string | null {
		const rest = this.resting.get(id)
		if (!rest) return null
		if (rest.until > Date.now()) return rest.why === "rate-limit" ? "rate limit" : "failure"
		this.resting.delete(id)
		return null
	}

	private isResting(id: string): boolean {
		return this.restOf(id) !== null
	}

	/** Each library's card and row in the Libraries tab, for this project. */
	async list(projectPath: string | null): Promise<LibraryWire[]> {
		const installed = this.installedIds()
		return Promise.all(
			this.definitions().map(async (library) => ({
				id: library.id,
				name: library.name,
				gives: library.gives,
				kind: library.kind,
				access: library.access,
				site: library.site,
				installed: installed.includes(library.id),
				enabled: this.enabled(library.id, projectPath),
				state: await this.stateOf(library, projectPath),
			})),
		)
	}

	private async stateOf(library: LibraryDefinition, projectPath: string | null): Promise<LibraryWire["state"]> {
		if (!this.enabled(library.id, projectPath)) return "off"
		if (this.isResting(library.id)) return "resting"
		if (library.access === "key" && !(await this.credential(library.id))) return "key"
		if (library.access === "sign-in" && !this.signInFor(library.id)?.signedIn()) return "sign-in"
		const connection = this.connections.get(library.id)
		if (!connection) {
			void this.connect(library).catch(() => {})
			return "connecting"
		}
		return connection.state
	}

	/** Stores a pasted key and reconnects the library with it. */
	async setKey(id: string, key: string): Promise<{ ok: true } | { ok: false; error: string }> {
		const name = SECRET_OF[id]
		if (!name) return { ok: false, error: "This library does not take a key." }
		const stored = await setSecret(name, key)
		if (!stored.ok) return stored
		this.resting.delete(id)
		await this.disconnect(id)
		const library = this.definition(id)
		if (library) await this.connect(library).catch(() => {})
		this.changed()
		return { ok: true }
	}

	/** The browser sign-in, for libraries that use one. */
	async signIn(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
		const library = this.definition(id)
		const auth = this.signInFor(id)
		if (!library || library.access !== "sign-in" || !auth) return { ok: false, error: "This library has no sign-in." }
		const connection = connectionFor(id, await this.context())
		if (!connection || connection.kind !== "http") return { ok: false, error: "This library has no sign-in." }
		const result = await auth.signIn(connection.url)
		if (!result.ok) return result
		this.resting.delete(id)
		await this.disconnect(id)
		await this.connect(library).catch(() => {})
		this.changed()
		return { ok: true }
	}

	private signInFor(id: string): SignInAuth | null {
		return id === "gummble" ? this.gummble : null
	}

	/** Closes every connection (Caret is quitting). */
	async close(): Promise<void> {
		await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)))
	}

	private async disconnect(id: string): Promise<void> {
		const connection = this.connections.get(id)
		this.connections.delete(id)
		await connection?.live?.close().catch(() => {})
	}

	/** The library's live connection, opening it once; a failed one is retried on the next call. */
	private async connect(library: LibraryDefinition): Promise<LiveLibrary> {
		const existing = this.connections.get(library.id)
		if (existing) {
			await existing.ready
			if (existing.live) return existing.live
			if (existing.state !== "failed" || this.connections.get(library.id) !== existing) {
				throw new Error(existing.error ?? `${library.name} is not connected`)
			}
			this.connections.delete(library.id)
		}
		const entry: Connecting = { state: "connecting", ready: Promise.resolve() }
		entry.ready = (async () => {
			try {
				const connection = await this.connectionOf(library)
				if (!connection) throw new Error(`${library.name} needs a key first`)
				entry.live = await (this.options.open ?? openLibrary)(connection, library, this.signInFor(library.id))
				entry.state = "ready"
				Logger.info(`[libraries] ${library.id} connected (${entry.live.tools.length} tools)`)
			} catch (err) {
				entry.error = err instanceof Error ? err.message : String(err)
				const refused = /\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid.?(api.?)?key|sign.?in/i.test(entry.error)
				// A refused key asks for the key again; a refused sign-in asks to sign in again.
				entry.state =
					refused && library.access === "key" ? "key" : refused && library.access === "sign-in" ? "sign-in" : "failed"
				Logger.warn(`[libraries] ${library.id} did not connect: ${entry.error}`)
			}
		})()
		this.connections.set(library.id, entry)
		await entry.ready
		if (!entry.live) throw new Error(entry.error ?? `${library.name} is not connected`)
		return entry.live
	}

	private async connectionOf(library: LibraryDefinition): Promise<LibraryConnection | null> {
		const extra = this.extra.find((e) => e.definition.id === library.id)
		if (extra) return extra.connection
		return connectionFor(library.id, { ...(await this.context()), credential: await this.credential(library.id) })
	}

	private async credential(id: string): Promise<string | undefined> {
		if (id === "twentyfirst") return getSecret("twentyfirstApiKey") || undefined
		if (id !== "lazyweb") return undefined
		const stored = getSecret("lazywebToken") || this.lazywebInMemory
		if (stored) return stored
		// Lazyweb issues free, no-login tokens that only authorise its reference
		// tools. Caret asks for one itself, so this library needs no setup.
		try {
			const response = await fetch(LAZYWEB_TOKEN_URL, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			})
			if (!response.ok) throw new Error(`HTTP ${response.status}`)
			const token = ((await response.json()) as { token?: unknown }).token
			if (typeof token !== "string" || !token) throw new Error("no token in the answer")
			const saved = await setSecret("lazywebToken", token)
			if (!saved.ok) this.lazywebInMemory = token
			return token
		} catch (err) {
			Logger.warn(`[libraries] could not get a Lazyweb token: ${err}`)
			return undefined
		}
	}

	private async context() {
		if (!this.shadcnDir) {
			this.shadcnDir = path.join((this.options.dataDir ?? (() => app.getPath("userData")))(), "libraries", "shadcn")
			await fs.mkdir(this.shadcnDir, { recursive: true })
			await fs.writeFile(path.join(this.shadcnDir, "components.json"), shadcnComponentsJson(), "utf-8")
		}
		return {
			npx: process.platform === "win32" ? "npx.cmd" : "npx",
			path: systemSpawnEnv().PATH,
			shadcnDir: this.shadcnDir,
		}
	}
}

/** Connects to one library as an MCP client and reads its tools once. */
async function openLibrary(
	connection: LibraryConnection,
	_library: LibraryDefinition,
	auth: SignInAuth | null,
): Promise<LiveLibrary> {
	const transport: Transport =
		connection.kind === "stdio"
			? new StdioClientTransport({
					command: connection.command,
					args: connection.args,
					env: { ...(process.env as Record<string, string>), ...(connection.env ?? {}) },
					stderr: "ignore",
				})
			: new StreamableHTTPClientTransport(new URL(connection.url), {
					requestInit: connection.headers ? { headers: connection.headers } : undefined,
					fetch: fetch as never,
					...(auth ? { authProvider: auth.provider() } : {}),
				})
	const client = new Client({ name: "caret", version: "1.0.0" })
	await client.connect(transport, { timeout: 90_000 })
	const { tools } = await client.listTools(undefined, { timeout: 60_000 })
	return {
		tools,
		call: async (tool, args) =>
			(await client.callTool({ name: tool, arguments: args }, undefined, { timeout: CALL_MS })) as CallToolResult,
		close: () => client.close(),
	}
}

function errorResult(text: string): CallToolResult {
	return { content: [{ type: "text", text }], isError: true }
}

function textOf(result: CallToolResult): string {
	return (result.content ?? [])
		.map((part) => (part.type === "text" ? part.text : ""))
		.join(" ")
		.trim()
}

let shared: LibraryHub | null = null

/** Creates the one manager for the app (main, at startup). */
export function startLibraryHub(options: LibraryHubOptions = {}): LibraryHub {
	shared ??= new LibraryHub(options)
	return shared
}

/** The one manager for the app. */
export function libraryHub(): LibraryHub {
	shared ??= new LibraryHub()
	return shared
}
