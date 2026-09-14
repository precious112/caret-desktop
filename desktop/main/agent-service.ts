/**
 * One project's coding backend, wired to its window.
 *
 * The design core owns the conversation and the permission rules; this is the
 * host half — where the backend comes from (preferences), what the system prompt
 * says (the project's own foundations), and where state goes (the chrome
 * renderer).
 *
 * Backend selection is deliberately **lazy and re-checked**: a user can install
 * a CLI, sign in, or change their mind between two turns, and a backend resolved
 * once at window open would keep refusing long after the reason was fixed.
 */
import {
	AgentConversation,
	type AppWritePolicy,
	BackendBridge,
	type CodingBackend,
	type ConversationState,
	discardSyncPlan,
	EditLaneBridge,
	type EditStatus,
	ExploreLane,
	type ExploreTakeStatus,
	getBackend,
	type RunOutcome,
	type RunRequest,
	runSyncApply,
	setProjectBridge,
	setProjectConversation,
	setProjectEditLane,
	setProjectExploreLane,
} from "../../src/core/design"
import { Logger } from "../../src/shared/services/Logger"
import { getPrefs, setPref } from "./prefs"
import { buildGuide } from "./rules/context"

export interface AgentServiceOptions {
	projectPath: string
	/** Pushes conversation state to the chrome renderer. */
	onState(state: ConversationState): void
	/** Narrates canvas-initiated edits to the canvas pill. */
	onEditStatus(status: EditStatus): void
	/** Narrates each playground take's generation to its card. */
	onExploreStatus(status: ExploreTakeStatus): void
	/**
	 * Fired when any lane's turn settles — the acceptance checker's hook. The
	 * conversation is passed so the checker can feed findings back into the very
	 * session that produced them.
	 */
	onTurnComplete?(conversation: AgentConversation, outcome: RunOutcome, request: RunRequest): void
}

export class AgentService {
	readonly conversation: AgentConversation
	/**
	 * Canvas-initiated edits, on their own conversation.
	 *
	 * Sharing the chat's conversation coupled the surfaces at their worst points:
	 * an AI edit mid-chat wiped the sidebar transcript (run() clears it on
	 * activity-kind change), and an edit's only live feedback lived in a panel
	 * the user wasn't looking at. The lanes share the backend, the permission
	 * rules, provenance and the session record — and no UI.
	 */
	private readonly editConversation: AgentConversation
	readonly editLane: EditLaneBridge
	/**
	 * Playground takes, each on its own throwaway conversation so a round runs
	 * in parallel. Takes are unattended and skip the acceptance checker — the
	 * settled page is checked by the normal flows that write it.
	 */
	readonly exploreLane: ExploreLane

	constructor(private readonly options: AgentServiceOptions) {
		this.conversation = new AgentConversation({
			projectPath: options.projectPath,
			resolveBackend: () => this.resolveBackend(),
			model: () => getPrefs().backendModel || undefined,
			effort: () => getPrefs().backendEffort || undefined,
			appWrites: () => this.appWrites(),
			setAppWrites: (policy) => this.setAppWrites(policy),
			systemPrompt: () => this.systemPrompt(),
			onChange: (state) => options.onState(state),
			onTurnComplete: (outcome, request) => options.onTurnComplete?.(this.conversation, outcome, request),
		})

		this.editLane = new EditLaneBridge(
			() => this.editConversation,
			() => this.conversation.getState().ready,
			(status) => options.onEditStatus(status),
		)
		this.editConversation = new AgentConversation({
			projectPath: options.projectPath,
			resolveBackend: () => this.resolveBackend(),
			model: () => getPrefs().backendModel || undefined,
			effort: () => getPrefs().backendEffort || undefined,
			appWrites: () => this.appWrites(),
			setAppWrites: (policy) => this.setAppWrites(policy),
			systemPrompt: () => this.systemPrompt(),
			onChange: (state) => this.editLane.handleState(state),
			onTurnComplete: (outcome, request) => options.onTurnComplete?.(this.editConversation, outcome, request),
		})

		this.exploreLane = new ExploreLane(
			(onChange) =>
				new AgentConversation({
					projectPath: options.projectPath,
					resolveBackend: () => this.resolveBackend(),
					model: () => getPrefs().backendModel || undefined,
					effort: () => getPrefs().backendEffort || undefined,
					appWrites: () => this.appWrites(),
					setAppWrites: (policy) => this.setAppWrites(policy),
					systemPrompt: () => this.systemPrompt(),
					onChange,
				}),
			() => this.conversation.getState().ready,
			(status) => options.onExploreStatus(status),
		)

		// The bridge is what every outbound feature already calls. Swapping the
		// implementation here is the whole of "route AgentBridge through the
		// backend" — no call site changes.
		setProjectBridge(options.projectPath, new BackendBridge(this.conversation, () => this.conversation.getState().ready))
		setProjectConversation(options.projectPath, this.conversation)
		setProjectEditLane(options.projectPath, this.editLane)
		setProjectExploreLane(options.projectPath, this.exploreLane)
	}

	async start(): Promise<void> {
		await this.conversation.refreshBackend()
	}

	/**
	 * Whether ANY lane is writing right now — chat, canvas edit, or playground
	 * takes. The healer's watcher asks this to attribute a file write: checking
	 * only the chat made every take's write read as an "external" hand-edit,
	 * polluting provenance and threatening the direct-write notice.
	 */
	isWorking(): boolean {
		return this.conversation.getState().streaming || this.editConversation.getState().streaming || this.exploreLane.busy()
	}

	/**
	 * The Plan/Act toggle's landing point, and where a flip becomes an approval.
	 *
	 * Flipping to Act with a settled plan IS the user saying "do it" — the
	 * semantics, chosen deliberately over an extra confirm button. The two
	 * guards that keep that safe both live in `settledPlan()`: it is null while
	 * a turn streams (a flip racing a turn's end can only change mode), and a
	 * plan only settles off a completed read-only turn with a real reply. In
	 * every other case the flip is a mode change and nothing more.
	 */
	setChatMode(mode: "read-only" | "write", steering?: string): { executed: boolean } {
		const conversation = this.conversation
		if (mode === "read-only") {
			conversation.setMode(mode)
			return { executed: false }
		}
		const plan = conversation.settledPlan()
		conversation.setMode("write")
		if (!plan) return { executed: false }
		if (plan.kind === "sync-plan") {
			// Long-lived, reports into the chat itself — same contract as the
			// sync orchestrator's fire-and-forget.
			void runSyncApply(conversation, { cwd: this.options.projectPath, steering })
		} else {
			void conversation.actOnPlan(steering)
		}
		return { executed: true }
	}

	/** The plan card's Discard. Sync plans also clear their pending record. */
	discardPlan(): void {
		const plan = this.conversation.settledPlan()
		if (plan?.kind === "sync-plan") {
			void discardSyncPlan(this.conversation, this.options.projectPath)
		} else {
			this.conversation.clearPlan()
		}
	}

	async close(): Promise<void> {
		// Take conversations close themselves as each run settles; cancelAll
		// waits for that, so nothing leaks past the window.
		await this.exploreLane.cancelAll()
		await this.conversation.close()
		await this.editConversation.close()
	}

	/**
	 * The configured backend, but only if it is actually ready.
	 *
	 * A backend that is installed and signed out is not a backend: returning it
	 * would turn a clear "sign in with this command" into a failed turn three
	 * minutes later.
	 */
	private async resolveBackend(): Promise<CodingBackend | null> {
		const id = getPrefs().backendId
		if (!id) return null

		const backend = getBackend(id)
		try {
			const report = await backend.availability()
			return report.ready ? backend : null
		} catch (err) {
			Logger.warn(`[agent] ${id} availability check failed: ${err}`)
			return null
		}
	}

	private appWrites(): AppWritePolicy {
		return getPrefs().appWritesAllowed.includes(this.options.projectPath) ? "allow" : "ask"
	}

	private async setAppWrites(policy: AppWritePolicy): Promise<void> {
		const current = getPrefs().appWritesAllowed
		const next =
			policy === "allow"
				? [...new Set([...current, this.options.projectPath])]
				: current.filter((path) => path !== this.options.projectPath)
		await setPref("appWritesAllowed", next)
	}

	/**
	 * Foundations, authoring rules and the asset index, straight into the system
	 * prompt.
	 *
	 * This is the capability BYO-agent could never have. The generated rules files
	 * still exist for external agents, but an agent Caret owns is not asked to
	 * *choose* to read them — the one failure mode that made pull-only context
	 * useless in the first place.
	 *
	 * Rebuilt per turn rather than cached: a token change between two turns has to
	 * reach the next one, and the build is a handful of small file reads.
	 */
	private async systemPrompt(): Promise<string | undefined> {
		try {
			return await buildGuide(this.options.projectPath, "embedded")
		} catch (err) {
			Logger.warn(`[agent] could not build the system prompt: ${err}`)
			return undefined
		}
	}
}
