/**
 * The foundation surface — one flow in, one design system out.
 *
 * A project without a committed design system opens here on a single question:
 * "What are you building?" The description then routes through a chooser of
 * how much control the user wants:
 *
 * - **AI-led** — the minimal interview. A handful of plain-language questions,
 *   the model does the heavy lifting. For the developer who is not a designer.
 * - **Collaborative** — the same interview machinery with the depth exposed:
 *   every design decision is asked about, nothing is decided silently. For
 *   someone design-savvy who wants the AI for lifting, not deciding.
 * - **Manual** — the token editor, every value by hand. No AI at all.
 *
 * Once a foundation is committed, this surface becomes the design-system view:
 * palette, type, spacing, depth and the interview's persisted reasoning, each
 * section editable in place. Re-running the interview is a door on that page,
 * guarded by the blast-radius banner.
 */
import { useEffect, useState } from "react"

import { landsInChat, type ProjectState, type WizardModeWire, type WizardStateWire } from "../../../shared/ipc"
import { TokenWizard } from "../components/design-wizard/TokenWizard"
import { invoke, on } from "../ipc"
import { setActiveProject } from "../services/design-client"
import { AppImportCard, useImportProgress } from "./AppImport"
import { DesignSystemView } from "./DesignSystemView"
import { FoundationEntry } from "./FoundationEntry"
import { InterviewView } from "./InterviewView"
import { FirstPageCard, SetupStepper } from "./Setup"
import { WizardView } from "./WizardView"

/** `agent` is only ever entered by an external agent pushing a question. */
type Mode = "entry" | "wizard" | "manual" | "agent" | "overview"

export function FoundationView({
	project,
	onDone,
	onInterviewAnswered,
	onMakeFirstPage,
	onOpenBackend,
}: {
	project: ProjectState
	onDone(): void
	onInterviewAnswered?(): void
	/** Step 2 of setup: opens the chat seeded for a first page. */
	onMakeFirstPage?(): void
	/** The Backend tab — where an MCP agent is connected. */
	onOpenBackend?(): void
}) {
	const [mode, setMode] = useState<Mode>(project.hasFoundation ? "overview" : "entry")
	const [wizardState, setWizardState] = useState<WizardStateWire | null>(null)
	const [wizardStart, setWizardStart] = useState<{ mode: WizardModeWire; description: string } | null>(null)
	const [description, setDescription] = useState("")
	const importProgress = useImportProgress(project.path)
	const [blastRadius, setBlastRadius] = useState<{ occurrences: number; files: number } | null>(null)

	// The wizard's data layer is module-scoped to one project per window. Set
	// during render, not in an effect: children's load effects run BEFORE a
	// parent's (React runs effects bottom-up), so the DS view's first fetch on a
	// fresh mount would otherwise beat the effect that names the project and
	// throw "No project is open". Assigning a module variable is idempotent.
	setActiveProject(project.path)

	// A commit can land while this view sits on the untouched entry screen — an
	// external agent's `commit_foundation` does exactly that. The entry screen
	// is only the door for an uncommitted project, so it yields to the DS view;
	// any mode the user actively chose is theirs and is never switched away.
	useEffect(() => {
		if (project.hasFoundation) setMode((current) => (current === "entry" ? "overview" : current))
	}, [project.hasFoundation])

	// A crash mid-interview must resume into the interview, not restart at the
	// describe screen — every answered question cost a model call.
	useEffect(() => {
		let cancelled = false
		void invoke("wizard:resume", project.path).then((resumed) => {
			if (cancelled || !resumed) return
			if (resumed.phase === "question" || resumed.phase === "finish" || resumed.phase === "error") {
				setWizardState(resumed)
				setMode((current) => (current === "agent" ? current : "wizard"))
			}
		})
		return () => {
			cancelled = true
		}
	}, [project.path])

	// An *external* agent's question wins over whatever is on screen: unlike
	// Caret's own flows, there is a tool call blocked on it. Asset picks are
	// not this surface's to show — they dock in the chat.
	useEffect(
		() =>
			on("interview:prompt", (prompt) => {
				if (!landsInChat(prompt)) setMode("agent")
			}),
		[],
	)

	// And a prompt that arrived *before* this view existed still has to land.
	// The event is what switches the surface here, so when the user was anywhere
	// but Foundation this component mounts a tick too late and its listener above
	// never fires — the agent then blocks forever on a question that was never
	// shown. Certification missed it for months because the scenario that asks
	// one always ran after a scenario that left this view already mounted; run it
	// first and it fails every time.
	useEffect(() => {
		void invoke("interview:pending").then((waiting) => {
			if (waiting && !landsInChat(waiting)) setMode("agent")
		})
	}, [])

	// Re-running on an existing foundation: tokens are live bindings, so the
	// reach of a change is a measurable number, not a vibe — measure it.
	useEffect(() => {
		if (!project.hasFoundation) return
		invoke("tokens:blastRadius", project.path)
			.then(setBlastRadius)
			.catch(() => setBlastRadius(null))
	}, [project.hasFoundation, project.path])

	const rerunning = project.hasFoundation && mode !== "overview" && mode !== "agent"

	return (
		<div className="flex flex-1 flex-col overflow-hidden bg-shell-bg">
			{rerunning && (
				<div className="border-b border-shell-border bg-caret-accent/10 px-8 py-3" data-testid="foundation-rerun-notice">
					<p className="mx-auto max-w-3xl">
						This project already has foundations. Tokens are live bindings, so committing new ones restyles
						{blastRadius && blastRadius.occurrences > 0
							? ` ${blastRadius.occurrences} token-bound style${blastRadius.occurrences === 1 ? "" : "s"} across ${blastRadius.files} file${blastRadius.files === 1 ? "" : "s"}`
							: " every token-bound style"}{" "}
						instantly. Anything written as a raw value keeps its frozen look.
					</p>
				</div>
			)}

			{mode === "agent" && (
				<InterviewView
					onAnswered={onInterviewAnswered}
					onDone={() => setMode(project.hasFoundation ? "overview" : "entry")}
				/>
			)}
			{mode === "overview" && (
				<DesignSystemView
					header={
						project.app && (!project.hasPages || importProgress) ? (
							// An existing app's step 2 is its own screens, brought in —
							// a blank first page is the fallback, not the default.
							<>
								{!project.hasPages && <SetupStepper step={2} />}
								<AppImportCard
									onMakePageInstead={!project.hasPages ? onMakeFirstPage : undefined}
									onOpenBackend={onOpenBackend}
									project={project}
								/>
							</>
						) : !project.hasPages && onMakeFirstPage ? (
							<>
								<SetupStepper step={2} />
								<FirstPageCard onMakePage={onMakeFirstPage} />
							</>
						) : undefined
					}
					onEditByHand={() => setMode("manual")}
					onRerunInterview={() => setMode("entry")}
				/>
			)}
			{mode === "entry" && (
				<FoundationEntry
					app={project.app}
					onManual={(described) => {
						setDescription(described)
						setMode("manual")
					}}
					onStart={(startMode, described) => {
						setDescription(described)
						setWizardState(null)
						setWizardStart({ mode: startMode, description: described })
						setMode("wizard")
					}}
					settingUp={!project.hasFoundation}
				/>
			)}
			{mode === "wizard" && (
				<WizardView
					header={!project.hasFoundation ? <SetupStepper step={1} /> : undefined}
					initialState={wizardState}
					key={wizardStart ? `${wizardStart.mode}:${wizardStart.description}` : "resume"}
					onOpenBackend={onOpenBackend}
					start={wizardState ? null : wizardStart}
					onCommitted={onDone}
					onNothingInFlight={() => setMode("entry")}
					onSwitchToManual={() => setMode("manual")}
					projectPath={project.path}
				/>
			)}
			{mode === "manual" && <TokenWizard initialDescription={description} onDone={onDone} />}
		</div>
	)
}
