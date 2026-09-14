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

import { landsInChat, type ProjectState, type WizardStateWire } from "../../../shared/ipc"
import { TokenWizard } from "../components/design-wizard/TokenWizard"
import { invoke, on } from "../ipc"
import { setActiveProject } from "../services/design-client"
import { DesignSystemView } from "./DesignSystemView"
import { FoundationEntry } from "./FoundationEntry"
import { InterviewView } from "./InterviewView"
import { WizardView } from "./WizardView"

/** `agent` is only ever entered by an external agent pushing a question. */
type Mode = "entry" | "wizard" | "manual" | "agent" | "overview"

export function FoundationView({
	project,
	onDone,
	onInterviewAnswered,
}: {
	project: ProjectState
	onDone(): void
	onInterviewAnswered?(): void
}) {
	const [mode, setMode] = useState<Mode>(project.hasFoundation ? "overview" : "entry")
	const [wizardState, setWizardState] = useState<WizardStateWire | null>(null)
	const [description, setDescription] = useState("")
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
			{!project.hasFoundation && mode !== "agent" && (
				<div className="border-b border-shell-border bg-caret-accent/10 px-8 py-3">
					<p className="mx-auto max-w-3xl">
						Set your foundations before generating any pages. Everything an agent writes will be styled from these,
						and changing them afterwards means restyling what already exists.
					</p>
				</div>
			)}
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
				<DesignSystemView onEditByHand={() => setMode("manual")} onRerunInterview={() => setMode("entry")} />
			)}
			{mode === "entry" && (
				<FoundationEntry
					onManual={(described) => {
						setDescription(described)
						setMode("manual")
					}}
					onStarted={(state, described) => {
						setDescription(described)
						setWizardState(state)
						setMode("wizard")
					}}
					projectPath={project.path}
				/>
			)}
			{mode === "wizard" && (
				<WizardView
					initialState={wizardState}
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
