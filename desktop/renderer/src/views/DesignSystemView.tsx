/**
 * The design system, as a page — what a committed foundation looks like.
 *
 * Before this existed, committing the interview dropped the user onto the
 * canvas and the model's reasoning was destroyed with the scratch; the only
 * way to "see" the tokens was to reopen the manual editor. This surface is the
 * missing artifact: the palette by role, the type at real sizes, spacing,
 * corners, depth — plus the persisted rationale (`meta`) explaining why.
 *
 * Layered on purpose: the page leads with the simple story (name, summary,
 * restraint rule, swatches, specimens) a vibe coder glances at; the depth —
 * full ramps with hexes, contrast ratios, weights, shadow values, the
 * decisions log — sits in expandable detail for the design-savvy, so it is
 * there without confronting anyone who never asked for it.
 *
 * Each section edits in place with the manual editor's own step components on
 * a local draft; Save goes through the same merge as the editor, so `meta`
 * and every derived group survive.
 */
import { Loader2, Pencil } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { draftFromSaved, type FoundationTokensDraft, mergeDraftOverSaved } from "../components/design-wizard/draft"
import { ColorStep } from "../components/design-wizard/steps/ColorStep"
import { DepthStep } from "../components/design-wizard/steps/DepthStep"
import { RadiusStep } from "../components/design-wizard/steps/RadiusStep"
import { SpacingStep } from "../components/design-wizard/steps/SpacingStep"
import { TypographyStep } from "../components/design-wizard/steps/TypographyStep"
import { VibeStep } from "../components/design-wizard/steps/VibeStep"
import { cn } from "../lib/utils"
import { DesignServiceClient } from "../services/design-client"

type SectionId = "vibe" | "color" | "type" | "spacing" | "radius" | "depth"

interface Props {
	onRerunInterview(): void
	onEditByHand(): void
}

export function DesignSystemView({ onRerunInterview, onEditByHand }: Props) {
	const [raw, setRaw] = useState<Record<string, any> | null>(null)
	const [draft, setDraft] = useState<FoundationTokensDraft | null>(null)
	const [editing, setEditing] = useState<SectionId | null>(null)
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState("")
	const [loaded, setLoaded] = useState(false)

	const load = useCallback(async () => {
		try {
			const response = await DesignServiceClient.getFoundationTokens({})
			if (response.tokensJson && response.tokensJson !== "null") {
				const saved = JSON.parse(response.tokensJson)
				setRaw(saved)
				setDraft(draftFromSaved(saved))
			}
		} catch {
			// No readable tokens: the sections render empty and the footer still
			// offers the interview.
		} finally {
			setLoaded(true)
		}
	}, [])

	useEffect(() => {
		void load()
	}, [load])

	const save = useCallback(async () => {
		if (!draft) return
		setSaving(true)
		setError("")
		try {
			await DesignServiceClient.updateFoundationTokens({
				tokensJson: JSON.stringify(mergeDraftOverSaved(raw, draft)),
			})
			setEditing(null)
			await load()
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not save the change.")
		} finally {
			setSaving(false)
		}
	}, [draft, raw, load])

	const updateDraft = useCallback((next: FoundationTokensDraft) => setDraft(next), [])

	const cancel = useCallback(() => {
		if (raw) setDraft(draftFromSaved(raw))
		setEditing(null)
		setError("")
	}, [raw])

	useFonts([raw?.typography?.fontFamily, raw?.typography?.displayFamily].filter(Boolean) as string[])

	// The testid is on every branch: a probe must be able to tell "the DS view
	// is mounted but empty" apart from "the surface never rendered at all".
	if (!loaded) {
		return (
			<div className="flex flex-1 items-center justify-center text-shell-muted" data-testid="design-system-view">
				Loading…
			</div>
		)
	}
	if (!raw || !draft) {
		return (
			<div className="flex flex-1 items-center justify-center text-shell-muted" data-testid="design-system-view">
				No design system to show yet.
			</div>
		)
	}

	const meta = raw.meta as
		| { rule?: string; summary?: string; decisions?: Array<{ area: string; choice: string; reason: string }> }
		| undefined
	// A colour role neither present nor recorded as decided is a GAP the title
	// must flag — only judgeable when a decisions log exists at all.
	const hasDecisionLog = (meta?.decisions?.length ?? 0) > 0
	const colorHasGap =
		hasDecisionLog &&
		((!raw.color?.secondary && !areaDecided(meta?.decisions, "secondary-color", "supporting-colors")) ||
			(!raw.color?.accent && !areaDecided(meta?.decisions, "accent-color")))
	const displayFamily = raw.typography?.displayFamily || raw.typography?.fontFamily
	const name = displayFamily === raw.typography?.fontFamily ? displayFamily : `${displayFamily} · ${raw.typography?.fontFamily}`

	const section = (id: SectionId, title: string, view: React.ReactNode, editor: React.ReactNode, hasGap?: boolean) => (
		<section className="border-t border-shell-border py-6" data-testid={`ds-section-${id}`}>
			<div className="flex items-center justify-between">
				<h2 className="flex items-center gap-2 text-[11px] tracking-wider text-shell-muted uppercase">
					{/* The gap marker: findable while scrolling past sections. */}
					{hasGap && <span className="size-1.5 rounded-full bg-shell-warn" data-testid={`ds-gap-${id}`} />}
					{title}
				</h2>
				{editing !== id && (
					<button
						className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11.5px] text-shell-muted transition-colors hover:bg-white/5 hover:text-shell-text"
						data-testid={`ds-edit-${id}`}
						onClick={() => {
							cancel()
							setEditing(id)
						}}
						type="button">
						<Pencil size={11} />
						Edit
					</button>
				)}
			</div>
			{editing === id ? (
				<div className="mt-4">
					{editor}
					{error && <p className="mt-3 text-[12px] text-error">{error}</p>}
					<div className="mt-4 flex items-center gap-2">
						<button
							className="flex items-center gap-2 rounded-lg bg-caret-accent px-3 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-caret-accent-hover disabled:opacity-40"
							data-testid={`ds-save-${id}`}
							disabled={saving}
							onClick={save}
							type="button">
							{saving && <Loader2 className="animate-spin" size={12} />}
							Save
						</button>
						<button
							className="rounded-lg px-3 py-1.5 text-[12.5px] text-shell-muted transition-colors hover:bg-white/5"
							disabled={saving}
							onClick={cancel}
							type="button">
							Cancel
						</button>
					</div>
				</div>
			) : (
				<div className="mt-4">{view}</div>
			)}
		</section>
	)

	return (
		<div className="flex-1 overflow-auto bg-shell-bg" data-testid="design-system-view">
			<div className="mx-auto max-w-4xl px-8 py-10">
				<p className="text-[11px] tracking-wider text-shell-muted uppercase">This project's design system</p>
				<h1 className="mt-2 text-2xl font-medium">{name}</h1>
				{meta?.summary && <p className="mt-2 max-w-2xl leading-relaxed text-shell-muted">{meta.summary}</p>}
				{meta?.rule && (
					<p className="mt-4 max-w-2xl border-l-2 border-caret-accent/50 pl-3 text-[12.5px] leading-relaxed text-shell-muted">
						{meta.rule}
					</p>
				)}
				{(meta?.decisions?.length ?? 0) > 0 && (
					<details className="mt-4 max-w-2xl" data-testid="ds-decisions">
						<summary className="cursor-pointer text-[12px] text-shell-muted transition-colors hover:text-shell-text">
							How this was decided
						</summary>
						<ul className="mt-2 flex flex-col gap-1.5 border-l border-shell-border pl-3">
							{meta?.decisions?.map((decision) => (
								<li className="text-[12px] leading-relaxed" key={decision.area}>
									<span className="font-medium">{decision.choice}</span>
									<span className="text-shell-muted"> — {decision.reason}</span>
								</li>
							))}
						</ul>
					</details>
				)}

				<div className="mt-8">
					{section(
						"color",
						"Colour",
						<ColorSection color={raw.color} decisions={meta?.decisions} />,
						<div className="ds-editor">
							<ColorStep onChange={updateDraft} tokens={draft} />
						</div>,
						colorHasGap,
					)}
					{section(
						"type",
						"Typography",
						<TypeSection typography={raw.typography} />,
						<div className="ds-editor">
							<TypographyStep onChange={updateDraft} tokens={draft} />
						</div>,
					)}
					{section(
						"spacing",
						"Spacing",
						<SpacingSection spacing={raw.spacing} />,
						<div className="ds-editor">
							<SpacingStep onChange={updateDraft} tokens={draft} />
						</div>,
					)}
					{section(
						"radius",
						"Corners",
						<RadiusSection radius={raw.radius} />,
						<div className="ds-editor">
							<RadiusStep onChange={updateDraft} tokens={draft} />
						</div>,
					)}
					{section(
						"depth",
						"Depth & motion",
						<DepthSection border={raw.border} elevation={raw.elevation} motion={raw.motion} />,
						<div className="ds-editor">
							<DepthStep onChange={updateDraft} tokens={draft} />
						</div>,
					)}
					{section(
						"vibe",
						"Vibe",
						<VibeSection vibe={raw.vibe} />,
						<div className="ds-editor">
							<VibeStep onChange={updateDraft} tokens={draft} />
						</div>,
					)}
				</div>

				<div className="mt-8 flex items-center gap-2 border-t border-shell-border pt-6">
					<button
						className="rounded-lg bg-caret-accent px-4 py-2 font-medium text-white transition-colors hover:bg-caret-accent-hover"
						data-testid="ds-rerun"
						onClick={onRerunInterview}
						type="button">
						Re-run the interview
					</button>
					<button
						className="rounded-lg px-3 py-2 text-shell-muted transition-colors hover:bg-white/5"
						data-testid="ds-edit-by-hand"
						onClick={onEditByHand}
						type="button">
						Edit everything by hand
					</button>
				</div>
			</div>
		</div>
	)
}

// ── read-only sections ──────────────────────────────────────────────────────

function SwatchRow({ label, seed, scale, on }: { label: string; seed?: string; scale?: Record<string, string>; on?: string }) {
	if (!seed && !scale) return null
	const steps = Object.entries(scale ?? {})
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center gap-2">
				<span className="w-24 text-[12px] text-shell-muted">{label}</span>
				{seed && (
					<span className="flex items-center gap-1.5 text-[11px] text-shell-muted">
						<span className="inline-block size-3.5 rounded border border-white/10" style={{ background: seed }} />
						<span className="font-mono">{seed}</span>
					</span>
				)}
				{seed && on && <ContrastBadge bg={seed} fg={on} />}
			</div>
			{steps.length > 0 && (
				<details className="ml-24">
					<summary className="flex cursor-pointer list-none gap-0.5 [&::-webkit-details-marker]:hidden">
						{steps.map(([step, value]) => (
							<span
								className="inline-block h-5 w-6 first:rounded-l last:rounded-r"
								key={step}
								style={{ background: value }}
								title={`${step}: ${value}`}
							/>
						))}
					</summary>
					<div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
						{steps.map(([step, value]) => (
							<span className="font-mono text-[10px] text-shell-muted" key={step}>
								{step} {value}
							</span>
						))}
					</div>
				</details>
			)}
		</div>
	)
}

/**
 * How an ABSENT colour role reads. Absence has two meanings and they must not
 * look alike: a role the interview settled as "none" is a decision (muted,
 * calm); a role the interview never asked about is a gap (amber, glaring —
 * test4 committed with the accent never mentioned and nothing on this page
 * said so). Legacy foundations without a decisions log stay quiet: absence
 * there carries no evidence either way, and amber nagging on every manual
 * foundation would be noise.
 */
function AbsentRole({ label, decided, hasLog }: { label: string; decided: boolean; hasLog: boolean }) {
	if (!hasLog) return null
	if (decided) {
		return (
			<div className="flex items-center gap-2">
				<span className="w-24 text-[12px] text-shell-muted">{label}</span>
				<span className="text-[12px] text-shell-muted">None — chosen</span>
			</div>
		)
	}
	return (
		<div className="flex items-center gap-2" data-testid={`ds-notset-${label.toLowerCase()}`}>
			<span className="w-24 text-[12px] text-shell-muted">{label}</span>
			<span className="inline-flex items-center gap-2 rounded-lg border border-dashed border-shell-warn/55 px-2.5 py-0.5 text-[12px] text-shell-warn">
				Not set
				<span className="text-[11.5px] text-shell-muted">— the interview never settled this. Edit to pick one.</span>
			</span>
		</div>
	)
}

/** Decision-log lookup tolerant of the pre-split area name. */
function areaDecided(decisions: Array<{ area: string }> | undefined, ...areas: string[]): boolean {
	return (decisions ?? []).some((decision) => areas.includes(decision.area))
}

function ColorSection({ color, decisions }: { color: Record<string, any>; decisions?: Array<{ area: string }> }) {
	const on = color.on ?? {}
	const hasLog = (decisions?.length ?? 0) > 0
	return (
		<div className="flex flex-col gap-3">
			<SwatchRow label="Brand" on={on.brand} scale={color.brand?.scale} seed={color.brand?.seed} />
			{color.secondary ? (
				<SwatchRow label="Supporting" on={on.secondary} scale={color.secondary.scale} seed={color.secondary.seed} />
			) : (
				<AbsentRole
					decided={areaDecided(decisions, "secondary-color", "supporting-colors")}
					hasLog={hasLog}
					label="Supporting"
				/>
			)}
			{color.accent ? (
				<SwatchRow label="Accent" on={on.accent} scale={color.accent.scale} seed={color.accent.seed} />
			) : (
				/* The pre-split "supporting-colors" tag vouches only for the
				   secondary — that is what its one question actually asked; the
				   accent riding the same tag unasked is the bug the split fixed. */
				<AbsentRole decided={areaDecided(decisions, "accent-color")} hasLog={hasLog} label="Accent" />
			)}
			<SwatchRow label={`Neutral (${color.neutral?.character ?? "?"})`} scale={color.neutral?.scale} />
			<div className="flex items-center gap-2">
				<span className="w-24 text-[12px] text-shell-muted">Semantic</span>
				<div className="flex items-center gap-2.5">
					{Object.entries(color.semantic ?? {}).map(([key, value]) => (
						<span className="flex items-center gap-1 text-[11px] text-shell-muted" key={key}>
							<span
								className="inline-block size-3.5 rounded border border-white/10"
								style={{ background: value as string }}
							/>
							{key}
						</span>
					))}
				</div>
			</div>
			<div className="flex items-center gap-2 text-[12px] text-shell-muted">
				<span className="w-24">Surface</span>
				<span>{color.surface === "dark" ? "Dark pages" : "Light pages"}</span>
				{on.surfaceMuted && color.neutral?.scale && (
					<ContrastBadge
						bg={
							color.surface === "dark"
								? (color.neutral.scale["950"] ?? "#0a0a0a")
								: (color.neutral.scale["50"] ?? "#ffffff")
						}
						fg={on.surfaceMuted}
						label="muted text"
					/>
				)}
			</div>
		</div>
	)
}

function TypeSection({ typography }: { typography: Record<string, any> }) {
	const display = typography.displayFamily || typography.fontFamily
	const scale: Array<[string, number]> = Object.entries(typography.scale ?? {}).map(([label, size]) => [label, Number(size)])
	const order = ["5xl", "4xl", "3xl", "2xl", "xl", "lg", "base", "sm", "xs"]
	scale.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
	const leadings = typography.leadings ?? {}
	const displayWeight = typography.weights?.display?.[0] ?? 600

	return (
		<div className="flex flex-col gap-3">
			<p
				className="truncate leading-tight"
				style={{
					fontFamily: `"${display}", ${typography.displayFallback || "serif"}`,
					fontSize: 34,
					fontWeight: displayWeight,
					lineHeight: leadings["3xl"] ?? 1.15,
				}}>
				The quick brown fox jumps
			</p>
			<p
				className="max-w-xl"
				style={{
					fontFamily: `"${typography.fontFamily}", ${typography.fallback || "sans-serif"}`,
					fontSize: typography.baseSize ?? 16,
					fontWeight: typography.weights?.body?.[0] ?? 400,
					lineHeight: leadings.base ?? 1.5,
				}}>
				Body text at its real size, in the body face, with the leading pages actually get.
			</p>
			<p className="text-[12px] text-shell-muted">
				{display !== typography.fontFamily
					? `${display} for headings, ${typography.fontFamily} for body`
					: typography.fontFamily}{" "}
				· base {typography.baseSize}px · ratio {typography.scaleRatio}
				{typography.weights
					? ` · weights ${typography.weights.display?.join("/")} display, ${typography.weights.body?.join("/")} body`
					: ""}
			</p>
			<details>
				<summary className="cursor-pointer text-[12px] text-shell-muted transition-colors hover:text-shell-text">
					Full scale
				</summary>
				<table className="mt-2 text-[11.5px]">
					<tbody>
						{scale.map(([label, size]) => (
							<tr key={label}>
								<td className="pr-4 text-shell-muted">{label}</td>
								<td className="pr-4 font-mono">{Math.round(size * 100) / 100}px</td>
								<td className="font-mono text-shell-muted">×{leadings[label] ?? "—"}</td>
							</tr>
						))}
					</tbody>
				</table>
			</details>
		</div>
	)
}

function SpacingSection({ spacing }: { spacing: Record<string, any> }) {
	// Scale entries are px. Heights on a square-root curve: proportional bars
	// either dwarf the small steps or need a cap — and a cap drew 24 through 64
	// as four identical bars, which read as data and was noise.
	const steps: number[] = (spacing?.scale ?? []).filter((v: number) => v > 0)
	return (
		<div className="flex flex-col gap-3">
			{/* The decision leads, as a value — never prose. "The airier of the
			    two" buried the one fact this section records. */}
			<p className="text-[15px]">
				<span className="font-mono font-semibold">{spacing?.baseUnit ?? 4}px</span> base unit
				{steps.length > 0 && (
					<span className="ml-2 text-[12.5px] text-shell-muted">
						{steps.length} steps, {steps[0]}–{steps[steps.length - 1]}px
					</span>
				)}
			</p>
			<div className="flex items-end gap-2">
				{steps.map((px) => (
					<div className="flex flex-col items-center gap-1" key={px}>
						<span className="w-3.5 rounded-sm bg-caret-accent/60" style={{ height: Math.round(Math.sqrt(px) * 7) }} />
						<span className="font-mono text-[10.5px] text-shell-muted">{px}</span>
					</div>
				))}
			</div>
		</div>
	)
}

/** Scale positions ↔ the utility names pages write. 0 is `none` and the last is `full`. */
const RADIUS_STEP_NAMES = ["none", "sm", "md", "lg", "xl", "full"]

/** One honest phrase per character — data, not decoration. */
const RADIUS_GLOSS: Record<string, string> = {
	sharp: "square corners",
	soft: "gently rounded",
	round: "clearly rounded",
	pill: "fully rounded ends",
}

function RadiusSection({ radius }: { radius: Record<string, any> }) {
	const steps: Array<{ px: number; name: string }> = (radius?.scale ?? [])
		.map((px: number, index: number) => ({ px, name: RADIUS_STEP_NAMES[index] ?? String(index) }))
		.filter((step: { px: number }) => step.px < 9999)
	return (
		<div className="flex flex-col gap-3">
			<p className="text-[15px]">
				<span className="font-semibold capitalize">{radius?.character ?? "?"}</span>
				{RADIUS_GLOSS[radius?.character] && (
					<span className="ml-2 text-[12.5px] text-shell-muted">{RADIUS_GLOSS[radius?.character]}</span>
				)}
			</p>
			<div className="flex items-center gap-3.5">
				{steps.map((step) => (
					<div className="flex flex-col items-center gap-1" key={step.name}>
						<span
							className="size-9 border-2 border-caret-accent/60 bg-shell-panel"
							style={{ borderRadius: step.px }}
						/>
						<span className="font-mono text-[10.5px] text-shell-muted">
							{step.name} · {step.px}px
						</span>
					</div>
				))}
				<div className="flex flex-col items-center gap-1">
					<span className="size-9 rounded-full border-2 border-caret-accent/60 bg-shell-panel" />
					<span className="font-mono text-[10.5px] text-shell-muted">full</span>
				</div>
			</div>
		</div>
	)
}

function DepthSection({
	elevation,
	border,
	motion,
}: {
	elevation?: Record<string, any>
	border?: Record<string, any>
	motion?: Record<string, any>
}) {
	const shadows: Array<[string, string]> = Object.entries(elevation?.scale ?? {}).filter(
		([, value]) => value && value !== "none",
	) as Array<[string, string]>
	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center gap-4">
				{shadows.length === 0 && <span className="text-[12px] text-shell-muted">Flat — no shadows.</span>}
				{shadows.map(([label, value]) => (
					<div className="flex flex-col items-center gap-1.5" key={label}>
						<span className="h-10 w-16 rounded-md bg-white" style={{ boxShadow: value }} />
						<span className="text-[9px] text-shell-muted">{label}</span>
					</div>
				))}
				<span className="text-[12px] capitalize text-shell-muted">{elevation?.character ?? "subtle"}</span>
			</div>
			{border && (
				<p className="text-[12px] text-shell-muted">
					Hairlines {border.width}px in <span className="font-mono">{border.color}</span> · focus ring{" "}
					{border.focusRing?.width}px in <span className="font-mono">{border.focusRing?.color}</span>
				</p>
			)}
			{motion && (
				<p className="text-[12px] text-shell-muted" data-testid="ds-motion">
					Motion (derived): {motion.durations?.fast}ms / {motion.durations?.base}ms / {motion.durations?.slow}ms
				</p>
			)}
		</div>
	)
}

function VibeSection({ vibe }: { vibe: Record<string, any> }) {
	return (
		<div className="flex flex-col gap-2">
			{vibe?.description && (
				<p className="max-w-2xl text-[12.5px] italic leading-relaxed text-shell-muted">"{vibe.description}"</p>
			)}
			<div className="flex flex-wrap gap-1.5">
				{(vibe?.tags ?? []).map((tag: string) => (
					<span className="rounded-full border border-shell-border px-2 py-0.5 text-[11px] text-shell-muted" key={tag}>
						{tag}
					</span>
				))}
			</div>
		</div>
	)
}

/** "7.2:1 AA" on the pairing the foundation guarantees. */
function ContrastBadge({ bg, fg, label }: { bg: string; fg: string; label?: string }) {
	const ratio = contrastRatio(bg, fg)
	const grade = ratio >= 7 ? "AAA" : ratio >= 4.5 ? "AA" : "—"
	return (
		<span
			className={cn(
				"rounded px-1.5 py-0.5 font-mono text-[9.5px]",
				grade === "—" ? "bg-error/15 text-error" : "bg-white/5 text-shell-muted",
			)}
			title={`${label ?? "text"} on this colour: ${ratio.toFixed(2)}:1`}>
			{ratio.toFixed(1)}:1 {grade}
		</span>
	)
}

function luminance(hex: string): number {
	const value = hex.replace("#", "")
	if (value.length < 6) return 0
	const [r, g, b] = [0, 2, 4]
		.map((i) => Number.parseInt(value.slice(i, i + 2), 16) / 255)
		.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
	return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(a: string, b: string): number {
	const la = luminance(a)
	const lb = luminance(b)
	const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
	return (hi + 0.05) / (lo + 0.05)
}

/** Loads Google Fonts stylesheets for the faces the specimens show. */
function useFonts(families: string[]): void {
	const key = [...new Set(families.filter(Boolean))].sort().join("|")
	useEffect(() => {
		if (!key) return
		const url = `https://fonts.googleapis.com/css2?${key
			.split("|")
			.map((family) => `family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@400;500;600;700`)
			.join("&")}&display=swap`
		const link = document.createElement("link")
		link.rel = "stylesheet"
		link.href = url
		document.head.appendChild(link)
		return () => link.remove()
	}, [key])
}
