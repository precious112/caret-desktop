/**
 * Level 3: the planner defends or drops each flagged part, a separate judge
 * weighs every defence, and only what the user's own words support is kept
 * without asking. These are the rules between those calls — no AI in here.
 */
import { type Item, normalize } from "./findings"

export interface Defence {
	decision: "keep" | "remove"
	reason: string
	/** Words the planner says it found in the brief. Verified before they count. */
	briefQuote: string
}

export interface Verdict {
	anchored: boolean
	why: string
}

export type Outcome =
	/** The planner dropped it: the rework removes it. */
	| "removed"
	/** The user's own words call for it, and the judge agreed. */
	| "kept"
	/** Only the AI's argument supports it: the user decides. */
	| "ask"
	/** Passed the mechanical checks; waiting for the judge. */
	| "judge"

export interface Screened {
	item: Item
	defence: Defence | null
	outcome: Outcome
	/** Why it went the way it did, in plain words. */
	note: string
}

/** At most this many questions per page; the most reported habits are asked first. */
export const QUESTION_CAP = 5

/**
 * The checks that need no judge. A defence only reaches the judge when it
 * quotes words that really are in the brief, and when its reason is its own —
 * the same reason pasted under several items is no defence at all.
 */
export function screenDefences(items: Item[], defences: Map<number, Defence>, brief: string): Screened[] {
	const reasonCounts = new Map<string, number>()
	for (const defence of defences.values()) {
		if (defence.decision !== "keep" || !defence.reason.trim()) continue
		const key = normalize(defence.reason)
		reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1)
	}
	const lowerBrief = normalize(brief)
	return items.map((item, index) => {
		const defence = defences.get(index + 1) ?? null
		if (!defence) return { item, defence, outcome: "ask", note: "The AI gave no reason for it." }
		if (defence.decision === "remove") return { item, defence, outcome: "removed", note: "The AI dropped it." }
		if (!defence.reason.trim()) return { item, defence, outcome: "ask", note: "The AI gave no reason for it." }
		if ((reasonCounts.get(normalize(defence.reason)) ?? 0) > 1) {
			return { item, defence, outcome: "ask", note: "The same reason was given for several parts." }
		}
		const quote = normalize(defence.briefQuote)
		if (!quote || !lowerBrief.includes(quote)) {
			return { item, defence, outcome: "ask", note: "Nothing in your words calls for it." }
		}
		return { item, defence, outcome: "judge", note: "Waiting for the judge." }
	})
}

/** The defences that go to the judge: verified brief quote, own reason. */
export function forJudge(screened: Screened[]): Screened[] {
	return screened.filter((s) => s.outcome === "judge")
}

/** Applies the judge's verdicts to what it was shown. A missing verdict is not an acquittal. */
export function applyVerdicts(screened: Screened[], verdicts: Map<Screened, Verdict>): Screened[] {
	return screened.map((s) => {
		if (s.outcome !== "judge") return s
		const verdict = verdicts.get(s)
		if (verdict?.anchored) return { ...s, outcome: "kept", note: "Your own words call for it." }
		return { ...s, outcome: "ask", note: verdict?.why || "Only the AI's argument supports it." }
	})
}

/**
 * Who gets asked, and what goes back for rework. Questions are capped; the most
 * reported habits are asked first and the rest are reworked rather than asked,
 * because a sixth question is a chore and a reworked part costs the user nothing.
 */
export function selectQuestions(screened: Screened[]): { ask: Screened[]; rework: Screened[]; kept: Screened[] } {
	// A defence the judge never saw is still only the AI's argument.
	const asked = screened
		.filter((s) => s.outcome === "ask" || s.outcome === "judge")
		.sort((a, b) => b.item.sources - a.item.sources)
	return {
		ask: asked.slice(0, QUESTION_CAP),
		rework: [...screened.filter((s) => s.outcome === "removed"), ...asked.slice(QUESTION_CAP)],
		kept: screened.filter((s) => s.outcome === "kept"),
	}
}

/**
 * A fixed shuffle, so the judge never reads items in the planner's order (and
 * can't judge one by its neighbour), while a re-run is still reproducible.
 */
export function judgeOrder<T>(list: T[]): T[] {
	return list
		.map((value, index) => ({ value, key: Math.sin(index * 9301 + list.length * 49297) }))
		.sort((a, b) => a.key - b.key)
		.map((entry) => entry.value)
}
