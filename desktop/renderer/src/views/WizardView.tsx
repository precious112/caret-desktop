/**
 * The AI interview, as the user meets it.
 *
 * Caret runs the interview: the engine decides the topic and how it is shown,
 * and this screen draws it. The model only wrote the words and the options.
 *
 * Everything shown comes from the engine's one reading of the answers
 * (`state`): the Covering list, So far and the preview never work anything
 * out on their own. Answers are built with the same functions the engine uses
 * to check them (`interview/answers.ts`), so what this screen lets through is
 * exactly what the engine accepts. A typed value Caret can't save is refused
 * here, with the reason, before anything is sent.
 *
 * - The recommendation is preselected: pressing straight through lands on a
 *   foundation the model would defend.
 * - Specimens over labels: an option shows what it would produce.
 * - The user's own value is always possible: a colour picker, a font search,
 *   their own sizes, their own status colours.
 */
import { ArrowLeft, Check, Loader2, Pipette, Search, Sparkles } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import {
	type AreaOption,
	type AreaQuestion,
	type OwnRaw,
	optionAnswer,
	ownAnswer,
	skipAnswer,
} from "../../../../src/core/design/interview/answers"
import { AREAS, type AreaId, specOf } from "../../../../src/core/design/interview/areas"
import type { AreaAnswer, InterviewState, OpeningStatement, Verdict } from "../../../../src/core/design/interview/state"
import type { SpecimenParams } from "../../../../src/core/design/interview/widgets"
import type { InterviewModeWire, InterviewWire } from "../../../shared/ipc"
import { invoke, on } from "../ipc"
import { cn } from "../lib/utils"
import { ConnectModel } from "./ConnectModel"

interface Props {
	projectPath: string
	/** What the Foundation tab found in progress, when it resumed an interview. */
	initialState?: InterviewWire | null
	/** An interview to begin on mount, behind the "thinking" screen. */
	start?: { mode: InterviewModeWire; description: string } | null
	/** Shown above the interview while setup is on step 1. */
	header?: React.ReactNode
	/** The Backend tab, offered by the connect step for MCP users. */
	onOpenBackend?(): void
	onCommitted(name: string): void
	/** "Set tokens by hand": the interview is thrown away first. */
	onSwitchToManual(): void
	/** Nothing was in progress; the Foundation tab decides what comes next. */
	onNothingInFlight?(): void
}

export function WizardView({
	projectPath,
	initialState,
	start,
	header,
	onOpenBackend,
	onCommitted,
	onSwitchToManual,
	onNothingInFlight,
}: Props) {
	const [wire, setWire] = useState<InterviewWire | null>(initialState ?? null)
	const [busy, setBusy] = useState(!initialState)
	const [attempt, setAttempt] = useState(1)
	const fromApp = (wire && "mode" in wire ? wire.mode : start?.mode) === "from-app"

	useEffect(
		() =>
			on("wizard:progress", (progress) => {
				if (progress.projectPath === projectPath) setAttempt(progress.attempt)
			}),
		[projectPath],
	)

	// Once per mount, even where React runs mount effects twice (StrictMode in
	// development). The engine also merges a duplicate start.
	const started = useRef(false)
	useEffect(() => {
		if (initialState || !start || started.current) return
		started.current = true
		void transition(() => invoke("wizard:start", projectPath, start.description, start.mode))
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	useEffect(() => {
		if (initialState || start) return
		let cancelled = false
		void invoke("wizard:resume", projectPath)
			.then((resumed) => {
				if (cancelled) return
				if (resumed) setWire(resumed)
				else onNothingInFlight?.()
			})
			.finally(() => !cancelled && setBusy(false))
		return () => {
			cancelled = true
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [projectPath])

	async function transition(run: () => Promise<InterviewWire>) {
		setBusy(true)
		setAttempt(1)
		try {
			setWire(await run())
		} catch (err) {
			setWire((previous) => ({
				phase: "error",
				mode: previous && "mode" in previous ? previous.mode : (start?.mode ?? "collaborative"),
				stage: "unknown",
				message: err instanceof Error ? err.message : String(err),
				canFinish: false,
				state: previous && "state" in previous ? previous.state : emptyState(),
			}))
		} finally {
			setBusy(false)
		}
	}

	const leaveForManual = () => {
		void invoke("wizard:abandon", projectPath).finally(onSwitchToManual)
	}

	if (!wire && !busy) return <Centered>Nothing in progress.</Centered>
	const state = wire && "state" in wire ? wire.state : null

	return (
		<div className="flex-1 overflow-auto bg-shell-bg" data-testid="wizard">
			<div className="mx-auto max-w-5xl px-8 pt-10">{header}</div>
			<div className={cn("mx-auto flex max-w-5xl gap-8 px-8 pb-10", !header && "pt-10")}>
				<div className="min-w-0 flex-1">
					{busy &&
						(!wire || wire.phase === "needs-backend" || wire.phase === "opening" || wire.phase === "question") && (
							<Thinking attempt={attempt} first={!state || state.position.index <= 1} fromApp={fromApp} />
						)}

					{wire?.phase === "needs-backend" && !busy && (
						<ConnectModel
							detail={wire.detail}
							onManual={leaveForManual}
							onOpenBackend={onOpenBackend}
							onReady={() =>
								transition(() =>
									start
										? invoke("wizard:start", projectPath, start.description, start.mode)
										: invoke("wizard:retry", projectPath),
								)
							}
						/>
					)}

					{wire?.phase === "opening" && !busy && (
						<Opening
							fromApp={wire.mode === "from-app"}
							key="opening"
							onContinue={(verdicts) => transition(() => invoke("wizard:openingAnswer", projectPath, verdicts))}
							question={wire.question}
							statements={wire.statements}
						/>
					)}

					{wire?.phase === "question" && !busy && (
						<Question
							key={wire.question.id}
							onAnswer={(answer) => transition(() => invoke("wizard:answer", projectPath, answer))}
							onBack={wire.canBack ? () => transition(() => invoke("wizard:back", projectPath)) : undefined}
							// Available once anything is settled (an answer, or a line agreed on the
							// opening screen): starting from an app, the opening screen may settle
							// nearly everything, and the one question left still needs the way out.
							onFinishNow={
								wire.canBack ? () => transition(() => invoke("wizard:finishNow", projectPath)) : undefined
							}
							previous={wire.previous}
							question={wire.question}
							state={wire.state}
						/>
					)}

					{wire?.phase === "finish" && (
						<Finish
							busy={busy}
							onBack={() => transition(() => invoke("wizard:back", projectPath))}
							onCommit={() =>
								transition(async () => {
									const result = await invoke("wizard:commit", projectPath)
									onCommitted(result.name)
									return wire
								})
							}
							wire={wire}
						/>
					)}

					{wire?.phase === "error" && (
						<ErrorScreen
							busy={busy}
							canFinish={wire.canFinish}
							message={wire.message}
							onFinishNow={() => transition(() => invoke("wizard:finishNow", projectPath))}
							onManual={leaveForManual}
							onRetry={() => transition(() => invoke("wizard:retry", projectPath))}
						/>
					)}
				</div>

				{state && wire?.phase !== "needs-backend" && (
					<div className="hidden w-56 shrink-0 flex-col gap-7 lg:flex">
						<Coverage now={wire?.phase === "question" ? wire.question.area : null} state={state} />
						<SoFar state={state} />
					</div>
				)}
			</div>
		</div>
	)
}

function emptyState(): InterviewState {
	return {
		stage: "opening",
		areas: {} as InterviewState["areas"],
		next: null,
		position: { index: 1, total: 12 },
		coverage: [],
		soFar: [],
		spec: {},
		values: null,
	}
}

function Centered({ children }: { children: React.ReactNode }) {
	return <div className="flex flex-1 items-center justify-center bg-shell-bg text-shell-muted">{children}</div>
}

// ── screens ─────────────────────────────────────────────────────────────────

function Thinking({ first, attempt, fromApp }: { first: boolean; attempt: number; fromApp: boolean }) {
	return (
		<div className="fade-in flex flex-col gap-2 py-16" data-testid="wizard-thinking">
			<div className="flex items-center gap-3 text-shell-muted">
				<Loader2 className="animate-spin text-caret-accent" size={15} />
				{first ? (fromApp ? "Reading your app's styles…" : "Reading your description…") : "Writing the next question…"}
			</div>
			{first && fromApp && (
				<p className="pl-7 text-[12.5px] text-shell-muted">
					Looking through your stylesheets, theme files and components. Only reading: nothing in your app changes.
				</p>
			)}
			{attempt >= 2 && (
				<p className="pl-7 text-[12.5px] text-shell-muted" data-testid="wizard-thinking-slow">
					This is taking longer than usual. Still working on it.
				</p>
			)}
		</div>
	)
}

/** "Here's what I took from your description": each line starts agreed; "Not quite" asks what is true instead. */
function Opening({
	question,
	statements,
	fromApp,
	onContinue,
}: {
	question: string
	statements: OpeningStatement[]
	fromApp: boolean
	onContinue(verdicts: Verdict[]): void
}) {
	const [notes, setNotes] = useState<Record<string, string | null>>({})
	const verdicts: Verdict[] = statements.map((statement) => {
		const note = notes[statement.id]
		return note !== undefined && note !== null && note.trim()
			? { statementId: statement.id, verdict: "corrected", note: note.trim() }
			: { statementId: statement.id, verdict: "confirmed" }
	})
	// "Not quite" with nothing typed can't be sent: the topic would reopen with no hint of what is true.
	const waiting = statements.some((s) => notes[s.id] !== undefined && notes[s.id] !== null && !notes[s.id]?.trim())

	return (
		<div className="fade-in" data-testid="wizard-opening">
			<p className="text-[11px] tracking-wider text-shell-muted uppercase">Before the questions</p>
			<h1 className="mt-3 text-2xl font-medium">{question}</h1>
			<p className="mt-1.5 max-w-2xl leading-relaxed text-shell-muted">
				{fromApp
					? 'These start agreed. Press "Not quite" on anything that\'s wrong, and that part gets its own question.'
					: 'These start agreed. Press "Not quite" on anything that\'s wrong, and that topic gets its own question.'}
			</p>
			<div className="mt-6 flex flex-col gap-2">
				{statements.map((statement) => {
					const disagreeing = notes[statement.id] !== undefined && notes[statement.id] !== null
					return (
						<div
							className={cn(
								"rounded-xl border px-4 py-3",
								disagreeing ? "border-caret-accent/50" : "border-shell-border",
							)}
							data-area={statement.area}
							data-testid="wizard-statement"
							key={statement.id}>
							<div className="flex items-start justify-between gap-3">
								<div className="flex items-start gap-2.5">
									<span
										className={cn(
											"mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
											disagreeing
												? "border-shell-muted/50"
												: "border-caret-accent bg-caret-accent text-white",
										)}>
										{!disagreeing && <Check size={10} strokeWidth={3} />}
									</span>
									<div>
										<p className="leading-relaxed">
											{statement.text}
											<span className="ml-2 rounded border border-shell-border px-1.5 py-px text-[10.5px] text-shell-muted">
												{AREAS[statement.area].label}
											</span>
										</p>
										{statement.source && (
											<p className="mt-0.5 text-[11.5px] text-shell-muted">From {statement.source}</p>
										)}
									</div>
								</div>
								<button
									className="shrink-0 rounded-lg px-2 py-1 text-[11.5px] text-shell-muted transition-colors hover:bg-white/5 hover:text-shell-text"
									data-testid="wizard-not-quite"
									onClick={() =>
										setNotes((previous) => ({ ...previous, [statement.id]: disagreeing ? null : "" }))
									}
									type="button">
									{disagreeing ? "Never mind" : "Not quite"}
								</button>
							</div>
							{disagreeing && (
								<input
									autoFocus
									className="mt-2.5 w-full rounded-lg border border-shell-border bg-shell-panel px-3 py-1.5 text-[12.5px] outline-none focus:border-caret-accent/60"
									data-testid="wizard-correction"
									onChange={(event) =>
										setNotes((previous) => ({ ...previous, [statement.id]: event.target.value }))
									}
									placeholder="What's true instead?"
									value={notes[statement.id] ?? ""}
								/>
							)}
						</div>
					)
				})}
			</div>
			<div className="mt-7 flex items-center gap-2">
				<button
					className="rounded-lg bg-caret-accent px-4 py-2 font-medium text-white transition-colors hover:bg-caret-accent-hover disabled:opacity-40"
					data-testid="wizard-continue"
					disabled={waiting}
					onClick={() => onContinue(verdicts)}
					type="button">
					Continue
				</button>
			</div>
		</div>
	)
}

/**
 * One question. The selected card and whatever is typed into the own-answer
 * box are held here, in one place: the answer is worked out from them on every
 * render, so clearing the box always falls back to the selected card, and
 * clicking a card always makes it the answer.
 */
function Question({
	question,
	state,
	previous,
	onAnswer,
	onBack,
	onFinishNow,
}: {
	question: AreaQuestion
	state: InterviewState
	previous?: AreaAnswer
	onAnswer(answer: AreaAnswer): void
	onBack?: () => void
	onFinishNow?: () => void
}) {
	const spec = AREAS[question.area]
	const [selected, setSelected] = useState(
		previous?.optionId && question.options.some((o) => o.id === previous.optionId)
			? previous.optionId
			: question.recommendedId,
	)
	const [own, setOwn] = useState<OwnRaw | null>(() => (previous?.via === "own" ? ownRawOf(question.area, previous) : null))

	const result = own ? ownAnswer(question, own, selected) : ({ kind: "empty" } as const)
	const answer: AreaAnswer | null =
		result.kind === "answer" ? result.answer : result.kind === "refused" ? null : optionAnswer(question, selected)
	const usingOwn = result.kind === "answer"

	const pick = (optionId: string) => {
		setSelected(optionId)
		setOwn(null)
	}
	const base = state.spec
	const selectedOption = question.options.find((o) => o.id === selected)

	return (
		<div className="fade-in" data-area={question.area} data-testid="wizard-question">
			<div className="flex items-center justify-between">
				<p className="text-[11px] tracking-wider text-shell-muted uppercase" data-testid="wizard-position">
					Question {state.position.index} of {state.position.total} · {spec.label}
				</p>
				{onBack && (
					<button
						className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11.5px] text-shell-muted transition-colors hover:bg-white/5 hover:text-shell-text"
						data-testid="wizard-back"
						onClick={onBack}
						type="button">
						<ArrowLeft size={12} />
						Back
					</button>
				)}
			</div>

			<h1 className="mt-3 text-2xl font-medium">{question.question}</h1>
			{question.why && <p className="mt-1.5 max-w-2xl leading-relaxed text-shell-muted">{question.why}</p>}

			<div className="mt-6">
				{question.input === "slider" ? (
					<SliderInput base={base} onPick={pick} own={own} question={question} selected={usingOwn ? null : selected} />
				) : (
					<div
						className={cn(
							"grid gap-4",
							question.input === "color" || question.input === "status" ? "md:grid-cols-3" : "md:grid-cols-2",
						)}>
						{question.options.map((option) => (
							<OptionCard
								key={option.id}
								onSelect={() => pick(option.id)}
								option={option}
								recommended={option.id === question.recommendedId}
								selected={!usingOwn && option.id === selected}>
								<OptionPicture area={question.area} base={base} option={option} />
							</OptionCard>
						))}
					</div>
				)}
				{!usingOwn && <Reason reason={selectedOption?.reason} />}
				{spec.ownInput && (
					<OwnInput
						area={question.area}
						onChange={setOwn}
						own={own}
						refused={result.kind === "refused" ? result.reason : null}
						using={usingOwn}
					/>
				)}
			</div>

			<div className="mt-7 flex items-center gap-2">
				<button
					className="flex items-center gap-2 rounded-lg bg-caret-accent px-4 py-2 font-medium text-white transition-colors hover:bg-caret-accent-hover disabled:opacity-40"
					data-testid="wizard-continue"
					disabled={!answer}
					onClick={() => answer && onAnswer(answer)}
					type="button">
					Continue
				</button>
				<button
					className="rounded-lg px-3 py-2 text-shell-muted transition-colors hover:bg-white/5"
					data-testid="wizard-skip"
					onClick={() => onAnswer(skipAnswer(question))}
					title="Skip this question: the recommended choice stands"
					type="button">
					Skip
				</button>
				{onFinishNow && (
					<button
						className="ml-auto rounded-lg px-3 py-2 text-[11.5px] text-shell-muted transition-colors hover:bg-white/5"
						data-testid="wizard-finish-now"
						onClick={onFinishNow}
						title="Stop answering: Caret fills in the rest and builds the foundation"
						type="button">
						Just finish it
					</button>
				)}
			</div>
		</div>
	)
}

/** What the own-answer box held for an answer given before (shown again after Back). */
function ownRawOf(area: AreaId, answer: AreaAnswer): OwnRaw | null {
	const value = answer.value as Record<string, unknown>
	switch (AREAS[area].ownInput) {
		case "hex":
			return typeof value.hex === "string" ? { kind: "hex", hex: value.hex } : null
		case "font":
			return typeof value.family === "string" ? { kind: "font", family: value.family } : null
		case "size":
			return { kind: "size", px: String(value.baseSize ?? ""), ratio: String(value.scaleRatio ?? "") }
		case "status-hexes":
			return {
				kind: "status-hexes",
				success: String(value.success ?? ""),
				warning: String(value.warning ?? ""),
				error: String(value.error ?? ""),
				info: String(value.info ?? ""),
			}
		default:
			return null
	}
}

/** The picture on an option card: the specimen as that option would make it. */
function OptionPicture({ area, option, base }: { area: AreaId; option: AreaOption; base: SpecimenParams }) {
	const value = option.value as Record<string, unknown>
	useFonts(familiesOf({ ...base, ...specOf(area, option.value) }))
	if (area === "semantics") {
		const names: Array<[string, string]> = [
			["Healthy", String(value.success)],
			["Warning", String(value.warning)],
			["Error", String(value.error)],
			["Info", String(value.info)],
		]
		return (
			<div className="grid grid-cols-2 gap-2 p-4">
				{names.map(([name, hex]) => (
					<span className="flex items-center gap-2 text-[12px]" key={name}>
						<span className="inline-block size-4 rounded" style={{ background: hex }} />
						{name}
					</span>
				))}
			</div>
		)
	}
	if ("none" in value) {
		return (
			<div
				className="flex flex-1 items-center justify-center p-8 text-[12.5px] text-shell-muted"
				style={{ minHeight: 120 }}>
				No {area === "accent-color" ? "accent" : "supporting"} colour
			</div>
		)
	}
	// Supporting and accent colours preview on the button; the brand keeps the rest of the page.
	return <Specimen spec={{ ...base, ...specOf(area, option.value) }} tall={area === "spacing" || area === "depth"} />
}

/** The type-size question: steps from quiet to bold, with a live preview of the selected one. */
function SliderInput({
	question,
	selected,
	own,
	base,
	onPick,
}: {
	question: AreaQuestion
	selected: string | null
	own: OwnRaw | null
	base: SpecimenParams
	onPick(optionId: string): void
}) {
	const chosen = question.options.find((o) => o.id === selected)
	const typed = own?.kind === "size" ? ownAnswer(question, own, selected ?? undefined) : null
	const value = (typed?.kind === "answer" ? typed.answer.value : chosen?.value) as
		| { baseSize: number; scaleRatio: number }
		| undefined
	useFonts(familiesOf(base))
	return (
		<div>
			<div className="overflow-hidden rounded-xl border border-shell-border">
				<Specimen morph spec={{ ...base, baseSize: value?.baseSize }} tall />
			</div>
			<div className="mt-3 flex justify-between text-[11.5px] text-shell-muted">
				<span>Quiet</span>
				<span>Bold</span>
			</div>
			<div className="mt-2 flex flex-wrap gap-1.5" data-testid="wizard-scale">
				{question.options.map((option) => (
					<button
						className={cn(
							"min-h-8 flex-1 rounded-lg border px-2 py-1 text-[11.5px] leading-tight transition-colors",
							option.id === selected
								? "border-caret-accent bg-caret-accent/15 text-caret-accent"
								: "border-shell-border text-shell-muted hover:bg-white/5",
						)}
						data-option-id={option.id}
						data-selected={option.id === selected}
						data-testid="wizard-option"
						key={option.id}
						onClick={() => onPick(option.id)}
						type="button">
						{option.label}
						{option.id === question.recommendedId && <span className="ml-1 text-caret-accent">★</span>}
					</button>
				))}
			</div>
		</div>
	)
}

/** The box for the user's own answer: a colour, a font, sizes, or four status colours. */
function OwnInput({
	area,
	own,
	using,
	refused,
	onChange,
}: {
	area: AreaId
	own: OwnRaw | null
	using: boolean
	refused: string | null
	onChange(raw: OwnRaw | null): void
}) {
	const kind = AREAS[area].ownInput
	return (
		<div
			className={cn(
				"mt-4 flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 transition-colors",
				refused ? "border-red-400/60" : using ? "border-caret-accent" : "border-shell-border",
			)}
			data-testid="wizard-own-value">
			{kind === "hex" && (
				<HexInput
					hex={own?.kind === "hex" ? own.hex : ""}
					onChange={(hex) => onChange(hex ? { kind: "hex", hex } : null)}
				/>
			)}
			{kind === "font" && (
				<FontSearch
					family={own?.kind === "font" ? own.family : ""}
					onChange={(family) => onChange(family ? { kind: "font", family } : null)}
				/>
			)}
			{kind === "size" && (
				<SizeInput
					onChange={(px, ratio) => onChange(px || ratio ? { kind: "size", px, ratio } : null)}
					px={own?.kind === "size" ? own.px : ""}
					ratio={own?.kind === "size" ? own.ratio : ""}
				/>
			)}
			{kind === "status-hexes" && (
				<StatusInput
					onChange={(next) =>
						onChange(Object.values(next).some((v) => v.trim()) ? { kind: "status-hexes", ...next } : null)
					}
					value={
						own?.kind === "status-hexes"
							? { success: own.success, warning: own.warning, error: own.error, info: own.info }
							: { success: "", warning: "", error: "", info: "" }
					}
				/>
			)}
			{refused && (
				<p className="basis-full text-[12px] text-red-400" data-testid="wizard-own-value-reason">
					{refused}
				</p>
			)}
		</div>
	)
}

function HexInput({ hex, onChange }: { hex: string; onChange(hex: string): void }) {
	const shown = /^#?[0-9a-fA-F]{6}$/.test(hex.trim()) ? (hex.trim().startsWith("#") ? hex.trim() : `#${hex.trim()}`) : "#888888"
	return (
		<>
			<span className="text-[12px] text-shell-muted">None of these, use my colour:</span>
			<label className="relative inline-flex size-7 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-shell-border">
				<input
					aria-label="Pick a colour"
					className="absolute -inset-2 cursor-pointer opacity-0"
					onChange={(event) => onChange(event.target.value)}
					type="color"
					value={shown}
				/>
				<span aria-hidden className="pointer-events-none absolute inset-0" style={{ background: shown }} />
			</label>
			<input
				className="w-28 rounded-lg border border-shell-border bg-shell-panel px-2 py-1 font-mono text-[12px] outline-none focus:border-caret-accent/60"
				data-testid="wizard-hex"
				onChange={(event) => onChange(event.target.value)}
				placeholder="#28a4f0"
				value={hex}
			/>
			{"EyeDropper" in window && (
				<button
					className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] text-shell-muted transition-colors hover:bg-white/5"
					onClick={async () => {
						try {
							const picker = new (
								window as unknown as { EyeDropper: new () => { open(): Promise<{ sRGBHex: string }> } }
							).EyeDropper()
							onChange((await picker.open()).sRGBHex)
						} catch {
							// Cancelled.
						}
					}}
					type="button">
					<Pipette size={12} />
					Pick from screen
				</button>
			)}
		</>
	)
}

function FontSearch({ family, onChange }: { family: string; onChange(family: string): void }) {
	const [query, setQuery] = useState("")
	const [results, setResults] = useState<Array<{ family: string; category: string }>>([])
	const [offline, setOffline] = useState(false)
	useEffect(() => {
		const needle = query.trim()
		if (needle.length < 2) {
			setResults([])
			return
		}
		const timer = setTimeout(() => {
			void invoke("fonts:search", needle).then((found) => {
				setResults(found.fonts.slice(0, 6))
				setOffline(found.source === "bundled")
			})
		}, 250)
		return () => clearTimeout(timer)
	}, [query])
	useFonts(results.map((r) => r.family))
	return (
		<div className="basis-full" data-testid="wizard-font-other">
			<div className="flex items-center gap-2">
				<Search className="shrink-0 text-shell-muted" size={13} />
				<input
					className="w-full bg-transparent text-[13px] outline-none placeholder:text-shell-muted"
					data-testid="wizard-font-search"
					onChange={(event) => setQuery(event.target.value)}
					placeholder="None of these? Search all of Google Fonts"
					value={query}
				/>
				{family && (
					<button
						className="shrink-0 rounded px-1.5 text-[12px] text-shell-muted hover:bg-white/5"
						data-testid="wizard-font-clear"
						onClick={() => onChange("")}
						title="Use the cards instead"
						type="button">
						using {family} ×
					</button>
				)}
			</div>
			{results.length > 0 && (
				<div className="mt-2 flex flex-col">
					{results.map((font) => (
						<button
							className="flex items-baseline justify-between rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/5"
							data-testid="wizard-font-result"
							key={font.family}
							onClick={() => {
								onChange(font.family)
								setQuery("")
								setResults([])
							}}
							type="button">
							<span style={{ fontFamily: `"${font.family}", sans-serif`, fontSize: 16 }}>{font.family}</span>
							<span className="text-[11px] text-shell-muted">{font.category}</span>
						</button>
					))}
				</div>
			)}
			{offline && query.trim().length >= 2 && (
				<p className="mt-2 text-[11px] text-shell-muted" data-testid="wizard-font-offline">
					Offline: searching a small built-in list, not all of Google Fonts. A font missing here may still exist.
				</p>
			)}
		</div>
	)
}

function SizeInput({ px, ratio, onChange }: { px: string; ratio: string; onChange(px: string, ratio: string): void }) {
	const field = (value: string, set: (v: string) => void, placeholder: string, label: string) => (
		<input
			aria-label={label}
			className="w-20 rounded-lg border border-shell-border bg-shell-panel px-2.5 py-1.5 text-[12.5px] outline-none focus:border-caret-accent/60"
			data-testid={label === "Body text size in px" ? "wizard-own-px" : "wizard-own-ratio"}
			onChange={(event) => set(event.target.value)}
			placeholder={placeholder}
			value={value}
		/>
	)
	return (
		<>
			<span className="text-[12px] text-shell-muted">None of these, use my own:</span>
			<label className="flex items-center gap-2 text-[12px]">
				{field(px, (v) => onChange(v, ratio), "16", "Body text size in px")} px body text
			</label>
			<label className="flex items-center gap-2 text-[12px]">
				×{field(ratio, (v) => onChange(px, v), "1.25", "Step between heading sizes")} between sizes
			</label>
		</>
	)
}

function StatusInput({
	value,
	onChange,
}: {
	value: { success: string; warning: string; error: string; info: string }
	onChange(next: { success: string; warning: string; error: string; info: string }): void
}) {
	const names = { success: "Healthy", warning: "Warning", error: "Error", info: "Info" } as const
	return (
		<>
			<span className="text-[12px] text-shell-muted">None of these, use my own:</span>
			{(Object.keys(names) as Array<keyof typeof names>).map((key) => (
				<input
					aria-label={`${names[key]} colour`}
					className="w-24 rounded-lg border border-shell-border bg-shell-panel px-2 py-1 font-mono text-[12px] outline-none focus:border-caret-accent/60"
					data-testid={`wizard-own-${key}`}
					key={key}
					onChange={(event) => onChange({ ...value, [key]: event.target.value })}
					placeholder={names[key]}
					value={value[key]}
				/>
			))}
		</>
	)
}

function ErrorScreen({
	message,
	canFinish,
	busy,
	onRetry,
	onFinishNow,
	onManual,
}: {
	message: string
	canFinish: boolean
	busy: boolean
	onRetry(): void
	onFinishNow(): void
	onManual(): void
}) {
	return (
		<div className="fade-in" data-testid="wizard-error">
			<h1 className="text-2xl font-medium">That didn't work.</h1>
			<p className="mt-2 max-w-xl leading-relaxed break-words text-shell-muted">{message}</p>
			<p className="mt-1 max-w-xl text-[12.5px] text-shell-muted">Your answers so far are saved.</p>
			<div className="mt-5 flex items-center gap-2">
				<button
					className="flex items-center gap-2 rounded-lg bg-caret-accent px-4 py-2 font-medium text-white transition-colors hover:bg-caret-accent-hover disabled:opacity-40"
					disabled={busy}
					onClick={onRetry}
					type="button">
					{busy && <Loader2 className="animate-spin" size={13} />}
					Try again
				</button>
				{canFinish && (
					<button
						className="rounded-lg px-3 py-2 text-shell-muted transition-colors hover:bg-white/5"
						disabled={busy}
						onClick={onFinishNow}
						type="button">
						Finish with what I've answered
					</button>
				)}
				<button
					className="rounded-lg px-3 py-2 text-shell-muted transition-colors hover:bg-white/5"
					onClick={onManual}
					type="button">
					Set tokens by hand
				</button>
			</div>
		</div>
	)
}

function Finish({
	wire,
	busy,
	onCommit,
	onBack,
}: {
	wire: Extract<InterviewWire, { phase: "finish" }>
	busy: boolean
	onCommit(): void
	onBack(): void
}) {
	useFonts(familiesOf(wire.state.spec))
	return (
		<div className="fade-in" data-testid="wizard-finish">
			<div className="flex items-center justify-between">
				<p className="text-[11px] tracking-wider text-shell-muted uppercase">Everything together</p>
				<button
					className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11.5px] text-shell-muted transition-colors hover:bg-white/5 hover:text-shell-text"
					data-testid="wizard-back"
					disabled={busy}
					onClick={onBack}
					type="button">
					<ArrowLeft size={12} />
					Back
				</button>
			</div>
			<h1 className="mt-3 text-2xl font-medium">{wire.name}</h1>
			{wire.summary && <p className="mt-1.5 max-w-2xl leading-relaxed text-shell-muted">{wire.summary}</p>}
			<div className="mt-6 overflow-hidden rounded-xl border border-shell-border">
				<Specimen spec={wire.state.spec} tall />
			</div>
			<p className="mt-4 max-w-2xl border-l-2 border-shell-border pl-3 text-[12px] leading-relaxed text-shell-muted">
				{wire.rule}
			</p>
			<div className="mt-5 max-w-2xl" data-testid="wizard-decisions">
				<p className="text-[11px] tracking-wider text-shell-muted uppercase">How this was decided</p>
				<ul className="mt-2 flex flex-col gap-1.5">
					{wire.proposal.decisions?.map((decision) => (
						<li className="text-[12px] leading-relaxed" data-area={decision.area} key={decision.area}>
							<span className="font-medium">
								{AREAS[decision.area as AreaId]?.term ?? decision.area}: {decision.choice}
							</span>
							<span className="text-shell-muted"> {decision.reason}</span>
						</li>
					))}
				</ul>
			</div>
			<button
				className="mt-7 flex items-center gap-2 rounded-lg bg-caret-accent px-4 py-2 font-medium text-white transition-colors hover:bg-caret-accent-hover disabled:opacity-40"
				data-testid="wizard-commit"
				disabled={busy}
				onClick={onCommit}
				type="button">
				{busy && <Loader2 className="animate-spin" size={13} />}
				Use these foundations
			</button>
		</div>
	)
}

// ── the side panel ──────────────────────────────────────────────────────────

/** Every topic in the order it is asked: done, the one on screen, or still to come. */
function Coverage({ state, now }: { state: InterviewState; now: AreaId | null }) {
	return (
		<aside data-testid="wizard-coverage">
			<p className="text-[11px] tracking-wider text-shell-muted uppercase">Covering</p>
			<ul className="mt-3 flex flex-col gap-1.5">
				{state.coverage.map((row) => (
					<li
						className="flex items-center gap-2 text-[11.5px]"
						data-area={row.area}
						data-done={row.done}
						data-status={row.status}
						key={row.area}>
						<span
							className={cn(
								"flex size-3.5 shrink-0 items-center justify-center rounded-full border",
								row.done
									? "border-caret-accent bg-caret-accent/15 text-caret-accent"
									: row.area === now
										? "border-caret-accent text-transparent"
										: "border-shell-border text-transparent",
							)}>
							<Check size={9} strokeWidth={3} />
						</span>
						<span className={row.done || row.area === now ? "" : "text-shell-muted"}>{row.label}</span>
						{row.status === "confirmed" && <span className="ml-auto text-[10px] text-shell-muted">agreed</span>}
						{row.status === "skipped" && <span className="ml-auto text-[10px] text-shell-muted">recommended</span>}
					</li>
				))}
			</ul>
		</aside>
	)
}

/** "Your foundation so far": every settled topic, from the engine's reading of the answers. */
function SoFar({ state }: { state: InterviewState }) {
	useFonts(familiesOf(state.spec))
	return (
		<aside data-testid="wizard-so-far">
			<p className="text-[11px] tracking-wider text-shell-muted uppercase">So far</p>
			<div className="mt-3 overflow-hidden rounded-xl border border-shell-border">
				<MiniSpecimen spec={state.spec} />
			</div>
			<dl className="mt-3 flex flex-col gap-1.5">
				{state.soFar.map((row) => (
					<div
						className="flex items-start justify-between gap-2 text-[11.5px]"
						data-area={row.area}
						data-term={row.term}
						key={row.area}>
						<dt className="shrink-0 text-shell-muted">{row.term}</dt>
						{/* Long values (three status colours) wrap; a cut-off value hides the answer. */}
						<dd className="flex min-w-0 flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5 text-right">
							{row.swatches.map((hex) => (
								<span className="inline-block size-3 shrink-0 rounded" key={hex} style={{ background: hex }} />
							))}
							<span className="min-w-0 break-words">{row.text}</span>
						</dd>
					</div>
				))}
				{state.soFar.length === 0 && <p className="text-[11.5px] text-shell-muted">Nothing settled yet.</p>}
			</dl>
		</aside>
	)
}

// ── shared pieces ───────────────────────────────────────────────────────────

/** The model's reason for the selected option, under the cards. */
function Reason({ reason }: { reason?: string }) {
	if (!reason) return null
	return (
		<p className="mt-3 flex max-w-2xl items-start gap-2 leading-relaxed text-shell-muted" data-testid="wizard-reason">
			<Sparkles className="mt-1 shrink-0 text-caret-accent" size={12} />
			{reason}
		</p>
	)
}

function OptionCard({
	option,
	selected,
	recommended,
	onSelect,
	children,
}: {
	option: AreaOption
	selected: boolean
	recommended: boolean
	onSelect(): void
	children: React.ReactNode
}) {
	const hex = (option.value as { hex?: string }).hex
	return (
		<button
			// items-stretch: a <button> defaults to flex-start, which would shrink the specimen.
			className={cn(
				"group flex flex-col items-stretch overflow-hidden rounded-xl border text-left transition-colors",
				selected ? "border-caret-accent" : "border-shell-border hover:border-white/20",
			)}
			data-option-id={option.id}
			data-selected={selected}
			data-testid="wizard-option"
			onClick={onSelect}
			type="button">
			{children}
			<div className="flex items-start gap-2 border-t border-shell-border bg-shell-panel px-3 py-2.5">
				<span
					className={cn(
						"mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border",
						selected ? "border-caret-accent bg-caret-accent text-white" : "border-shell-muted/50",
					)}>
					{selected && <Check size={9} strokeWidth={3} />}
				</span>
				<span className="flex min-w-0 flex-wrap items-center gap-2 font-medium">
					{hex && <span className="inline-block size-3 shrink-0 rounded-[4px]" style={{ background: hex }} />}
					{option.label}
					{recommended && (
						<span className="rounded bg-caret-accent/15 px-1.5 py-px text-[10px] font-normal text-caret-accent">
							Recommended
						</span>
					)}
				</span>
			</div>
		</button>
	)
}

/** The specimen everything renders through: a heading, body copy, and the brand on one button. */
function Specimen({ spec, tall, morph }: { spec: SpecimenParams; tall?: boolean; morph?: boolean }) {
	const surface = surfaceFor(spec)
	const radius = spec.radius ?? 8
	const unit = spec.spacingUnit ?? 8
	const baseSize = spec.baseSize ?? 15
	const transition = morph ? "all 200ms ease" : undefined
	// A depth option only shows on a card that casts its shadow.
	const card: React.CSSProperties = spec.shadow
		? {
				background: surface.bg,
				border: "1px solid rgba(0,0,0,0.06)",
				borderRadius: Math.min(radius, 24),
				padding: unit * 2.5,
				boxShadow: spec.shadow === "none" ? undefined : spec.shadow,
				transition,
			}
		: {}
	return (
		<div
			className="flex-1"
			style={{
				background: surface.bg,
				color: surface.text,
				fontFamily: stack(spec.bodyFamily),
				padding: tall ? unit * 4 : unit * 2.5,
				transition,
			}}>
			<div style={card}>
				<p
					style={{
						fontFamily: stack(spec.displayFamily ?? spec.bodyFamily),
						fontSize: tall ? 34 : 21,
						lineHeight: 1.15,
						fontWeight: 500,
						transition,
					}}>
					Built for the way you work
				</p>
				<p className="opacity-70" style={{ fontSize: baseSize, marginTop: unit * 1.5, lineHeight: 1.55, transition }}>
					A short paragraph, so you can see how it reads at the size it will actually be used.
				</p>
				<span
					className="inline-block"
					style={{
						background: spec.accent ?? "#6b7280",
						color: readableOn(spec.accent ?? "#6b7280"),
						borderRadius: Math.min(radius, 24),
						marginTop: unit * 2.5,
						padding: `${unit}px ${unit * 2.5}px`,
						fontSize: baseSize - 1,
						transition,
					}}>
					Get started
				</span>
			</div>
		</div>
	)
}

function MiniSpecimen({ spec }: { spec: SpecimenParams }) {
	const surface = surfaceFor(spec)
	const unit = spec.spacingUnit ?? 8
	return (
		<div style={{ background: surface.bg, color: surface.text, padding: unit * 1.5, fontFamily: stack(spec.bodyFamily) }}>
			<p style={{ fontFamily: stack(spec.displayFamily ?? spec.bodyFamily), fontSize: 15, fontWeight: 500 }}>Aa</p>
			<p className="opacity-70" style={{ fontSize: 11, marginTop: 4 }}>
				The quick brown fox
			</p>
			<span
				className="mt-2 inline-block"
				style={{
					background: spec.accent ?? "#6b7280",
					color: readableOn(spec.accent ?? "#6b7280"),
					borderRadius: Math.min(spec.radius ?? 8, 12),
					padding: "3px 8px",
					fontSize: 10,
				}}>
				Button
			</span>
		</div>
	)
}

function stack(family?: string): string {
	return family ? `"${family}", ui-sans-serif, sans-serif` : "ui-sans-serif, system-ui, sans-serif"
}

function familiesOf(spec: SpecimenParams): string[] {
	return [spec.displayFamily, spec.bodyFamily].filter(Boolean) as string[]
}

/** Loads Google Fonts stylesheets for whatever families the screen shows. */
function useFonts(families: string[]): void {
	const key = useMemo(() => [...new Set(families.filter(Boolean))].sort().join("|"), [families])
	useEffect(() => {
		if (!key) return
		const url = `https://fonts.googleapis.com/css2?${key
			.split("|")
			.map((family) => `family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@400;500;600`)
			.join("&")}&display=swap`
		const link = document.createElement("link")
		link.rel = "stylesheet"
		link.href = url
		document.head.appendChild(link)
		return () => link.remove()
	}, [key])
}

/** Surfaces per grey character: the difference the eye reads as considered. */
const LIGHT_SURFACES: Record<string, { bg: string; text: string }> = {
	warm: { bg: "#faf7f2", text: "#2a2520" },
	cool: { bg: "#f7f8fa", text: "#1a1d24" },
	true: { bg: "#f8f8f8", text: "#1c1c1c" },
	"slight-tint": { bg: "#f6f7f9", text: "#20242b" },
}

const DARK_SURFACES: Record<string, { bg: string; text: string }> = {
	warm: { bg: "#191512", text: "#f0ebe4" },
	cool: { bg: "#0e1116", text: "#e6e9ef" },
	true: { bg: "#111111", text: "#ededed" },
	"slight-tint": { bg: "#101319", text: "#e8ebf1" },
}

function surfaceFor(spec: SpecimenParams): { bg: string; text: string } {
	const table = spec.surface === "dark" ? DARK_SURFACES : LIGHT_SURFACES
	return table[spec.neutral ?? "cool"] ?? table.cool
}

/** Black or white on a given background, by relative luminance. */
function readableOn(hex: string): string {
	const value = hex.replace("#", "")
	if (value.length < 6) return "#ffffff"
	const channels = [0, 2, 4].map((i) => Number.parseInt(value.slice(i, i + 2), 16) / 255)
	const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
	return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? "#111111" : "#ffffff"
}

/** One question with a scripted payload, for `scripts/preview-wizard.ts`. No IPC. */
export function __PreviewQuestion({ question, state }: { question: AreaQuestion; state: InterviewState }) {
	return (
		<div className="max-w-3xl">
			<Question onAnswer={() => {}} onFinishNow={() => {}} question={question} state={state} />
		</div>
	)
}
