/**
 * "Automatic (fastest connected)": the model that checks and judges for the
 * Design pass when the user has not picked one.
 *
 * Checking is matching a section against a list, not designing, so a small fast
 * model does it as well as a big one and in a fraction of the time. Nothing in
 * any provider catalogue says how fast a model is, so speed is read from the
 * names model makers give their fast tiers. A model that costs nothing per
 * token on a free tier is a last resort: free tiers rate-limit, and a pass that
 * checks a dozen sections at once would hit the limit first.
 */
import type { ModelGroup } from "../agent/backend"

/** Fast-tier names, fastest family first. */
const FAST_NAMES = [
	/haiku/i,
	/flash/i,
	/\bluna\b/i,
	/\bmini\b/i,
	/\bnano\b/i,
	/\blite\b/i,
	/\bsmall\b/i,
	/\bfast\b/i,
	/\bturbo\b/i,
]

export interface HelperChoice {
	/** `provider/model`, or null when nothing is connected. */
	model: string | null
	label: string | null
}

/**
 * The helper: the user's pick when it is still connected, else the fastest
 * connected model, else the main model (one model then does both jobs).
 */
export function pickHelperModel(groups: ModelGroup[], chosen: string, mainModel: string | undefined): HelperChoice {
	const all = groups.flatMap((group) => group.models.map((model) => ({ ...model, provider: group.providerName })))
	const find = (id: string | undefined) => (id ? all.find((m) => m.id === id) : undefined)

	const pinned = find(chosen)
	if (pinned) return { model: pinned.id, label: pinned.label }

	const rank = (m: (typeof all)[number]) => {
		const text = `${m.id} ${m.label}`
		const index = FAST_NAMES.findIndex((pattern) => pattern.test(text))
		return index === -1 ? FAST_NAMES.length : index
	}
	const fast = all
		.filter((m) => rank(m) < FAST_NAMES.length)
		.sort((a, b) => Number(!!a.free) - Number(!!b.free) || rank(a) - rank(b))
	const best = fast.find((m) => !m.free) ?? find(mainModel) ?? fast[0] ?? all[0]
	return best ? { model: best.id, label: best.label } : { model: mainModel ?? null, label: null }
}
