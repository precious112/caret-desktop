/**
 * Auto-supply: the agent writes a page that imports a catalog component, and
 * Caret makes the import true.
 *
 * The rules advertise exact import paths
 * (`../../components/catalog/<library>/<component>`), so the agent USES the
 * catalog as if it were already installed — no tool call to forget, no
 * instruction to ignore. After any page write (agent turn, external save,
 * inline edit), the scanner finds catalog imports that are not yet in the
 * lock and Caret installs them — consent-gated per library, budget-gated per
 * page.
 *
 * The budget gate is where restraint stops being advice: a page already
 * carrying a signature component does not get a second one supplied. The
 * import stays unresolved (a visible broken-import card in the canvas, never
 * a silent one), the restraint-budget check flags it as an error, and the
 * checker's feedback loop tells the agent to remove it. The agent cannot
 * spam what Caret declines to supply.
 */
import { findCatalogComponent, parseCatalogImport } from "./catalog"
import { type CatalogLock, isInstalled } from "./install"

export interface CatalogImportRef {
	libraryId: string
	componentId: string
	signature: boolean
	known: boolean
}

/** Every catalog import in a source file, in order of appearance. */
export function scanCatalogImports(source: string): CatalogImportRef[] {
	const refs: CatalogImportRef[] = []
	const seen = new Set<string>()
	for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
		const parsed = parseCatalogImport(match[1])
		if (!parsed) continue
		const key = `${parsed.libraryId}/${parsed.componentId}`
		if (seen.has(key)) continue
		seen.add(key)
		const found = findCatalogComponent(parsed.libraryId, parsed.componentId)
		refs.push({
			libraryId: parsed.libraryId,
			componentId: parsed.componentId,
			signature: found?.component.signature ?? false,
			known: Boolean(found),
		})
	}
	return refs
}

/** The one-signature-move-per-page budget. */
export const SIGNATURE_BUDGET_PER_PAGE = 1

export interface SupplyPlan {
	/** Components to install now (known, not installed, within budget). */
	install: CatalogImportRef[]
	/** Signature imports beyond the budget — NOT supplied, flagged instead. */
	overBudget: CatalogImportRef[]
	/** Imports that look like catalog paths but name nothing in the catalog. */
	unknown: CatalogImportRef[]
	/** Distinct signature components this page would carry if fully supplied. */
	signatureCount: number
}

/**
 * Decides what a page's imports get. The FIRST signature import (in source
 * order) wins the budget slot — deterministic, and matches how a reader
 * scans the file. Non-signature components are always within budget.
 */
export function planSupply(source: string, lock: CatalogLock): SupplyPlan {
	const refs = scanCatalogImports(source)
	const install: CatalogImportRef[] = []
	const overBudget: CatalogImportRef[] = []
	const unknown: CatalogImportRef[] = []

	let signatureSeen = 0
	for (const ref of refs) {
		if (!ref.known) {
			unknown.push(ref)
			continue
		}
		if (ref.signature) {
			signatureSeen += 1
			if (signatureSeen > SIGNATURE_BUDGET_PER_PAGE) {
				overBudget.push(ref)
				continue
			}
		}
		if (!isInstalled(lock, ref.libraryId, ref.componentId)) {
			install.push(ref)
		}
	}

	return { install, overBudget, unknown, signatureCount: signatureSeen }
}

// ---------------------------------------------------------------------------
// Checker integration — the budget as a mechanical finding.
// ---------------------------------------------------------------------------

import type { CheckFinding } from "../design-checks"

/** Source-computable catalog findings for one page. */
export function catalogFindings(source: string, pageId: string, lock: CatalogLock): CheckFinding[] {
	const plan = planSupply(source, lock)
	const findings: CheckFinding[] = []
	for (const ref of plan.overBudget) {
		findings.push({
			check: "restraint-budget",
			severity: "error",
			message: `${ref.libraryId}/${ref.componentId} is a second signature component on this page — the budget is one; remove it or move it to its own page`,
			pageId,
		})
	}
	for (const ref of plan.unknown) {
		findings.push({
			check: "catalog-unknown",
			severity: "error",
			message: `the import of ${ref.libraryId}/${ref.componentId} names nothing in the catalog — check the catalog index in the rules for what exists`,
			pageId,
		})
	}
	return findings
}
