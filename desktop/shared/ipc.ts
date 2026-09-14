/**
 * The IPC contract between the Electron main process and the app-chrome renderer.
 *
 * This replaces the extension↔webview gRPC-over-message-passing layer, which
 * existed only to cross the VS Code webview boundary. Electron IPC crosses the
 * same boundary natively, so the entire `proto/` + generated-client apparatus is
 * gone and this file is the whole interface.
 *
 * Types here are declared locally rather than imported from `src/core/design`.
 * That is deliberate: the design core is main-process code that touches the
 * filesystem and spawns processes, and a renderer that can `import` it is a
 * renderer that can be made to run it. Keeping the wire types structural means
 * the boundary is enforced by what is importable, not by remembering not to.
 */

/** Mirrors `FoundationTokens` in the design core. */
export interface FoundationTokensWire {
	vibe: { description: string; tags: string[] }
	color: {
		brand: { seed: string; scale: Record<string, string> }
		neutral: { character: string; scale: Record<string, string> }
		semantic: { success: string; warning: string; error: string; info: string }
	}
	typography: {
		fontFamily: string
		fallback: string
		scaleRatio: number
		baseSize: number
		scale: Record<string, number | string>
	}
	spacing: { baseUnit: number; scale: number[] }
	radius: { character: string; scale: number[] }
}

/** Mirrors `PageMeta` in the design core. */
export interface PageMetaWire {
	id: string
	title: string
	type: string
	states: string[]
	tags: string[]
}

/** Canvas → host, forwarded by the chrome. Mirrors `DesignInboundMessage`. */
export interface DesignInboundWire {
	source: "caret-vite"
	type: string
	payload: Record<string, unknown>
}

/** Host → canvas. Mirrors `DesignOutboundMessage`. */
export interface DesignOutboundWire {
	source: "caret-host"
	type: string
	payload: Record<string, unknown>
}

export interface ProjectSummary {
	/** Absolute path of the project root. */
	path: string
	/** Directory name, used as the display name. */
	name: string
	/** False when the path no longer exists on disk. */
	exists: boolean
	/** Whether the project already has a `.caret/` design layer. */
	hasDesignLayer: boolean
}

export interface ProjectState {
	path: string
	name: string
	/** Vite URL for the canvas, or null while booting / after a crash. */
	canvasUrl: string | null
	/** MCP endpoint an agent should be pointed at, or null if the server is down. */
	mcpUrl: string | null
	/** Whether an agent is currently connected over MCP. */
	agentConnected: boolean
	/** Whether foundation tokens have been set (gates the onboarding prompt). */
	hasFoundation: boolean
}

export type NotificationLevel = "info" | "warn" | "error"

export interface NotificationRequest {
	id: string
	level: NotificationLevel
	message: string
	actions: string[]
}

export interface AgentClientConfig {
	/** Display name, e.g. "Claude Code". */
	client: string
	/** What the user runs, or the file they paste into. */
	instruction: string
	/** The config snippet itself. */
	snippet: string
	/** Where the snippet goes, when it is a file. */
	targetPath?: string
}

/** A candidate rendered as something to look at, never as a list of values. */
export interface PresentedCandidateWire {
	id: string
	name: string
	summary: string
	fontUrl: string
	displayFamily: string
	displayFallback: string
	bodyFamily: string
	bodyFallback: string
	surface: "light" | "dark"
	brandColor: string
	neutralCharacter: string
	radius: number[]
	baseSize: number
}

export type InterviewPromptWire =
	| {
			kind: "question"
			id: string
			question: string
			hint?: string
			choices: string[]
			place?: "chat"
			step?: number
			total?: number
	  }
	| {
			kind: "options"
			id: string
			title: string
			subtitle?: string
			candidates: PresentedCandidateWire[]
			step?: number
			total?: number
	  }
	| {
			/** Takes of an asset the agent proposed. Pictures to point at, nothing more. */
			kind: "takes"
			id: string
			title: string
			subtitle?: string
			takes: Array<{ index: number; preview: string; error?: string }>
			surface: string
			place?: "chat"
			step?: number
			total?: number
	  }
	| {
			/**
			 * Existing assets offered as answers to a question. Rendered docked in
			 * the chat, never on the interview surface — the conversation this
			 * belongs to is happening in the sidebar, and yanking the user to
			 * Foundation for it would break the surface they were planning on.
			 */
			kind: "asset-options"
			id: string
			question: string
			why?: string
			options: AssetOptionWire[]
			step?: number
			total?: number
	  }

/**
 * Where a prompt renders — and therefore which surfaces react to it.
 *
 * Asset picks always dock in the chat; a question or takes prompt does too when
 * the tool that asked marked it `place: "chat"`. Everything else is the
 * foundation interview, which force-switches the user to Foundation and pins
 * them there until answered. Chat-placed prompts must trigger neither: asset
 * generation proposed mid-conversation belongs to the conversation, and
 * yanking the user to Foundation for it removes the canvas they were planning
 * against.
 */
export function landsInChat(prompt: InterviewPromptWire): boolean {
	return prompt.kind === "asset-options" || (prompt.kind !== "options" && prompt.place === "chat")
}

/** One asset, as a pickable option. URLs are Vite-relative like `AssetEntryWire`'s. */
export interface AssetOptionWire {
	tag: string
	url: string
	kind: string
	posterUrl: string | null
}

/**
 * The AI-run token wizard — the Foundation surface's default door.
 *
 * The model composes every question from a fixed widget vocabulary; these are
 * the wire mirrors of those shapes. The renderer's job is to have a real,
 * well-made component for each `kind`, including the escape hatches ("other"):
 * a colour picker + hex field + eyedropper on colour questions, Google Fonts
 * search on font questions, free text where the model allows it.
 */
export interface WizardSpecWire {
	displayFamily?: string
	bodyFamily?: string
	surface?: "light" | "dark"
	accent?: string
	neutral?: string
	radius?: number
	spacingUnit?: number
	baseSize?: number
	shadow?: string
}

export type WizardKindWire = "options" | "color" | "font" | "scale" | "chips" | "text" | "boolean" | "assumptions"

export interface WizardOptionWire {
	id: string
	label: string
	reason?: string
	hex?: string
	spec?: WizardSpecWire
}

export type WizardModeWire = "ai-led" | "collaborative"

export interface WizardQuestionWire {
	id: string
	kind: WizardKindWire
	question: string
	why?: string
	options?: WizardOptionWire[]
	recommendedId?: string
	/** Collaborative mode: the coverage areas this question settles. */
	covers?: string[]
	other?: "color" | "font" | "text"
	leftLabel?: string
	rightLabel?: string
	steps?: Array<{ label: string; spec?: WizardSpecWire }>
	defaultStep?: number
	placeholder?: string
	multiline?: boolean
}

export interface WizardAnswerWire {
	questionId: string
	question: string
	kind: WizardKindWire
	value: string
	label?: string
	wasOther?: boolean
	/** Typed payload written by the widget at capture — see core `AnswerData`. */
	data?: { hex?: string; family?: string; px?: number; ratio?: number; none?: boolean }
	skipped?: boolean
}

export interface WizardQAWire {
	question: WizardQuestionWire
	answer: WizardAnswerWire
}

export interface FoundationProposalWire {
	displayFamily: string
	displayFallback?: string
	bodyFamily: string
	bodyFallback?: string
	scaleRatio: number
	baseSize: number
	brand: string
	secondary?: string
	accent?: string
	neutral: "warm" | "cool" | "true" | "slight-tint"
	surface: "light" | "dark"
	semantic?: { success?: string; warning?: string; error?: string; info?: string }
	spacingUnit: number
	radiusCharacter: "sharp" | "soft" | "round" | "pill"
	elevationCharacter?: "flat" | "subtle" | "pronounced"
	displayWeight?: number
	bodyWeight?: number
	rule: string
	vibeTags?: string[]
	summary: string
	decisions?: Array<{ area: string; choice: string; reason: string }>
}

/** Collaborative mode's checklist, for the coverage rail. */
export interface WizardCoverageWire {
	done: Array<{ id: string; label: string }>
	missing: Array<{ id: string; label: string }>
}

export type WizardStateWire =
	| { phase: "needs-backend"; detail: string }
	| { phase: "describe"; description: string }
	| {
			phase: "question"
			mode: WizardModeWire
			description: string
			current: WizardQuestionWire
			/** Questions answered so far, and the hard cap — for "question 3". */
			asked: number
			cap: number
			history: WizardQAWire[]
			/** Present only in collaborative mode. */
			coverage?: WizardCoverageWire
	  }
	| {
			phase: "finish"
			mode: WizardModeWire
			description: string
			proposal: FoundationProposalWire
			name: string
			rule: string
			summary: string
			history: WizardQAWire[]
	  }
	| { phase: "error"; description: string; message: string; canFinish: boolean }

/**
 * The coding backend Caret drives, as the renderer sees it.
 *
 * Structural mirrors of the core types, like every other `*Wire` here, so a
 * renderer import of main-process code stays a compile error.
 */
export type BackendIdWire = "opencode"

export interface BackendReportWire {
	id: BackendIdWire
	displayName: string
	/** Who serves this backend's models, for ids that do not say so themselves. */
	providerName: string
	installed: boolean
	authenticated: boolean
	ready: boolean
	detail: string
	remedy?: { label: string; command?: string; url?: string }
}

export type TranscriptEntryWire =
	| { kind: "user"; id: string; text: string }
	/** `plan` marks the reply of a completed plan-mode turn; the LIVE one is named by `AgentStateWire.plan.entryId`. */
	| { kind: "assistant"; id: string; text: string; plan?: boolean }
	| { kind: "thinking"; id: string; text: string }
	| { kind: "tool"; id: string; callId: string; name: string; summary: string; status: "running" | "ok" | "failed" }
	| {
			kind: "permission"
			id: string
			requestId: string
			summary: string
			status: "pending" | "allowed" | "denied"
			automatic?: string
	  }
	| { kind: "error"; id: string; message: string }
	| { kind: "note"; id: string; text: string }

export interface AgentStateWire {
	backendId: BackendIdWire | null
	backendName: string | null
	providerName: string | null
	ready: boolean
	blocked: string | null
	activity: { id: string; kind: string; title: string; mode: "read-only" | "write"; sessionId: string } | null
	streaming: boolean
	/** When the backend last said anything during this turn. Null outside one. */
	lastEventAt: number | null
	transcript: {
		entries: TranscriptEntryWire[]
		files: string[]
		usage: { inputTokens: number; outputTokens: number; costUsd: number }
	}
	/** The conversation's Plan/Act position — the composer toggle reads this. */
	mode: "read-only" | "write"
	/** The settled plan's card: which transcript entry it is, and which continuation a flip runs. */
	plan: { kind: string; entryId: string } | null
	appWrites: "ask" | "allow"
	model: string | null
	effort: string | null
}

/** A model and who serves it. Providers are the categories; models are the items. */
export interface ModelGroupWire {
	providerId: string
	providerName: string
	models: Array<{ id: string; label: string; free?: boolean; contextTokens?: number; seesImages?: boolean }>
	/** A plan already paid for. Its models cost nothing per token, but are not free. */
	subscription?: boolean
}

/** A provider worth offering that this machine is not signed in to. */
export interface ProviderDoorWire {
	id: string
	name: string
	methods: Array<{ id: string; kind: "oauth" | "api-key"; label: string }>
	subscription: boolean
	/** A few of the models it would put within reach, newest first. */
	sample: string[]
}

/** What is left to do after a sign-in starts. */
export interface OauthChallengeWire {
	url: string
	instructions?: string
	needsCode: boolean
}

export interface AgentSessionWire {
	id: string
	title: string
	updatedAt: number
}

export interface SyncOutcome {
	status: string
	message: string
}

export interface WriteResult {
	ok: boolean
	error?: string
}

export interface FontOptionWire {
	family: string
	category: string
	variants: string[]
}

export interface FontSearchResultWire {
	fonts: FontOptionWire[]
	/** "google-fonts" is the full catalogue; "bundled" means offline, 20 fonts. */
	source: "google-fonts" | "bundled"
}

/**
 * An asset as the renderer sees it.
 *
 * A structural mirror rather than the core type, like every other `*Wire` here,
 * so a renderer import of main-process code stays a compile error.
 */
/**
 * An image attached to one chat message, for the model to look at.
 *
 * Deliberately not an asset: it is never copied into `.caret/`, never tagged,
 * and does not survive the turn. The library is for things the design is built
 * from; this is for things the conversation is about.
 */
export interface ComposerImage {
	name: string
	/** `data:image/png;base64,…` — the only form the agent bridge accepts. */
	dataUrl: string
}

export interface AssetEntryWire {
	tag: string
	file: string
	url: string
	kind: "image" | "vector" | "video" | "model"
	mime: string
	width: number | null
	height: number | null
	bytes: number
	alt: string
	description: string
	origin: string
	addedAt: string
	/** URL of the extracted poster frame, for kinds that cannot show themselves. */
	posterUrl: string | null
	/** The full provenance record, for assets a lane produced. */
	generated?: GeneratedProvenanceWire
}

/**
 * Everything `index.json` recorded about how a generated asset came to be.
 *
 * The library shows this behind the "generated" chip — provenance the plan
 * calls "complete and honest" is not honest while the UI reduces it to one
 * word and reading the record means opening a JSON file.
 */
export interface GeneratedProvenanceWire {
	lane: string
	/** Model id, generator id, or icon-set name. */
	producer: string
	recipeId?: string
	answers?: Record<string, string>
	/** The fully resolved request — a prompt as sent, or a parameter set. */
	resolved?: string
	postProcessed?: {
		from: { bytes: number; mime: string }
		to: { bytes: number; mime: string; width: number; height: number }
	}
	/** In the provider's own meter (tokens or credits), never a currency. */
	cost?: {
		unit: string
		amount: number
		round?: { calls: number; amount: number }
		note?: string
	}
}

export interface SecretStatusWire {
	/** False when the OS offers no keychain — storing is refused, not downgraded. */
	available: boolean
	present: boolean
	reason?: string
}

export interface AssetAddResult {
	added: string[]
	/** Files that could not be added, each with a reason the user can act on. */
	rejected: Array<{ file: string; reason: string }>
}

/** What the user is generating, chosen before they describe it. */
export type GenerationKindWire = "image" | "texture" | "mark" | "object3d" | "shader"

/** What the user asked for, on its way to main. */
export interface AssetRequestWire {
	kind: GenerationKindWire
	/**
	 * The brief the takes are generated from. Opens as the user's own words;
	 * after the rebuild stage it is the polished brief they saw, and possibly
	 * edited, in the prompt box — never something rewritten out of their sight.
	 */
	text: string
	transparent?: boolean
	answers?: Record<string, string>
	/**
	 * Tag of a saved image to borrow light and grade from, chosen by the user
	 * from a picker of the project's own photos. Resolved from the asset index
	 * on disk, so the choice works in any session — the first version held the
	 * anchor in main-process memory and it silently vanished on every restart.
	 */
	styleAnchor?: string
}

/** One question Caret decided it needed to ask about this particular request. */
export interface ClarifyQuestionWire {
	id: string
	question: string
	/** What it changes about the result. A question without one is answered badly. */
	why: string
	/** Fast paths only — the answer is always free text if the user wants. */
	suggestions: string[]
}

export interface ClarifyResultWire {
	sufficient: boolean
	questions: ClarifyQuestionWire[]
}

/** One question in the generation interview, mirrored for the renderer. */
export interface GenerationQuestionWire {
	id: string
	question: string
	why: string
	choices: Array<{ id: string; label: string; hint: string }>
}

/**
 * A recipe as the picker sees it, carrying its own specimen.
 *
 * The specimen is the recipe rendered against *this project's* foundation, not
 * a stock thumbnail: the whole claim of the library is that a recipe produces
 * something that belongs to your project, and a card that shows somebody else's
 * palette is arguing the opposite.
 */
export interface RecipeCardWire {
	id: string
	name: string
	use: string
	kind: string
	lane: string
	aspects: string[]
	/** An inline `data:` URL of variant 0, ready for an `<img>`. */
	specimen: string
	/**
	 * The project's own surface colour, to put *behind* the specimen.
	 *
	 * Load-bearing rather than decorative. Several recipes are transparent by
	 * design — an overlay, a halftone, a grid — and rendered against the chrome's
	 * near-black they show nothing at all: the picker offered four options and
	 * two of them looked like empty cards. The backdrop is also the only honest
	 * preview, since what the user is choosing is how this looks *on their page*.
	 */
	surface: string
	transparent: boolean
	/**
	 * Set when this recipe's lane cannot run here — a photograph with no key.
	 *
	 * Carried on the card rather than filtered out of the list, so the picker can
	 * show what it *would* offer and say what is missing. Silently having fewer
	 * options than the library does is the version of this that teaches the user
	 * nothing.
	 */
	unavailable?: string
}

/**
 * Progress from a long-running generation job.
 *
 * Marks and 3D are not variant lanes — one result, minutes of waiting — so the
 * renderer cannot sit on a spinner and call it feedback. The mark loop streams
 * each round's render as it happens, which turns the wait into the one thing
 * worth watching: the model correcting its own work.
 */
export interface GenerateProgressWire {
	job: "mark" | "model3d" | "shader"
	/** Short, present-tense, for the status line. */
	stage: string
	detail?: string
	/** Mark rounds only: which round, and what it rendered. */
	round?: number
	preview?: string
}

/** What the mark loop came back with. The SVG stays in main until accepted. */
export interface MarkOutcomeWire {
	ok: boolean
	/** Preview of the final round, as a data URL. */
	preview?: string
	rounds?: number
	model?: string
	reason?: string
	/** True when the fix is picking a model that accepts images. */
	needsAnotherModel?: boolean
}

/** What the shader loop came back with. The GLSL stays in main until accepted. */
export interface ShaderOutcomeWire {
	ok: boolean
	/** Frames at the critique timestamps, as data URLs — the picker's strip. */
	frames?: string[]
	/**
	 * The fragment body, so the chrome can RUN the animation live — three
	 * static stills of a thing whose whole point is motion was the field
	 * complaint that added this.
	 */
	fragment?: string
	/** The full knob manifest, so the chrome renders real controls, not a caption. */
	knobs?: Array<{ name: string; label: string; type: "float" | "color"; default: number | string; min?: number; max?: number }>
	/** Luminance spread of the final render — the anti-timidity number. */
	range?: { min: number; max: number }
	rounds?: number
	model?: string
	reason?: string
	/** True when the fix is picking a model that accepts images. */
	needsAnotherModel?: boolean
}

/** What the 3D pipeline came back with. The glb stays in main until accepted. */
export interface Model3dOutcomeWire {
	ok: boolean
	/** Bytes before and after the shrink pass. */
	draftBytes?: number
	optimizedBytes?: number
	/** How the final bytes were produced, in plain words (compression, or convert + compression). */
	model?: string
	reason?: string
	needsAnotherModel?: boolean
	/** The source failed verification — the fix is a different image, not a retry. */
	badSource?: boolean
}

/** A backend model annotated for a specific task's picker. */
export interface TaskModelWire {
	id: string
	label: string
	providerName: string
	free?: boolean
	/** In the named-recommended set for this task. */
	recommended?: boolean
}

/** One generated option, ready to be looked at and picked. */
export interface GeneratedVariantWire {
	variant: number
	/** Inline `data:` URL. Nothing is written to disk until the user picks. */
	preview: string
	width: number
	height: number
	/** As on `RecipeCardWire`, and for the same reason. */
	surface: string
	/**
	 * The design approach this option explores, when the lane varies it (mark
	 * targets do). Shown on the card: three named design decisions beat three
	 * anonymous pictures.
	 */
	direction?: string
	/** Set when this variant could not be produced. The lane's own words. */
	error?: string
	/**
	 * With `error`: true means the service was exhausted (quota) after the
	 * client spent its whole retry budget — re-running later can work. False
	 * or absent means retrying would only repeat the refusal.
	 */
	retryable?: boolean
}

/** Renderer → main. Each entry is an `ipcRenderer.invoke` channel. */
export interface IpcRequests {
	"project:pickFolder": () => string | null
	"project:open": (projectPath: string) => ProjectState | null
	"project:close": (projectPath: string) => void
	"project:recents": () => ProjectSummary[]
	"project:forgetRecent": (projectPath: string) => void
	"project:state": (projectPath: string) => ProjectState | null

	"tokens:read": (projectPath: string) => FoundationTokensWire | null
	"tokens:write": (projectPath: string, tokens: FoundationTokensWire) => WriteResult
	/**
	 * How far a foundation change reaches: colour-utility uses of any defined
	 * token across the design layer. Shown before a re-run so "restyles what
	 * already exists" is a number rather than a vibe.
	 */
	"tokens:blastRadius": (projectPath: string) => { occurrences: number; files: number }
	"tokens:generateScale": (
		type: "color" | "typography" | "spacing" | "radius",
		seed: string,
		options?: Record<string, unknown>,
	) => Record<string, string>
	"fonts:search": (query: string) => FontSearchResultWire

	"pages:list": (projectPath: string) => PageMetaWire[]

	"assets:list": (projectPath: string) => AssetEntryWire[]
	/**
	 * Copies files into `.caret/assets/`. Paths come from a drop or a native
	 * dialog, so main does the copying — the renderer never touches the disk.
	 */
	"assets:add": (projectPath: string, sourcePaths: string[]) => AssetAddResult
	/**
	 * The same, for dropped files that have no path on disk — an image dragged
	 * out of a browser or a mail client carries bytes and a name, nothing more.
	 */
	"assets:addBytes": (projectPath: string, files: Array<{ name: string; base64: string }>) => AssetAddResult
	"assets:retag": (projectPath: string, from: string, to: string) => WriteResult
	"assets:describe": (projectPath: string, tag: string, fields: { alt?: string; description?: string }) => WriteResult
	"assets:remove": (projectPath: string, tag: string) => WriteResult
	/**
	 * Stores a poster frame the library extracted from a video.
	 *
	 * The renderer is the only place a video frame exists as pixels without
	 * shipping ffmpeg, so it captures and main persists. `dataUrl` is a PNG data
	 * URL of a single decoded frame.
	 */
	"assets:setPoster": (projectPath: string, tag: string, dataUrl: string) => WriteResult
	/** Opens a native file picker filtered to supported asset types. */
	"assets:pickFiles": () => string[]

	/**
	 * Drops photographs that were generated and never chosen.
	 *
	 * Only the raster lane holds anything: a model's output cannot be recomposed
	 * from a seed, so the bytes have to survive between "show me options" and
	 * "I'll take that one". They live in memory, not in `.caret/` — an option
	 * nobody picked is not a decision, and writing it there would make it look
	 * like one.
	 */
	"generate:discard": (projectPath: string) => void
	/** The generation interview's questions. Caret owns these; no model invents them. */
	"generate:questions": () => GenerationQuestionWire[]
	/**
	 * Recipes that fit the answers, each rendered against the project's own
	 * foundation. Free and synchronous for the generator lane — a recipe card is
	 * an integer's worth of work, which is why the picker can afford to be honest
	 * and show the thing itself rather than a stock preview.
	 */
	"generate:recipes": (projectPath: string, answers: Record<string, string>, kind?: string) => RecipeCardWire[]
	/** N variants of one recipe. Still nothing on disk. */
	"generate:variants": (
		projectPath: string,
		recipeId: string,
		answers: Record<string, string>,
		aspect: string,
		count: number,
	) => GeneratedVariantWire[]
	/**
	 * Runs the mark loop: emit SVG, render, show the model its own work, correct.
	 *
	 * Awaited for the whole run — progress arrives on `generate:progress`. The
	 * subject is a fact ("a compass rose"), not a style prompt; everything about
	 * how it should look is composed by Caret from the foundation.
	 */
	/**
	 * Target candidates for a mark — the taste stage. The user iterates here
	 * (takes + refine-by-note); the trace loop then reproduces the pick.
	 */
	"generate:markTargets": (projectPath: string, subject: string) => GeneratedVariantWire[]
	"generate:markTargetRefine": (
		projectPath: string,
		sourceVariant: number,
		note: string,
		newVariant: number,
	) => GeneratedVariantWire
	/** Runs the trace loop against the held target `targetVariant` picked above. */
	"generate:mark": (projectPath: string, subject: string, targetVariant?: number) => MarkOutcomeWire
	/** Commits the held mark. Main holds the SVG; the renderer never carries it. */
	"generate:markAccept": (projectPath: string, tag: string) => WriteResult & { tag?: string }

	/**
	 * Image → 3D through Tripo, then an LLM-directed optimization pass.
	 *
	 * `sourceTag` names an image asset already in the library — uploaded or
	 * generated, both are assets by the time this runs, so one picker covers
	 * both. The LLM never touches mesh bytes: it reads the draft's stats and the
	 * intended use and decides the convert parameters, inside a bounded schema.
	 */
	"generate:model3d": (projectPath: string, sourceTag: string) => Model3dOutcomeWire
	"generate:model3dAccept": (projectPath: string, tag: string) => WriteResult & { tag?: string }

	/**
	 * The backend's models, annotated for a task's picker.
	 *
	 * `recommended` marks the named set for that task — matched against what the
	 * backend actually reports, never a hardcoded id list that goes stale.
	 */
	"generate:taskModels": (task: "mark" | "model3d" | "shader") => TaskModelWire[]
	/** Per-task model override. Empty string clears back to the session model. */
	"generate:setTaskModel": (task: "mark" | "model3d" | "shader", model: string) => void

	/**
	 * Runs the shader loop: the model writes GLSL against Caret's scaffold,
	 * Caret compiles it, bounces compile errors and flat renders back, then
	 * shows the model its own frames. Awaited for the whole run — progress
	 * arrives on `generate:progress` with job "shader". The request carries the
	 * user's words and their clarify answers; the GLSL stays in main until
	 * accepted, when it becomes a component in `.caret/components/shaders/`
	 * plus a poster asset.
	 */
	"generate:shader": (projectPath: string, request: AssetRequestWire) => ShaderOutcomeWire
	/**
	 * Re-enters the authoring loop on the HELD shader with the user's note —
	 * an edit of the current GLSL, not a rewrite from scratch. The result
	 * replaces the held shader.
	 */
	"generate:shaderRefine": (projectPath: string, note: string) => ShaderOutcomeWire
	/** `tuned` carries knob values the user set in the live preview; they become the component's defaults. */
	"generate:shaderAccept": (
		projectPath: string,
		tag: string,
		tuned?: Record<string, number | string>,
	) => WriteResult & { tag?: string; componentPath?: string }

	/**
	 * Whether the request needs anything more before it is worth spending on.
	 *
	 * The user has already said what they want; this decides whether that is
	 * enough. Questions come back tailored to what was asked, because the useful
	 * question for a paperclip has nothing in common with the useful question for
	 * a building. A backend that cannot answer means "generate anyway" — this
	 * improves a request, it is not permission to make one.
	 */
	"generate:clarify": (projectPath: string, request: AssetRequestWire) => ClarifyResultWire
	/**
	 * The rebuild stage: request + clarify answers → the brief a professional
	 * would have written, per-kind. Lands in the editable prompt box so the
	 * user reads, edits and owns it before anything generates. Null means
	 * "skip the step and use the words as typed" — never a blocked user.
	 */
	"generate:refineBrief": (projectPath: string, request: AssetRequestWire) => { prompt: string } | null
	/** Three takes of the thing the user asked for. Same subject, different treatment. */
	"generate:takes": (projectPath: string, request: AssetRequestWire, aspect: string) => GeneratedVariantWire[]
	/** Commits the take the user pointed at, with their own words kept in provenance. */
	"generate:acceptTake": (
		projectPath: string,
		request: AssetRequestWire,
		aspect: string,
		variant: number,
		tag: string,
	) => WriteResult & { tag?: string }
	/**
	 * One refined take: the picked take goes back as the REFERENCE image with
	 * the note as the edit instruction — iteration, not another roll of the
	 * dice. `newVariant` is renderer-chosen and unique across rounds so the
	 * refined result coexists with every earlier take in the pending store.
	 */
	"generate:refineTake": (
		projectPath: string,
		request: AssetRequestWire,
		aspect: string,
		sourceVariant: number,
		note: string,
		newVariant: number,
	) => GeneratedVariantWire

	/** Commits the chosen variant as an ordinary asset, with its provenance. */
	"generate:accept": (
		projectPath: string,
		recipeId: string,
		answers: Record<string, string>,
		aspect: string,
		variant: number,
		tag: string,
	) => WriteResult & { tag?: string }

	"sync:now": (projectPath: string) => SyncOutcome
	"sync:rollback": (projectPath: string) => SyncOutcome
	"sync:markSynced": (projectPath: string) => SyncOutcome

	"agent:clientConfigs": (projectPath: string) => AgentClientConfig[]

	/** Everything the chat sidebar renders. Also pushed on the `agent:state` event. */
	"agent:state": (projectPath: string) => AgentStateWire | null
	/**
	 * `images` are data-URLs the model should look at but that are not part of the
	 * design — a reference the user is describing, a screenshot of a bug. Anything
	 * meant to end up *in* the page belongs in the asset library and is named with
	 * `@` instead, which is a different act and stays a different control.
	 */
	"agent:send": (projectPath: string, text: string, images?: string[]) => void
	/** Opens a picker and reads the choices; nothing reaches disk, they only get looked at. */
	"chat:pickImages": () => ComposerImage[]
	"agent:abort": (projectPath: string) => void
	"agent:permission": (projectPath: string, requestId: string, decision: "allow" | "deny" | "allow-always") => void
	/**
	 * The Plan/Act toggle. Flipping to "write" with a settled plan starts
	 * executing it — `steering` is the composer draft at flip time, the user's
	 * last word on how to proceed. `executed` says whether that happened, so
	 * the composer only clears the draft it actually spent.
	 */
	"agent:setMode": (projectPath: string, mode: "read-only" | "write", steering?: string) => { executed: boolean }
	/** The plan card's Discard. Sync plans also clear their pending record. */
	"agent:discardPlan": (projectPath: string) => void
	"agent:reset": (projectPath: string) => void
	/** Availability of every backend, for the setup screen. Probed live. */
	"agent:backends": () => BackendReportWire[]
	"agent:selectBackend": (id: BackendIdWire | null) => void
	/** Models the chosen backend can reach, grouped by provider. Empty = it cannot say. */
	"agent:models": () => ModelGroupWire[]
	"agent:providerDoors": () => ProviderDoorWire[]
	/**
	 * Whether a model will answer at all, in one trivial turn.
	 *
	 * Null means it answered. A string is the provider's own refusal — a plan that
	 * does not cover it, a model retired from a free tier — which is a thing the
	 * catalogue cannot know and the user should not discover three minutes into a
	 * turn.
	 */
	"agent:probeModel": (projectPath: string, model: string) => string | null
	/**
	 * Connects a provider. A key connects it outright; an OAuth method returns
	 * what the user has to do next, and Caret opens the URL for them.
	 */
	"agent:connectProvider": (
		providerId: string,
		methodId: string,
		key?: string,
	) => { ok: true; challenge: OauthChallengeWire | null } | { ok: false; error: string }
	"agent:completeOauth": (providerId: string, methodId: string, code: string) => { ok: boolean; error?: string }
	/** Polled while a browser sign-in is out: finished, failed, or still going. */
	"agent:oauthStatus": (providerId: string) => { connected: boolean; failure?: string }
	"agent:disconnectProvider": (providerId: string) => boolean
	"agent:sessions": (projectPath: string) => AgentSessionWire[]
	"agent:replay": (projectPath: string, sessionId: string) => boolean
	/** Deletes one past session and its transcript from the backend, permanently. */
	"agent:deleteSession": (projectPath: string, sessionId: string) => void

	"prefs:get": () => Record<string, unknown>
	"prefs:set": (patch: Record<string, unknown>) => void
	/** Fire-and-forget renderer telemetry; names outside RENDERER_EVENTS are dropped main-side. */
	"analytics:event": (name: string, props?: Record<string, unknown>) => void

	/**
	 * Whether a credential is set, and whether this machine can store one.
	 *
	 * Deliberately not a getter for the value. The renderer never needs the key
	 * itself, and one that can be read into a web context is one a compromised
	 * renderer can send somewhere.
	 */
	"secrets:status": (name: string) => SecretStatusWire
	"secrets:set": (name: string, value: string) => WriteResult
	"secrets:clear": (name: string) => void

	"canvas:message": (projectPath: string, message: DesignInboundWire) => void
	/**
	 * How much room the chrome occupies around the canvas view.
	 *
	 * Layout authority stays in the renderer, which is the only place that knows
	 * how tall the top bar is or whether the chat sidebar is open — main cannot
	 * measure a DOM it does not own.
	 */
	"canvas:setBounds": (projectPath: string, insets: { top: number; right: number }) => void
	/** Parks the canvas off-screen while the chrome shows a full-window surface. */
	"canvas:setVisible": (projectPath: string, visible: boolean) => void

	/** Answers a `notify` prompt raised by main. */
	"notification:respond": (id: string, action: string | null) => void
	/** Answers an interview question or option set. Null means the user skipped. */
	"interview:respond": (id: string, answer: string | null) => void
	/** The full curated library, for the no-agent path. */
	"interview:library": () => unknown
	/** Whatever prompt is waiting, so a late-mounting renderer can recover it. */
	"interview:pending": () => InterviewPromptWire | null

	/**
	 * The in-app interview Caret runs itself.
	 *
	 * Request/response rather than pushed state: each step costs a real model
	 * call, so the renderer asking for one is what keeps a re-render from
	 * spending the user's quota.
	 */
	"wizard:resume": (projectPath: string) => WizardStateWire | null
	"wizard:start": (projectPath: string, description: string, mode: WizardModeWire) => WizardStateWire
	"wizard:answer": (projectPath: string, answer: WizardAnswerWire) => WizardStateWire
	/** "Just finish" — the model constructs from whatever has been answered. */
	"wizard:finishNow": (projectPath: string) => WizardStateWire
	/** Re-runs a failed turn without recording a new answer. */
	"wizard:retry": (projectPath: string) => WizardStateWire
	"wizard:back": (projectPath: string) => WizardStateWire
	"wizard:commit": (projectPath: string) => { name: string; rule: string }
	"wizard:abandon": (projectPath: string) => void
}

/** Main → renderer. Each entry is an `ipcRenderer.on` channel. */
export interface IpcEvents {
	"project:stateChanged": (state: ProjectState) => void
	"canvas:message": (projectPath: string, message: DesignOutboundWire) => void
	"notification:show": (request: NotificationRequest) => void
	"interview:prompt": (prompt: InterviewPromptWire) => void
	/** Wizard retry heartbeat: the UI stays on loading until attempts are spent. */
	"wizard:progress": (progress: { projectPath: string; attempt: number; max: number }) => void
	/** The asset index changed — by the UI, an agent, or a file dropped in Finder. */
	"assets:changed": (projectPath: string) => void
	/** An exploration opened or resolved — the Canvas button badges while one is open. */
	"explore:open-changed": (projectPath: string, open: boolean) => void
	/** The chat moved on: a token streamed, a permission was raised, a turn ended. */
	"agent:state": (projectPath: string, state: AgentStateWire) => void
	/** A long-running generation job (mark loop, 3D pipeline) moved a step. */
	"generate:progress": (projectPath: string, update: GenerateProgressWire) => void
	log: (line: string) => void
}

export type IpcRequestChannel = keyof IpcRequests
export type IpcEventChannel = keyof IpcEvents

/** The API the preload script exposes on `window.caret`. */
export interface CaretBridge {
	invoke<C extends IpcRequestChannel>(
		channel: C,
		...args: Parameters<IpcRequests[C]>
	): Promise<Awaited<ReturnType<IpcRequests[C]>>>
	on<C extends IpcEventChannel>(channel: C, listener: IpcEvents[C]): () => void
	platform: NodeJS.Platform
	/**
	 * The real disk path behind a dropped `File`, or "" when there isn't one.
	 *
	 * Electron removed `File.path` in v32, and this app runs 33 — reading it
	 * yields `undefined`, so a drop looked like it worked and copied nothing.
	 * `webUtils.getPathForFile` is the replacement, and it can only be called
	 * from the preload, which is why it rides on the bridge rather than living
	 * in the view.
	 */
	pathForFile(file: File): string
}
