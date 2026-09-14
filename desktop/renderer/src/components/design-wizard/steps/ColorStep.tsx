import { useCallback, useState } from "react"
import { DesignServiceClient } from "@/services/design-client"
import { NEUTRAL_CHARACTERS, type NeutralCharacter } from "../data-steps"
import type { FoundationTokensDraft } from "../TokenWizard"

type Props = {
	tokens: FoundationTokensDraft
	onChange: (tokens: FoundationTokensDraft) => void
}

/**
 * A typed hex beside every swatch. The brand colour always had one; the
 * supporting, accent and semantic colours were native swatches only, which
 * makes an exact hex impossible to enter without the OS eyedropper — found in
 * the field by a user holding a written-down palette. Commits on Enter or
 * blur, and only a valid six-digit hex commits; anything else is left in the
 * box uncommitted rather than corrected behind the user's back.
 */
function HexField({ value, onCommit, testid }: { value: string; onCommit(hex: string): void; testid?: string }) {
	const commit = (raw: string) => {
		let hex = raw.trim()
		if (!hex.startsWith("#")) hex = `#${hex}`
		if (/^#[0-9a-fA-F]{6}$/.test(hex)) onCommit(hex.toLowerCase())
	}
	return (
		<input
			className="w-24 px-2 py-1 text-sm font-mono rounded border border-input bg-input-background text-foreground"
			data-testid={testid}
			defaultValue={value}
			key={value}
			onBlur={(e) => commit(e.target.value)}
			onKeyDown={(e) => {
				if (e.key === "Enter") commit(e.currentTarget.value)
			}}
			placeholder="#000000"
		/>
	)
}

export function ColorStep({ tokens, onChange }: Props) {
	const [generating, setGenerating] = useState(false)

	const handleBrandColorChange = useCallback(
		async (seed: string) => {
			onChange({
				...tokens,
				color: { ...tokens.color, brand: { ...tokens.color.brand, seed } },
			})

			setGenerating(true)
			try {
				const response = await DesignServiceClient.generateTokenScale({
					type: "color",
					seedValue: seed,
					optionsJson: JSON.stringify({ steps: 11 }),
				})
				const scale = JSON.parse(response.scaleJson)
				onChange({
					...tokens,
					color: { ...tokens.color, brand: { seed, scale } },
				})
			} catch (e) {
				console.error("Failed to generate color scale:", e)
			} finally {
				setGenerating(false)
			}
		},
		[tokens, onChange],
	)

	const handleNeutralChange = useCallback(
		(character: NeutralCharacter) => {
			onChange({
				...tokens,
				color: { ...tokens.color, neutral: { ...tokens.color.neutral, character } },
			})
		},
		[tokens, onChange],
	)

	const handleRoleChange = useCallback(
		async (role: "secondary" | "accent", seed: string) => {
			onChange({ ...tokens, color: { ...tokens.color, [role]: { seed, scale: {} } } })
			try {
				const response = await DesignServiceClient.generateTokenScale({
					type: "color",
					seedValue: seed,
					optionsJson: JSON.stringify({ steps: 11 }),
				})
				onChange({ ...tokens, color: { ...tokens.color, [role]: { seed, scale: JSON.parse(response.scaleJson) } } })
			} catch (e) {
				console.error("Failed to generate color scale:", e)
			}
		},
		[tokens, onChange],
	)

	const removeRole = useCallback(
		(role: "secondary" | "accent") => {
			const color = { ...tokens.color }
			delete color[role]
			onChange({ ...tokens, color })
		},
		[tokens, onChange],
	)

	const handleSemanticChange = useCallback(
		(key: string, value: string) => {
			onChange({
				...tokens,
				color: {
					...tokens.color,
					semantic: { ...tokens.color.semantic, [key]: value },
				},
			})
		},
		[tokens, onChange],
	)

	const scaleEntries = Object.entries(tokens.color.brand.scale || {})

	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-col gap-2">
				<label className="text-sm font-medium text-foreground">Brand Color</label>
				<div className="flex items-center gap-3">
					<input
						className="w-10 h-10 rounded border border-input cursor-pointer"
						onChange={(e) => handleBrandColorChange(e.target.value)}
						type="color"
						value={tokens.color.brand.seed}
					/>
					<HexField onCommit={handleBrandColorChange} testid="color-brand-hex" value={tokens.color.brand.seed} />
					{generating && <span className="text-xs text-muted-foreground">Generating scale...</span>}
				</div>
			</div>

			{scaleEntries.length > 0 && (
				<div className="flex flex-col gap-2">
					<label className="text-xs font-medium text-muted-foreground">Brand Scale</label>
					<div className="flex gap-1">
						{scaleEntries.map(([step, color]) => (
							<div className="flex flex-col items-center gap-1" key={step}>
								<div
									className="w-6 h-6 rounded-sm border border-input"
									style={{ backgroundColor: color as string }}
								/>
								<span className="text-[9px] text-muted-foreground">{step}</span>
							</div>
						))}
					</div>
				</div>
			)}

			{(["secondary", "accent"] as const).map((role) => {
				const entry = tokens.color[role]
				const label = role === "secondary" ? "Supporting Color" : "Accent Color"
				return (
					<div className="flex flex-col gap-2" key={role}>
						{entry ? (
							<>
								<label className="text-sm font-medium text-foreground">{label}</label>
								<div className="flex items-center gap-3">
									<input
										className="w-10 h-10 rounded border border-input cursor-pointer"
										data-testid={`color-${role}`}
										onChange={(e) => handleRoleChange(role, e.target.value)}
										type="color"
										value={entry.seed}
									/>
									<HexField
										onCommit={(hex) => handleRoleChange(role, hex)}
										testid={`color-${role}-hex`}
										value={entry.seed}
									/>
									<button
										className="text-xs text-muted-foreground hover:text-foreground hover:underline"
										onClick={() => removeRole(role)}>
										Remove
									</button>
								</div>
							</>
						) : (
							<button
								className="self-start text-xs text-button-background hover:underline"
								data-testid={`color-add-${role}`}
								onClick={() => handleRoleChange(role, role === "secondary" ? "#0ea5e9" : "#f59e0b")}>
								+ {role === "secondary" ? "Add a supporting color" : "Add an accent"}
							</button>
						)}
					</div>
				)
			})}

			<div className="flex flex-col gap-2">
				<label className="text-sm font-medium text-foreground">Surface</label>
				<div className="flex gap-2">
					{(["light", "dark"] as const).map((surface) => (
						<button
							className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${
								tokens.color.surface === surface
									? "border-button-background bg-button-background text-button-foreground"
									: "border-input bg-input-background text-foreground hover:bg-input-background/80"
							}`}
							data-testid={`color-surface-${surface}`}
							key={surface}
							onClick={() => onChange({ ...tokens, color: { ...tokens.color, surface } })}>
							{surface === "light" ? "Light pages" : "Dark pages"}
						</button>
					))}
				</div>
			</div>

			<div className="flex flex-col gap-2">
				<label className="text-sm font-medium text-foreground">Neutral Character</label>
				<div className="flex gap-2">
					{NEUTRAL_CHARACTERS.map((char) => (
						<button
							className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${
								tokens.color.neutral.character === char
									? "border-button-background bg-button-background text-button-foreground"
									: "border-input bg-input-background text-foreground hover:bg-input-background/80"
							}`}
							key={char}
							onClick={() => handleNeutralChange(char)}>
							{char}
						</button>
					))}
				</div>
			</div>

			<div className="flex flex-col gap-2">
				<label className="text-sm font-medium text-foreground">Semantic Colors</label>
				<div className="grid grid-cols-2 gap-3">
					{(["success", "warning", "error", "info"] as const).map((key) => (
						<div className="flex items-center gap-2" key={key}>
							<input
								className="w-7 h-7 rounded border border-input cursor-pointer"
								onChange={(e) => handleSemanticChange(key, e.target.value)}
								type="color"
								value={tokens.color.semantic[key]}
							/>
							<span className="w-14 text-xs text-foreground capitalize">{key}</span>
							<HexField
								onCommit={(hex) => handleSemanticChange(key, hex)}
								testid={`color-semantic-${key}-hex`}
								value={tokens.color.semantic[key]}
							/>
						</div>
					))}
				</div>
			</div>
		</div>
	)
}
