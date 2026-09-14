/**
 * App→design proposals — the reverse half of the sync loop, Phase 9.4.
 *
 * When an app file drifts from its design (someone edited the app directly),
 * the design layer is lying about that page. The fix is agent-mediated and its
 * quality varies, so it NEVER writes the design silently: the agent translates
 * the app's current truth back into a proposal page, and the user reviews it
 * on the same playground surface every exploration uses — the current design
 * and the proposal rendered side by side, chosen by pointing. Accepting applies
 * the proposal through the normal variant-apply path and refreshes the sync
 * mapping (both hashes re-recorded, so the entry reads clean); discarding
 * leaves the drift standing and honestly reported.
 */
import { Logger } from "@/shared/services/Logger"

import { ExploreCancelledError } from "../agent/explore-lane"
import { bridgeFor, editLaneFor, exploreLaneFor } from "../services"
import { createExploration, updateNodeStatus } from "../variants"
import { computeDrift } from "./drift"
import { readManifest } from "./mapping-manifest"

export interface ReverseSyncStart {
	ok: boolean
	reason?: string
	/** The proposal take's page id, when started. */
	proposalId?: string
}

/** `.caret/pages/<id>/index.tsx` → `<id>`; null for non-page design files. */
export function pageIdOf(designPath: string): string | null {
	const match = /^\.caret\/pages\/([^/]+)\/index\.tsx$/.exec(designPath)
	return match ? match[1] : null
}

function buildProposalPrompt(pageId: string, proposalId: string, appPaths: string[]): string {
	return `The app files below were changed directly, AFTER they were last translated from the design
page "${pageId}". The design layer no longer tells the truth about this page, and your job is to
bring the DESIGN back in line with the APP — the reverse of a normal sync.

App files (the current truth):
${appPaths.map((p) => `- ${p}`).join("\n")}

Read them, read the current design page (.caret/pages/${pageId}/index.tsx), and rewrite the
PROPOSAL page at .caret/pages/${proposalId}/index.tsx so it reflects what the app actually
renders now. This is a proposal the user reviews side-by-side against the current design —
write only the proposal page, never the original.

Rules for the translation back:
- Keep the design layer's conventions: Tailwind classes bound to foundation tokens where the
  app's values match a token, data-caret-id attributes preserved for content that survives.
- Reflect the app's CONTENT and LOOK faithfully — the point is truth, not improvement. Do not
  editorialize or "fix" the app's choices.
- If part of the app change cannot be expressed in the design page (backend logic, framework
  glue), reflect its visible result and leave the mechanics out.`
}

/**
 * Starts a reverse-sync proposal for one drifted design file. Fire-and-forget
 * beyond the returned start status: the take streams in behind the compare
 * surface exactly like a variant run, and the pick/discard is the user's.
 */
export async function startReverseSyncProposal(workspacePath: string, designPath: string): Promise<ReverseSyncStart> {
	const pageId = pageIdOf(designPath)
	if (!pageId) {
		return { ok: false, reason: `${designPath} is not a page — only pages have a visual proposal surface (yet)` }
	}

	const manifest = await readManifest(workspacePath)
	const entry = manifest.entries.find((e) => e.designPath === designPath)
	if (!entry) {
		return { ok: false, reason: `${designPath} has no recorded mapping — nothing to reverse-sync from` }
	}

	const drift = await computeDrift(workspacePath)
	const classified = drift.entries.find((e) => e.designPath === designPath)
	if (!classified || (classified.classification !== "app-drift" && classified.classification !== "conflict")) {
		return { ok: false, reason: `${designPath} shows no app-side drift — nothing to propose` }
	}

	const lane = exploreLaneFor(workspacePath)
	const fallback = editLaneFor(workspacePath) ?? bridgeFor(workspacePath)
	if (!(lane ? lane.connected() : fallback.connected())) {
		return { ok: false, reason: "Reverse sync needs a coding backend — open Settings → Backend to connect one." }
	}

	let proposalId: string
	try {
		const exploration = await createExploration(workspacePath, {
			pageId,
			instruction: `app drift: ${classified.changedAppPaths.join(", ")}`,
			count: 1,
			kind: "drift-proposal",
			proposalAppPaths: entry.appPaths,
			label: "App's version",
		})
		proposalId = exploration.nodes[0].id
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err) }
	}

	void (async () => {
		const task = {
			kind: "visual-edit" as const,
			prompt: buildProposalPrompt(pageId, proposalId, entry.appPaths),
			displayPrompt: `Reverse sync: bring "${pageId}" in line with the app`,
			context: { filePath: `.caret/pages/${proposalId}/index.tsx` },
			unattended: true,
		}
		try {
			if (lane) await lane.run(proposalId, task)
			else await fallback.request(task)
			await updateNodeStatus(workspacePath, proposalId, "ready")
		} catch (err) {
			if (err instanceof ExploreCancelledError) {
				await updateNodeStatus(workspacePath, proposalId, "cancelled")
				return
			}
			const message = err instanceof Error ? err.message : String(err)
			Logger.warn(`[reverse-sync] proposal turn failed for ${pageId}: ${message}`)
			await updateNodeStatus(workspacePath, proposalId, "failed", message)
		}
	})()

	return { ok: true, proposalId }
}
