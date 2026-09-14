import { useCallback, useEffect, useRef, useState } from "react"
import { Input } from "@/components/ui/input"
import { DesignServiceClient } from "@/services/design-client"
import { TYPE_SCALE_RATIOS } from "../data-steps"
import type { FoundationTokensDraft } from "../TokenWizard"

type Props = {
	tokens: FoundationTokensDraft
	onChange: (tokens: FoundationTokensDraft) => void
}

type FontResult = { family: string; category: string; variants: string[] }

const DISPLAY_WEIGHTS = [400, 500, 600, 700, 800]
const BODY_WEIGHTS = [300, 400, 500]

/** One Google Fonts search box with its dropdown — used for body and heading faces. */
function FontSearch({ current, onSelect }: { current: string; onSelect(family: string): void }) {
	const [fontSearch, setFontSearch] = useState("")
	const [fontResults, setFontResults] = useState<FontResult[]>([])
	const [searchSource, setSearchSource] = useState<"google-fonts" | "bundled">("google-fonts")
	const [showDropdown, setShowDropdown] = useState(false)
	const dropdownRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		const handleClickOutside = (e: MouseEvent) => {
			if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
				setShowDropdown(false)
			}
		}
		document.addEventListener("mousedown", handleClickOutside)
		return () => document.removeEventListener("mousedown", handleClickOutside)
	}, [])

	useEffect(() => {
		const timeout = setTimeout(async () => {
			try {
				const response = await DesignServiceClient.searchGoogleFonts({ value: fontSearch })
				setFontResults(response.fonts)
				setSearchSource(response.source)
			} catch (e) {
				console.error("Font search failed:", e)
			}
		}, 300)
		return () => clearTimeout(timeout)
	}, [fontSearch])

	return (
		<div className="relative" ref={dropdownRef}>
			<Input
				onChange={(e) => {
					setFontSearch(e.target.value)
					setShowDropdown(true)
				}}
				onFocus={() => setShowDropdown(true)}
				placeholder={current ? `Search fonts… (current: ${current})` : "Search fonts..."}
				value={fontSearch}
			/>
			{showDropdown && fontResults.length > 0 && (
				<div
					className="absolute z-10 top-full mt-1 w-full max-h-48 overflow-y-auto rounded-md border border-input shadow-md"
					style={{
						backgroundColor:
							"var(--vscode-editorWidget-background, var(--vscode-dropdown-background, var(--vscode-editor-background)))",
					}}>
					{fontResults.map((font) => (
						<button
							className="w-full px-3 py-2 text-left text-sm text-foreground"
							key={font.family}
							onClick={() => {
								onSelect(font.family)
								setFontSearch("")
								setShowDropdown(false)
							}}
							onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--vscode-list-hoverBackground)")}
							onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}>
							<span className="font-medium">{font.family}</span>
							<span className="ml-2 text-xs text-muted-foreground">{font.category}</span>
						</button>
					))}
				</div>
			)}
			{/* An offline search must say it is one: it covers 20 fonts, not the
			    whole catalogue — especially when it finds nothing, which otherwise
			    reads as "no such font". */}
			{searchSource === "bundled" && fontSearch.trim().length >= 2 && (
				<p className="mt-1 text-xs text-muted-foreground">
					Offline — searching a small built-in list, not all of Google Fonts. A font missing here may still exist.
				</p>
			)}
		</div>
	)
}

function WeightRow({
	label,
	choices,
	selected,
	onToggle,
}: {
	label: string
	choices: number[]
	selected: number[]
	onToggle(weight: number): void
}) {
	return (
		<div className="flex items-center gap-3">
			<span className="text-xs text-muted-foreground w-16">{label}</span>
			<div className="flex gap-2">
				{choices.map((weight) => (
					<button
						className={`px-2 py-1 text-xs rounded-md border transition-colors ${
							selected.includes(weight)
								? "border-button-background bg-button-background text-button-foreground"
								: "border-input bg-input-background text-foreground hover:bg-input-background/80"
						}`}
						key={weight}
						onClick={() => onToggle(weight)}
						style={{ fontWeight: weight }}>
						{weight}
					</button>
				))}
			</div>
		</div>
	)
}

export function TypographyStep({ tokens, onChange }: Props) {
	const selectFont = useCallback(
		(family: string) => {
			onChange({ ...tokens, typography: { ...tokens.typography, fontFamily: family } })
		},
		[tokens, onChange],
	)

	const selectDisplayFont = useCallback(
		(family: string | undefined) => {
			const typography = { ...tokens.typography }
			if (family) {
				typography.displayFamily = family
			} else {
				delete typography.displayFamily
				delete typography.displayFallback
			}
			onChange({ ...tokens, typography })
		},
		[tokens, onChange],
	)

	const toggleWeight = useCallback(
		(role: "display" | "body", weight: number) => {
			const weights = {
				display: tokens.typography.weights?.display ?? [600],
				body: tokens.typography.weights?.body ?? [400, 500],
			}
			// Multi-select per role: the token model carries arrays, the Google
			// Fonts import fetches every chosen weight, and a single-weight picker
			// here was quietly stricter than the interview (which sets several).
			// The last weight standing cannot be removed — a role with no weight
			// renders as the browser's fake bold.
			const current = weights[role]
			const next = current.includes(weight) ? current.filter((w) => w !== weight) : [...current, weight]
			if (next.length === 0) return
			weights[role] = next.sort((a, b) => a - b)
			onChange({ ...tokens, typography: { ...tokens.typography, weights } })
		},
		[tokens, onChange],
	)

	const handleRatioChange = useCallback(
		(ratio: number) => {
			onChange({ ...tokens, typography: { ...tokens.typography, scaleRatio: ratio } })
		},
		[tokens, onChange],
	)

	const handleBaseSizeChange = useCallback(
		(size: number) => {
			onChange({ ...tokens, typography: { ...tokens.typography, baseSize: size } })
		},
		[tokens, onChange],
	)

	const previewSizes = generatePreviewSizes(tokens.typography.baseSize, tokens.typography.scaleRatio)

	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-col gap-2">
				<label className="text-sm font-medium text-foreground">Body Font</label>
				<FontSearch current={tokens.typography.fontFamily} onSelect={selectFont} />
				<span className="text-xs text-muted-foreground">
					Current: <strong>{tokens.typography.fontFamily}</strong>
				</span>
			</div>

			<div className="flex flex-col gap-2">
				<label className="text-sm font-medium text-foreground">Heading Font</label>
				{tokens.typography.displayFamily ? (
					<>
						<FontSearch current={tokens.typography.displayFamily} onSelect={(family) => selectDisplayFont(family)} />
						<span className="text-xs text-muted-foreground">
							Current: <strong>{tokens.typography.displayFamily}</strong>
							{" · "}
							<button
								className="text-button-background hover:underline"
								onClick={() => selectDisplayFont(undefined)}>
								Same as body
							</button>
						</span>
					</>
				) : (
					<button
						className="self-start text-xs text-button-background hover:underline"
						data-testid="typography-add-display"
						onClick={() => selectDisplayFont(tokens.typography.fontFamily)}>
						+ Use a different face for headings
					</button>
				)}
			</div>

			<div className="flex flex-col gap-2">
				<label className="text-sm font-medium text-foreground">Weights</label>
				<WeightRow
					choices={DISPLAY_WEIGHTS}
					label="Headings"
					onToggle={(weight) => toggleWeight("display", weight)}
					selected={tokens.typography.weights?.display ?? [600]}
				/>
				<WeightRow
					choices={BODY_WEIGHTS}
					label="Body"
					onToggle={(weight) => toggleWeight("body", weight)}
					selected={tokens.typography.weights?.body ?? [400, 500]}
				/>
				<p className="text-[10px] text-muted-foreground">
					Pick every weight the design may use — each one is fetched from Google Fonts; a weight you skip would render
					as fake bold.
				</p>
			</div>

			<div className="flex flex-col gap-2">
				<label className="text-sm font-medium text-foreground">Base Size</label>
				<div className="flex items-center gap-3">
					<Input
						className="w-20"
						max={24}
						min={12}
						onChange={(e) => handleBaseSizeChange(Number(e.target.value))}
						type="number"
						value={tokens.typography.baseSize}
					/>
					<span className="text-xs text-muted-foreground">px</span>
				</div>
			</div>

			<div className="flex flex-col gap-2">
				<label className="text-sm font-medium text-foreground">Scale Ratio</label>
				<div className="flex flex-wrap gap-2">
					{TYPE_SCALE_RATIOS.map(({ label, value }) => (
						<button
							className={`px-2 py-1 text-xs rounded-md border transition-colors ${
								tokens.typography.scaleRatio === value
									? "border-button-background bg-button-background text-button-foreground"
									: "border-input bg-input-background text-foreground hover:bg-input-background/80"
							}`}
							key={value}
							onClick={() => handleRatioChange(value)}>
							{label}
						</button>
					))}
				</div>
			</div>

			<div className="flex flex-col gap-2">
				<label className="text-xs font-medium text-muted-foreground">Scale Preview</label>
				<div className="flex flex-col gap-1">
					{previewSizes.map(({ label, size }) => (
						<div className="flex items-baseline gap-3" key={label}>
							<span className="text-[10px] text-muted-foreground w-8">{label}</span>
							<span className="text-foreground" style={{ fontSize: `${Math.min(size, 36)}px` }}>
								Aa
							</span>
							<span className="text-[10px] text-muted-foreground">{size}px</span>
						</div>
					))}
				</div>
			</div>
		</div>
	)
}

function generatePreviewSizes(baseSize: number, ratio: number): Array<{ label: string; size: number }> {
	const labels = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl"]
	const baseIndex = 2
	return labels.map((label, i) => ({
		label,
		size: Math.round(baseSize * ratio ** (i - baseIndex) * 100) / 100,
	}))
}
