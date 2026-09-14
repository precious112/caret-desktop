/**
 * Generates the repo rules files that carry Caret's foundations into every agent
 * session.
 *
 * This exists because **MCP cannot inject context.** An MCP server exposes
 * tools, resources and prompts; the *client* decides what enters the model's
 * context. No server can force content into every request of an agent it does
 * not own, so "the foundations are always in context" is not implementable at
 * the MCP layer at all.
 *
 * The channel that does work is the one every mainstream agent already
 * auto-loads: rules files in the repo. `AGENTS.md`, `CLAUDE.md` and
 * `.cursor/rules/` are read before the first turn without anyone choosing to
 * read them, which is exactly the property the foundations need — an agent that
 * has to *decide* to look up spacing and typography will not, and will fill the
 * gap from its training data.
 *
 * Two consequences shape the implementation:
 *
 * - **Regenerate on every token change.** A stale rules file is worse than none,
 *   because it is confidently wrong about the brand colour.
 * - **Write into a marked block, never over the file.** These files are the
 *   user's, and often already contain their own instructions. Caret owns the
 *   region between its markers and nothing else.
 */
import * as fs from "fs/promises"
import * as path from "path"

import { Logger } from "../../../src/shared/services/Logger"
import { buildGuide } from "./context"

const BEGIN = "<!-- BEGIN CARET DESIGN LAYER (generated — edits here are overwritten) -->"
const END = "<!-- END CARET DESIGN LAYER -->"

/** Files Caret keeps in sync, relative to the project root. */
const RULES_TARGETS = ["AGENTS.md", "CLAUDE.md", path.join(".cursor", "rules", "caret-design-layer.mdc")]

/**
 * Rewrites every rules file from the current foundation.
 *
 * Called on project open and after any token change. Failure is logged and
 * swallowed per file: a read-only `CLAUDE.md` or a missing `.cursor/` should
 * degrade one delivery channel, not break the token save that triggered it.
 */
export async function regenerateRulesFiles(projectPath: string): Promise<void> {
	const body = await buildGuide(projectPath)
	const block = `${BEGIN}\n\n${body}\n${END}`

	await Promise.all(
		RULES_TARGETS.map(async (relative) => {
			const target = path.join(projectPath, relative)
			try {
				await fs.mkdir(path.dirname(target), { recursive: true })
				await fs.writeFile(target, mergeBlock(await readIfExists(target), block, relative), "utf-8")
			} catch (err) {
				Logger.warn(`[rules] could not write ${relative}: ${err}`)
			}
		}),
	)

	Logger.info(`[rules] regenerated ${RULES_TARGETS.length} rules file(s) for ${path.basename(projectPath)}`)
}

/** Removes Caret's block from every rules file, leaving the user's content intact. */
export async function removeRulesFiles(projectPath: string): Promise<void> {
	await Promise.all(
		RULES_TARGETS.map(async (relative) => {
			const target = path.join(projectPath, relative)
			const existing = await readIfExists(target)
			if (existing === null) return
			const stripped = stripBlock(existing).trim()
			try {
				if (stripped.length === 0) {
					await fs.rm(target, { force: true })
				} else {
					await fs.writeFile(target, `${stripped}\n`, "utf-8")
				}
			} catch (err) {
				Logger.warn(`[rules] could not clean ${relative}: ${err}`)
			}
		}),
	)
}

/**
 * Splices `block` into `existing`, replacing a previous Caret block if there is
 * one and appending otherwise. The user's own content above and below is never
 * touched.
 */
function mergeBlock(existing: string | null, block: string, relative: string): string {
	if (existing === null) {
		return `${header(relative)}${block}\n`
	}

	const start = existing.indexOf(BEGIN)
	const end = existing.indexOf(END)

	if (start === -1 || end === -1 || end < start) {
		// No previous block (or a mangled one). Append rather than guessing where
		// it should go — the user's own instructions come first for a reason.
		return `${existing.replace(/\n*$/, "")}\n\n${block}\n`
	}

	return existing.slice(0, start) + block + existing.slice(end + END.length)
}

function stripBlock(existing: string): string {
	const start = existing.indexOf(BEGIN)
	const end = existing.indexOf(END)
	if (start === -1 || end === -1 || end < start) return existing
	return existing.slice(0, start) + existing.slice(end + END.length)
}

/**
 * Cursor's `.mdc` rule files need frontmatter to be applied automatically;
 * `AGENTS.md` and `CLAUDE.md` do not.
 */
function header(relative: string): string {
	if (!relative.endsWith(".mdc")) return ""
	return ["---", "description: Caret design layer conventions", "alwaysApply: true", "---", "", ""].join("\n")
}

async function readIfExists(target: string): Promise<string | null> {
	try {
		return await fs.readFile(target, "utf-8")
	} catch {
		return null
	}
}
