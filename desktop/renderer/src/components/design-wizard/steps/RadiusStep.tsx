import { useCallback } from "react"
import { DesignServiceClient } from "@/services/design-client"
import { RADIUS_CHARACTERS, type RadiusCharacter } from "../data-steps"
import type { FoundationTokensDraft } from "../TokenWizard"

type Props = {
	tokens: FoundationTokensDraft
	onChange: (tokens: FoundationTokensDraft) => void
}

export function RadiusStep({ tokens, onChange }: Props) {
	const handleCharacterChange = useCallback(
		async (character: RadiusCharacter) => {
			try {
				const response = await DesignServiceClient.generateTokenScale({
					type: "radius",
					seedValue: character,
					optionsJson: "{}",
				})
				const scaleObj = JSON.parse(response.scaleJson)
				const scaleValues = Object.values(scaleObj).map((v) => Number.parseInt(v as string))
				onChange({ ...tokens, radius: { character, scale: scaleValues } })
			} catch {
				const fallbackScales: Record<RadiusCharacter, number[]> = {
					sharp: [0, 1, 2, 4, 6, 9999],
					soft: [0, 2, 4, 8, 12, 9999],
					round: [0, 4, 8, 12, 16, 9999],
					pill: [0, 4, 8, 16, 24, 9999],
				}
				onChange({ ...tokens, radius: { character, scale: fallbackScales[character] } })
			}
		},
		[tokens, onChange],
	)

	// The character picks a starting point; the values themselves stay
	// editable. "Pick one of four moods" was quietly the whole story before,
	// and a chair whose bends are exactly 6px could not say so in the manual
	// lane — the one lane that exists for people with exact opinions.
	const setStep = useCallback(
		(index: number, value: number) => {
			if (!Number.isFinite(value) || value < 0 || value > 64) return
			const scale = [...tokens.radius.scale]
			scale[index] = value
			onChange({ ...tokens, radius: { ...tokens.radius, scale } })
		},
		[tokens, onChange],
	)

	const labels = ["none", "sm", "md", "lg", "xl", "full"]

	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-col gap-2">
				<label className="text-sm font-medium text-foreground">Corner Style</label>
				<div className="flex gap-2">
					{RADIUS_CHARACTERS.map((char) => (
						<button
							className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${
								tokens.radius.character === char
									? "border-button-background bg-button-background text-button-foreground"
									: "border-input bg-input-background text-foreground hover:bg-input-background/80"
							}`}
							key={char}
							onClick={() => handleCharacterChange(char)}>
							{char}
						</button>
					))}
				</div>
				<p className="text-[10px] text-muted-foreground">A starting point — every value below is yours to change.</p>
			</div>

			<div className="flex flex-col gap-2">
				<label className="text-xs font-medium text-muted-foreground">Radius Values</label>
				<div className="flex gap-3 flex-wrap">
					{tokens.radius.scale.map((value, i) => (
						<div className="flex flex-col items-center gap-1" key={i}>
							<div
								className="w-12 h-12 border-2 border-button-background/60 bg-input-background"
								style={{ borderRadius: value === 9999 ? "9999px" : `${value}px` }}
							/>
							<span className="text-[9px] text-muted-foreground">{labels[i]}</span>
							{value === 9999 || i === 0 ? (
								<span className="text-[9px] text-muted-foreground">{value === 9999 ? "full" : "0px"}</span>
							) : (
								<input
									className="w-12 rounded border border-input bg-input-background px-1 py-0.5 text-center text-[10px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
									data-testid={`radius-step-${labels[i]}`}
									max={64}
									min={0}
									onChange={(e) => setStep(i, Number(e.target.value))}
									type="number"
									value={value}
								/>
							)}
						</div>
					))}
				</div>
			</div>

			<div className="flex flex-col gap-2">
				<label className="text-xs font-medium text-muted-foreground">Applied Preview</label>
				<div className="flex gap-3 items-start">
					<button
						className="px-5 py-2 text-xs font-medium text-white shadow-sm"
						style={{
							borderRadius: `${tokens.radius.scale[2]}px`,
							backgroundColor: "var(--vscode-button-background)",
							border: "none",
						}}>
						Add to Cart
					</button>
					<button
						className="px-5 py-2 text-xs font-medium shadow-sm"
						style={{
							borderRadius: `${tokens.radius.scale[2]}px`,
							backgroundColor: "transparent",
							border: "1px solid var(--vscode-button-background)",
							color: "var(--vscode-button-background)",
						}}>
						View Details
					</button>
				</div>
				<div
					className="mt-1 overflow-hidden border border-input"
					style={{ borderRadius: `${tokens.radius.scale[3]}px`, maxWidth: "200px" }}>
					<div className="h-16" style={{ backgroundColor: "var(--vscode-button-background)", opacity: 0.15 }} />
					<div className="p-2.5">
						<div className="text-xs font-medium text-foreground mb-0.5">Product Name</div>
						<div className="text-[10px] text-muted-foreground">$49.99</div>
					</div>
				</div>
			</div>
		</div>
	)
}
