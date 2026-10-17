/**
 * The bundled server's data home is Caret's own, seeded once from the shared
 * one. The boot itself — a 2.x database in the shared dir, and the pinned
 * binary starting anyway — is `scripts/probe-foreign-db.ts`, because it needs
 * the real binary.
 */
import { strict as assert } from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { bundledOpencodeDir, caretDataHome, discardSeededDatabase, seedFromSharedInstall, sharedOpencodeDir } from "../data-home"

describe("bundled OpenCode data home", () => {
	let root: string
	let from: string
	let to: string

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "caret-data-home-"))
		from = path.join(root, "shared")
		to = path.join(root, "bundled")
		fs.mkdirSync(from)
	})

	afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

	it("never resolves to the directory the user's own OpenCode uses", () => {
		assert.notEqual(bundledOpencodeDir(), sharedOpencodeDir())
		assert.equal(bundledOpencodeDir(), path.join(caretDataHome(), "opencode"))
	})

	it("carries the database, its journal and the sign-ins over", () => {
		for (const name of ["opencode.db", "opencode.db-wal", "opencode.db-shm", "auth.json"]) {
			fs.writeFileSync(path.join(from, name), name)
		}

		assert.equal(seedFromSharedInstall(from, to), true)
		for (const name of ["opencode.db", "opencode.db-wal", "opencode.db-shm", "auth.json"]) {
			assert.equal(fs.readFileSync(path.join(to, name), "utf-8"), name)
		}
	})

	it("seeds only once — an existing bundled database is never replaced", () => {
		fs.writeFileSync(path.join(from, "opencode.db"), "shared")
		fs.mkdirSync(to)
		fs.writeFileSync(path.join(to, "opencode.db"), "ours")

		assert.equal(seedFromSharedInstall(from, to), false)
		assert.equal(fs.readFileSync(path.join(to, "opencode.db"), "utf-8"), "ours")
	})

	it("reports nothing to seed when there was never a shared database", () => {
		fs.writeFileSync(path.join(from, "auth.json"), "{}")
		assert.equal(seedFromSharedInstall(from, to), false)
		assert.equal(fs.existsSync(to), false)
	})

	it("discards a refused database but keeps the sign-ins", () => {
		for (const name of ["opencode.db", "opencode.db-wal", "auth.json"]) {
			fs.writeFileSync(path.join(from, name), name)
		}
		seedFromSharedInstall(from, to)

		discardSeededDatabase(to)
		assert.deepEqual(fs.readdirSync(to), ["auth.json"])
	})
})
