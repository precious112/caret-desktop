import { useCallback } from "react"
import type { FoundationTokensDraft } from "../TokenWizard"

type Props = {
	tokens: FoundationTokensDraft
	onChange: (tokens: FoundationTokensDraft) => void
}

/**
 * Scale entries are PIXEL VALUES, not multipliers — the same ladders the
 * curated presets carry. The base unit is the rhythm the ladder follows
 * (multiples of 8 feel airier than multiples of 4), not a factor the entries
 * are multiplied by; this component used to multiply and showed "2 → 16px",
 * a step no page would ever get.
 *
 * The unit is a free number now, not a 4-or-8 binary — the ladder derives
 * from one shared shape, which reproduces the old presets exactly at 4 and 8
 * and gives every other rhythm the same proportions. The binary was another
 * place the manual door was quietly coarser than the token model it writes.
 */
const LADDER_SHAPE = [0, 0.25, 0.5, 1, 1.5, 2, 3, 4, 6, 8, 12, 16]

function ladderFor(unit: number): number[] {
	return [...new Set(LADDER_SHAPE.map((step) => Math.round(unit * step)))]
}

export function SpacingStep({ tokens, onChange }: Props) {
	const handleBaseUnitChange = useCallback(
		(baseUnit: number) => {
			if (!Number.isFinite(baseUnit) || baseUnit < 2 || baseUnit > 16) return
			onChange({ ...tokens, spacing: { baseUnit, scale: ladderFor(baseUnit) } })
		},
		[tokens, onChange],
	)

	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-col gap-2">
				<label className="text-sm font-medium text-foreground">Rhythm</label>
				<div className="flex items-center gap-3">
					{([4, 8] as const).map((unit) => (
						<button
							className={`px-4 py-2 text-sm rounded-md border transition-colors ${
								tokens.spacing.baseUnit === unit
									? "border-button-background bg-button-background text-button-foreground"
									: "border-input bg-input-background text-foreground hover:bg-input-background/80"
							}`}
							key={unit}
							onClick={() => handleBaseUnitChange(unit)}>
							{unit}px — {unit === 4 ? "tighter" : "airier"}
						</button>
					))}
					<input
						className="w-16 rounded-md border border-input bg-input-background px-2 py-2 text-center text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
						data-testid="spacing-unit-input"
						max={16}
						min={2}
						onChange={(e) => handleBaseUnitChange(Number(e.target.value))}
						type="number"
						value={tokens.spacing.baseUnit}
					/>
					<span className="text-xs text-muted-foreground">px, 2–16</span>
				</div>
				<p className="text-[10px] text-muted-foreground">
					The grid gaps snap to. Larger rhythm means more breathing room at every step.
				</p>
			</div>

			<div className="flex flex-col gap-2">
				<label className="text-xs font-medium text-muted-foreground">The steps pages space with</label>
				{/* Label column first, fixed width and right-aligned, bars growing
				    from one shared edge — labels trailing the bars read as a
				    diagonal of floating numbers (reported in the field, where the
				    bars were also invisible for theme reasons). */}
				<div className="flex flex-col gap-1.5">
					{tokens.spacing.scale
						.filter((px) => px > 0)
						.map((px) => (
							<div className="flex items-center gap-2.5" key={px}>
								<span className="w-12 text-right font-mono text-[10.5px] text-muted-foreground">{px}px</span>
								<div
									className="h-2.5 rounded-sm bg-button-background/60"
									style={{ width: `${Math.min(px, 200)}px` }}
								/>
							</div>
						))}
				</div>
			</div>
		</div>
	)
}
