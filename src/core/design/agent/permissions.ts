/**
 * Caret is the enforcement boundary.
 *
 * Every backend has its own permission configuration, and Caret sets it — the
 * Plan agent for read-only sessions, glob rules for `.caret/`. That is the first
 * line and never the boundary. Upstream backends have shipped bugs where a
 * subagent inherits none of its parent's restrictions, and a design tool whose
 * "read-only plan" can silently rewrite the user's app is worse than one with no
 * plan mode at all. So Caret answers every request itself, and this file is
 * where the answer is decided.
 *
 * Deliberately a pure function over strings: the rules are the part that must be
 * right, and they are worth testing without a running agent.
 */
import * as path from "path"

import type { PermissionDecision, SessionMode } from "./backend"

/** What the user has said about writes to their app's own source. */
export type AppWritePolicy = "ask" | "allow"

export interface PermissionRequest {
	/** The backend's action name: `edit`, `bash`, `webfetch`, `external_directory`, … */
	action: string
	/** Paths (for edits) or the command (for bash). May be empty. */
	patterns: string[]
}

export interface PermissionContext {
	/** Absolute, symlink-resolved project root. */
	projectPath: string
	mode: SessionMode
	appWrites: AppWritePolicy
	/**
	 * Command prefixes the USER has vouched for as read-only, from the
	 * project's `.caret/permissions.json`. The built-in allowlist is Caret's
	 * best guess at "reads"; a project that needs `npm ls` or a bespoke report
	 * script in its plans should not need a Caret release to get it.
	 */
	extraReadOnlyCommands?: readonly string[]
}

export type PermissionRuling =
	/** Caret decided; the user is never shown this. */
	| { kind: "auto"; decision: PermissionDecision; reason: string }
	/** The user decides. `summary` is what the prompt says. */
	| { kind: "ask"; summary: string }

/** Actions that change files. Everything else is asked about or allowed by config. */
const EDIT_ACTIONS = new Set(["edit", "write", "patch", "multiedit"])

export function rulePermission(request: PermissionRequest, context: PermissionContext): PermissionRuling {
	if (EDIT_ACTIONS.has(request.action)) return ruleEdit(request, context)

	// Caret's own MCP tools, as the bundled backend's chat agent sees them. Only
	// the mutating ones are gated (the spawn config names them — see
	// `desktop/main/index.ts`), and every one of them writes inside `.caret/` by
	// construction: the bridge is the design layer's API and reaches nothing
	// else. So the ruling is the same as an `edit` aimed at the design layer —
	// allowed, with the note that makes the auto-approval visible in the chat.
	// Without this, the request would fall to the unrecognised-action ask below,
	// and a chat turn would stall on a question about Caret's own tool.
	if (request.action.startsWith("caret_")) {
		return { kind: "auto", decision: "allow", reason: "the design layer is Caret's own to write" }
	}

	if (request.action === "external_directory") {
		return context.mode === "read-only"
			? { kind: "auto", decision: "deny", reason: "a plan may not reach outside this project" }
			: {
					kind: "ask",
					summary: `Let the agent work outside this project: ${request.patterns.join(", ") || "another directory"}?`,
				}
	}

	if (request.action === "bash") {
		const command = request.patterns.join(" ").trim() || "a shell command"

		// A plan that cannot look around writes a worse plan. Denying bash outright
		// was tried and the agent simply retried it until the turn ran out, so
		// read-only sessions allow commands that are read-only in the same sense
		// the session is — and refuse everything else, including anything that
		// could chain a second command onto a harmless first one.
		if (context.mode === "read-only") {
			return isReadOnlyCommand(command, context.extraReadOnlyCommands)
				? { kind: "auto", decision: "allow", reason: "reading is what a plan is for" }
				: {
						kind: "auto",
						decision: "deny",
						// The reason is written for the MODEL as much as the human —
						// it rides the rejection as feedback. Name the alternative,
						// because "no" alone was measured ending whole turns.
						reason: `\`${command}\` is not on the plan-mode allowlist — plans may only read. Use your read tools (read, glob, grep, git log/diff/ls-files/ls-tree) instead, and carry on with the plan.`,
					}
		}

		if (isCaretInstallCommand(command, context.projectPath)) {
			return { kind: "auto", decision: "allow", reason: "installing into the design layer is Caret's own to manage" }
		}

		return { kind: "ask", summary: `Run \`${command}\`?` }
	}

	// Anything unrecognised is asked about rather than allowed. A backend that
	// grows a new capability must not gain it silently inside Caret.
	return { kind: "ask", summary: `Allow the agent to ${request.action}${describeTargets(request.patterns)}?` }
}

function ruleEdit(request: PermissionRequest, context: PermissionContext): PermissionRuling {
	const targets = request.patterns.filter(Boolean)
	if (targets.length === 0) {
		return { kind: "ask", summary: "Let the agent change a file?" }
	}

	const classified = targets.map((target) => classify(target, context.projectPath))

	// Mixed batches take the strictest answer. An edit call that touches both the
	// design layer and the app is an app edit as far as consent goes.
	const escaping = targets.filter((_, index) => classified[index] === "outside")
	if (escaping.length > 0) {
		// Names the file. A refusal that only says "outside this project" is
		// unarguable-with: if Caret has misread the path there is no way to tell.
		return {
			kind: "auto",
			decision: "deny",
			reason: `writing outside this project is never allowed (${escaping.join(", ")})`,
		}
	}

	if (classified.every((c) => c === "design")) {
		return { kind: "auto", decision: "allow", reason: "the design layer is Caret's own to write" }
	}

	if (context.mode === "read-only") {
		return { kind: "auto", decision: "deny", reason: "this is a plan — nothing in your app is written yet" }
	}

	if (context.appWrites === "allow") {
		return { kind: "auto", decision: "allow", reason: "you allowed app changes for this project" }
	}

	return { kind: "ask", summary: `Change ${describeFiles(targets, context.projectPath)}?` }
}

/**
 * Commands a plan may run.
 *
 * An allowlist of *programs*, not a parser: anything that could start a second
 * command is refused before the name is even looked at, so `ls; rm -rf .` never
 * reaches the check. `git` is included only for its reporting subcommands —
 * `git checkout` and `git reset` change the working tree, which is exactly what
 * a plan must not do.
 */
const READ_ONLY_COMMANDS = new Set([
	"cat",
	"file",
	"find",
	"grep",
	"head",
	"ls",
	"pwd",
	"rg",
	"sed",
	"stat",
	"tail",
	"tree",
	"wc",
	"which",
	// Windows spellings of the same reads — a backend running its shell through
	// cmd/PowerShell reaches for these, and refusing a read kills whole turns
	// (see the git note below).
	"dir",
	"findstr",
	"more",
	"type",
	"where",
])

// `ls-tree`, `rev-parse` and `cat-file` earned their places the hard way:
// each is a pure read in every form, and refusing a read the model reasonably
// reaches for is not a safety win — it is a landmine. On the ChatGPT provider
// route a single refusal was measured killing the WHOLE turn 0.2s later
// (probe: scripts/probe-plan-turn.ts), which made every sync plan die at
// exactly "a plan may not run `git ls-tree`".
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"blame",
	"branch",
	"cat-file",
	"diff",
	"log",
	"ls-files",
	"ls-tree",
	"rev-parse",
	"show",
	"status",
])

/** Anything that could chain, redirect, or substitute another command. */
const SHELL_COMPOSITION = /[;&|><`$(){}]|\n/

/**
 * Discarding stderr is not a redirection worth refusing.
 *
 * `find … 2>/dev/null` is how every agent writes `find`, and refusing it sent
 * the plan phase into a retry loop over a command that does nothing but silence
 * permission-denied noise. The null device is not a file — and on Windows it is
 * spelled `NUL`.
 */
const HARMLESS_REDIRECTS = /\s*\d?>\s*(?:\/dev\/null|nul\b)|\s*2>&1/gi

/**
 * Quoted arguments, which the shell does not interpret as composition.
 *
 * `grep -n "route\|Router" file` is a pipe character the shell never sees, and
 * refusing it makes the plan phase useless for exactly the searches it most
 * wants to run. Single quotes are inert, so they come out whole; double quotes
 * still expand `$…` and backticks, so a span containing either is left in place
 * to be caught by the composition test.
 */
const SINGLE_QUOTED = /'[^']*'/g
const DOUBLE_QUOTED = /"[^"$`]*"/g

export function isReadOnlyCommand(command: string, extra?: readonly string[]): boolean {
	const bare = command.replace(HARMLESS_REDIRECTS, "").replace(SINGLE_QUOTED, "").replace(DOUBLE_QUOTED, "")
	if (SHELL_COMPOSITION.test(bare)) return false

	// The user's own entries, prefix-matched — but only AFTER the composition
	// guard above. Vouching for `npm ls` must not vouch for `npm ls; rm -rf .`.
	if (extra?.some((prefix) => prefix.trim() && (command === prefix.trim() || command.startsWith(`${prefix.trim()} `)))) {
		return true
	}

	const [program, ...rest] = command.trim().split(/\s+/)
	if (!program) return false

	// `sed -i` edits in place, which is a write wearing a reader's name.
	if (program === "sed" && rest.some((argument) => argument.startsWith("-i"))) return false

	if (program === "git") {
		const subcommand = rest.find((argument) => !argument.startsWith("-"))
		return subcommand !== undefined && READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)
	}

	return READ_ONLY_COMMANDS.has(program)
}

/**
 * An `npm install` aimed at the design layer's own workspace.
 *
 * The guide tells the agent to install a library into `.caret` before
 * importing it (the import of an uninstalled package stops the whole page
 * rendering); that instruction is worthless if the install then blocks on a
 * human ask — the design layer is already Caret's own to write. Only the
 * exact shape the guide prescribes is allowed:
 *
 *   npm install --prefix <path inside .caret> <packages…> --ignore-scripts
 *
 * `--ignore-scripts` is required, not optional: it is the difference between
 * "files land in node_modules" and "the registry runs code on this machine
 * at install time". No chaining, and both verbs (`install`, `i`) count.
 * Anything else falls through to the ask below.
 */
export function isCaretInstallCommand(command: string, projectPath: string): boolean {
	if (SHELL_COMPOSITION.test(command)) return false
	const parts = command.trim().split(/\s+/)
	if (parts[0] !== "npm" || (parts[1] !== "install" && parts[1] !== "i")) return false
	if (!parts.includes("--ignore-scripts")) return false

	let prefix: string | undefined
	for (let index = 2; index < parts.length; index++) {
		if (parts[index] === "--prefix") prefix = parts[index + 1]
		else if (parts[index].startsWith("--prefix=")) prefix = parts[index].slice("--prefix=".length)
	}
	if (!prefix) return false

	// A relative prefix resolves against the session's working directory,
	// which is the project root.
	const root = stripPrivate(path.normalize(projectPath))
	const resolved = comparable(stripPrivate(path.normalize(path.resolve(root, prefix))))
	const caretDir = comparable(path.join(root, ".caret"))
	return resolved === caretDir || resolved.startsWith(caretDir + path.sep)
}

type Classification = "design" | "app" | "outside"

/**
 * Where a path sits relative to the project.
 *
 * Backends do not agree on how to spell a path. The same edit arrives as an
 * absolute path, as an absolute path with its leading separator stripped, as a
 * path relative to the project, and (on macOS) through `/private`. Only one of
 * those compares equal to the project root, so a single interpretation gets the
 * answer wrong on real traffic — which is not a cosmetic failure here: a design
 * file misread as "outside" is silently refused, and the user watches their
 * agent get denied its own work with no way to tell why.
 *
 * So a non-absolute path is tried **both** ways and taken as whichever lands
 * inside the project. That is deliberately the safe direction to be wrong in.
 * Reading a stripped-slash path as project-relative would produce an extra
 * permission *prompt*; reading a project-relative path as stripped-slash
 * produces a wrong refusal. The absolute reading wins when both fit, because a
 * relative path only resolves that way if it already contained the project root.
 */
export function classify(target: string, projectPath: string): Classification {
	const root = stripPrivate(path.normalize(projectPath))

	const candidates = path.isAbsolute(target)
		? [target]
		: // Stripped leading separator first, then genuinely project-relative.
			[path.resolve(path.sep, target), path.resolve(root, target)]

	for (const candidate of candidates) {
		const inside = within(root, candidate)
		if (inside) return inside
	}
	return "outside"
}

function within(root: string, candidate: string): Exclude<Classification, "outside"> | null {
	const relative = path.relative(comparable(root), comparable(stripPrivate(path.normalize(candidate))))
	if (relative.startsWith("..") || path.isAbsolute(relative)) return null
	return relative.split(path.sep)[0] === ".caret" ? "design" : "app"
}

/** macOS resolves `/tmp` and `/var` through `/private`; both spellings are the same file. */
function stripPrivate(value: string): string {
	return value.startsWith("/private/") ? value.slice("/private".length) : value
}

/**
 * Windows filesystems are case-insensitive, and backends spell the drive letter
 * and path segments however they like — `c:\users\…` against a root recorded as
 * `C:\Users\…` must not classify as "outside", which is the silent-refusal
 * failure mode the doc comment above warns about. Comparison only; paths shown
 * to the user keep their original casing.
 */
function comparable(value: string): string {
	return process.platform === "win32" ? value.toLowerCase() : value
}

function describeFiles(targets: string[], projectPath: string): string {
	const names = targets.map((target) => {
		const relative = path.relative(stripPrivate(projectPath), stripPrivate(target))
		return relative.startsWith("..") ? target : relative
	})
	if (names.length === 1) return names[0]
	return `${names.length} files (${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""})`
}

function describeTargets(patterns: string[]): string {
	const meaningful = patterns.filter(Boolean)
	return meaningful.length ? `: ${meaningful.join(", ")}` : ""
}
