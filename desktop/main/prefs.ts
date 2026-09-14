/**
 * Preferences, replacing VS Code's `globalState` / `StateManager`.
 *
 * A single JSON file under `app.getPath("userData")`, written atomically. The
 * get/set shape deliberately mirrors what `StateManager` exposed so call sites
 * read the same, and everything is loaded synchronously at startup because
 * window creation needs the recents list before it can draw anything.
 */
import { app } from "electron"
import * as fs from "fs"
import * as fsp from "fs/promises"
import * as path from "path"

export interface Prefs {
	/** Most-recently-opened project paths, newest first. */
	recentProjects: string[]
	/** Command used to reveal a file, e.g. `code -g` or `cursor`. Empty = OS default. */
	editorCommand: string
	/** The user's own Google Fonts API key, if they have one. */
	googleFontsApiKey: string
	/**
	 * Google Cloud project for the raster lane's Vertex backend.
	 *
	 * The test-only switch §6.7 specifies, and deliberately absent from the UI:
	 * the shipped path is a Gemini API key in the keychain. It lives in prefs
	 * rather than only in the environment because a macOS app launched from
	 * Finder or the dock inherits no shell environment at all — an env-only
	 * switch can therefore only ever be reached by the certification harness,
	 * which spawns Electron itself, and never by someone running the app.
	 * Empty = not configured. Requires working `gcloud` ADC.
	 */
	vertexProject: string
	/** Vertex region. Empty falls back to `global`. */
	vertexLocation: string
	/**
	 * Opt out of the 214MB cutout model.
	 *
	 * The download is unconditional otherwise, and deliberately: gating it on
	 * anything — a key being present, the feature being opened — starts it at the
	 * moment somebody wants a cutout, which is the one moment it is in the way.
	 * Someone on a metered connection gets a switch rather than a guess made for
	 * them.
	 */
	skipCutoutModel: boolean
	/** Whether `.caret/` is auto-committed after the design layer settles. */
	autoCommitDesign: boolean
	/** Windows the user had open, restored on next launch. */
	lastSession: string[]
	/** Set once the first-run onboarding has been completed. */
	onboardingCompleted: boolean
	/** Which coding backend Caret drives. Null until the user picks one. */
	backendId: "opencode" | null
	/** Model in the backend's own namespace, e.g. `opencode-go/gpt-5.6-luna`. Empty = its default. */
	backendModel: string
	/** How hard the model thinks. Empty = the backend's own default. */
	backendEffort: "" | "minimal" | "low" | "medium" | "high" | "xhigh"
	/**
	 * Projects where the user chose "don't ask again" for writes to their app's
	 * own source. Per project rather than global: consent to rewrite one repo is
	 * not consent to rewrite the next one.
	 */
	appWritesAllowed: string[]
	/** `<projectPath>::<libraryId>` pairs the user approved for catalog installs. */
	catalogAllowed: string[]
	/**
	 * Encrypted credentials, keyed by name. Ciphertext only.
	 *
	 * Written and read through `secrets.ts`, never directly: the encryption key
	 * lives in the OS keychain, and a call site that reached in here would get
	 * base64 noise and quietly treat it as a key.
	 */
	secrets: Record<string, string>
	/**
	 * Which backend-and-model pairs have been shown an image successfully.
	 *
	 * Keyed `backendId::model`, because the capability belongs to the pair rather
	 * than to either alone — a capable model behind an adapter that drops images
	 * cannot see, which is a bug this project actually shipped.
	 */
	visionChecks: Record<string, { sees: boolean; reason?: string; at: number }>
	/**
	 * Per-task model overrides for the generation lanes.
	 *
	 * The lanes inherit the session model by default; these exist because the
	 * right model for chat and the right model for a specific job are often not
	 * the same one — mesh optimization has a recommended set of its own.
	 */
	laneModels: { mark?: string; model3d?: string; shader?: string }
	/**
	 * Anonymous, opt-out product telemetry. One click to turn off — the
	 * first-run notice, the Privacy toggle, or CARET_DISABLE_TELEMETRY=1.
	 * What is collected (and what never is) lives in docs/telemetry.md.
	 */
	telemetryEnabled: boolean
	/**
	 * Random UUID identifying this install to PostHog. Minted on first send,
	 * never derived from the machine or tied to any account.
	 */
	telemetryId: string
	/** Set once the first-run telemetry notice has been shown and dismissed. */
	telemetryNoticeShown: boolean
	/**
	 * Whether the chat agent may generate assets itself.
	 *
	 * Off by default, deliberately: the agent's one-line briefs produced
	 * technically-correct, bland assets (the whole test5 dogfood), while the
	 * Assets tab's describe→clarify→iterate loop is where quality actually
	 * happens. Off, the tool tells the agent to propose WHAT to create and
	 * lets the user make it well. A switch rather than surgery — the whole
	 * chain stays built and certified behind it.
	 */
	chatAssetGeneration: boolean
}

const DEFAULTS: Prefs = {
	recentProjects: [],
	editorCommand: "",
	googleFontsApiKey: "",
	vertexProject: "",
	vertexLocation: "",
	skipCutoutModel: false,
	autoCommitDesign: true,
	lastSession: [],
	onboardingCompleted: false,
	backendId: null,
	backendModel: "",
	backendEffort: "",
	appWritesAllowed: [],
	catalogAllowed: [],
	secrets: {},
	visionChecks: {},
	laneModels: {},
	telemetryEnabled: true,
	telemetryId: "",
	telemetryNoticeShown: false,
	chatAssetGeneration: false,
}

const MAX_RECENTS = 12

let cache: Prefs = { ...DEFAULTS }
let filePath = ""

function resolvePath(): string {
	filePath ||= path.join(app.getPath("userData"), "preferences.json")
	return filePath
}

/** Loads preferences from disk. Call once, before the first window opens. */
export function loadPrefs(): Prefs {
	try {
		const raw = fs.readFileSync(resolvePath(), "utf-8")
		// Merge over defaults so a preferences file written by an older version
		// gains new keys rather than leaving them undefined.
		cache = { ...DEFAULTS, ...JSON.parse(raw) }
	} catch {
		cache = { ...DEFAULTS }
	}
	return retireRemovedBackends(cache)
}

/** Backends Caret used to drive. See `agent/backend.ts` for why they went. */
const REMOVED_BACKENDS = new Set(["claude", "codex", "kimi"])

/**
 * Moves anyone who had chosen a removed backend onto the bundled one.
 *
 * **The model has to go with it.** Model ids live in a backend's own namespace,
 * so a leftover `claude-sonnet-5` handed to OpenCode is not a wrong model, it is
 * a model that does not exist — the first turn would fail with a provider error
 * naming a string the user never typed. Clearing it lands them on the provider's
 * own default, which always resolves, and the picker shows what they have.
 *
 * Effort survives: it is Caret's own vocabulary, not a backend's.
 */
function retireRemovedBackends(prefs: Prefs): Prefs {
	if (!prefs.backendId || !REMOVED_BACKENDS.has(prefs.backendId)) return prefs
	cache = { ...prefs, backendId: "opencode", backendModel: "" }
	void persist()
	return cache
}

export function getPrefs(): Prefs {
	return cache
}

export function getPref<K extends keyof Prefs>(key: K): Prefs[K] {
	return cache[key]
}

export async function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): Promise<void> {
	cache = { ...cache, [key]: value }
	await persist()
}

export async function setPrefs(patch: Partial<Prefs>): Promise<void> {
	cache = { ...cache, ...patch }
	await persist()
}

/** Moves `projectPath` to the front of the recents list. */
export async function recordRecentProject(projectPath: string): Promise<void> {
	const recents = [projectPath, ...cache.recentProjects.filter((p) => p !== projectPath)].slice(0, MAX_RECENTS)
	await setPref("recentProjects", recents)
}

export async function forgetRecentProject(projectPath: string): Promise<void> {
	await setPref(
		"recentProjects",
		cache.recentProjects.filter((p) => p !== projectPath),
	)
}

/**
 * Temp-then-rename, so a crash mid-write leaves the previous preferences intact
 * rather than a truncated file that fails to parse on next launch.
 */
async function persist(): Promise<void> {
	const target = resolvePath()
	const tmp = `${target}.tmp`
	await fsp.mkdir(path.dirname(target), { recursive: true })
	await fsp.writeFile(tmp, JSON.stringify(cache, null, 2), "utf-8")
	await fsp.rename(tmp, target)
}
