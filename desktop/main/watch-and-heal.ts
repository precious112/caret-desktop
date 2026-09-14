/**
 * Watches `.caret/` and heals whatever lands in it.
 *
 * Caret exposes MCP write tools, and nothing makes an agent use them. Claude
 * Code will edit `.caret/pages/*` with its own `Edit` tool; a user will open the
 * file in their editor; a script will generate one. All of those bypass the
 * mutation queue, the atomic writes and the validation that the MCP path gets
 * for free.
 *
 * So direct writing is treated as the **primary** path rather than an
 * exception. Anything that appears under `.caret/` gets the caret-id codemod and
 * validation run over it, whoever wrote it. That makes the reliability story
 * independent of agent cooperation, which is the only way it can hold for agents
 * Caret does not own.
 *
 * The codemod is append-only and idempotent: an id already in source is never
 * rewritten, so a heal that finds nothing to do writes nothing, triggers no HMR,
 * and cannot feed itself.
 */
import chokidar, { type FSWatcher } from "chokidar"
import * as fsp from "fs/promises"
import * as path from "path"

import { assetIndexPath, entryFileSources, reindexAssets, viteConfigSource, writeThemeCss } from "../../src/core/design"
import { recordEdit } from "../../src/core/design/provenance"
import { precomputeAndApply } from "../../src/core/design/visual-editing/post-generation-hook"
import { Logger } from "../../src/shared/services/Logger"
import { enrichOpaqueBoxesSoon } from "./asset-metrics"
import { regenerateRulesFiles } from "./rules/generate"

/**
 * Long enough that an agent writing a file in several chunks settles first, short
 * enough that the heal lands before the user clicks the element.
 */
const HEAL_DEBOUNCE_MS = 400

/** Directory names, at any depth under `.caret/`, that hold nothing healable. */
const IGNORED_DIR_SEGMENTS = new Set([
	"node_modules",
	// Poster frames Caret extracts from videos. Derived from the asset beside
	// them, so they are neither design content nor something to index as assets
	// in their own right — a poster with its own @tag would be a second name for
	// the same decision.
	".posters",
])

/**
 * Top-level directories of `.caret/` that are Caret's own output.
 *
 * Only top-level: `lib` here is the generated canvas modules, but a user's
 * `components/lib/Button.tsx` is a component like any other and must heal.
 */
const IGNORED_TOP_DIRS = new Set(["lib", "thumbnails"])

/** Files Caret itself owns and regenerates. Healing them would be circular. */
const IGNORED_FILES = new Set([
	"vite.log",
	// Generated from foundation.json by Caret itself — healing it would loop:
	// tokens change → theme regenerated → healer wakes → regenerates again.
	"caret-theme.css",
	"caret-fonts.css",
	// The vite plugin rewrites it per open playground take (Tailwind @source
	// registration) — healing it would wake the healer once per round.
	"caret-take-sources.css",
	"canvas-layout.json",
	".sync-pending.json",
	// Mapping metadata Caret writes during sync — versioned, but not healable
	// content, and waking the healer once per recorded mapping is noise.
	"sync-manifest.json",
	// The decisions-and-stubs ledger the sync apply maintains. Versioned like
	// the manifest (it is the user's map of what is still fake), but markdown
	// the model writes — nothing in it is healable.
	"sync-notes.md",
	".provenance.jsonl",
	".mcp.json",
	// Caret's own scratch, rewritten on every interview step. Not design content,
	// and waking the healer once per answered question is work for nothing.
	".interview.json",
	// The undo journal: rewritten on every undoable boundary, never design content.
	".undo-journal.json",
	// Correction-offer bookkeeping — observation, like the provenance log.
	".corrections-state.json",
	// The generate-and-pick set's own state. The variant PAGES are healable
	// pages and deliberately not ignored; the scratch is Caret's bookkeeping.
	".variants.json",
	// The checker's latest results — derived observation, rewritten per run.
	".checks-results.json",
])

/**
 * Whether the healer should stay asleep for a path.
 *
 * A predicate, not a glob list: **chokidar 4 dropped glob support in `ignored`**
 * and compares a string entry literally, so the `"**\/node_modules/**"` this
 * file used to pass matched nothing at all. Everything was watched —
 * `.caret/node_modules` (1,400 files that Vite writes into as it optimises
 * deps), and every file listed here that Caret regenerates. Reproduce in ten
 * lines if you ever doubt it: watch a dir with the glob in `ignored` and touch
 * `node_modules/.vite/deps/react.js`; the add event fires.
 */
export function isIgnoredPath(caretDir: string, target: string): boolean {
	const rel = path.relative(caretDir, target)
	// Outside the tree, or the root itself — nothing to say about it.
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false
	if (rel.endsWith(".tmp")) return true

	const parts = rel.split(path.sep)
	if (IGNORED_TOP_DIRS.has(parts[0])) return true
	// A directory event names the directory itself, so the last segment counts too.
	if (parts.some((segment) => IGNORED_DIR_SEGMENTS.has(segment))) return true
	// Caret's own files all sit at the top of `.caret/`; a page called
	// `.variants.json` deeper in the tree is not one of them.
	return parts.length === 1 && IGNORED_FILES.has(parts[0])
}

export interface WatchAndHealOptions {
	projectPath: string
	/**
	 * Whether a Caret-driven agent turn is in flight.
	 *
	 * The backend Caret owns writes `.caret/` files with its own tools, so from
	 * the watcher's side those look identical to a person editing the file in
	 * their editor. They are not the same thing: one is the user working *in*
	 * Caret, the other is bypassing it. Phase 7 mines this distinction to tell
	 * taste from machine output, and the direct-edit notice below would otherwise
	 * fire on the user's own AI edits.
	 */
	isAgentActive?(): boolean
	/**
	 * The first genuinely direct write to the design layer this session.
	 *
	 * Direct edits are tolerated and healed, never recommended — the visual editor
	 * is the supported path — so this is said once and then never again.
	 */
	onFirstDirectWrite?(filePath: string): void
	/** Called after a heal actually changed a file, so the canvas can be told. */
	onHealed?(filePath: string): void
	/**
	 * Called after any page/component write settles (healed or not) — the
	 * catalog's auto-supply hook. Whoever wrote the file, an import of a
	 * catalog component must become true.
	 */
	onPageWritten?(filePath: string): void
	/** Called when foundation tokens change, after the rules files are rewritten. */
	onTokensChanged?(): void
	/** Called after the asset index changed, so the library surface can refresh. */
	onAssetsChanged?(): void
}

export class WatchAndHeal {
	private watcher: FSWatcher | null = null
	private timers = new Map<string, NodeJS.Timeout>()
	/**
	 * Files this process just wrote. A heal writes the file it is healing, which
	 * the watcher then reports back — without this the codemod would re-enter
	 * itself once per write. It terminates anyway because the codemod is
	 * idempotent, but the wasted parse is avoidable.
	 */
	private selfWrites = new Set<string>()
	/** The direct-edit notice is once per session, not once per file. */
	private announcedDirectWrite = false

	constructor(private readonly options: WatchAndHealOptions) {}

	start(): void {
		if (this.watcher) return
		const caretDir = path.join(this.options.projectPath, ".caret")

		this.watcher = chokidar.watch(caretDir, {
			ignored: (target: string) => isIgnoredPath(caretDir, target),
			ignoreInitial: true,
			awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
			// Polling, deliberately: FSEvents drops events for files (and even the
			// addDir) when a whole new directory appears at once — an agent's
			// mkdir+write of pages/<new>/ was missed in two certification runs,
			// so the page was never healed and the catalog never supplied. The
			// .caret tree is small and node_modules/lib are ignored, so a 1s poll
			// is cheap; correctness beats elegance here.
			usePolling: true,
			interval: 1000,
		})

		this.watcher.on("error", (err) => Logger.warn(`[heal] watcher error: ${err}`))
		this.watcher.on("ready", () => void this.healWhatWasAlreadyThere(caretDir))
		this.watcher.on("add", (file) => this.schedule(file, "create"))
		this.watcher.on("change", (file) => this.schedule(file, "write"))
		// A new directory's files can be created before chokidar's watcher for
		// that directory attaches — with ignoreInitial they then read as
		// "already there" and NO EVENT EVER FIRES. An agent writing
		// pages/<new>/index.tsx right after mkdir hits this race routinely (a
		// certification run caught it: the healer never saw the page, so the
		// catalog was never supplied). Catch up by scanning the new directory
		// once it settles; schedule() debounces duplicates from the normal path.
		this.watcher.on("addDir", (dir) => {
			setTimeout(() => {
				void fsp
					.readdir(dir, { withFileTypes: true })
					.then((entries) => {
						for (const entry of entries) {
							if (entry.isFile()) this.schedule(path.join(dir, entry.name), "create")
						}
					})
					.catch(() => {})
			}, 500)
		})
		this.watcher.on("unlink", (file) => {
			void recordEdit(this.options.projectPath, { actor: "external", action: "delete", file })
		})

		Logger.info(`[heal] watching ${caretDir}`)
	}

	/**
	 * Heals everything that was already on disk when the watcher opened its eyes.
	 *
	 * `ignoreInitial: true` suppresses events for every file present at the
	 * initial scan — and because that scan is asynchronous, "present" includes
	 * files written *while it runs*. Nothing in that window ever produces an
	 * event, so nothing in it is ever healed. The `addDir` catch-up below does
	 * not help: the directory is in the initial scan too, so no `addDir` fires
	 * either.
	 *
	 * That window is exactly when unhealed content is most likely to exist. A
	 * project cloned from a teammate, updated by `git pull`, or written by an
	 * agent while Caret was closed opens with pages that carry no caret-ids —
	 * and every click on them resolves to nothing, which reads as "the editor
	 * doesn't work" rather than "this page was never healed". Certification only
	 * missed it because the scenario that writes an unhealed page ran minutes
	 * after launch, long past the race; running it first fails every time.
	 *
	 * A sweep is safe to repeat: the codemod is idempotent, so a project that is
	 * already healed is read and not written, produces no HMR and no provenance.
	 */
	private async healWhatWasAlreadyThere(caretDir: string): Promise<void> {
		let healed = 0
		let seen = 0
		for (const file of await this.healableFilesUnder(caretDir)) {
			seen++
			try {
				this.markSelfWrite(file)
				const result = await precomputeAndApply(file)
				if (result.modified) {
					healed++
					await recordEdit(this.options.projectPath, {
						actor: "caret",
						action: "heal",
						file,
						note: "healed at open — written while Caret was not watching",
					})
					this.options.onHealed?.(file)
				} else {
					this.selfWrites.delete(file)
				}
				// Whoever wrote the page, an import of a catalog component still has
				// to become true — and a page pulled from git is the likeliest place
				// for one that was never installed here.
				this.options.onPageWritten?.(file)
			} catch (err) {
				this.selfWrites.delete(file)
				Logger.debug(`[heal] could not heal ${file} at open: ${err}`)
			}
		}
		Logger.info(`[heal] opening sweep: ${healed} of ${seen} page file(s) needed healing`)
	}

	/** Every healable file under `.caret/`, skipping what the watcher itself skips. */
	private async healableFilesUnder(dir: string): Promise<string[]> {
		const found: string[] = []
		const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
		for (const entry of entries) {
			const full = path.join(dir, entry.name)
			if (isIgnoredPath(path.join(this.options.projectPath, ".caret"), full)) continue
			if (entry.isDirectory()) {
				found.push(...(await this.healableFilesUnder(full)))
			} else if (entry.isFile() && isHealable(full)) {
				found.push(path.resolve(full))
			}
		}
		return found
	}

	async stop(): Promise<void> {
		for (const timer of this.timers.values()) clearTimeout(timer)
		this.timers.clear()
		await this.watcher?.close()
		this.watcher = null
	}

	/** Marks a path as written by us, so the resulting event is not treated as external. */
	markSelfWrite(filePath: string): void {
		this.selfWrites.add(path.resolve(filePath))
	}

	private schedule(filePath: string, action: "create" | "write"): void {
		const existing = this.timers.get(filePath)
		if (existing) clearTimeout(existing)
		this.timers.set(
			filePath,
			setTimeout(() => {
				this.timers.delete(filePath)
				void this.handle(filePath, action)
			}, HEAL_DEBOUNCE_MS),
		)
	}

	/**
	 * Records who wrote a file, and says something the first time it was written
	 * around Caret rather than through it.
	 */
	private async recordAuthor(filePath: string, action: "create" | "write"): Promise<void> {
		if (this.options.isAgentActive?.()) {
			await recordEdit(this.options.projectPath, { actor: "agent", action, file: filePath })
			return
		}

		await recordEdit(this.options.projectPath, { actor: "external", action, file: filePath })

		if (!this.announcedDirectWrite) {
			this.announcedDirectWrite = true
			this.options.onFirstDirectWrite?.(filePath)
		}
	}

	private async handle(filePath: string, action: "create" | "write"): Promise<void> {
		const resolved = path.resolve(filePath)
		const wasSelfWrite = this.selfWrites.delete(resolved)

		if (isFoundationTokens(filePath)) {
			await this.onTokensChanged(filePath, action, wasSelfWrite)
			return
		}

		if (isPromotedRules(filePath)) {
			// Promoted rules are always-on context, same stakes as the tokens: a
			// stale rules file silently drops a correction the user promoted. The
			// change may come from Caret's own promote, a hand edit, or a git pull —
			// all of them must reach the generated files.
			if (!wasSelfWrite) {
				await recordEdit(this.options.projectPath, { actor: "external", action, file: filePath })
			}
			await regenerateRulesFiles(this.options.projectPath).catch((err) =>
				Logger.warn(`[heal] could not regenerate rules files: ${err}`),
			)
			return
		}

		if (isAssetFile(filePath)) {
			await this.onAssetsChanged(filePath, action, wasSelfWrite)
			return
		}

		if (isShellFile(path.join(this.options.projectPath, ".caret"), filePath)) {
			await this.onShellFileChanged(resolved, wasSelfWrite)
			return
		}

		if (!isHealable(filePath)) {
			if (!wasSelfWrite && isDesignContent(filePath)) {
				await this.recordAuthor(filePath, action)
			}
			return
		}

		if (!wasSelfWrite) {
			await this.recordAuthor(filePath, action)
		}

		try {
			this.markSelfWrite(resolved)
			const result = await precomputeAndApply(resolved)
			if (result.modified) {
				await recordEdit(this.options.projectPath, {
					actor: "caret",
					action: "heal",
					file: filePath,
					note: "added caret-ids / converted inline styles",
				})
				this.options.onHealed?.(resolved)
			} else {
				// Nothing was written, so no event is coming back for it.
				this.selfWrites.delete(resolved)
			}
		} catch (err) {
			this.selfWrites.delete(resolved)
			// A file mid-save is routinely unparseable. That is not an error worth
			// showing the user — the next save will heal it.
			Logger.debug(`[heal] could not heal ${filePath}: ${err}`)
		}

		this.options.onPageWritten?.(resolved)
	}

	/**
	 * Restores a shell boot file that something rewrote mid-session.
	 *
	 * `vite.config.ts`, `global.css`, `main.tsx` and `index.html` ARE the
	 * Tailwind/Vite setup, and they are only regenerated at project open — so a
	 * bad write to one of them (edits to the design layer are auto-approved, so
	 * an agent's write never surfaces to anyone) broke styling for the rest of
	 * the session and then silently self-repaired on the next open, the worst
	 * possible shape for a bug. The content compare is the loop guard: the
	 * restore's own write comes back through the watcher, matches, and no-ops.
	 */
	private async onShellFileChanged(resolved: string, wasSelfWrite: boolean): Promise<void> {
		if (wasSelfWrite) return
		const name = path.basename(resolved)
		const generated: Record<string, string> = { "vite.config.ts": viteConfigSource(), ...entryFileSources() }
		const expected = generated[name]
		if (!expected) return
		const current = await fsp.readFile(resolved, "utf-8").catch(() => null)
		if (current === expected) return

		await recordEdit(this.options.projectPath, { actor: "external", action: "write", file: resolved })
		try {
			this.markSelfWrite(resolved)
			await fsp.writeFile(resolved, expected)
			await recordEdit(this.options.projectPath, {
				actor: "caret",
				action: "heal",
				file: resolved,
				note: "restored generated shell file — Caret owns it, edits belong in pages/components/tokens",
			})
			Logger.info(`[heal] restored ${name} — a shell file Caret generates was rewritten`)
		} catch (err) {
			this.selfWrites.delete(resolved)
			Logger.warn(`[heal] could not restore ${name}: ${err}`)
		}
	}

	/**
	 * Indexes an asset that appeared in `.caret/assets/`, whoever put it there.
	 *
	 * Dragging a file into the folder in Finder has to work as well as using the
	 * UI, for the same reason an agent's own `Edit` tool has to work on pages: the
	 * reliable path cannot be the one that depends on everybody choosing it.
	 *
	 * The index write comes back through this watcher, so it is marked as a
	 * self-write first. `reindexAssets` is also a no-op when nothing changed,
	 * which closes the loop from the other side.
	 */
	private async onAssetsChanged(filePath: string, action: "create" | "write", wasSelfWrite: boolean): Promise<void> {
		if (!wasSelfWrite) {
			await recordEdit(this.options.projectPath, { actor: "external", action, file: filePath })
		}

		try {
			this.markSelfWrite(path.resolve(assetIndexPath(this.options.projectPath)))
			const result = await reindexAssets(this.options.projectPath)

			for (const { file, reason } of result.skipped) {
				Logger.info(`[heal] not indexing ${file}: ${reason}`)
			}
			if (result.added.length || result.removed.length || result.updated.length) {
				await recordEdit(this.options.projectPath, {
					actor: "caret",
					action: "write",
					file: assetIndexPath(this.options.projectPath),
					note: `indexed assets (+${result.added.length} -${result.removed.length} ~${result.updated.length})`,
				})
				// The asset list is always-on context, so a stale rules file would
				// have an agent reaching for an asset that is gone or missing one
				// that just arrived.
				await regenerateRulesFiles(this.options.projectPath).catch((err) =>
					Logger.warn(`[heal] could not regenerate rules files: ${err}`),
				)
			}
			this.options.onAssetsChanged?.()

			// Measured-pixel metadata (opaqueBox) rides behind the reindex rather
			// than inside it: decoding pixels is Electron work the pure core cannot
			// do, and a decode failure must never fail the reindex. The write is
			// marked as our own only when it is actually about to happen.
			enrichOpaqueBoxesSoon(this.options.projectPath, () =>
				this.markSelfWrite(path.resolve(assetIndexPath(this.options.projectPath))),
			)
		} catch (err) {
			Logger.warn(`[heal] could not reindex assets: ${err}`)
		}
	}

	private async onTokensChanged(filePath: string, action: "create" | "write", wasSelfWrite: boolean): Promise<void> {
		if (!wasSelfWrite) {
			await recordEdit(this.options.projectPath, { actor: "external", action, file: filePath })
		}
		// A stale rules file is worse than none — it is confidently wrong about the
		// brand colour — so this must happen on every token change, not on request.
		await regenerateRulesFiles(this.options.projectPath).catch((err) =>
			Logger.warn(`[heal] could not regenerate rules files: ${err}`),
		)
		// The theme IS the tokens, as far as the rendered pages are concerned:
		// `text-brand-*` resolves through caret-theme.css. Regenerating it here is
		// what makes a foundation change restyle the open canvas as a CSS hot
		// update instead of waiting for the next project open.
		await writeThemeCss(path.join(this.options.projectPath, ".caret")).catch((err) =>
			Logger.warn(`[heal] could not regenerate the theme css: ${err}`),
		)
		this.options.onTokensChanged?.()
	}
}

/** Page and component sources — the files the codemod knows how to fix. */
function isHealable(filePath: string): boolean {
	if (!/\.(tsx|jsx)$/.test(filePath)) return false
	const normalised = filePath.split(path.sep).join("/")
	return (
		normalised.includes("/.caret/pages/") ||
		normalised.includes("/.caret/components/") ||
		normalised.includes("/.caret/layouts/")
	)
}

/**
 * The shell boot files Caret generates at `.caret/`'s root and restores on
 * drift. Root only — a page's own `index.html` fixture deeper in the tree is
 * not one of them.
 */
const SHELL_FILES = new Set(["vite.config.ts", "global.css", "main.tsx", "index.html"])
function isShellFile(caretDir: string, filePath: string): boolean {
	const rel = path.relative(caretDir, path.resolve(filePath))
	return !rel.includes(path.sep) && SHELL_FILES.has(rel)
}

function isFoundationTokens(filePath: string): boolean {
	return filePath.split(path.sep).join("/").endsWith("/.caret/tokens/foundation.json")
}

/** The promoted-rules store (`.caret/rules.json`) — versioned design content. */
function isPromotedRules(filePath: string): boolean {
	return filePath.split(path.sep).join("/").endsWith("/.caret/rules.json")
}

/**
 * Anything in `.caret/assets/` except the index itself.
 *
 * Excluding the index matters: reindexing writes it, and treating that write as
 * a reason to reindex again is a loop that only stops because the self-write set
 * happens to catch it.
 */
function isAssetFile(filePath: string): boolean {
	const normalised = filePath.split(path.sep).join("/")
	return normalised.includes("/.caret/assets/") && !normalised.endsWith("/.caret/assets/index.json")
}

/** Design *content* as opposed to Caret's own machinery — worth recording. */
function isDesignContent(filePath: string): boolean {
	const normalised = filePath.split(path.sep).join("/")
	return ["/pages/", "/components/", "/layouts/", "/tokens/", "/flows/", "/assets/"].some((dir) =>
		normalised.includes(`/.caret${dir}`),
	)
}
