/**
 * The Design pass in the chat: the switch under the composer, the named steps
 * in the transcript, and the questions card.
 *
 * The pass is on by default and slower, so it must always be visible when on —
 * a line under the box says what it is doing for the user and that it takes a
 * few extra minutes. Turning it off is one click and one confirmation that
 * says, plainly, what is lost.
 */
import { Check, Circle, Loader2, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import type { InterviewPromptWire, TranscriptEntryWire } from "../../../shared/ipc"
import { cn } from "../lib/utils"

type PassEntry = Extract<TranscriptEntryWire, { kind: "design-pass" }>
type QuestionsPrompt = Extract<InterviewPromptWire, { kind: "design-questions" }>

/** The switch, and the line under the composer that says what it means. */
export function DesignPassSwitch({
	on,
	disabled,
	onSet,
	onOpenSettings,
}: {
	on: boolean
	disabled: boolean
	onSet(on: boolean): void
	onOpenSettings(): void
}) {
	const [confirming, setConfirming] = useState(false)
	const popover = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (!confirming) return
		const close = (event: MouseEvent) => {
			if (popover.current && !popover.current.contains(event.target as Node)) setConfirming(false)
		}
		const onKey = (event: KeyboardEvent) => event.key === "Escape" && setConfirming(false)
		window.addEventListener("mousedown", close)
		window.addEventListener("keydown", onKey)
		return () => {
			window.removeEventListener("mousedown", close)
			window.removeEventListener("keydown", onKey)
		}
	}, [confirming])

	// Not positioned itself: the popover anchors to the composer's row, which
	// spans the sidebar, so it can never run past the window's edge.
	return (
		<div>
			<button
				aria-pressed={on}
				className={cn(
					"flex items-center gap-1.5 rounded-lg border px-2 py-0.5 text-[11px] transition-colors",
					on
						? "border-caret-accent/50 bg-caret-accent/15 font-medium text-shell-text hover:bg-caret-accent/25"
						: "border-shell-border text-shell-muted hover:text-shell-fg",
				)}
				data-testid="design-pass-switch"
				disabled={disabled}
				onClick={() => (on ? setConfirming(true) : onSet(true))}
				title={on ? "Design pass is on" : "Turn the Design pass on"}
				type="button">
				<span className={cn("size-1.5 rounded-full", on ? "bg-caret-accent" : "bg-shell-muted/60")} />
				{on ? "Design pass" : "Design pass off"}
			</button>
			{confirming && (
				<div
					className="absolute right-0 bottom-full left-0 z-20 mb-2 rounded-xl border border-shell-border bg-shell-panel p-3.5 shadow-2xl"
					data-testid="design-pass-confirm"
					ref={popover}>
					<p className="font-medium">Turn off the Design pass?</p>
					<p className="mt-1.5 text-[12px] leading-relaxed text-shell-muted">
						It's what removes the generic "AI look" (eyebrow labels, purple gradients, cards everywhere) and polishes
						the details. Without it, pages build faster, but you'll do that work yourself in the chat.
					</p>
					<div className="mt-3 flex gap-2">
						<button
							className="rounded-lg bg-caret-accent px-3 py-1.5 font-medium text-white transition-colors hover:bg-caret-accent-hover"
							data-testid="design-pass-keep"
							onClick={() => setConfirming(false)}
							type="button">
							Keep it on
						</button>
						<button
							className="rounded-lg px-3 py-1.5 text-shell-muted transition-colors hover:bg-white/5 hover:text-shell-text"
							data-testid="design-pass-turn-off"
							onClick={() => {
								setConfirming(false)
								onSet(false)
							}}
							type="button">
							Turn off for this project
						</button>
					</div>
					<button
						className="mt-3 text-[11.5px] text-shell-muted underline-offset-2 transition-colors hover:text-shell-text hover:underline"
						data-testid="design-pass-settings"
						onClick={() => {
							setConfirming(false)
							onOpenSettings()
						}}
						type="button">
						Design pass settings ›
					</button>
				</div>
			)}
		</div>
	)
}

export function DesignPassLine({ on }: { on: boolean }) {
	return (
		<p className="mt-1.5 px-1 text-[11px] leading-relaxed text-shell-muted" data-testid="design-pass-line">
			{on
				? "Design pass is on: plans, removes common AI habits and polishes details before building. Takes a few extra minutes."
				: "Design pass is off. Pages build straight away."}
		</p>
	)
}

const STEP_LABEL: Record<PassEntry["steps"][number]["step"], string> = {
	plan: "Planning the page",
	check: "Checking for common AI habits",
	questions: "Your design questions",
	polish: "Polishing details",
	build: "Building",
}

/** The pass's named steps, as they happen. */
export function DesignPassSteps({ entry }: { entry: PassEntry }) {
	return (
		<ol
			className="fade-in my-1 flex flex-col gap-1.5 rounded-xl border border-shell-border px-3 py-2.5"
			data-testid="design-pass-steps">
			{entry.steps.map((step) => {
				const waiting = step.step === "questions" && step.state === "active"
				const label = waiting ? `Waiting for you: ${step.detail ?? "design questions"}` : STEP_LABEL[step.step]
				const detail = waiting ? undefined : step.detail
				return (
					<li
						className={cn(
							"flex items-center gap-2 text-[12px]",
							step.state === "pending" && "text-shell-muted/70",
							step.state === "active" && (waiting ? "text-caret-accent" : "text-shell-text"),
							step.state === "done" && "text-shell-muted",
							step.state === "failed" && "text-red-300",
						)}
						data-state={step.state}
						data-step={step.step}
						data-testid="design-pass-step"
						key={step.step}>
						<StepIcon state={step.state} />
						<span>
							{label}
							{detail && <span className="text-shell-muted"> · {detail}</span>}
						</span>
					</li>
				)
			})}
		</ol>
	)
}

function StepIcon({ state }: { state: PassEntry["steps"][number]["state"] }) {
	if (state === "done") return <Check className="shrink-0 text-emerald-400/80" size={12} />
	if (state === "active") return <Loader2 className="shrink-0 animate-spin" size={12} />
	if (state === "failed") return <X className="shrink-0" size={12} />
	return <Circle className="shrink-0" size={10} />
}

/** "N design questions" while the questions card is waiting, for the row above the composer. */
export function waitingDesignQuestions(entries: TranscriptEntryWire[]): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]
		if (entry.kind !== "design-pass") continue
		const questions = entry.steps.find((s) => s.step === "questions")
		return questions?.state === "active" ? (questions.detail ?? "design questions") : null
	}
	return null
}

/**
 * The questions card. The plan waits on it — no default, no timer, and no
 * dismiss button: closing it would be deciding for the user.
 */
export function DesignQuestionsBlock({ prompt, onAnswer }: { prompt: QuestionsPrompt; onAnswer(answer: string): void }) {
	const [answers, setAnswers] = useState<Array<"keep" | "remove" | null>>(() => prompt.items.map(() => null))
	const set = (index: number, value: "keep" | "remove") =>
		setAnswers((current) => current.map((answer, i) => (i === index ? value : answer)))
	const send = (all: Array<"keep" | "remove" | null>) => {
		if (all.some((a) => a === null)) return
		onAnswer(JSON.stringify(all))
	}

	return (
		<div className="max-h-[55%] overflow-y-auto border-t border-caret-accent/40 px-3.5 py-3" data-testid="design-questions">
			<p className="font-medium">{prompt.title}</p>
			<p className="mt-0.5 text-[11.5px] leading-relaxed text-shell-muted">{prompt.subtitle}</p>
			<ul className="mt-3 flex flex-col gap-2.5">
				{prompt.items.map((item, index) => (
					<li
						className="rounded-lg border border-shell-border px-3 py-2.5"
						data-testid="design-question"
						key={`${item.section}-${index}`}>
						<p className="leading-relaxed">{item.quote}</p>
						<p className="mt-0.5 text-[11px] text-shell-muted">
							{item.habit} · in "{item.section}"
						</p>
						<p className="mt-1.5 text-[11.5px] leading-relaxed text-shell-muted">AI's reason: {item.reason}</p>
						<div className="mt-2 flex gap-1.5">
							{(["keep", "remove"] as const).map((choice) => (
								<button
									aria-pressed={answers[index] === choice}
									className={cn(
										"rounded-md border px-2.5 py-1 text-[11.5px] transition-colors",
										answers[index] === choice
											? "border-caret-accent bg-caret-accent/20 font-medium text-shell-text"
											: "border-shell-border text-shell-muted hover:text-shell-text",
									)}
									data-testid={`design-question-${choice}`}
									key={choice}
									onClick={() => set(index, choice)}
									type="button">
									{choice === "keep" ? "Keep" : "Remove"}
								</button>
							))}
						</div>
					</li>
				))}
			</ul>
			<div className="mt-3 flex flex-wrap items-center gap-2">
				<button
					className="rounded-lg bg-caret-accent px-3 py-1.5 font-medium text-white transition-colors hover:bg-caret-accent-hover disabled:opacity-40"
					data-testid="design-questions-done"
					disabled={answers.some((a) => a === null)}
					onClick={() => send(answers)}
					type="button">
					Done
				</button>
				<button
					className="rounded-lg px-3 py-1.5 text-shell-muted transition-colors hover:bg-white/5 hover:text-shell-text"
					data-testid="design-questions-keep-all"
					onClick={() => send(prompt.items.map(() => "keep"))}
					type="button">
					Keep all
				</button>
				<button
					className="rounded-lg px-3 py-1.5 text-shell-muted transition-colors hover:bg-white/5 hover:text-shell-text"
					data-testid="design-questions-remove-all"
					onClick={() => send(prompt.items.map(() => "remove"))}
					type="button">
					Remove all
				</button>
			</div>
		</div>
	)
}
