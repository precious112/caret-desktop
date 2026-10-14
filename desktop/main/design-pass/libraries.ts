/**
 * The Design pass's libraries, kept alive on each project's OpenCode instance.
 *
 * Users install and configure nothing. A library is added to the instance the
 * moment it can be (no key needed, a key pasted, or a sign-in done), re-added
 * after anything that resets the instance (a credential change disposes it, and
 * runtime-added servers go with it), and rested for a while when it rate-limits
 * or fails, so the designer moves straight on to the next one.
 */

import { app, shell } from "electron"
import * as fs from "fs/promises"
import * as path from "path"

import type { CodingBackend, McpServerStatus, ToolCallRecord } from "../../../src/core/design/agent/backend"
import { setOpencodeToolPolicy } from "../../../src/core/design/agent/opencode"
import { getBackend } from "../../../src/core/design/agent/registry"
import {
	isLibraryOutage,
	LIBRARIES,
	type LibraryDefinition,
	type LibraryId,
	libraryById,
	libraryOfTool,
	libraryToolPolicy,
	mcpConfigFor,
	shadcnComponentsJson,
} from "../../../src/core/design/design-pass/libraries"
import { systemSpawnEnv } from "../../../src/core/design/spawn-env"
import { fetch } from "../../../src/shared/net"
import { Logger } from "../../../src/shared/services/Logger"
import type { DesignLibraryWire } from "../../shared/ipc"
import { capture } from "../analytics"
import { getPrefs, setPref } from "../prefs"
import { getSecret, type SecretName, setSecret } from "../secrets"

/** How long a library that rate-limited or failed sits out. */
export const REST_MS = 15 * 60_000

const SECRET_OF: Partial<Record<LibraryId, SecretName>> = { lazyweb: "lazywebToken", twentyfirst: "twentyfirstApiKey" }

const LAZYWEB_TOKEN_URL = "https://www.lazyweb.com/api/mcp/install-token?install_channel=caret"

export class DesignLibraries {
	private readonly resting = new Map<LibraryId, { until: number; why: string }>()
	private readonly usableByDirectory = new Map<string, Set<LibraryId>>()
	private readonly statusByDirectory = new Map<string, Record<string, McpServerStatus>>()
	private readonly ensuring = new Map<string, Promise<Set<LibraryId>>>()
	/** A free Lazyweb token when the keychain cannot store one: good for this run. */
	private lazywebInMemory = ""

	constructor(private readonly backend: () => Promise<CodingBackend | null>) {
		setOpencodeToolPolicy((directory) => libraryToolPolicy(this.usable(directory)))
	}

	enabled(id: LibraryId): boolean {
		return !getPrefs().designPassLibrariesOff.includes(id)
	}

	async setEnabled(id: LibraryId, on: boolean): Promise<void> {
		const off = new Set(getPrefs().designPassLibrariesOff)
		if (on) off.delete(id)
		else off.add(id)
		await setPref("designPassLibrariesOff", [...off])
	}

	/** Libraries the designer may use in this project right now (sync: the tool policy needs it per prompt). */
	usable(directory: string): Set<LibraryId> {
		const now = Date.now()
		return new Set(
			[...(this.usableByDirectory.get(directory) ?? [])].filter((id) => this.enabled(id) && !this.isResting(id, now)),
		)
	}

	/**
	 * Adds every enabled library this project's instance is missing, and returns
	 * the usable ones. Concurrent calls for one project share the work.
	 */
	ensure(directory: string): Promise<Set<LibraryId>> {
		const running = this.ensuring.get(directory)
		if (running) return running
		const work = this.doEnsure(directory).finally(() => this.ensuring.delete(directory))
		this.ensuring.set(directory, work)
		return work
	}

	private async doEnsure(directory: string): Promise<Set<LibraryId>> {
		const backend = await this.backend()
		const mcp = backend?.mcp
		if (!mcp) return new Set()
		let status: Record<string, McpServerStatus> = {}
		try {
			status = await mcp.status(directory)
		} catch (err) {
			Logger.warn(`[design-pass] library status failed: ${err}`)
			return new Set()
		}
		const context = await this.configContext()
		await Promise.all(
			LIBRARIES.map(async (library) => {
				if (!this.enabled(library.id)) {
					if (status[library.id]?.status === "connected") await mcp.disconnect(directory, library.id).catch(() => {})
					return
				}
				const current = status[library.id]?.status
				if (current === "connected" || current === "needs_auth") return
				if (current === "disabled") {
					await mcp
						.connect(directory, library.id)
						.catch((err) => Logger.warn(`[design-pass] ${library.id} connect failed: ${err}`))
					return
				}
				const credential = await this.credential(library.id)
				const config = mcpConfigFor(library.id, { ...context, credential })
				if (!config) return
				try {
					await mcp.add(directory, library.id, config as unknown as Record<string, unknown>)
				} catch (err) {
					Logger.warn(`[design-pass] adding ${library.id} failed: ${err}`)
				}
			}),
		)
		try {
			status = await mcp.status(directory)
		} catch {}
		this.statusByDirectory.set(directory, status)
		const usable = new Set(LIBRARIES.filter((l) => status[l.id]?.status === "connected").map((l) => l.id))
		this.usableByDirectory.set(directory, usable)
		return this.usable(directory)
	}

	/**
	 * Watches the designer's tool calls: a rate limit, quota, lost sign-in or
	 * outage rests that library, so the next session goes straight to another.
	 */
	noteToolCalls(calls: ToolCallRecord[]): void {
		for (const call of calls) {
			if (call.ok) continue
			const library = libraryOfTool(call.tool)
			const outage = library ? isLibraryOutage(call.error ?? "") : null
			if (!library || !outage) continue
			if (!this.resting.has(library)) capture("design_pass_mcp_failure", { library, kind: outage })
			this.resting.set(library, { until: Date.now() + REST_MS, why: outage })
			Logger.info(`[design-pass] ${library} rests for ${REST_MS / 60_000} minutes: ${outage}`)
		}
	}

	private isResting(id: LibraryId, now = Date.now()): boolean {
		const rest = this.resting.get(id)
		if (!rest) return false
		if (rest.until > now) return true
		this.resting.delete(id)
		return false
	}

	/** Each library's row in the backend tab. */
	async list(directory: string | null): Promise<DesignLibraryWire[]> {
		if (directory) await this.ensure(directory).catch(() => {})
		const status = directory ? (this.statusByDirectory.get(directory) ?? {}) : {}
		return Promise.all(
			LIBRARIES.map(async (library) => ({
				id: library.id,
				name: library.name,
				gives: library.gives,
				kind: library.kind,
				access: library.access,
				site: library.site,
				enabled: this.enabled(library.id),
				state: await this.stateOf(library, status[library.id]),
			})),
		)
	}

	private async stateOf(library: LibraryDefinition, status: McpServerStatus | undefined): Promise<DesignLibraryWire["state"]> {
		if (!this.enabled(library.id)) return "off"
		if (this.isResting(library.id)) return "resting"
		if (library.access === "key" && !(await this.credential(library.id))) return "key"
		if (status?.status === "needs_auth" || status?.status === "needs_client_registration") return "sign-in"
		if (status?.status === "connected") return "ready"
		if (status?.status === "failed") return "failed"
		return "connecting"
	}

	/** Stores a pasted key and connects the library with it. */
	async setKey(directory: string | null, id: LibraryId, key: string): Promise<{ ok: true } | { ok: false; error: string }> {
		const name = SECRET_OF[id]
		if (!name) return { ok: false, error: "This library does not take a key." }
		const stored = await setSecret(name, key)
		if (!stored.ok) return stored
		if (directory) await this.readd(directory, id)
		return { ok: true }
	}

	/** Starts the library's browser sign-in, then waits for the backend to report it connected. */
	async signIn(directory: string, id: LibraryId): Promise<{ ok: true } | { ok: false; error: string }> {
		const library = libraryById(id)
		const mcp = (await this.backend())?.mcp
		if (!library || library.access !== "sign-in" || !mcp) return { ok: false, error: "This library has no sign-in." }
		await this.ensure(directory)
		try {
			const { authorizationUrl } = await mcp.startAuth(directory, id)
			await shell.openExternal(authorizationUrl)
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) }
		}
		// The browser step is the user's, so the wait is long; the sign-in itself
		// has no time limit on the backend, only this poll does.
		const deadline = Date.now() + 5 * 60_000
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 2000))
			const status = await mcp.status(directory).catch(() => ({}) as Record<string, McpServerStatus>)
			if (status[id]?.status === "connected") {
				this.statusByDirectory.set(directory, status)
				this.usableByDirectory.set(directory, new Set([...(this.usableByDirectory.get(directory) ?? []), id]))
				return { ok: true }
			}
		}
		return { ok: false, error: "The sign-in did not finish. Try again when the browser page says you're connected." }
	}

	private async readd(directory: string, id: LibraryId): Promise<void> {
		const mcp = (await this.backend())?.mcp
		if (!mcp) return
		const config = mcpConfigFor(id, { ...(await this.configContext()), credential: await this.credential(id) })
		if (config) await mcp.add(directory, id, config as unknown as Record<string, unknown>).catch(() => {})
		this.resting.delete(id)
		this.statusByDirectory.delete(directory)
		await this.ensure(directory)
	}

	private async credential(id: LibraryId): Promise<string | undefined> {
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
			Logger.warn(`[design-pass] could not get a Lazyweb token: ${err}`)
			return undefined
		}
	}

	private shadcnDir = ""

	private async configContext() {
		if (!this.shadcnDir) {
			this.shadcnDir = path.join(app.getPath("userData"), "design-pass", "shadcn")
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

let shared: DesignLibraries | null = null

/**
 * The one library manager for the app. One, because the tool policy it installs
 * is process-wide (every prompt to the shared OpenCode server carries it), and
 * because a library resting after a rate limit is resting for every project.
 */
export function designLibraries(): DesignLibraries {
	shared ??= new DesignLibraries(async () => {
		const id = getPrefs().backendId
		return id ? getBackend(id) : null
	})
	return shared
}
