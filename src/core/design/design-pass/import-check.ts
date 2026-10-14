/**
 * The one free code check after a Design pass build: every component the
 * designer chose (and Caret installed) is actually imported by the page. If
 * one is not, the builder is told once — no AI judges the built page.
 */
import type { BuildComponent } from "./prompts"

/** The components no written page imports. `sources` are the page files the build turn wrote. */
export function missingImports(components: BuildComponent[], sources: string[]): BuildComponent[] {
	return components.filter((component) => {
		// Pages sit at the same depth, so the import string is the same in each;
		// the tail after "components/catalog/" is matched to allow `./`-style variants.
		const tail = component.importPath.slice(component.importPath.indexOf("components/catalog/"))
		const pattern = new RegExp(`from\\s+["'][./]*${tail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.tsx?)?["']`)
		return !sources.some((source) => pattern.test(source))
	})
}

/** What the builder is told, once. */
export function missingImportsPrompt(missing: BuildComponent[]): string {
	return `The approved plan places these installed components, but the page does not import them:
${missing.map((c) => `- section "${c.section}": import ${c.namedExport ? `{ ${c.namedExport} }` : "the default export"} from "${c.importPath}" (${c.job})`).join("\n")}
Use each one where the plan places it, filled with this page's real content. Change nothing else.`
}
