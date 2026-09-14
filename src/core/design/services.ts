/**
 * Per-project service lookup.
 *
 * The host and the agent bridge were briefly module singletons, which is wrong
 * as soon as two projects are open: the second window to start would capture
 * both, and a notification raised while syncing project A would appear over
 * project B. Every call site already carries the project path, so services are
 * keyed by it.
 *
 * Lookups never fail. An unregistered project resolves to a null host (silent)
 * and a `NullBridge` (refuses honestly), which is also the correct behaviour for
 * headless runs and tests that only exercise the design core.
 */
import { type AgentBridge, NullBridge } from "./agent/bridge"
import type { AgentConversation } from "./agent/conversation"
import type { EditLaneBridge } from "./agent/edit-lane"
import type { ExploreLane } from "./agent/explore-lane"
import { type DesignHost, nullDesignHost } from "./host"

export interface ProjectServices {
	host: DesignHost
	bridge: AgentBridge
	/**
	 * The project's chat with its backend, when one is running.
	 *
	 * Sync needs more than the bridge's fire-and-forget: it runs a read-only plan,
	 * waits for the user to accept it, then applies — and it advances the sync
	 * bookmark in Caret's own code afterwards. All three need the conversation
	 * itself, not a task handed to it.
	 */
	conversation: AgentConversation | null
	/**
	 * Canvas-initiated AI work (visual edits, overlay edits), on its own
	 * conversation so it never touches the chat's transcript. Null on hosts that
	 * haven't wired one — `visual-edit` tasks then fall back to the chat bridge.
	 */
	editLane: EditLaneBridge | null
	/**
	 * The playground's take generation — parallel unattended conversations, one
	 * per take. Null on hosts that haven't wired one; the router then refuses
	 * with the backend-needed message.
	 */
	exploreLane: ExploreLane | null
}

const registry = new Map<string, ProjectServices>()
const fallback: ProjectServices = {
	host: nullDesignHost,
	bridge: new NullBridge(),
	conversation: null,
	editLane: null,
	exploreLane: null,
}

/** Installs the services for an open project. Called when its window opens. */
export function registerProjectServices(workspacePath: string, services: Partial<ProjectServices>): void {
	registry.set(workspacePath, { ...fallback, ...registry.get(workspacePath), ...services })
}

/** Removes a project's services. Called when its window closes. */
export function unregisterProjectServices(workspacePath: string): void {
	registry.delete(workspacePath)
}

export function hostFor(workspacePath: string): DesignHost {
	return registry.get(workspacePath)?.host ?? fallback.host
}

export function bridgeFor(workspacePath: string): AgentBridge {
	return registry.get(workspacePath)?.bridge ?? fallback.bridge
}

export function conversationFor(workspacePath: string): AgentConversation | null {
	return registry.get(workspacePath)?.conversation ?? null
}

/** Replaces just the bridge — a backend becoming available mid-session. */
export function setProjectBridge(workspacePath: string, bridge: AgentBridge): void {
	registerProjectServices(workspacePath, { bridge })
}

export function setProjectConversation(workspacePath: string, conversation: AgentConversation | null): void {
	registerProjectServices(workspacePath, { conversation })
}

export function editLaneFor(workspacePath: string): EditLaneBridge | null {
	return registry.get(workspacePath)?.editLane ?? null
}

export function setProjectEditLane(workspacePath: string, editLane: EditLaneBridge | null): void {
	registerProjectServices(workspacePath, { editLane })
}

export function exploreLaneFor(workspacePath: string): ExploreLane | null {
	return registry.get(workspacePath)?.exploreLane ?? null
}

export function setProjectExploreLane(workspacePath: string, exploreLane: ExploreLane | null): void {
	registerProjectServices(workspacePath, { exploreLane })
}
