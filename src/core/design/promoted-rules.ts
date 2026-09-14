/**
 * Rules promoted from the user's own corrections — the durable half of
 * correction capture.
 *
 * `.caret/rules.json`, deliberately UNDER version control: a promoted rule is a
 * design decision, exactly as reviewable in a PR as a token change, and it must
 * travel with the project so every clone's agents inherit it. (The observation
 * logs the rules are mined FROM stay local and gitignored — how someone works
 * is not theirs to publish by accident.)
 *
 * Delivery is the always-on path: the rules generator splices these into
 * AGENTS.md / CLAUDE.md / the Cursor rules, and the embedded backend gets them
 * in its system prompt — an agent that must *choose* to look up the project's
 * standing corrections will not.
 */
import * as fs from "fs/promises"
import * as path from "path"

import { runExclusive, writeFileAtomic } from "./file-mutation-queue"

export interface PromotedRule {
	id: string
	/** The rule, in the user's own words (or the wording Caret offered). */
	text: string
	/** Where it came from — a mined correction, or typed in by hand. */
	source: "correction" | "manual"
	addedAt: string
}

export interface PromotedRules {
	version: 1
	rules: PromotedRule[]
}

export const PROMOTED_RULES_FILE = "rules.json"

function rulesPath(workspacePath: string): string {
	return path.join(workspacePath, ".caret", PROMOTED_RULES_FILE)
}

export async function readPromotedRules(workspacePath: string): Promise<PromotedRules> {
	try {
		const raw = JSON.parse(await fs.readFile(rulesPath(workspacePath), "utf-8"))
		const rules = Array.isArray(raw?.rules)
			? raw.rules.filter((r: PromotedRule) => typeof r?.text === "string" && r.text.trim().length > 0)
			: []
		return { version: 1, rules }
	} catch {
		return { version: 1, rules: [] }
	}
}

/** Adds a rule unless an identical one exists. Returns the stored rule. */
export async function addPromotedRule(
	workspacePath: string,
	text: string,
	source: PromotedRule["source"],
): Promise<PromotedRule> {
	const target = rulesPath(workspacePath)
	return runExclusive(target, async () => {
		const current = await readPromotedRules(workspacePath)
		const trimmed = text.trim()
		const existing = current.rules.find((r) => r.text === trimmed)
		if (existing) return existing
		const rule: PromotedRule = {
			id: `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
			text: trimmed,
			source,
			addedAt: new Date().toISOString(),
		}
		current.rules.push(rule)
		await writeFileAtomic(target, JSON.stringify(current, null, 2))
		return rule
	})
}

export async function removePromotedRule(workspacePath: string, id: string): Promise<boolean> {
	const target = rulesPath(workspacePath)
	return runExclusive(target, async () => {
		const current = await readPromotedRules(workspacePath)
		const next = current.rules.filter((r) => r.id !== id)
		if (next.length === current.rules.length) return false
		await writeFileAtomic(target, JSON.stringify({ version: 1, rules: next }, null, 2))
		return true
	})
}
