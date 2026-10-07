/**
 * The two-step setup a new project walks: a design system, then a first page.
 *
 * Telemetry showed what the old flow did to people: every project opened on
 * the interview, nothing said why it mattered, and four of five left for
 * another tab within twenty seconds — where nothing explained that those tabs
 * depend on the design system. These pieces make the path visible without
 * locking anything: the pill is always one click from the next step, and a
 * tab that needs the design system says so and still lets you look.
 */
import { ArrowRight, Check, Images, LayoutGrid } from "lucide-react"

import type { ProjectState } from "../../../shared/ipc"
import { cn } from "../lib/utils"

/** 1 = design system, 2 = first page, null = set up. */
export type SetupStep = 1 | 2 | null

export function setupStepOf(project: Pick<ProjectState, "hasFoundation" | "hasPages">): SetupStep {
	if (!project.hasFoundation) return 1
	if (!project.hasPages) return 2
	return null
}

/** What the composer is seeded with when step 2 opens the chat. */
export const FIRST_PAGE_SEED = "Make a "

/** The top-bar pill: where you are, and the way back to the next step. */
export function SetupPill({ step, onClick }: { step: 1 | 2; onClick(): void }) {
	return (
		<button
			className="flex shrink-0 items-center gap-2 rounded-full border border-caret-accent/35 bg-caret-accent/10 py-1 pr-2.5 pl-1.5 text-[11.5px] text-[#a9cfff] transition-colors hover:bg-caret-accent/15"
			data-testid="setup-pill"
			onClick={onClick}
			title={step === 1 ? "Set up your design system" : "Make your first page"}
			type="button">
			<span aria-hidden className="flex gap-[3px]">
				<i className={cn("block h-1 w-3.5 rounded-sm", step === 1 ? "bg-caret-accent" : "bg-emerald-500")} />
				<i className={cn("block h-1 w-3.5 rounded-sm", step === 2 ? "bg-caret-accent" : "bg-caret-accent/30")} />
			</span>
			Setup · step {step} of 2
		</button>
	)
}

/** The numbered steps at the top of every setup screen. */
export function SetupStepper({ step }: { step: 1 | 2 }) {
	return (
		<div className="mb-5 flex items-center gap-2 text-[11.5px] text-shell-muted" data-testid="setup-stepper">
			<StepDot done={step > 1} label="Design system" n={1} now={step === 1} />
			<span className="h-px w-6 bg-shell-border" />
			<StepDot done={false} label="First page" n={2} now={step === 2} />
		</div>
	)
}

function StepDot({ n, label, now, done }: { n: number; label: string; now: boolean; done: boolean }) {
	return (
		<span className={cn("flex items-center gap-1.5", now && "text-shell-text")}>
			<span
				className={cn(
					"flex size-[18px] items-center justify-center rounded-full border border-shell-border text-[10.5px]",
					now && "border-caret-accent bg-caret-accent text-white",
					done && "border-emerald-500/40 bg-emerald-500/15 text-emerald-400",
				)}>
				{done ? <Check size={10} strokeWidth={3} /> : n}
			</span>
			{label}
		</span>
	)
}

/**
 * Shown in the canvas's place while there is no page to show. The native view
 * is parked meanwhile — an empty grid with no explanation is what people saw
 * before, and nothing on it pointed anywhere.
 */
export function CanvasSetup({
	step,
	hasApp,
	onContinueSetup,
	onMakeFirstPage,
}: {
	step: 1 | 2
	/** An existing app's step 2 is bringing its screens in, which lives on Foundation. */
	hasApp?: boolean
	onContinueSetup(): void
	onMakeFirstPage(): void
}) {
	const importStep = step === 2 && hasApp
	return (
		<div className="flex flex-1 items-center justify-center bg-shell-bg p-6 text-center" data-testid="canvas-setup">
			<div className="max-w-md">
				<div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-xl border border-shell-border bg-shell-panel text-shell-muted">
					<LayoutGrid size={20} />
				</div>
				<h2 className="text-[17px] font-medium">Your pages will live here</h2>
				<p className="mt-2 leading-relaxed text-shell-muted">
					Click any text or colour on them and change it, and the change is written into the file.
				</p>
				<div className="mx-auto mt-5 inline-flex flex-col items-start gap-2 text-left">
					<StepDot done={step > 1} label="Set up your design system" n={1} now={step === 1} />
					<StepDot
						done={false}
						label={hasApp ? "Bring in your app's screens" : "Make your first page"}
						n={2}
						now={step === 2}
					/>
				</div>
				<div className="mt-5">
					<button
						className="inline-flex items-center gap-2 rounded-lg bg-caret-accent px-4 py-2 font-medium text-white transition-colors hover:bg-caret-accent-hover"
						data-testid="canvas-setup-continue"
						onClick={step === 1 || importStep ? onContinueSetup : onMakeFirstPage}
						type="button">
						{step === 1 ? "Continue setup" : importStep ? "Bring in your app's screens" : "Make your first page"}
						<ArrowRight size={14} />
					</button>
				</div>
			</div>
		</div>
	)
}

/**
 * Covers the asset library until the design system exists. Not a lock: the
 * library works without one, it just cannot match a look that is not decided
 * yet — which is worth one sentence before someone generates ten images.
 */
export function AssetsBeforeSetup({ onBack, onLookAround }: { onBack(): void; onLookAround(): void }) {
	return (
		<div className="flex flex-1 items-center justify-center bg-shell-bg p-6 text-center" data-testid="assets-before-setup">
			<div className="max-w-md">
				<div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-xl border border-shell-border bg-shell-panel text-shell-muted">
					<Images size={20} />
				</div>
				<h2 className="text-[17px] font-medium">Images here are made to match your design system</h2>
				<p className="mt-2 leading-relaxed text-shell-muted">
					Set it up first and every image, icon and illustration picks up your colours and style. It takes a couple of
					minutes.
				</p>
				<div className="mt-5 flex justify-center gap-2">
					<button
						className="rounded-lg bg-caret-accent px-4 py-2 font-medium text-white transition-colors hover:bg-caret-accent-hover"
						data-testid="assets-back-to-setup"
						onClick={onBack}
						type="button">
						Back to setup
					</button>
					<button
						className="rounded-lg border border-shell-border px-4 py-2 transition-colors hover:bg-white/5"
						data-testid="assets-look-around"
						onClick={onLookAround}
						type="button">
						Look around anyway
					</button>
				</div>
			</div>
		</div>
	)
}

/** Step 2's door on the design-system page: the next thing to do, pinned on top. */
export function FirstPageCard({ onMakePage }: { onMakePage(): void }) {
	return (
		<div
			className="mb-6 flex items-center gap-4 rounded-xl border border-caret-accent/60 bg-shell-panel px-5 py-4"
			data-testid="first-page-card">
			<div className="min-w-0 flex-1">
				<div className="font-medium">Make your first page</div>
				<div className="mt-0.5 text-[12.5px] text-shell-muted">
					Describe a page and Caret writes it in this design system, as real React you can edit on the canvas.
				</div>
			</div>
			<button
				className="shrink-0 rounded-lg bg-caret-accent px-4 py-2 font-medium text-white transition-colors hover:bg-caret-accent-hover"
				data-testid="first-page-make"
				onClick={onMakePage}
				type="button">
				Make a page
			</button>
		</div>
	)
}
