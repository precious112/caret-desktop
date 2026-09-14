/**
 * Encoding policy — Phase 10.5.
 *
 * Many encodings produce identical pixels (`w-[247px]`, `basis-[247px]`,
 * `flex-[0_0_247px]`). A hardcoded preference is guessing at the user's
 * conventions; reading the repo is not. Precedence:
 *
 *   1. explicit user intent (the hug/fill/fixed mode) — always wins
 *   2. project convention — how comparable cases are already written
 *   3. context default — the built-in policy per layout kind
 *
 * Cold start matters: the first write SEEDS the convention every later write
 * copies, so the default is the one worth propagating — `basis-[Npx] shrink-0`
 * for flex children (explicit about both the size and the no-shrink intent),
 * not the terser `flex-[0_0_Npx]` shorthand that hides the basis.
 */

export type FlexWidthEncoding = "basis" | "flex-shorthand"

/**
 * How this project writes fixed flex-child widths, from its own sources.
 * Counts real occurrences; ties and empty projects take the default.
 */
export function flexWidthEncodingFor(sources: string[]): FlexWidthEncoding {
	let basis = 0
	let shorthand = 0
	for (const source of sources) {
		basis += (source.match(/\bbasis-\[/g) ?? []).length
		shorthand += (source.match(/\bflex-\[0_0_/g) ?? []).length
	}
	return shorthand > basis ? "flex-shorthand" : "basis"
}
