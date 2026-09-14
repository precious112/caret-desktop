import simpleGit from "simple-git"
import { Logger } from "@/shared/services/Logger"
import { getLatestGitCommitHash, isGitRepository } from "@/utils/git"

const CARET_DIR = ".caret/"

/**
 * Ensures the workspace is a git repo so the design layer can be version-tracked
 * (sync's bookmark is a commit hash). Idempotent. Sets a local commit identity
 * only if none is configured, so we never override the user's global config.
 */
export async function ensureGitRepo(cwd: string): Promise<void> {
	if (await isGitRepository(cwd)) {
		return
	}
	const git = simpleGit(cwd)
	await git.init()
	await git.addConfig("commit.gpgSign", "false")
	// Only set a fallback identity if the user has none (else `git commit` fails).
	const name = (await git.raw(["config", "user.name"]).catch(() => "")).trim()
	if (!name) {
		await git.addConfig("user.name", "Caret")
		await git.addConfig("user.email", "caret@local")
	}
}

/**
 * Commits the design layer — STRICTLY scoped to `.caret/`. Uses a pathspec
 * commit (`git commit -- .caret/`, `--only` semantics): the commit records
 * `.caret/` content and HEAD's content for everything else, so app changes
 * (staged or unstaged) are never included and the user's other staged work is
 * preserved. Returns the new HEAD hash, or null if there was nothing to commit.
 */
export async function commitDesignLayer(cwd: string, message: string): Promise<string | null> {
	const git = simpleGit(cwd)
	try {
		// Stage everything under .caret/ (incl. untracked new pages).
		await git.raw(["add", "--", CARET_DIR])
		// Pathspec commit — only .caret/, regardless of what else is staged.
		await git.raw(["commit", "-m", message, "--no-verify", "--", CARET_DIR])
		return (await git.revparse(["HEAD"])).trim()
	} catch (error) {
		Logger.error("[sync] commitDesignLayer failed:", error)
		return null
	}
}

/**
 * Reverts uncommitted changes — STRICTLY scoped to `.caret/`. Restores tracked
 * `.caret/` files to HEAD and removes untracked `.caret/` files (new pages).
 * `git clean` respects `.gitignore`, so node_modules/thumbnails are untouched.
 * Nothing outside `.caret/` is affected.
 */
export async function discardDesignLayerChanges(cwd: string): Promise<void> {
	if (!(await isGitRepository(cwd))) {
		return
	}
	const git = simpleGit(cwd)
	try {
		// `restore` needs a HEAD to restore from; only run it once there are commits.
		if ((await getLatestGitCommitHash(cwd)) !== null) {
			await git.raw(["restore", "--staged", "--worktree", "--", CARET_DIR])
		}
		await git.raw(["clean", "-fd", "--", CARET_DIR])
	} catch (error) {
		Logger.error("[sync] discardDesignLayerChanges failed:", error)
	}
}
