/**
 * The skills you installed: Caret's own folder (`<userData>/skills/<id>/`),
 * one download serving every project.
 *
 * An install downloads every pinned file into a temporary folder, checks each
 * against its fingerprint, and only then moves the folder into place, so a
 * failed or tampered download leaves nothing half-installed.
 */
import { createHash, randomUUID } from "crypto"
import * as fs from "fs/promises"
import * as path from "path"

import { fileUrl, pinOf, RAW_GITHUB, type SkillDefinition, skillById } from "./catalog"

/** Records which pinned version a stored skill is. */
const STORE_MARK = ".caret-pin.json"

export type FetchBytes = (url: string) => Promise<Buffer>

export interface SkillStoreOptions {
	/** Caret's own skills folder. */
	dir: string
	/** Where files are downloaded from: GitHub's raw file host, or a local folder mirroring it (tests). */
	source?: string
	/** Downloads one file; Caret passes its proxy-aware fetch. */
	fetchBytes: FetchBytes
}

export class SkillStore {
	constructor(private readonly options: SkillStoreOptions) {}

	folderOf(id: string): string {
		return path.join(this.options.dir, id)
	}

	/** Installed skill ids, in the hand-picked list's order. */
	async installed(): Promise<string[]> {
		const entries = await fs.readdir(this.options.dir).catch(() => [] as string[])
		const present = new Set<string>()
		for (const id of entries) {
			if (await fs.stat(path.join(this.options.dir, id, STORE_MARK)).catch(() => null)) present.add(id)
		}
		return [...present]
	}

	async isInstalled(id: string): Promise<boolean> {
		return (await this.installed()).includes(id)
	}

	/** Downloads and checks every file, then moves the skill into place. */
	async install(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
		const skill = skillById(id)
		const pin = pinOf(id)
		if (!skill || !pin) return { ok: false, error: "Caret doesn't know that skill." }
		const temp = path.join(this.options.dir, `.downloading-${id}-${randomUUID().slice(0, 8)}`)
		try {
			await fs.mkdir(temp, { recursive: true })
			for (const file of pin.files) {
				const data = await this.download(skill, pin.commit, `${skill.path}/${file.path}`)
				check(data, file.sha256, file.path)
				await write(temp, file.path, data)
			}
			if (pin.licenceFile) {
				const data = await this.download(skill, pin.commit, pin.licenceFile.path)
				check(data, pin.licenceFile.sha256, pin.licenceFile.path)
				await write(temp, path.basename(pin.licenceFile.path), data)
			}
			await fs.writeFile(path.join(temp, STORE_MARK), `${JSON.stringify({ id, commit: pin.commit })}\n`)
			await fs.rm(this.folderOf(id), { recursive: true, force: true })
			await fs.rename(temp, this.folderOf(id))
			return { ok: true }
		} catch (err) {
			await fs.rm(temp, { recursive: true, force: true }).catch(() => {})
			const reason = err instanceof Error ? err.message : String(err)
			return { ok: false, error: `${skill.name} could not be downloaded: ${reason}` }
		}
	}

	async remove(id: string): Promise<void> {
		await fs.rm(this.folderOf(id), { recursive: true, force: true })
	}

	private async download(skill: SkillDefinition, commit: string, file: string): Promise<Buffer> {
		const url = fileUrl(this.options.source ?? RAW_GITHUB, skill, commit, file)
		return this.options.fetchBytes(url)
	}
}

/** The files a stored skill holds, as paths inside its folder (Caret's mark excluded). */
export async function filesOf(folder: string): Promise<string[]> {
	const out: string[] = []
	const walk = async (dir: string): Promise<void> => {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name)
			if (entry.isDirectory()) await walk(full)
			else if (entry.name !== STORE_MARK) out.push(path.relative(folder, full))
		}
	}
	await walk(folder)
	return out.sort()
}

function check(data: Buffer, expected: string, file: string): void {
	const actual = createHash("sha256").update(data).digest("hex")
	if (actual !== expected) throw new Error(`${file} is not the version Caret checked (its contents changed)`)
}

async function write(root: string, relative: string, data: Buffer): Promise<void> {
	const target = path.resolve(root, relative)
	// A pinned path never leaves the folder; refuse one that tries.
	if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error(`refused a file outside the skill: ${relative}`)
	await fs.mkdir(path.dirname(target), { recursive: true })
	await fs.writeFile(target, data)
}
