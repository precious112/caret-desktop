/**
 * Design skills, the app's side: Caret's own skills folder, and each
 * project's chosen skill.
 *
 * Downloads come from GitHub through Caret's proxy-aware fetch. In development
 * builds only, `CARET_SKILLS_SOURCE` names a local folder laid out like
 * GitHub's raw file host (`test-fixtures/skills/mirror`), so the real-app
 * tests run with no network. A packaged Caret never reads it.
 */
import { app } from "electron"
import * as fs from "fs/promises"
import * as path from "path"

import { SKILLS, skillById } from "../../../src/core/design/skills/catalog"
import { chooseSkill, chosenSkill, skillInstructions } from "../../../src/core/design/skills/project"
import { SkillStore } from "../../../src/core/design/skills/store"
import { fetch } from "../../../src/shared/net"
import { Logger } from "../../../src/shared/services/Logger"
import type { SkillWire } from "../../shared/ipc"
import { capture } from "../analytics"

export class SkillService {
	private readonly store: SkillStore
	private readonly listeners = new Set<(projectPath: string | null) => void>()

	constructor(options: { dir: string; source?: string }) {
		const local = Boolean(options.source)
		this.store = new SkillStore({
			dir: options.dir,
			source: options.source,
			fetchBytes: local
				? (file) => fs.readFile(file)
				: async (url) => {
						const response = await fetch(url)
						if (!response.ok) throw new Error(`HTTP ${response.status}`)
						return Buffer.from(await response.arrayBuffer())
					},
		})
	}

	/** Called when the installed skills or a project's choice changed (null: every project). */
	onChange(listener: (projectPath: string | null) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	private changed(projectPath: string | null): void {
		for (const listener of this.listeners) listener(projectPath)
	}

	/** Every hand-picked skill, whether it is installed, and which one this project uses. */
	async list(projectPath: string | null): Promise<SkillWire[]> {
		const installed = new Set(await this.store.installed())
		const chosen = projectPath ? await chosenSkill(projectPath) : null
		return SKILLS.map((skill) => ({
			id: skill.id,
			name: skill.name,
			by: skill.by,
			does: skill.does,
			licence: skill.licence,
			installed: installed.has(skill.id),
			chosen: skill.id === chosen,
		}))
	}

	async install(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
		const result = await this.store.install(id)
		if (result.ok) {
			Logger.info(`[skills] installed ${id}`)
			capture("skill_installed", { skill: id })
			this.changed(null)
		} else {
			Logger.warn(`[skills] ${result.error}`)
		}
		return result
	}

	/** Removes a skill from Caret, and from this project when it was the project's skill. */
	async remove(id: string, projectPath: string | null): Promise<void> {
		if (projectPath && (await chosenSkill(projectPath)) === id) await chooseSkill(projectPath, null)
		await this.store.remove(id)
		Logger.info(`[skills] removed ${id}`)
		this.changed(projectPath)
	}

	/** Makes an installed skill the project's skill, or none. */
	async choose(projectPath: string, id: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
		if (id && !(await this.store.isInstalled(id))) return { ok: false, error: "Install the skill first." }
		try {
			await chooseSkill(projectPath, id, id ? this.store.folderOf(id) : undefined)
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) }
		}
		Logger.info(`[skills] ${path.basename(projectPath)} uses ${id ?? "no design skill"}`)
		capture("skill_chosen", { skill: id ?? "none" })
		this.changed(projectPath)
		return { ok: true }
	}

	/** What Caret's chat is told about the project's skill, or nothing. */
	async chatInstructions(projectPath: string): Promise<string | null> {
		const id = await chosenSkill(projectPath)
		return id ? skillInstructions(projectPath, skillById(id)?.name) : null
	}
}

let shared: SkillService | null = null

export function startSkillService(source?: string): SkillService {
	shared ??= new SkillService({ dir: path.join(app.getPath("userData"), "skills"), source })
	return shared
}

export function skillService(): SkillService {
	shared ??= new SkillService({ dir: path.join(app.getPath("userData"), "skills") })
	return shared
}

/** The development-only local download source, or nothing in a packaged Caret. */
export function skillsSourceFromEnv(env: NodeJS.ProcessEnv, packaged: boolean): string | undefined {
	return packaged ? undefined : env.CARET_SKILLS_SOURCE || undefined
}
