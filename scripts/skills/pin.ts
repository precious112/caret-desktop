/**
 * Pins every hand-picked design skill to its repository's current commit, and
 * records each file's size and fingerprint (sha256) in
 * `src/core/design/skills/pins.json`. Caret installs exactly those files and
 * refuses a download that differs.
 *
 * Development only; needs the GitHub CLI (`gh`), signed in. Moving a pin is a
 * Caret change like any other: review what the skill now says before shipping.
 *
 *   npx tsx scripts/skills/pin.ts                       re-pin every skill
 *   npx tsx scripts/skills/pin.ts --keep                keep existing pins, add missing ones
 *   npx tsx scripts/skills/pin.ts --mirror frontend-design,emil-design-eng
 *       also save those skills' files under test-fixtures/skills/mirror/, the
 *       stand-in for GitHub that the free real-app tests download from
 */
import { execFileSync } from "child_process"
import { createHash } from "crypto"
import * as fs from "fs/promises"
import * as path from "path"

import { SKILLS, type SkillPin } from "../../src/core/design/skills/catalog"

const PINS = path.resolve("src/core/design/skills/pins.json")
const MIRROR = path.resolve("test-fixtures/skills/mirror")

const args = process.argv.slice(2)
const KEEP = args.includes("--keep")
const MIRRORED = new Set(args.includes("--mirror") ? args[args.indexOf("--mirror") + 1].split(",") : [])

function gh(endpoint: string): unknown {
	return JSON.parse(execFileSync("gh", ["api", endpoint], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }))
}

async function raw(repo: string, commit: string, file: string): Promise<Buffer> {
	const response = await fetch(`https://raw.githubusercontent.com/${repo}/${commit}/${file}`)
	if (!response.ok) throw new Error(`${repo}/${file}: HTTP ${response.status}`)
	return Buffer.from(await response.arrayBuffer())
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex")

async function main(): Promise<void> {
	const existing: SkillPin[] = JSON.parse(await fs.readFile(PINS, "utf8").catch(() => "[]"))
	const pins: SkillPin[] = []
	for (const skill of SKILLS) {
		const kept = existing.find((pin) => pin.id === skill.id)
		const commit = KEEP && kept ? kept.commit : (gh(`repos/${skill.repo}/commits/HEAD`) as { sha: string }).sha
		const tree = (
			gh(`repos/${skill.repo}/git/trees/${commit}?recursive=1`) as { tree: Array<{ path: string; type: string }> }
		).tree
		const inFolder = tree.filter((entry) => entry.type === "blob" && entry.path.startsWith(`${skill.path}/`))
		if (!inFolder.some((entry) => entry.path === `${skill.path}/SKILL.md`))
			throw new Error(`${skill.id}: no SKILL.md at ${skill.path}`)
		const files: SkillPin["files"] = []
		for (const entry of inFolder) {
			const data = await raw(skill.repo, commit, entry.path)
			files.push({ path: entry.path.slice(skill.path.length + 1), size: data.length, sha256: sha256(data) })
			if (MIRRORED.has(skill.id)) {
				const target = path.join(MIRROR, skill.repo, commit, entry.path)
				await fs.mkdir(path.dirname(target), { recursive: true })
				await fs.writeFile(target, data)
			}
		}
		const pin: SkillPin = { id: skill.id, commit, files }
		if (!files.some((file) => /^licen[cs]e/i.test(file.path))) {
			const licence = tree.find((entry) => entry.type === "blob" && /^licen[cs]e(\.(md|txt))?$/i.test(entry.path))
			if (licence) {
				const data = await raw(skill.repo, commit, licence.path)
				pin.licenceFile = { path: licence.path, sha256: sha256(data) }
				if (MIRRORED.has(skill.id)) {
					const target = path.join(MIRROR, skill.repo, commit, licence.path)
					await fs.mkdir(path.dirname(target), { recursive: true })
					await fs.writeFile(target, data)
				}
			}
		}
		pins.push(pin)
		const bytes = files.reduce((sum, file) => sum + file.size, 0)
		console.log(
			`${skill.id}: ${commit.slice(0, 10)}, ${files.length} files, ${bytes} bytes${pin.licenceFile ? `, licence ${pin.licenceFile.path}` : ""}`,
		)
	}
	await fs.writeFile(PINS, `${JSON.stringify(pins, null, "\t")}\n`)
	console.log(`wrote ${path.relative(process.cwd(), PINS)}`)
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err)
	process.exitCode = 1
})
