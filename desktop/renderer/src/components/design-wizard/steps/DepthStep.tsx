import { useCallback } from "react"
import { Input } from "@/components/ui/input"
import { ELEVATION_CHARACTERS, type ElevationCharacter } from "../data-steps"
import type { FoundationTokensDraft } from "../TokenWizard"

type Props = {
	tokens: FoundationTokensDraft
	onChange: (tokens: FoundationTokensDraft) => void
}

/** Preview shadows per character — illustrative only; the real strings are derived on save, tinted by the neutral. */
const PREVIEW_SHADOWS: Record<ElevationCharacter, string> = {
	flat: "none",
	subtle: "0 4px 12px -2px rgba(23, 23, 23, 0.08)",
	pronounced: "0 8px 24px -4px rgba(23, 23, 23, 0.14)",
}

const CHARACTER_HINTS: Record<ElevationCharacter, string> = {
	flat: "No shadows — separation comes from borders and colour.",
	subtle: "Quiet shadows that read as paper on a desk.",
	pronounced: "Deep shadows — cards visibly float.",
}

export function DepthStep({ tokens, onChange }: Props) {
	const setCharacter = useCallback(
		(character: ElevationCharacter) => {
			onChange({ ...tokens, elevation: { character } })
		},
		[tokens, onChange],
	)

	const setBorder = useCallback(
		(patch: Partial<{ width: number; ring: number }>) => {
			const current = tokens.border ?? { width: 1, focusRing: { width: 2 } }
			onChange({
				...tokens,
				border: {
					width: patch.width ?? current.width,
					focusRing: { width: patch.ring ?? current.focusRing.width },
				},
			})
		},
		[tokens, onChange],
	)

	const selected = tokens.elevation?.character ?? "subtle"

	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-col gap-2">
				<label className="text-sm font-medium text-foreground">Elevation</label>
				<div className="grid grid-cols-3 gap-3">
					{ELEVATION_CHARACTERS.map((character) => (
						<button
							className={`flex flex-col items-center gap-3 rounded-md border p-4 transition-colors ${
								selected === character
									? "border-button-background bg-input-background"
									: "border-input bg-input-background/50 hover:bg-input-background"
							}`}
							data-testid={`depth-${character}`}
							key={character}
							onClick={() => setCharacter(character)}>
							<div
								className="h-10 w-16 rounded-md border border-input bg-white"
								style={{ boxShadow: PREVIEW_SHADOWS[character] }}
							/>
							<span className="text-xs font-medium capitalize text-foreground">{character}</span>
						</button>
					))}
				</div>
				<p className="text-xs text-muted-foreground">{CHARACTER_HINTS[selected]}</p>
				<p className="text-[10px] text-muted-foreground">
					The shadow colours themselves are derived from your neutrals, so they always match the palette.
				</p>
			</div>

			<div className="flex flex-col gap-2">
				<label className="text-sm font-medium text-foreground">Borders</label>
				<div className="flex items-center gap-3">
					<span className="text-xs text-muted-foreground w-20">Hairline</span>
					<Input
						className="w-16"
						max={4}
						min={1}
						onChange={(e) => setBorder({ width: Number(e.target.value) })}
						type="number"
						value={tokens.border?.width ?? 1}
					/>
					<span className="text-xs text-muted-foreground">px</span>
				</div>
				<div className="flex items-center gap-3">
					<span className="text-xs text-muted-foreground w-20">Focus ring</span>
					<Input
						className="w-16"
						max={6}
						min={1}
						onChange={(e) => setBorder({ ring: Number(e.target.value) })}
						type="number"
						value={tokens.border?.focusRing.width ?? 2}
					/>
					<span className="text-xs text-muted-foreground">px</span>
				</div>
				<p className="text-[10px] text-muted-foreground">
					Border colour follows the neutrals; the focus ring follows the brand colour.
				</p>
			</div>
		</div>
	)
}
