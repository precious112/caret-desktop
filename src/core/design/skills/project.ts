/**
 * A project's design skill: one at a time, copied into the folders coding
 * tools read skills from.
 *
 * - `.claude/skills/<id>/` for Claude Code;
 * - `.agents/skills/<id>/` for Codex, Cursor, OpenCode, Gemini CLI and Copilot.
 *
 * Caret marks its own copies with `.caret-skill.json`. A skill folder without
 * that mark is the user's, and Caret never touches it: choosing, switching or
 * removing only ever removes Caret's own copies.
 */
import * as fs from "fs/promises"
import * as path from "path"

import { filesOf } from "./store"

export const SKILL_FOLDERS = [".claude/skills", ".agents/skills"] as const

const PROJECT_MARK = ".caret-skill.json"

/** The skill Caret put in this project, or null. */
export async function chosenSkill(projectPath: string): Promise<string | null> {
	for (const base of SKILL_FOLDERS) {
		for (const id of await fs.readdir(path.join(projectPath, base)).catch(() => [] as string[])) {
			const mark = await fs.readFile(path.join(projectPath, base, id, PROJECT_MARK), "utf8").catch(() => "")
			if (mark) return id
		}
	}
	return null
}

/**
 * Makes `id` (copied from `storeFolder`) the project's skill, or removes
 * Caret's skill when `id` is null. Only Caret's own copies are ever removed.
 */
export async function chooseSkill(projectPath: string, id: string | null, storeFolder?: string): Promise<void> {
	for (const base of SKILL_FOLDERS) {
		const dir = path.join(projectPath, base)
		for (const existing of await fs.readdir(dir).catch(() => [] as string[])) {
			const owned = await fs.stat(path.join(dir, existing, PROJECT_MARK)).catch(() => null)
			if (owned) await fs.rm(path.join(dir, existing), { recursive: true, force: true })
		}
	}
	if (!id || !storeFolder) return
	for (const base of SKILL_FOLDERS) {
		const target = path.join(projectPath, base, id)
		if (await fs.stat(target).catch(() => null)) {
			throw new Error(`${path.join(base, id)} already holds a skill of yours; Caret won't overwrite it`)
		}
	}
	const files = await filesOf(storeFolder)
	for (const base of SKILL_FOLDERS) {
		const target = path.join(projectPath, base, id)
		for (const file of files) {
			await fs.mkdir(path.dirname(path.join(target, file)), { recursive: true })
			await fs.copyFile(path.join(storeFolder, file), path.join(target, file))
		}
		await fs.writeFile(path.join(target, PROJECT_MARK), `${JSON.stringify({ id, by: "Caret" })}\n`)
	}
}

/**
 * What Caret's chat is told about the project's skill, or null when there is
 * none: the skill's instructions, where its reference files are, and that the
 * project's foundation wins.
 */
export async function skillInstructions(projectPath: string, name?: string): Promise<string | null> {
	const id = await chosenSkill(projectPath)
	if (!id) return null
	const text = await fs.readFile(path.join(projectPath, ".agents/skills", id, "SKILL.md"), "utf8").catch(() => "")
	if (!text) return null
	const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim()
	return [
		`## Design skill: ${name ?? id}`,
		"",
		"The user chose this design skill for this project. Follow it when you design or build pages.",
		"The project's foundation (its fonts, colours, spacing, corners and depth) always wins over anything the skill suggests: never replace a foundation value because the skill prefers another.",
		`Its reference files are in \`.agents/skills/${id}/\`; read one when the skill points to it.`,
		"",
		body,
	].join("\n")
}
