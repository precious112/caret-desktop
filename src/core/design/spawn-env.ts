/**
 * The environment for spawning system tools (node, npm).
 *
 * A macOS app launched from Finder inherits launchd's minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin) — the very node and npm the design shell
 * depends on are invisible exactly when the app is started the normal way.
 * Development never hits this because a shell-launched process carries the
 * login PATH, which is also why the same build can look healthy from Terminal
 * and broken from Finder on the same machine.
 *
 * Two layers of repair, cheapest first:
 *
 * 1. Hardcoded well-known dirs (/opt/homebrew/bin, /usr/local/bin) — Homebrew
 *    and the official node installer.
 * 2. The user's own login shell PATH, asked for ONCE and cached. This is what
 *    covers nvm, fnm, volta, mise and friends, which live under $HOME where no
 *    hardcoded list can find them (measured in the field: node v25 via a
 *    version manager, canvas fine from Terminal, `spawn node ENOENT` from
 *    Finder). Same approach VS Code uses to resolve its shell environment.
 *
 * Windows GUI launches inherit the user PATH, so no augmentation is needed
 * there.
 */
import * as child_process from "child_process"
import * as path from "path"

const UNIX_TOOL_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"]

/** undefined = not asked yet; null = asked and failed, do not ask again. */
let loginShellDirs: string[] | null | undefined

function askLoginShellForPath(): string[] | null {
	if (loginShellDirs !== undefined) return loginShellDirs
	try {
		const shell = process.env.SHELL || "/bin/zsh"
		// -l loads the login profile, -i the interactive rc; version managers
		// register themselves in one or the other depending on the user. The
		// markers isolate PATH from whatever else the rc prints, and the
		// timeout keeps a pathological rc from wedging the first spawn.
		const out = child_process.execFileSync(shell, ["-ilc", 'printf "CARET_PATH>%s<" "$PATH"'], {
			timeout: 4000,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		})
		const match = /CARET_PATH>([^<]*)</.exec(out)
		loginShellDirs = match ? match[1].split(path.delimiter).filter(Boolean) : null
	} catch {
		loginShellDirs = null
	}
	return loginShellDirs
}

export function systemSpawnEnv(): NodeJS.ProcessEnv {
	if (process.platform === "win32") return process.env
	const current = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
	const seen = new Set(current)
	const merged = [...current]
	for (const dir of [...(askLoginShellForPath() ?? []), ...UNIX_TOOL_DIRS]) {
		if (!seen.has(dir)) {
			seen.add(dir)
			merged.push(dir)
		}
	}
	if (merged.length === current.length) return process.env
	return { ...process.env, PATH: merged.join(path.delimiter) }
}
