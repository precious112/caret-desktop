/**
 * The hand-picked design skills, and the exact version of each Caret installs.
 *
 * A skill is a folder holding `SKILL.md` (written instructions on how to
 * design) and sometimes reference files. Claude Code, Codex, Cursor, OpenCode,
 * Gemini CLI and Copilot all read the same format.
 *
 * Nothing here ships the skills themselves: Caret downloads each one from its
 * makers' GitHub repository at the commit in `pins.json`, and checks every
 * file against the fingerprint recorded there, so an upstream change can never
 * silently change what the AI is told. `scripts/skills/pin.ts` moves a pin
 * forward; the live test checks every pin still downloads.
 */
import pins from "./pins.json"

export interface SkillDefinition {
	/** Also the folder name it is installed under, which the skill's own `name` must match. */
	id: string
	name: string
	by: string
	/** One sentence, in the Skills tab's words. */
	does: string
	/** "Apache 2.0", "MIT", or how it may be used when the repository has no licence (Vercel's: downloaded for your own use, never redistributed). */
	licence: string
	repo: string
	/** The skill's folder inside the repository. */
	path: string
}

export interface SkillPin {
	id: string
	commit: string
	files: Array<{ path: string; size: number; sha256: string }>
	/** The repository's licence file, copied in beside the skill when its folder has none. */
	licenceFile?: { path: string; sha256: string }
}

export const SKILLS: readonly SkillDefinition[] = [
	{
		id: "frontend-design",
		name: "Frontend Design",
		by: "Anthropic",
		does: "Pushes away from the generic AI look: a clear visual direction, strong typography, deliberate layout.",
		licence: "Apache 2.0",
		repo: "anthropics/skills",
		path: "skills/frontend-design",
	},
	{
		id: "impeccable",
		name: "Impeccable",
		by: "Paul Bakaus",
		does: "Builds on Frontend Design with detailed guides on type, colour, spacing, motion and interface writing.",
		licence: "Apache 2.0",
		repo: "pbakaus/impeccable",
		path: ".agents/skills/impeccable",
	},
	{
		id: "taste-skill",
		name: "Design Taste",
		by: "Leonxlnx",
		does: "Bans common AI design giveaways and lets you dial variety, motion and density. Best for landing pages.",
		licence: "MIT",
		repo: "Leonxlnx/taste-skill",
		path: "skills/taste-skill",
	},
	{
		id: "emil-design-eng",
		name: "Design Engineering",
		by: "Emil Kowalski",
		does: "The small details that make an interface feel finished: motion, transitions and polish.",
		licence: "MIT",
		repo: "emilkowalski/skills",
		path: "skills/emil-design-eng",
	},
	{
		id: "shadcn",
		name: "shadcn/ui",
		by: "shadcn",
		does: "How to use shadcn/ui well: its components, presets and registries.",
		licence: "MIT",
		repo: "shadcn-ui/ui",
		path: "skills/shadcn",
	},
	{
		id: "web-design-guidelines",
		name: "Web Interface Guidelines",
		by: "Vercel",
		does: "Reviews interface code against Vercel's guidelines for accessibility, forms and interaction details.",
		licence: "Your own use",
		repo: "vercel-labs/agent-skills",
		path: "skills/web-design-guidelines",
	},
]

export function skillById(id: string): SkillDefinition | undefined {
	return SKILLS.find((skill) => skill.id === id)
}

export function pinOf(id: string): SkillPin | undefined {
	return (pins as SkillPin[]).find((pin) => pin.id === id)
}

/** Where one file of a pinned skill is downloaded from: GitHub's raw file host, or a local mirror in tests. */
export function fileUrl(base: string, skill: SkillDefinition, commit: string, file: string): string {
	return `${base.replace(/\/$/, "")}/${skill.repo}/${commit}/${file}`
}

export const RAW_GITHUB = "https://raw.githubusercontent.com"
