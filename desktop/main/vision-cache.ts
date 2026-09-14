/**
 * Remembering which backend-and-model pairs can see an image.
 *
 * The probe costs a turn, so it runs once per pair and the answer is kept.
 * **Keyed by backend *and* model**, because the capability belongs to neither
 * alone: the same model behind an adapter that drops images cannot see, and the
 * same adapter with a text-only model cannot either. That pairing is exactly the
 * distinction the Claude bug lived in.
 *
 * Negative answers are cached with a timestamp and expire. A model that could
 * not see an image last month may be a model whose adapter has since been
 * fixed — which is not hypothetical here — and a permanent "no" would leave the
 * lane refusing forever with no way for the user to discover it now works.
 */
import { getBackend } from "../../src/core/design/agent/registry"
import { probeVision, type VisionVerdict } from "../../src/core/design/agent/vision"
import { Logger } from "../../src/shared/services/Logger"
import { getPrefs, setPref } from "./prefs"

/** A "no" is re-checked after this. A "yes" is kept — capabilities do not vanish. */
const NEGATIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000

interface CachedVerdict {
	sees: boolean
	reason?: string
	at: number
}

function key(backendId: string, model: string): string {
	return `${backendId}::${model || "(default)"}`
}

/**
 * Whether this pair can be shown an image, probing if the answer is not known.
 *
 * `force` re-probes regardless, for a "check again" button — the same shape the
 * backend setup screen already uses, and for the same reason: the world changes
 * underneath a cached answer.
 */
export async function canSeeImages(
	backendId: string,
	model: string,
	workingDirectory: string,
	force = false,
): Promise<VisionVerdict> {
	const cache = (getPrefs().visionChecks ?? {}) as Record<string, CachedVerdict>
	const cached = cache[key(backendId, model)]

	if (!force && cached) {
		const stale = !cached.sees && Date.now() - cached.at > NEGATIVE_TTL_MS
		if (!stale) return cached.sees ? { sees: true } : { sees: false, reason: cached.reason ?? "" }
	}

	const backend = await getBackend(backendId as never)
	if (!backend) return { sees: false, reason: `No backend called "${backendId}" is available.` }

	Logger.info(`[vision] checking whether ${backendId}/${model || "default"} can be shown an image`)
	const verdict = await probeVision({ backend, workingDirectory, model: model || undefined })

	await setPref("visionChecks", {
		...cache,
		[key(backendId, model)]: { sees: verdict.sees, ...(verdict.sees ? {} : { reason: verdict.reason }), at: Date.now() },
	})

	return verdict
}

/** Drops every remembered answer. For a settings-level "check again". */
export async function forgetVisionChecks(): Promise<void> {
	await setPref("visionChecks", {})
}
