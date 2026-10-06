/**
 * The one flow into a design system.
 *
 * Two shapes, chosen by what is already in the folder:
 *
 * - **An existing app** opens on three routes, the first recommended: read the
 *   look the app already has, design a new one with the AI, or set it by hand.
 *   Asking someone with a finished app "what are you building?" was a chore —
 *   their app already tells the story — and telemetry showed four of five
 *   people leaving this screen within twenty seconds without pressing anything.
 * - **A fresh folder** opens on the description, with the two routes as its
 *   submit buttons. The subheading says what each does, so the buttons do not
 *   need explaining twice.
 *
 * Detection only decides which shape is shown; "is there an app here?" needs no
 * judgement. Reading the app's look does, which is why that route is a model
 * route like the interview (see `fromAppSystemPrompt`).
 *
 * TWO interview doors, not three, still holds: the AI-led mode was removed
 * 2026-08-31 after it shipped decisions nobody was asked about. From-app is
 * not a third interview of taste — its opening screen is the app's own
 * decisions, each with the file it came from, for the user to confirm.
 */
import { ArrowLeft, ArrowRight, FileSearch, PenTool, Sparkles } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import type { AppProfileWire, WizardModeWire } from "../../../shared/ipc"
import { invoke } from "../ipc"
import { cn } from "../lib/utils"
import { SetupStepper } from "./Setup"

type SetupRoute = "from-app" | "ai-new-look" | "ai-describe" | "manual"

interface Props {
	/** The app already in the folder, or null for a fresh project. */
	app: AppProfileWire | null
	/** Setup is still on step 1 (no committed design system) — shows the stepper. */
	settingUp: boolean
	/** An interview should begin; the wizard surface runs the first turn. */
	onStart(mode: WizardModeWire, description: string): void
	onManual(description: string): void
	/** Preview harness only: open on the describe screen with a canned description. */
	__previewDescription?: string
}

function reportRoute(route: SetupRoute, hasAppCode: boolean): void {
	void invoke("analytics:event", "setup_route_chosen", { route, hasAppCode })
}

export function FoundationEntry({ app, settingUp, onStart, onManual, __previewDescription }: Props) {
	// An existing app opens on its routes; "design a new look" leads here.
	const [describing, setDescribing] = useState(app === null || __previewDescription !== undefined)

	return (
		<div className="flex-1 overflow-auto" data-testid="foundation-entry">
			<div className="mx-auto max-w-3xl px-8 py-10">
				{settingUp && <SetupStepper step={1} />}
				{describing ? (
					<Describe
						canGoBack={app !== null}
						initial={__previewDescription ?? ""}
						onAi={(description) => {
							reportRoute("ai-describe", app !== null)
							onStart("collaborative", description)
						}}
						onBack={() => setDescribing(false)}
						onManual={(description) => {
							reportRoute("manual", app !== null)
							onManual(description)
						}}
					/>
				) : (
					app && (
						<Routes
							app={app}
							onFromApp={() => {
								reportRoute("from-app", true)
								onStart("from-app", "")
							}}
							onManual={() => {
								reportRoute("manual", true)
								onManual("")
							}}
							onNewLook={() => {
								reportRoute("ai-new-look", true)
								setDescribing(true)
							}}
						/>
					)
				)}
			</div>
		</div>
	)
}

function Routes({
	app,
	onFromApp,
	onNewLook,
	onManual,
}: {
	app: AppProfileWire
	onFromApp(): void
	onNewLook(): void
	onManual(): void
}) {
	// What was detected, named only when it actually was — a plain-CSS app is
	// not told it uses Tailwind.
	const found = [app.framework, ...app.styling].filter((part): part is string => Boolean(part))

	return (
		<div className="fade-in">
			<h1 className="text-2xl font-medium">Start with your design system</h1>
			<p className="mt-2 max-w-xl leading-relaxed text-shell-muted">
				Caret styles every page from it: colours, type, spacing, corners. Set it once here and nothing you make later
				needs restyling.
			</p>

			{/* Context for the heading, not a choice: no box, no fill — a bordered
			    panel here read as a fourth option. */}
			<div
				className="mt-3.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]"
				data-testid="foundation-app-detected">
				<span aria-hidden className="text-emerald-400">
					✓
				</span>
				<span>Found an existing app in this folder</span>
				{found.length > 0 && <span className="text-[12px] text-shell-muted">{found.join(" · ")}</span>}
			</div>

			<p className="mt-9 text-[11px] tracking-wider text-shell-muted uppercase">How do you want to set it up?</p>
			<div className="mt-3 grid gap-3">
				<RouteCard
					icon={<FileSearch size={16} />}
					onClick={onFromApp}
					recommended
					testid="foundation-route-from-app"
					title="Use what my app already has"
					what="The AI reads your colours, fonts, spacing and corners from your code, then shows you what it found with the file each came from. Keep it, change a piece, or fill any gaps. Nothing in your app is touched."
				/>
				<RouteCard
					icon={<Sparkles size={16} />}
					onClick={onNewLook}
					testid="foundation-route-new-look"
					title="Design a new look with the AI"
					what="For a redesign or a fresh direction. A short interview with a recommendation on every screen."
				/>
				<RouteCard
					icon={<PenTool size={16} />}
					onClick={onManual}
					testid="foundation-route-manual"
					title="Set it by hand"
					what="The token editor, no AI."
				/>
			</div>
		</div>
	)
}

function RouteCard({
	icon,
	title,
	what,
	recommended,
	testid,
	onClick,
}: {
	icon: React.ReactNode
	title: string
	what: string
	recommended?: boolean
	testid: string
	onClick(): void
}) {
	return (
		<button
			className={cn(
				"flex items-start gap-4 rounded-xl border bg-shell-panel px-5 py-4 text-left transition-colors hover:border-caret-accent/60",
				recommended ? "border-caret-accent/60" : "border-shell-border",
			)}
			data-testid={testid}
			onClick={onClick}
			type="button">
			<span className="mt-0.5 rounded-lg bg-caret-accent/10 p-2 text-caret-accent">{icon}</span>
			<span className="min-w-0">
				<span className="flex flex-wrap items-center gap-2 font-medium">
					{title}
					{recommended && (
						<span className="rounded-full bg-caret-accent px-2 py-px text-[10.5px] font-medium text-white">
							Recommended
						</span>
					)}
				</span>
				<span className="mt-1 block text-[12.5px] leading-relaxed text-shell-muted">{what}</span>
			</span>
		</button>
	)
}

function Describe({
	initial,
	canGoBack,
	onBack,
	onAi,
	onManual,
}: {
	initial: string
	canGoBack: boolean
	onBack(): void
	onAi(description: string): void
	onManual(description: string): void
}) {
	const [description, setDescription] = useState(initial)
	const ref = useRef<HTMLTextAreaElement>(null)
	useEffect(() => ref.current?.focus(), [])
	const ready = description.trim().length >= 8

	return (
		<div className="fade-in">
			{canGoBack && (
				<button
					className="mb-3 flex items-center gap-1 text-[11.5px] text-shell-muted transition-colors hover:text-shell-text"
					data-testid="foundation-describe-back"
					onClick={onBack}
					type="button">
					<ArrowLeft size={12} />
					Back
				</button>
			)}
			<h1 className="text-2xl font-medium">Start with your design system</h1>
			<p className="mt-2 max-w-xl leading-relaxed text-shell-muted">
				Caret styles every page from it. Describe what you're making, then choose how to build it: explore it with the AI,
				which recommends every colour, font and spacing choice for you to accept or change, or set every token yourself by
				hand.
			</p>

			{/* The routes are this box's submit buttons, so they sit on it. */}
			<div className="mt-5 rounded-xl border border-caret-accent/50 bg-shell-panel">
				<textarea
					className="block min-h-24 w-full resize-none rounded-t-xl bg-transparent px-4 py-3 leading-relaxed outline-none"
					data-testid="foundation-describe"
					onChange={(event) => setDescription(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey && ready) {
							event.preventDefault()
							onAi(description.trim())
						}
					}}
					placeholder="A dashboard where support teams triage tickets all day. Dark, calm, serious."
					ref={ref}
					value={description}
				/>
				<div className="flex items-center justify-end gap-2 border-t border-shell-border px-3 py-2.5">
					<button
						className="rounded-lg border border-shell-border px-3.5 py-1.5 transition-colors hover:bg-white/5 disabled:opacity-40"
						data-testid="foundation-mode-manual"
						disabled={!ready}
						onClick={() => onManual(description.trim())}
						type="button">
						Set it by hand
					</button>
					<button
						className="flex items-center gap-1.5 rounded-lg bg-caret-accent px-3.5 py-1.5 font-medium text-white transition-colors hover:bg-caret-accent-hover disabled:opacity-40"
						data-testid="foundation-mode-collaborative"
						disabled={!ready}
						onClick={() => onAi(description.trim())}
						type="button">
						Explore it with the AI
						<ArrowRight size={13} />
					</button>
				</div>
			</div>
		</div>
	)
}
