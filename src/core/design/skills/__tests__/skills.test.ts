/**
 * Design skills: installing into Caret's own folder, and choosing one for a
 * project. Downloads come from the saved copies under
 * test-fixtures/skills/mirror/, laid out exactly like GitHub's raw file host.
 */
import { strict as assert } from "assert"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { pinOf, SKILLS } from "../catalog"
import { chooseSkill, chosenSkill, SKILL_FOLDERS, skillInstructions } from "../project"
import { filesOf, SkillStore } from "../store"

const MIRROR = path.resolve("test-fixtures/skills/mirror")

async function tempDir(name: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), `caret-skills-${name}-`))
}

async function store(fetchBytes = (url: string) => fs.readFile(url)) {
	return new SkillStore({ dir: await tempDir("store"), source: MIRROR, fetchBytes })
}

describe("design skills · the list", () => {
	it("pins every listed skill, each with a SKILL.md", () => {
		for (const skill of SKILLS) {
			const pin = pinOf(skill.id)
			assert.ok(pin, `${skill.id} has no pin`)
			assert.match(pin.commit, /^[0-9a-f]{40}$/)
			assert.ok(
				pin.files.some((file) => file.path === "SKILL.md"),
				`${skill.id} has no SKILL.md`,
			)
		}
	})
})

describe("design skills · installing", () => {
	it("downloads every pinned file and the licence, and lists the skill as installed", async () => {
		const skills = await store()
		assert.deepEqual(await skills.install("emil-design-eng"), { ok: true })
		assert.deepEqual(await skills.installed(), ["emil-design-eng"])
		assert.deepEqual(await filesOf(skills.folderOf("emil-design-eng")), ["LICENSE", "SKILL.md"])
	})

	it("refuses a file whose contents changed, and leaves nothing half-installed", async () => {
		const skills = await store(async (url) => {
			const data = await fs.readFile(url)
			return url.endsWith("SKILL.md") ? Buffer.concat([data, Buffer.from("\nInjected line.")]) : data
		})
		const result = await skills.install("frontend-design")
		assert.equal(result.ok, false)
		assert.match((result as { error: string }).error, /SKILL\.md is not the version Caret checked/)
		assert.deepEqual(await skills.installed(), [])
		assert.deepEqual(await fs.readdir(path.dirname(skills.folderOf("x"))), [], "a download folder was left behind")
	})

	it("fails cleanly when a file can't be downloaded", async () => {
		const skills = await store()
		const result = await skills.install("impeccable")
		assert.equal(result.ok, false, "impeccable has no saved copy, so its download must fail")
		assert.deepEqual(await fs.readdir(path.dirname(skills.folderOf("x"))), [])
	})
})

describe("design skills · one per project", () => {
	async function setUp() {
		const skills = await store()
		await skills.install("frontend-design")
		await skills.install("emil-design-eng")
		const project = await tempDir("project")
		// A skill the user put there themselves.
		await fs.mkdir(path.join(project, ".claude/skills/my-own"), { recursive: true })
		await fs.writeFile(path.join(project, ".claude/skills/my-own/SKILL.md"), "---\nname: my-own\n---\nMine.")
		return { skills, project }
	}

	it("copies the chosen skill into both folders coding tools read, exactly as installed", async () => {
		const { skills, project } = await setUp()
		await chooseSkill(project, "frontend-design", skills.folderOf("frontend-design"))
		assert.equal(await chosenSkill(project), "frontend-design")
		const installed = await filesOf(skills.folderOf("frontend-design"))
		for (const base of SKILL_FOLDERS) {
			const folder = path.join(project, base, "frontend-design")
			const copied = (await filesOf(folder)).filter((file) => file !== ".caret-skill.json")
			assert.deepEqual(copied, installed)
			for (const file of installed) {
				assert.ok(
					(await fs.readFile(path.join(folder, file))).equals(
						await fs.readFile(path.join(skills.folderOf("frontend-design"), file)),
					),
				)
			}
		}
	})

	it("switching replaces Caret's skill and leaves the user's own alone", async () => {
		const { skills, project } = await setUp()
		await chooseSkill(project, "frontend-design", skills.folderOf("frontend-design"))
		await chooseSkill(project, "emil-design-eng", skills.folderOf("emil-design-eng"))
		assert.equal(await chosenSkill(project), "emil-design-eng")
		for (const base of SKILL_FOLDERS) {
			assert.equal(await fs.stat(path.join(project, base, "frontend-design")).catch(() => null), null)
			assert.ok(await fs.stat(path.join(project, base, "emil-design-eng", "SKILL.md")))
		}
		assert.equal(
			await fs.readFile(path.join(project, ".claude/skills/my-own/SKILL.md"), "utf8"),
			"---\nname: my-own\n---\nMine.",
		)
	})

	it("no skill removes Caret's copies only", async () => {
		const { skills, project } = await setUp()
		await chooseSkill(project, "frontend-design", skills.folderOf("frontend-design"))
		await chooseSkill(project, null)
		assert.equal(await chosenSkill(project), null)
		assert.deepEqual(await fs.readdir(path.join(project, ".claude/skills")), ["my-own"])
		assert.deepEqual(await fs.readdir(path.join(project, ".agents/skills")), [])
	})

	it("never overwrites a skill of the user's with the same name", async () => {
		const { skills, project } = await setUp()
		await fs.mkdir(path.join(project, ".agents/skills/frontend-design"), { recursive: true })
		await fs.writeFile(path.join(project, ".agents/skills/frontend-design/SKILL.md"), "theirs")
		await assert.rejects(chooseSkill(project, "frontend-design", skills.folderOf("frontend-design")), /won't overwrite/)
		assert.equal(await fs.readFile(path.join(project, ".agents/skills/frontend-design/SKILL.md"), "utf8"), "theirs")
	})

	it("the chat is told to open the skill's reference files when the skill points to them, and which files there are", async () => {
		const { skills, project } = await setUp()
		await chooseSkill(project, "frontend-design", skills.folderOf("frontend-design"))
		// A skill with reference files, the way Impeccable and Design Taste ship them.
		const folder = path.join(project, ".agents/skills/frontend-design")
		await fs.mkdir(path.join(folder, "references"), { recursive: true })
		await fs.writeFile(path.join(folder, "references/copy.md"), "copy")
		await fs.writeFile(path.join(folder, "references/type.md"), "type")
		const text = (await skillInstructions(project, "Frontend Design"))!
		assert.match(
			text,
			/reference files in `\.agents\/skills\/frontend-design\/`: `references\/copy\.md`, `references\/type\.md`\./,
		)
		assert.match(
			text,
			/Whenever the skill points to one of them for the step you are on, open and read that file before doing the step\./,
		)
		assert.doesNotMatch(text, /`LICENSE|`SKILL\.md`|caret-skill/, "the list names files that aren't references")
	})

	it("the chat is told the skill's instructions and that the foundation wins; nothing when no skill is chosen", async () => {
		const { skills, project } = await setUp()
		assert.equal(await skillInstructions(project), null)
		await chooseSkill(project, "frontend-design", skills.folderOf("frontend-design"))
		const text = await skillInstructions(project, "Frontend Design")
		assert.ok(text)
		assert.match(text, /^## Design skill: Frontend Design/)
		assert.match(text, /foundation .* always wins over anything the skill suggests/)
		assert.doesNotMatch(text, /^---$/m, "the skill's header block was passed on")
		// Frontend Design has no reference files, so nothing is said about them.
		assert.doesNotMatch(text, /reference files/)
		const skillBody = (await fs.readFile(path.join(skills.folderOf("frontend-design"), "SKILL.md"), "utf8"))
			.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
			.trim()
		assert.ok(text.endsWith(skillBody), "the skill's own instructions are not all there")
	})
})
