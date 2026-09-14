import { Badge } from "@/components/ui/badge"
import type { FoundationTokensDraft } from "../TokenWizard"

type Props = {
	tokens: FoundationTokensDraft
	onEditStep: (step: number) => void
}

export function ReviewStep({ tokens, onEditStep }: Props) {
	const scaleEntries = Object.entries(tokens.color.brand.scale || {})

	return (
		<div className="flex flex-col gap-4">
			<Section onEdit={() => onEditStep(0)} title="Vibe">
				{tokens.vibe.description && <p className="text-xs text-muted-foreground italic">"{tokens.vibe.description}"</p>}
				<div className="flex flex-wrap gap-1">
					{tokens.vibe.tags.map((tag) => (
						<Badge key={tag} variant="outline">
							{tag}
						</Badge>
					))}
				</div>
			</Section>

			<Section onEdit={() => onEditStep(1)} title="Color">
				<div className="flex items-center gap-2">
					<div className="w-6 h-6 rounded border border-input" style={{ backgroundColor: tokens.color.brand.seed }} />
					<span className="text-xs font-mono text-muted-foreground">{tokens.color.brand.seed}</span>
					{tokens.color.secondary && (
						<div
							className="w-6 h-6 rounded border border-input"
							style={{ backgroundColor: tokens.color.secondary.seed }}
							title={`Supporting: ${tokens.color.secondary.seed}`}
						/>
					)}
					{tokens.color.accent && (
						<div
							className="w-6 h-6 rounded border border-input"
							style={{ backgroundColor: tokens.color.accent.seed }}
							title={`Accent: ${tokens.color.accent.seed}`}
						/>
					)}
					<span className="text-xs text-muted-foreground ml-2">Neutral: {tokens.color.neutral.character}</span>
					<span className="text-xs text-muted-foreground">· {tokens.color.surface} pages</span>
				</div>
				{scaleEntries.length > 0 && (
					<div className="flex gap-0.5 mt-1">
						{scaleEntries.map(([step, color]) => (
							<div
								className="w-4 h-4 rounded-sm"
								key={step}
								style={{ backgroundColor: color as string }}
								title={`${step}: ${color}`}
							/>
						))}
					</div>
				)}
			</Section>

			<Section onEdit={() => onEditStep(2)} title="Typography">
				<div className="text-xs text-muted-foreground">
					{tokens.typography.displayFamily && tokens.typography.displayFamily !== tokens.typography.fontFamily
						? `${tokens.typography.displayFamily} · ${tokens.typography.fontFamily}`
						: tokens.typography.fontFamily}{" "}
					· {tokens.typography.baseSize}px · ratio {tokens.typography.scaleRatio}
					{tokens.typography.weights &&
						` · weights ${tokens.typography.weights.display[0]}/${tokens.typography.weights.body[0]}`}
				</div>
			</Section>

			<Section onEdit={() => onEditStep(3)} title="Spacing">
				<div className="text-xs text-muted-foreground">
					Base unit: {tokens.spacing.baseUnit}px · {tokens.spacing.scale.length} steps
				</div>
			</Section>

			<Section onEdit={() => onEditStep(4)} title="Radius">
				<div className="flex items-center gap-2">
					<span className="text-xs text-muted-foreground capitalize">{tokens.radius.character}</span>
					<div className="flex gap-1">
						{tokens.radius.scale.slice(0, 4).map((v, i) => (
							<div
								className="w-4 h-4 border border-button-background/60"
								key={i}
								style={{ borderRadius: v === 9999 ? "9999px" : `${v}px` }}
							/>
						))}
					</div>
				</div>
			</Section>

			<Section onEdit={() => onEditStep(5)} title="Depth">
				<div className="text-xs text-muted-foreground capitalize">
					{tokens.elevation?.character ?? "subtle"} shadows · {tokens.border?.width ?? 1}px hairlines ·{" "}
					{tokens.border?.focusRing.width ?? 2}px focus ring
				</div>
			</Section>
		</div>
	)
}

function Section({ title, children, onEdit }: { title: string; children: React.ReactNode; onEdit: () => void }) {
	return (
		<div className="flex flex-col gap-1.5 p-3 rounded-md border border-input bg-input-background/30">
			<div className="flex items-center justify-between">
				<span className="text-xs font-medium text-foreground">{title}</span>
				<button className="text-[10px] text-button-background hover:underline" onClick={onEdit}>
					Edit
				</button>
			</div>
			{children}
		</div>
	)
}
