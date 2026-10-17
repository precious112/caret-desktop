/**
 * Where the bundled server keeps its state — never where the user's own
 * OpenCode keeps theirs.
 *
 * Pinning the binary was not enough. The binary resolves its data dir
 * XDG-first (`XDG_DATA_HOME || ~/.local/share`, every platform, read from the
 * bundle), so the server Caret spawned with an inherited environment opened the
 * very `opencode.db` the user's own install was using. A user who installed
 * OpenCode 2.x got that database migrated to a schema with `session_v2` and no
 * `session` table, and the pinned 1.18 refuses such a file on boot — "Database
 * is not empty and has no session table" — so Caret had no backend at all, and
 * nothing Caret did could fix it. Credentials moved with it: 2.x folds
 * `auth.json` into its database, which 1.18 cannot read.
 *
 * So the server gets `XDG_DATA_HOME` pointed at a directory Caret owns. It is a
 * fixed path rather than Electron's userData because certification launches
 * with a throwaway `--user-data-dir`, and sign-ins must survive between runs
 * the way they always have. The cost is that sign-ins are no longer shared with
 * the user's own OpenCode, and commands the agent runs inherit the variable.
 */
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

/** The user's own data home, exactly as the binary would resolve it unaided. */
function userDataHome(): string {
	return process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
}

/** The `XDG_DATA_HOME` the bundled server is spawned with. */
export function caretDataHome(): string {
	return path.join(userDataHome(), "caret")
}

/** The bundled server's own data dir: database, `auth.json`, logs. */
export function bundledOpencodeDir(): string {
	return path.join(caretDataHome(), "opencode")
}

/** Where every Caret before this one kept its sessions and sign-ins. */
export function sharedOpencodeDir(): string {
	return path.join(userDataHome(), "opencode")
}

/** The database is WAL-journalled: the main file alone can miss committed pages. */
const DATABASE_FILES = ["opencode.db", "opencode.db-wal", "opencode.db-shm"]

/**
 * Carries an earlier Caret's sessions and sign-ins into the bundled dir, once.
 *
 * Only when the bundled dir has no database yet, and never overwriting. The
 * copy may be one the pinned binary cannot open — a 2.x schema, or a torn copy
 * of a file someone else was writing — which is why this reports whether it
 * copied a database: the caller boots, and on failure discards the seed with
 * {@link discardSeededDatabase} and boots fresh. The binary's own check is the
 * only honest test of compatibility.
 */
export function seedFromSharedInstall(from = sharedOpencodeDir(), to = bundledOpencodeDir()): boolean {
	if (fs.existsSync(path.join(to, "opencode.db"))) return false
	if (!fs.existsSync(path.join(from, "opencode.db"))) return false

	fs.mkdirSync(to, { recursive: true })
	for (const name of [...DATABASE_FILES, "auth.json"]) {
		const source = path.join(from, name)
		if (!fs.existsSync(source)) continue
		try {
			fs.copyFileSync(source, path.join(to, name), fs.constants.COPYFILE_EXCL)
		} catch {
			// A file that appeared meanwhile is not ours to replace.
		}
	}
	return true
}

/** Removes a seeded database the pinned binary refused, so the next boot starts empty. */
export function discardSeededDatabase(dir = bundledOpencodeDir()): void {
	for (const name of DATABASE_FILES) {
		fs.rmSync(path.join(dir, name), { force: true })
	}
}
