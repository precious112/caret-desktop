/**
 * Per-task model pickers for the generation lanes.
 *
 * The lanes inherit the session model, and that default is usually right. The
 * override exists because two of these jobs have their own requirements the
 * chat's model may not meet: the mark loop needs a model that accepts images,
 * and mesh optimization has a **recommended set the user named** — Fable 5,
 * GPT 5.6 Sol, Kimi K3, GLM 5.2, DeepSeek V4 Flash.
 *
 * The recommendations are matched against what the backend actually reports,
 * never kept as a hardcoded id list: "Kimi K3" is a different string on every
 * backend that serves it, and a stale id fails silently — which is precisely
 * the class of bug the vision probe exists to catch on the other lane.
 */
import { getBackend, isRecommendedOptimizer } from "../../src/core/design"
import type { TaskModelWire } from "../shared/ipc"
import { getPrefs, setPref } from "./prefs"

export type LaneTask = "mark" | "model3d" | "shader"

export async function listTaskModels(task: LaneTask): Promise<TaskModelWire[]> {
	const prefs = getPrefs()
	if (!prefs.backendId) return []

	const backend = await getBackend(prefs.backendId)
	if (!backend) return []

	if (!backend.listModels) return []

	try {
		const groups = await backend.listModels()
		return groups.flatMap((group) =>
			group.models.map((model) => ({
				id: model.id,
				label: model.label,
				providerName: group.providerName,
				...(model.free ? { free: true } : {}),
				// Recommended is a highlight, not a gate — anything stays pickable.
				...(task === "model3d" && (isRecommendedOptimizer(model.id) || isRecommendedOptimizer(model.label))
					? { recommended: true }
					: {}),
			})),
		)
	} catch {
		// A backend that cannot enumerate is the free-text case; the UI handles it.
		return []
	}
}

export async function setTaskModel(task: LaneTask, model: string): Promise<void> {
	const current = getPrefs().laneModels
	await setPref("laneModels", { ...current, [task]: model.trim() || undefined })
}

export function taskModel(task: LaneTask): string {
	return getPrefs().laneModels[task] ?? ""
}
