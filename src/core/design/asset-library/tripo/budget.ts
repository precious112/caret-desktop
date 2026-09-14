/**
 * Holding the optimizer to the weight band.
 *
 * The decision is the model's; whether the *result* honoured it is checkable
 * arithmetic, and the first live run showed why checking matters: a decision
 * that sounded reasonable produced 740KB, and at 740KB the textures had a dirty
 * look and the labels on the earpads read like plastic melted under heat. The
 * user set the band at 3–5MB after seeing it.
 *
 * So: convert, weigh, and if the result fell below the band, escalate — texture
 * resolution first, because that is where the observed damage lived — and
 * convert once more. One corrective pass, not a loop: each convert costs
 * credits, and a second miss means the band and this object disagree, which is
 * the user's call to make with both files in front of them.
 */
import type { TripoClient, TripoModelOutput, TripoProgress, TripoResult } from "./client"
import { OPTIMIZATION_BOUNDS, type OptimizationDecision, WEIGHT_BAND } from "./optimize"

export interface BudgetedConversion {
	bytes: Buffer
	taskId: string
	/** The decision that produced the kept file — the escalated one, if retried. */
	applied: OptimizationDecision
	/** Present when a corrective pass ran, saying why. */
	corrected?: string
}

/**
 * Converts, and re-converts once if the result came in under the band.
 *
 * Over-the-band results are kept: the band's ceiling exists to guide the
 * decision, but a heavy file is recoverable taste and a melted one is not —
 * shrinking further is exactly the damage this module exists to prevent.
 */
export async function convertWithinBudget(
	client: TripoClient,
	draftTaskId: string,
	decision: OptimizationDecision,
	onProgress: (update: TripoProgress) => void,
	band: { minBytes: number; maxBytes: number } = WEIGHT_BAND,
): Promise<TripoResult<BudgetedConversion>> {
	const first = await client.convertModel(
		draftTaskId,
		{ faceLimit: decision.faceLimit, textureSize: decision.textureSize },
		onProgress,
	)
	if (!first.ok) return first

	if (first.value.bytes.length >= band.minBytes) {
		return { ok: true, value: { ...pick(first.value), applied: decision } }
	}

	const escalated = escalate(decision)
	if (!escalated) {
		// Already at the top of every knob and still light — this object is simply
		// small, and that is a fact about the object rather than a defect.
		return { ok: true, value: { ...pick(first.value), applied: decision } }
	}

	onProgress({
		stage: `Result came in at ${Math.round(first.value.bytes.length / 1024)}KB — below the quality band, converting again`,
	})
	const second = await client.convertModel(
		draftTaskId,
		{ faceLimit: escalated.faceLimit, textureSize: escalated.textureSize },
		onProgress,
	)
	// A failed corrective pass keeps the first result: bytes in hand beat an error.
	if (!second.ok) {
		return {
			ok: true,
			value: {
				...pick(first.value),
				applied: decision,
				corrected: `a corrective pass was attempted (${second.reason}) and the first result was kept`,
			},
		}
	}

	return {
		ok: true,
		value: {
			...pick(second.value),
			applied: escalated,
			corrected:
				`the first pass produced ${Math.round(first.value.bytes.length / 1024)}KB, below the ` +
				`${Math.round(band.minBytes / 1024 / 1024)}MB floor where texture damage has been observed — ` +
				`escalated to ${escalated.faceLimit.toLocaleString()} faces / ${escalated.textureSize}px`,
		},
	}
}

/** The next-gentler decision: textures up a step first, then faces doubled. */
function escalate(decision: OptimizationDecision): OptimizationDecision | null {
	const sizes = OPTIMIZATION_BOUNDS.textureSizes
	const nextSize = sizes[sizes.indexOf(decision.textureSize) + 1]
	const nextFaces = Math.min(OPTIMIZATION_BOUNDS.faceLimit.max, decision.faceLimit * 2)

	if (!nextSize && nextFaces === decision.faceLimit) return null
	return {
		faceLimit: nextFaces,
		textureSize: nextSize ?? decision.textureSize,
		reason: decision.reason,
	}
}

function pick(value: TripoModelOutput): { bytes: Buffer; taskId: string } {
	return { bytes: value.bytes, taskId: value.taskId }
}
