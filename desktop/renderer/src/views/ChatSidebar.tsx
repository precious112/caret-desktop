/**
 * The chat with Caret's own backend.
 *
 * Everything Caret starts — a sync, an AI edit, an overlay instruction — runs in
 * here, so there is one place to watch work happen, answer a permission, or stop
 * it. A sidebar rather than a modal for exactly that reason: the design is still
 * visible while the agent changes it.
 *
 * It renders whatever state main pushes and holds none of its own beyond the
 * draft message. The transcript is built once, in the design core, by the same
 * reducer that rebuilds old sessions — so what you see replayed is what you saw
 * live.
 *
 * **Two rules this panel is held to**, both of which it broke in its first form:
 *
 * 1. *Colour is reserved.* The shell exists to frame the user's design work, and
 *    accent-tinted chrome makes their own colours hard to judge. Accent appears
 *    on exactly one thing: something waiting on an answer.
 * 2. *Turns group.* Uniform spacing between every entry means a user message, a
 *    thinking block, four tool lines and the reply all read as one undifferentiated
 *    column. The gap between turns is what makes a transcript scannable.
 */

import {
	AlertTriangle,
	AtSign,
	Check,
	ChevronDown,
	ChevronRight,
	History,
	ImagePlus,
	Paperclip,
	Plus,
	Send,
	Square,
	Trash2,
	Wrench,
	X,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ThinkingOrb } from "thinking-orbs"

import {
	type AgentSessionWire,
	type AgentStateWire,
	type AssetEntryWire,
	type ComposerImage,
	type InterviewPromptWire,
	landsInChat,
	type ModelGroupWire,
	type ProjectState,
	type ProviderDoorWire,
	type TranscriptEntryWire,
} from "../../../shared/ipc"
import { invoke, on } from "../ipc"
import { cn } from "../lib/utils"
import { AssetMentionList, type AssetMentions, useAssetMentions } from "./AssetMentions"
import { splitAssetTags } from "./asset-tags"
import { Markdown } from "./Markdown"

export const CHAT_SIDEBAR_WIDTH = 380

/** Chat-placed prompts this sidebar renders; everything else is Foundation's. */
type AssetOptionsPromptWire = Extract<InterviewPromptWire, { kind: "asset-options" }>
type QuestionPromptWire = Extract<InterviewPromptWire, { kind: "question" }>
type TakesPromptWire = Extract<InterviewPromptWire, { kind: "takes" }>

interface ChatSidebarProps {
	project: ProjectState
	onClose(): void
	onOpenBackendSetup(): void
	/** Opens the asset viewer over the canvas. State lives in App, not here. */
	onViewAsset(tag: string): void
}

export function ChatSidebar({ project, onClose, onOpenBackendSetup, onViewAsset }: ChatSidebarProps) {
	const [state, setState] = useState<AgentStateWire | null>(null)
	const [draft, setDraft] = useState("")
	const [attached, setAttached] = useState<ComposerImage[]>([])
	const [sessions, setSessions] = useState<AgentSessionWire[] | null>(null)
	const [assets, setAssets] = useState<AssetEntryWire[]>([])
	const [docked, setDocked] = useState<InterviewPromptWire | null>(null)
	// A model the provider will not serve, in the provider's own words. Held here
	// rather than in the picker so it survives the popover closing — the whole
	// point is that it is still true after you look away.
	const [notice, setNotice] = useState<ModelNotice | null>(null)
	const scrollRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLTextAreaElement>(null)

	useEffect(() => {
		void invoke("agent:state", project.path).then(setState)
		return on("agent:state", (path, next) => {
			if (path === project.path) setState(next)
		})
	}, [project.path])

	// Tag detection and option thumbnails both need the current index. Followed
	// on the same event the library follows, because assets arrive from agents
	// and from Finder, not only from this window's own surfaces.
	useEffect(() => {
		const refresh = () => void invoke("assets:list", project.path).then((list) => setAssets(list ?? []))
		refresh()
		return on("assets:changed", (changed) => {
			if (changed === project.path) refresh()
		})
	}, [project.path])

	// Chat-placed prompts dock here rather than on the interview surface — the
	// plan they belong to is this conversation. Asset picks always; questions
	// and takes when the asking tool marked them `place: "chat"` (generation
	// consent, generated takes). The mount-time catch-up is not optional: a
	// prompt sent before this listener existed is lost forever, and an agent
	// can ask while the sidebar is closed.
	useEffect(() => {
		const keep = (prompt: InterviewPromptWire | null) => {
			if (prompt && landsInChat(prompt)) setDocked(prompt)
		}
		void invoke("interview:pending").then(keep)
		return on("interview:prompt", keep)
	}, [])

	const resolveDocked = (answer: string | null) => {
		if (!docked) return
		setDocked(null)
		// Then ask for the next one: an agent can fire several generate calls in
		// one turn, and each queued its prompt while this one held the dock. The
		// events already fired, so only a re-fetch after answering can surface
		// them — and it must run after the respond lands, or it reads back the
		// prompt just answered.
		void invoke("interview:respond", docked.id, answer).then(() =>
			invoke("interview:pending").then((next) => {
				if (next && landsInChat(next)) setDocked(next)
			}),
		)
	}

	const assetTags = useMemo(() => new Set(assets.map((asset) => asset.tag)), [assets])

	// Sticks to the bottom while a turn streams. Checked against the scroll
	// position first: yanking the view back down while someone is reading an
	// earlier tool call is the most common way a chat panel becomes unusable.
	useEffect(() => {
		const element = scrollRef.current
		if (!element) return
		const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 120
		if (nearBottom) element.scrollTop = element.scrollHeight
	}, [state])

	const entries = state?.transcript.entries ?? []
	const streaming = state?.streaming ?? false
	const turns = useMemo(() => groupIntoTurns(entries), [entries])

	// The oldest unanswered ask. While one exists the composer is REPLACED by
	// the permission dock — OpenCode's own pattern, adopted after a field run
	// where the user typed "continue" into the box instead of answering the
	// prompt above it. With nothing to type into, answering is the only move;
	// asks queued behind this one surface as each is answered.
	const pendingAsk = useMemo(() => {
		const entry = entries.find((e) => e.kind === "permission" && e.status === "pending")
		return entry && entry.kind === "permission" ? entry : null
	}, [entries])

	const mentions = useAssetMentions({ project, draft, setDraft, inputRef })

	const send = () => {
		const text = draft.trim()
		if (!text || streaming) return
		const images = attached.map((image) => image.dataUrl)
		setDraft("")
		setAttached([])
		void invoke("agent:send", project.path, text, images.length > 0 ? images : undefined)
	}

	// Pasted and dropped files never touch main: the renderer already holds the
	// bytes, and a round trip through a path would only be a chance to lose them.
	const attachFiles = useCallback((files: File[]) => {
		const images = files.filter((file) => file.type.startsWith("image/"))
		if (images.length === 0) return
		void Promise.all(
			images.map(
				(file) =>
					new Promise<ComposerImage | null>((resolve) => {
						const reader = new FileReader()
						reader.onload = () =>
							resolve(
								typeof reader.result === "string"
									? { name: file.name || "pasted image", dataUrl: reader.result }
									: null,
							)
						reader.onerror = () => resolve(null)
						reader.readAsDataURL(file)
					}),
			),
		).then((read) =>
			setAttached((current) => [...current, ...read.filter((image): image is ComposerImage => image !== null)]),
		)
	}, [])

	// The Plan/Act flip. Flipping to Act sends the current draft along as
	// steering — the user's last word on how to proceed — and clears it only
	// when main reports it actually started executing; a flip that was just a
	// mode change must not eat a half-written message.
	const flipMode = (mode: "read-only" | "write") => {
		const steering = mode === "write" ? draft.trim() : ""
		void invoke("agent:setMode", project.path, mode, steering || undefined).then((result) => {
			if (result?.executed) {
				setDraft("")
				setAttached([])
			}
		})
	}

	const composer = {
		draft,
		setDraft,
		attached,
		setAttached,
		attachFiles,
		send,
		streaming,
		mode: state?.mode ?? "write",
		flipMode,
		ready: state?.ready ?? false,
		model: describeModel(state?.model ?? "", state?.providerName),
		modelId: state?.model ?? "",
		projectPath: project.path,
		notice,
		setNotice,
		effort: state?.effort ?? "",
		inputRef,
		mentions,
		onOpenBackendSetup,
		onStop: () => void invoke("agent:abort", project.path),
		onReferenceAsset: mentions.begin,
	}

	return (
		<aside
			className="flex h-full shrink-0 flex-col border-l border-shell-border bg-shell-panel"
			data-testid="chat-sidebar"
			style={{ width: CHAT_SIDEBAR_WIDTH }}>
			<header className="flex h-10 shrink-0 items-center gap-2 border-b border-shell-border px-3">
				<span className="truncate text-[12px] font-medium" data-testid="chat-title">
					{sessions ? "Chat history" : (state?.activity?.title ?? "Chat")}
				</span>

				<div className="flex-1" />

				<IconButton
					label={sessions ? "Back to the chat" : "Earlier sessions"}
					onClick={() => {
						if (sessions) {
							setSessions(null)
							return
						}
						void invoke("agent:sessions", project.path).then(setSessions)
					}}>
					<History className={cn(sessions && "text-caret-accent")} size={13} />
				</IconButton>
				<IconButton
					label="New chat"
					onClick={() => {
						setSessions(null)
						void invoke("agent:reset", project.path)
					}}>
					<Plus size={13} />
				</IconButton>
				<IconButton label="Close" onClick={onClose}>
					<X size={13} />
				</IconButton>
			</header>

			{/* History is its OWN view, not a strip pushed onto the conversation.
			    The first version squeezed the list above a still-live transcript,
			    which read as clutter and hid most of both. Open, it replaces the
			    chat entirely; picking a session (or going back) returns to it. */}
			{sessions ? (
				<SessionList
					onDelete={(id) => {
						// Delete, then re-fetch rather than filtering locally: the list
						// the user sees should always be what the backend actually holds.
						void invoke("agent:deleteSession", project.path, id).then(() =>
							invoke("agent:sessions", project.path).then(setSessions),
						)
					}}
					onPick={(id) => {
						setSessions(null)
						void invoke("agent:replay", project.path, id)
					}}
					sessions={sessions}
				/>
			) : (
				<>
					<div className="flex-1 overflow-y-auto px-3.5 py-4" data-testid="chat-transcript" ref={scrollRef}>
						{!state?.ready && <NoBackend detail={state?.blocked} onOpenBackendSetup={onOpenBackendSetup} />}

						{entries.length === 0 && state?.ready && (
							<p className="px-1 py-8 text-center text-[12px] leading-relaxed text-shell-muted">
								Ask for a change, or describe what you want to build.
								<br />
								Caret can see this project's foundations and assets.
							</p>
						)}

						{turns.map((turn, index) => (
							// The gap between turns is six times the gap inside one. That ratio
							// is the whole reason a long transcript stays readable.
							<div className={cn("flex flex-col gap-1.5", index > 0 && "mt-7")} key={turn[0]?.id ?? index}>
								{turn.map((entry) => (
									<Entry
										assetTags={assetTags}
										entry={entry}
										key={entry.id}
										livePlan={state?.plan ?? null}
										onDiscardPlan={() => void invoke("agent:discardPlan", project.path)}
										onRespond={(requestId, decision) =>
											void invoke("agent:permission", project.path, requestId, decision)
										}
										onViewAsset={onViewAsset}
										streaming={streaming}
									/>
								))}
							</div>
						))}

						{state?.streaming && (
							<WorkingRow lastEventAt={state.lastEventAt} waitingOn={pendingAsk?.summary ?? null} />
						)}

						<FileChanges files={state?.transcript.files ?? []} />
					</div>

					{docked?.kind === "asset-options" && (
						<AssetOptionsBlock
							canvasUrl={project.canvasUrl}
							onDismiss={() => resolveDocked(null)}
							onPick={(tag) => resolveDocked(tag)}
							onView={onViewAsset}
							prompt={docked}
						/>
					)}
					{docked?.kind === "question" && (
						<QuestionBlock onAnswer={resolveDocked} onDismiss={() => resolveDocked(null)} prompt={docked} />
					)}
					{docked?.kind === "takes" && (
						<TakesBlock onDismiss={() => resolveDocked(null)} onPick={resolveDocked} prompt={docked} />
					)}

					{pendingAsk ? (
						<PermissionDock
							entry={pendingAsk}
							onRespond={(requestId, decision) =>
								void invoke("agent:permission", project.path, requestId, decision)
							}
						/>
					) : (
						<Composer {...composer} />
					)}
				</>
			)}
		</aside>
	)
}

// ── composers ───────────────────────────────────────────────────────────────

interface ComposerProps {
	draft: string
	setDraft(value: string): void
	attached: ComposerImage[]
	setAttached: React.Dispatch<React.SetStateAction<ComposerImage[]>>
	attachFiles(files: File[]): void
	send(): void
	streaming: boolean
	/** The conversation's Plan/Act position, from main. */
	mode: "read-only" | "write"
	flipMode(mode: "read-only" | "write"): void
	ready: boolean
	/** For the pill: the model named the way a person would say it. */
	model: string
	/** The id itself, for marking what is chosen and for probing it. */
	modelId: string
	projectPath: string
	notice: ModelNotice | null
	setNotice(notice: ModelNotice | null): void
	effort: string
	onOpenBackendSetup(): void
	onReferenceAsset(): void
	onStop(): void
	inputRef: React.RefObject<HTMLTextAreaElement | null>
	mentions: AssetMentions
}

const PLACEHOLDER = "Ask for a change, @ for an asset…"

function useComposerKeys(send: () => void, mentions: AssetMentions) {
	return (event: React.KeyboardEvent) => {
		// The picker gets first refusal on every key. Enter chooses an asset when
		// the list is open and sends only when it is not — otherwise picking an
		// asset would also send the half-written message.
		if (mentions.handleKeyDown(event)) return
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault()
			send()
		}
	}
}

/**
 * The composer: one surface that holds its own controls.
 *
 * Two other arrangements were built and looked at side by side at real size —
 * a calmer one with the controls above the box, and a single-row one. Both lost
 * to this for the same reason: they put the model and the effort *below or above*
 * the box as a caption, and a caption is a label where this needs a control. The
 * thing you most want to vary per message should not be a click away in another
 * surface, which is what the first version of this panel did.
 */
function Composer(props: ComposerProps) {
	const onKeyDown = useComposerKeys(props.send, props.mentions)

	// A textarea does not grow on its own. Height tracks content up to the
	// max-height ceiling (10rem, from `max-h-40`); past it, the box holds still
	// and the text scrolls inside. Driven by the draft value rather than input
	// events so sending — which clears the draft — also collapses the box.
	useEffect(() => {
		const el = props.inputRef.current
		if (!el) return
		el.style.height = "auto"
		el.style.height = `${Math.min(el.scrollHeight, 160)}px`
	}, [props.draft, props.inputRef])

	return (
		<footer
			className="relative shrink-0 p-2.5"
			onDragOver={(event) => event.preventDefault()}
			onDrop={(event) => {
				if (event.dataTransfer.files.length === 0) return
				event.preventDefault()
				props.attachFiles(Array.from(event.dataTransfer.files))
			}}>
			<AssetMentionList mentions={props.mentions} />
			<ModelNoticeLine notice={props.notice} onOpenBackendSetup={props.onOpenBackendSetup} />
			<div className="rounded-xl border border-shell-border bg-shell-bg focus-within:border-white/20">
				<AttachedImages attached={props.attached} setAttached={props.setAttached} />
				<textarea
					className="max-h-40 min-h-[46px] w-full resize-none overflow-y-auto bg-transparent px-3 pt-2.5 leading-relaxed outline-none placeholder:text-shell-muted"
					data-testid="chat-input"
					disabled={!props.ready}
					onChange={(event) => props.setDraft(event.target.value)}
					onKeyDown={onKeyDown}
					// A screenshot in the clipboard is the commonest way anyone has an
					// image to show; making them save it to disk first would be the only
					// step in this flow that leaves the app.
					onPaste={(event) => {
						const files = Array.from(event.clipboardData.files)
						if (files.length === 0) return
						event.preventDefault()
						props.attachFiles(files)
					}}
					placeholder={
						props.ready
							? props.mode === "read-only"
								? "Refine the plan, or switch to Act to apply it…"
								: PLACEHOLDER
							: "No backend connected"
					}
					ref={props.inputRef}
					rows={1}
					value={props.draft}
				/>
				<div className="flex items-center gap-1.5 px-2 pt-0.5 pb-2">
					<AttachMenu {...props} />
					<ModelPicker {...props} />
					{props.effort && <Pill label={props.effort} onClick={props.onOpenBackendSetup} />}
					<div className="flex-1" />
					<SendButton {...props} />
				</div>
			</div>
			{/* Below the box, not in it: the mode is a stance for the conversation,
			    and the in-box row is already spent on per-message controls. It also
			    stopped fitting — the toggle inside the row squeezed the model pill
			    into the effort pill at this width. */}
			<div className="mt-1.5 flex items-center px-1">
				<ModeToggle disabled={!props.ready} flipMode={props.flipMode} mode={props.mode} />
			</div>
		</footer>
	)
}

/**
 * The Plan/Act toggle.
 *
 * In Plan the conversation's turns run read-only and the reply is a plan; in
 * Act they edit. Flipping to Act with a settled plan IS the approval — no
 * separate Apply button — which is why this control sits in the composer where
 * the decision is made, not in the header where a chip merely reported it.
 * Stays clickable while a turn streams (changing mode mid-turn is legitimate);
 * main's settled-plan guard is what makes a mid-stream flip execute nothing.
 */
function ModeToggle({
	mode,
	flipMode,
	disabled,
}: {
	mode: "read-only" | "write"
	flipMode(mode: "read-only" | "write"): void
	disabled: boolean
}) {
	const segment = (active: boolean) =>
		cn(
			"rounded-md px-2 py-0.5 text-[11px] transition-colors",
			active ? "bg-white/10 font-medium" : "text-shell-muted hover:text-shell-fg",
		)
	return (
		<div className="flex items-center gap-0.5 rounded-lg border border-shell-border p-0.5">
			<button
				aria-pressed={mode === "read-only"}
				className={segment(mode === "read-only")}
				data-testid="chat-mode-plan"
				disabled={disabled}
				onClick={() => mode !== "read-only" && flipMode("read-only")}
				title="Plan: discuss and refine — nothing is written"
				type="button">
				Plan
			</button>
			<button
				aria-pressed={mode === "write"}
				className={segment(mode === "write")}
				data-testid="chat-mode-act"
				disabled={disabled}
				onClick={() => mode !== "write" && flipMode("write")}
				title="Act: make the changes — flipping with a plan applies it"
				type="button">
				Act
			</button>
		</div>
	)
}

/** A model the provider refused, and what it said. */
interface ModelNotice {
	model: string
	message: string
}

/**
 * The picker: every model you can run right now, and the doors to the rest.
 *
 * This is where switching models happens, because switching models is the thing
 * you most often want to do between one message and the next, and it used to
 * mean leaving the conversation for a settings screen. The Backend tab still
 * exists and this still points at it — but only for the thing it is actually
 * for, which is connecting an account.
 *
 * Providers are groups rather than a flattened list for the same reason the
 * setup screen groups them: `gpt-5.6-luna` served by a subscription you already
 * pay for and the same weights billed per token are not the same offer, and a
 * flat list hides which one you are about to spend.
 */
function ModelPicker(props: ComposerProps) {
	const [open, setOpen] = useState(false)
	const [groups, setGroups] = useState<ModelGroupWire[] | null>(null)
	const [doors, setDoors] = useState<ProviderDoorWire[] | null>(null)
	const [probing, setProbing] = useState(false)
	const [filter, setFilter] = useState("")

	useEffect(() => {
		if (!open) return
		const close = () => setOpen(false)
		window.addEventListener("pointerdown", close)
		return () => window.removeEventListener("pointerdown", close)
	}, [open])

	// Fetched on open rather than on mount: the catalogue is several megabytes on
	// the other side of this call, and most sessions never open the picker.
	useEffect(() => {
		if (!open) return
		setFilter("")
		void invoke("agent:models").then((list) => setGroups(list ?? []))
		void invoke("agent:providerDoors").then((list) => setDoors(list ?? []))
	}, [open])

	// One connected provider is a short list; three is not, and that is the state
	// this whole feature exists to make normal. Matching the provider's name too,
	// so "kimi" finds the models as well as the door.
	const needle = filter.trim().toLowerCase()
	const shown = (groups ?? [])
		.map((group) => ({
			...group,
			models: needle
				? group.models.filter(
						(model) =>
							model.label.toLowerCase().includes(needle) ||
							model.id.toLowerCase().includes(needle) ||
							group.providerName.toLowerCase().includes(needle),
					)
				: group.models,
		}))
		.filter((group) => group.models.length > 0)
	const shownDoors = (doors ?? []).filter(
		(door) => !needle || door.name.toLowerCase().includes(needle) || door.sample.join(" ").toLowerCase().includes(needle),
	)

	const choose = async (id: string) => {
		setOpen(false)
		props.setNotice(null)
		await invoke("prefs:set", { backendModel: id })
		if (!id) return

		// Asked now, not when the user is three minutes into a turn. Entitlement is
		// not in any catalogue: a plan lists models it will refuse.
		setProbing(true)
		try {
			const refusal = await invoke("agent:probeModel", props.projectPath, id)
			props.setNotice(refusal ? { model: id, message: refusal } : null)
		} finally {
			setProbing(false)
		}
	}

	return (
		// Sized by its content and allowed to shrink — NOT flex-1. A zero-basis
		// flex-1 here split the row's free space equally with the spacer, so this
		// container got ~106px no matter how long the model name was, and the
		// un-shrinkable label span painted straight across the effort pill.
		<div className="relative min-w-0 shrink" onPointerDown={(event) => event.stopPropagation()}>
			<Pill
				grow
				label={probing ? "checking…" : props.model}
				onClick={() => setOpen(!open)}
				testId="chat-model-pill"
				warn={Boolean(props.notice)}
			/>
			{open && (
				<div
					// Pulled left of the pill and kept narrower than the sidebar: anchored
					// to the pill at full width it ran past the window edge, and a menu
					// whose right-hand column is clipped hides the very thing it is for.
					className="absolute -left-8 bottom-8 z-20 flex max-h-[60vh] w-[20.5rem] flex-col overflow-hidden rounded-lg border border-shell-border bg-shell-panel shadow-lg"
					data-testid="chat-model-menu">
					<input
						autoFocus
						className="shrink-0 border-b border-shell-border bg-transparent px-2.5 py-2 text-[12px] outline-none placeholder:text-shell-muted"
						data-testid="chat-model-filter"
						onChange={(event) => setFilter(event.target.value)}
						placeholder="Filter models…"
						value={filter}
					/>
					<div className="overflow-y-auto py-1">
						{/* Not a match for anything typed, so it goes when filtering starts. */}
						{!needle && (
							<MenuItem
								chosen={!props.modelId}
								label="Automatic"
								onClick={() => void choose("")}
								sub="Whatever the provider considers current"
							/>
						)}

						{shown.map((group) => (
							<div key={group.providerId}>
								<p className="mt-1 px-2.5 pt-1.5 pb-1 text-[10px] tracking-wide text-shell-muted uppercase">
									{group.providerName}
									{group.subscription && <span className="ml-1.5 normal-case">· your plan</span>}
								</p>
								{group.models.map((model) => (
									<MenuItem
										chosen={props.modelId === model.id}
										key={model.id}
										label={model.label}
										onClick={() => void choose(model.id)}
										sub={describeCapabilities(model, group)}
										testId={`chat-model-${model.id}`}
									/>
								))}
							</div>
						))}

						{groups?.length === 0 && (
							<p className="px-2.5 py-2 text-[11px] leading-relaxed text-shell-muted">
								No provider is connected, so there is nothing to run yet.
							</p>
						)}

						{shownDoors.length > 0 && (
							<>
								<p className="mt-1 border-t border-shell-border px-2.5 pt-2 pb-1 text-[10px] tracking-wide text-shell-muted uppercase">
									Connect
								</p>
								{shownDoors.map((door) => (
									<MenuItem
										key={door.id}
										label={door.name}
										onClick={() => {
											setOpen(false)
											props.onOpenBackendSetup()
										}}
										sub={`${door.subscription ? "Subscription" : "API key"} · ${door.sample.slice(0, 2).join(", ")}`}
										testId={`chat-model-door-${door.id}`}
									/>
								))}
							</>
						)}
					</div>
				</div>
			)}
		</div>
	)
}

/**
 * What a model is, in the two facts that change what you can do with it.
 *
 * Sight is here because the overlay editor sends screenshots and a model that
 * cannot see them does not fail — it describes what it never saw. Cost is here
 * because "free" and "included in a plan you pay for" are different things.
 */
function describeCapabilities(model: ModelGroupWire["models"][number], group: ModelGroupWire): string {
	const parts: string[] = []
	if (model.contextTokens) parts.push(`${Math.round(model.contextTokens / 1000)}K context`)
	if (model.seesImages) parts.push("sees images")
	if (group.subscription) parts.push("included in your plan")
	else if (model.free) parts.push("no cost")
	return parts.join(" · ")
}

function MenuItem({
	chosen,
	label,
	onClick,
	sub,
	testId,
}: {
	chosen?: boolean
	label: string
	onClick(): void
	sub?: string
	testId?: string
}) {
	return (
		<button
			className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-white/5"
			data-testid={testId}
			onClick={onClick}
			type="button">
			<span className="mt-0.5 w-3 shrink-0 text-caret-accent">{chosen && <Check size={12} />}</span>
			<span className="min-w-0 flex-1">
				<span className="block truncate text-[12px]">{label}</span>
				{sub && <span className="block text-[10.5px] leading-snug text-shell-muted">{sub}</span>}
			</span>
		</button>
	)
}

/**
 * The provider's refusal, kept on screen.
 *
 * Quoted rather than paraphrased: only the provider knows whether this is a plan
 * that does not cover the model, a model retired from a free tier, or an expired
 * credential, and a Caret-authored sentence would have to guess at all three.
 */
function ModelNoticeLine({ notice, onOpenBackendSetup }: { notice: ModelNotice | null; onOpenBackendSetup(): void }) {
	if (!notice) return null
	return (
		<div
			className="mb-1.5 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5"
			data-testid="chat-model-notice">
			<AlertTriangle className="mt-0.5 shrink-0 text-amber-300" size={12} />
			<p className="min-w-0 flex-1 text-[11px] leading-relaxed text-amber-100/90">
				<span className="font-medium">{notice.model}</span> did not answer: {notice.message}
				<button className="ml-1 underline hover:text-amber-100" onClick={onOpenBackendSetup} type="button">
					Check the connection
				</button>
			</p>
		</div>
	)
}

/**
 * The paperclip, which now covers two different acts.
 *
 * Tagging an asset puts a name in the message that the agent resolves to a file
 * in the library and can *use in the page*. Attaching an image only lets the
 * model look at it — a reference to imitate, a screenshot of something wrong.
 * They were one button because the second did not exist; conflating them would
 * mean either every reference photo becomes a permanent asset or every asset
 * has to be described in words.
 *
 * `@` is untouched. Tagging still works by typing it, and this menu item does
 * exactly what the button did before: types the `@` and lets the picker open.
 */
function AttachMenu(props: ComposerProps) {
	const [open, setOpen] = useState(false)

	// Any click that is not on the menu closes it. Registered while open only, so
	// the common case costs nothing.
	useEffect(() => {
		if (!open) return
		const close = () => setOpen(false)
		window.addEventListener("pointerdown", close)
		return () => window.removeEventListener("pointerdown", close)
	}, [open])

	const choose = (act: () => void) => () => {
		setOpen(false)
		act()
	}

	return (
		<div className="relative" onPointerDown={(event) => event.stopPropagation()}>
			<IconButton label="Attach" onClick={() => setOpen(!open)}>
				<Paperclip size={13} />
			</IconButton>
			{open && (
				<div
					className="absolute bottom-8 left-0 z-20 w-44 overflow-hidden rounded-lg border border-shell-border bg-shell-panel py-1 shadow-lg"
					data-testid="chat-attach-menu">
					<AttachMenuItem
						hint="Name a file from the library so the agent can put it in the page"
						icon={<AtSign size={12} />}
						label="Tag asset"
						onClick={choose(props.onReferenceAsset)}
						testId="chat-attach-asset"
					/>
					<AttachMenuItem
						hint="Something for the model to look at, not added to the library"
						icon={<ImagePlus size={12} />}
						label="Upload image"
						onClick={choose(() => {
							void invoke("chat:pickImages").then((images) => {
								if (images && images.length > 0) props.setAttached((current) => [...current, ...images])
							})
						})}
						testId="chat-attach-image"
					/>
				</div>
			)}
		</div>
	)
}

function AttachMenuItem({
	hint,
	icon,
	label,
	onClick,
	testId,
}: {
	hint: string
	icon: React.ReactNode
	label: string
	onClick(): void
	testId: string
}) {
	return (
		<button
			className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-white/5"
			data-testid={testId}
			onClick={onClick}
			type="button">
			<span className="mt-0.5 text-shell-muted">{icon}</span>
			<span className="min-w-0">
				<span className="block text-[12px]">{label}</span>
				<span className="block text-[10.5px] leading-snug text-shell-muted">{hint}</span>
			</span>
		</button>
	)
}

/** Thumbnails above the text, so what is going with the message is never a guess. */
function AttachedImages({
	attached,
	setAttached,
}: {
	attached: ComposerImage[]
	setAttached: React.Dispatch<React.SetStateAction<ComposerImage[]>>
}) {
	if (attached.length === 0) return null
	return (
		<div className="flex flex-wrap gap-1.5 px-3 pt-2.5" data-testid="chat-attachments">
			{attached.map((image, index) => (
				<span className="group relative" key={`${image.name}-${index}`} title={image.name}>
					<img
						alt={image.name}
						className="size-11 rounded-md border border-shell-border object-cover"
						src={image.dataUrl}
					/>
					<button
						className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-shell-panel text-shell-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-shell-text"
						onClick={() => setAttached((current) => current.filter((_, at) => at !== index))}
						title={`Remove ${image.name}`}
						type="button">
						<X size={10} />
					</button>
				</span>
			))}
		</div>
	)
}

/** Neutral, not accent: sending is the expected act, not the urgent one. */
function SendButton(props: ComposerProps) {
	if (props.streaming) {
		return (
			<button
				className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-white/10 transition-colors hover:bg-white/15"
				data-testid="chat-stop"
				onClick={props.onStop}
				title="Stop"
				type="button">
				<Square size={12} />
			</button>
		)
	}
	return (
		<button
			className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-white/10 transition-colors hover:bg-white/20 disabled:opacity-30"
			data-testid="chat-send"
			disabled={!props.ready || props.draft.trim().length === 0}
			onClick={props.send}
			title="Send"
			type="button">
			<Send size={12} />
		</button>
	)
}

function Pill({
	label,
	onClick,
	grow,
	testId,
	warn,
}: {
	label: string
	onClick(): void
	grow?: boolean
	testId?: string
	/** The chosen model would not answer. Rule 1 allows colour on this: it waits on you. */
	warn?: boolean
}) {
	return (
		<button
			className={cn(
				"flex items-center gap-1 rounded-lg px-1.5 py-1 text-[11px] transition-colors hover:bg-white/5 hover:text-shell-text",
				warn ? "text-amber-300" : "text-shell-muted",
				// The growing pill (the model name) truncates; a fixed pill (the
				// effort) never shrinks — one long model id must not squeeze its
				// neighbours into overlap, which is exactly what it did.
				grow ? "min-w-0 shrink" : "shrink-0",
			)}
			data-testid={testId}
			onClick={onClick}
			type="button">
			{/* min-w-0 is what makes truncate real: a flex item's default
			    min-width is its content, so without it the span never shrinks —
			    it overflows the button and paints over whatever sits beside it. */}
			<span className="min-w-0 truncate">{label}</span>
			<ChevronDown className="shrink-0" size={10} />
		</button>
	)
}

// ── transcript ──────────────────────────────────────────────────────────────

/** Splits a flat transcript into turns, each beginning at what the user said. */
function groupIntoTurns(entries: TranscriptEntryWire[]): TranscriptEntryWire[][] {
	const turns: TranscriptEntryWire[][] = []
	for (const entry of entries) {
		if (entry.kind === "user" || turns.length === 0) turns.push([])
		turns[turns.length - 1].push(entry)
	}
	return turns
}

function NoBackend({ detail, onOpenBackendSetup }: { detail?: string | null; onOpenBackendSetup(): void }) {
	return (
		<div className="mb-3 border-l-2 border-amber-500/60 pl-3" data-testid="chat-no-backend">
			<p className="leading-relaxed text-amber-200">{detail ?? "No coding backend is set up yet."}</p>
			<button
				className="mt-2 text-shell-muted underline underline-offset-2 transition-colors hover:text-shell-text"
				onClick={onOpenBackendSetup}
				type="button">
				Open backend settings
			</button>
		</div>
	)
}

/**
 * Sessions the History list should not carry.
 *
 * Visual edits create one session per click of the pencil, so a working
 * afternoon buries the actual conversations under dozens of "Edit" rows. The
 * pill already reported each one when it happened, and provenance keeps the
 * durable record — the History list is for conversations someone might want to
 * reopen. Syncs stay listed: their transcripts answer "what did that sync do".
 * (Titles are Caret's own, set at session creation, so matching on them is
 * matching on our own constants — "AI edit" covers pre-lane sessions.)
 */
const HIDDEN_SESSION_TITLES = new Set(["Edit", "AI edit"])

/** "14:32" for today, "Aug 21" for anything older — enough to tell sessions apart. */
function sessionWhen(updatedAt: number): string {
	const then = new Date(updatedAt)
	const now = new Date()
	const sameDay =
		then.getFullYear() === now.getFullYear() && then.getMonth() === now.getMonth() && then.getDate() === now.getDate()
	return sameDay
		? then.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
		: then.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function SessionList({
	sessions: allSessions,
	onPick,
	onDelete,
}: {
	sessions: AgentSessionWire[]
	onPick(id: string): void
	onDelete(id: string): void
}) {
	const sessions = allSessions.filter((session) => !HIDDEN_SESSION_TITLES.has(session.title))
	return (
		<div className="flex-1 overflow-y-auto py-1.5" data-testid="chat-sessions">
			{sessions.length === 0 ? (
				<p className="px-3.5 py-8 text-center text-[12px] leading-relaxed text-shell-muted">
					Nothing here yet. Conversations you have with Caret will be listed here to reopen.
				</p>
			) : (
				// A row is a group, not one button: a delete control nested inside
				// the pick button would be invalid HTML and misfire both handlers.
				sessions.map((session) => (
					<div
						className="group flex items-center pr-2 transition-colors hover:bg-white/5"
						data-testid="chat-session-row"
						key={session.id}>
						<button
							className="flex min-w-0 flex-1 items-baseline gap-3 px-3.5 py-2.5 text-left"
							onClick={() => onPick(session.id)}
							type="button">
							<span className="min-w-0 flex-1 truncate">{session.title}</span>
							<span className="shrink-0 text-[11px] text-shell-muted">{sessionWhen(session.updatedAt)}</span>
						</button>
						<button
							className="shrink-0 rounded-md p-1.5 text-shell-muted opacity-0 transition-opacity hover:text-red-300 focus-visible:opacity-100 group-hover:opacity-100"
							data-testid="chat-session-delete"
							onClick={() => onDelete(session.id)}
							title="Delete this conversation"
							type="button">
							<Trash2 size={12} />
						</button>
					</div>
				))
			)}
		</div>
	)
}

function Entry({
	entry,
	onRespond,
	assetTags,
	onViewAsset,
	livePlan,
	streaming,
	onDiscardPlan,
}: {
	entry: TranscriptEntryWire
	onRespond(requestId: string, decision: "allow" | "deny" | "allow-always"): void
	assetTags: ReadonlySet<string>
	onViewAsset(tag: string): void
	/** The settled plan, if any — names which entry renders as the live card. */
	livePlan: { kind: string; entryId: string } | null
	/** A turn is streaming: the card demotes, because its offers are inert until it ends. */
	streaming: boolean
	onDiscardPlan(): void
}) {
	switch (entry.kind) {
		case "user":
			return (
				<div className="fade-in mb-1 max-w-[82%] self-end rounded-xl rounded-br-sm bg-white/[0.07] px-3 py-2 leading-relaxed whitespace-pre-wrap">
					<TaggedText onTag={onViewAsset} tags={assetTags} text={entry.text} />
				</div>
			)

		case "assistant": {
			// A plan is not chat prose. The LIVE plan — the one a flip to Act
			// would execute — gets the card; superseded or consumed plans keep
			// their flag but demote to dimmed prose, so the transcript still
			// reads as history without two things claiming to be "the plan".
			// While a turn streams the card demotes too: main's guard already
			// makes a mid-stream flip inert, and a card promising "switch to
			// Act to apply" during a revision would be promising a no-op.
			if (entry.plan && entry.id === livePlan?.entryId && !streaming) {
				return (
					<div
						className="fade-in rounded-xl border border-shell-border bg-white/[0.03] px-3 py-2.5"
						data-testid="chat-plan">
						<p className="mb-1.5 text-[10px] font-medium tracking-widest text-shell-muted uppercase">Plan</p>
						<Markdown assetTags={assetTags} className="leading-relaxed" onAssetTag={onViewAsset} text={entry.text} />
						<div className="mt-2 flex items-center justify-between border-t border-shell-border pt-2 text-[11px] text-shell-muted">
							<span>
								Reply to revise it, or switch to Act to apply — open questions fall to their marked defaults.
							</span>
							{livePlan.kind === "sync-plan" && (
								<button
									className="shrink-0 transition-colors hover:text-shell-fg"
									data-testid="chat-plan-discard"
									onClick={onDiscardPlan}
									type="button">
									Discard plan
								</button>
							)}
						</div>
					</div>
				)
			}
			return (
				<Markdown
					assetTags={assetTags}
					className={cn("fade-in leading-relaxed", entry.plan && "opacity-60")}
					onAssetTag={onViewAsset}
					text={entry.text}
				/>
			)
		}

		case "thinking":
			return <Thinking text={entry.text} />

		case "tool":
			return (
				<div className="flex items-center gap-2 text-[11.5px] text-shell-muted" data-testid="chat-tool">
					<Wrench className={cn("shrink-0", entry.status === "running" && "animate-pulse")} size={11} />
					<span className="shrink-0">{entry.name}</span>
					<span className={cn("truncate", entry.status === "failed" && "text-red-300")}>{entry.summary}</span>
				</div>
			)

		case "permission":
			return <Permission entry={entry} onRespond={onRespond} />

		case "error":
			// A rule, not a filled card. At this width a stack of tinted boxes reads
			// as noise, and the text is the part that matters.
			return (
				<div className="flex items-start gap-2 border-l-2 border-red-500/60 pl-3 text-red-200">
					<AlertTriangle className="mt-0.5 shrink-0" size={13} />
					<span className="leading-relaxed">{entry.message}</span>
				</div>
			)

		case "note":
			return (
				<p className="border-l-2 border-shell-border pl-3 text-[11.5px] leading-relaxed text-shell-muted">{entry.text}</p>
			)
	}
}

/**
 * Plain text with known `@tags` made clickable, for the user's own bubbles.
 * The assistant side gets the same treatment inside `Markdown`, off the same
 * tokenizer, so the two halves of a conversation agree on what is a tag.
 */
function TaggedText({ text, tags, onTag }: { text: string; tags: ReadonlySet<string>; onTag(tag: string): void }) {
	const segments = useMemo(() => splitAssetTags(text, tags), [text, tags])
	return (
		<>
			{segments.map((segment, index) =>
				segment.kind === "tag" ? (
					<button
						className="text-caret-accent transition-colors hover:text-caret-accent-hover"
						data-testid="chat-asset-tag"
						key={index}
						onClick={() => onTag(segment.tag)}
						type="button">
						@{segment.tag}
					</button>
				) : (
					<span key={index}>{segment.text}</span>
				),
			)}
		</>
	)
}

/**
 * Assets the agent offered against one question, docked where approvals dock —
 * the tool call is blocked on this, which is what earns it the accent border.
 * Each chip is two acts on purpose: the picture opens the viewer for a closer
 * look, "Use this" is the answer. Looking must never commit.
 */
function AssetOptionsBlock({
	prompt,
	canvasUrl,
	onPick,
	onView,
	onDismiss,
}: {
	prompt: Extract<InterviewPromptWire, { kind: "asset-options" }>
	canvasUrl: string | null
	onPick(tag: string): void
	onView(tag: string): void
	onDismiss(): void
}) {
	// Same absolutising the library does: this chrome is not served by Vite, so
	// the index's relative paths would 404 against the chrome's own origin.
	const absolute = (url: string) => (canvasUrl ? new URL(url, canvasUrl).toString() : null)

	return (
		<div className="border-t border-caret-accent/40 px-3.5 py-3" data-testid="chat-asset-options">
			<div className="flex items-start gap-2">
				<div className="min-w-0 flex-1">
					<p className="leading-relaxed">{prompt.question}</p>
					{prompt.why && <p className="mt-0.5 text-[11.5px] leading-relaxed text-shell-muted">{prompt.why}</p>}
				</div>
				<button
					className="flex size-6 shrink-0 items-center justify-center rounded-lg text-shell-muted transition-colors hover:bg-white/10 hover:text-shell-text"
					data-testid="chat-asset-options-dismiss"
					onClick={onDismiss}
					title="Dismiss"
					type="button">
					<X size={12} />
				</button>
			</div>

			<div className="mt-2.5 flex flex-wrap gap-2">
				{prompt.options.map((option) => {
					const preview = option.kind === "video" && option.posterUrl ? option.posterUrl : option.url
					const src = option.kind === "image" || option.kind === "vector" || option.posterUrl ? absolute(preview) : null
					return (
						<div
							className="w-[104px] overflow-hidden rounded-lg border border-shell-border"
							data-testid="chat-asset-option"
							key={option.tag}>
							<button
								className="block h-16 w-full bg-black/20"
								onClick={() => onView(option.tag)}
								title={`Look at @${option.tag}`}
								type="button">
								{src ? (
									<img alt={option.tag} className="size-full object-cover" src={src} />
								) : (
									<span className="flex size-full items-center justify-center text-[10px] tracking-wide text-shell-muted uppercase">
										{option.kind}
									</span>
								)}
							</button>
							<p className="truncate px-1.5 pt-1 font-mono text-[10.5px] text-shell-muted" title={`@${option.tag}`}>
								@{option.tag}
							</p>
							<button
								className="w-full px-1.5 pt-0.5 pb-1.5 text-left text-[11px] font-medium text-caret-accent transition-colors hover:text-caret-accent-hover"
								data-testid="chat-asset-option-use"
								onClick={() => onPick(option.tag)}
								type="button">
								Use this
							</button>
						</div>
					)
				})}
			</div>
		</div>
	)
}

/**
 * A chat-placed question — generation consent, mostly — docked where the
 * conversation is. Same testids as the interview surface's question screen, so
 * one certification selector covers a question wherever it lands.
 */
function QuestionBlock({
	prompt,
	onAnswer,
	onDismiss,
}: {
	prompt: QuestionPromptWire
	onAnswer(choice: string): void
	onDismiss(): void
}) {
	return (
		<div className="border-t border-caret-accent/40 px-3.5 py-3" data-testid="chat-interview-dock">
			<div className="flex items-start gap-2" data-testid="interview-question">
				<div className="min-w-0 flex-1">
					<p className="leading-relaxed">{prompt.question}</p>
					{prompt.hint && <p className="mt-0.5 text-[11.5px] leading-relaxed text-shell-muted">{prompt.hint}</p>}
				</div>
				<button
					className="flex size-6 shrink-0 items-center justify-center rounded-lg text-shell-muted transition-colors hover:bg-white/10 hover:text-shell-text"
					data-testid="chat-interview-dismiss"
					onClick={onDismiss}
					title="Dismiss"
					type="button">
					<X size={12} />
				</button>
			</div>
			<div className="mt-2.5 flex flex-wrap gap-2">
				{prompt.choices.map((choice, index) => (
					<button
						className={cn(
							"rounded-lg px-3 py-1.5 transition-colors",
							index === 0
								? "bg-caret-accent font-medium text-white hover:bg-caret-accent-hover"
								: "text-shell-muted hover:bg-white/5",
						)}
						data-testid="interview-choice"
						key={choice}
						onClick={() => onAnswer(choice)}
						type="button">
						{choice}
					</button>
				))}
			</div>
		</div>
	)
}

/**
 * Chat-placed takes — the generated results, to point at. Same testids as the
 * interview surface's takes screen, for the same reason as above.
 */
function TakesBlock({ prompt, onPick, onDismiss }: { prompt: TakesPromptWire; onPick(index: string): void; onDismiss(): void }) {
	const usable = prompt.takes.filter((take) => !take.error)
	return (
		<div className="border-t border-caret-accent/40 px-3.5 py-3" data-testid="chat-interview-dock">
			<div className="flex items-start gap-2" data-testid="interview-takes">
				<div className="min-w-0 flex-1">
					<p className="leading-relaxed">{prompt.title}</p>
					{prompt.subtitle && (
						<p className="mt-0.5 text-[11.5px] leading-relaxed text-shell-muted">{prompt.subtitle}</p>
					)}
				</div>
				<button
					className="flex size-6 shrink-0 items-center justify-center rounded-lg text-shell-muted transition-colors hover:bg-white/10 hover:text-shell-text"
					data-testid="chat-interview-dismiss"
					onClick={onDismiss}
					title="Keep none of them"
					type="button">
					<X size={12} />
				</button>
			</div>
			{usable.length === 0 ? (
				<p className="mt-2 text-[11.5px] text-shell-muted" data-testid="interview-takes-empty">
					{prompt.takes[0]?.error ?? "Nothing came back."}
				</p>
			) : (
				<div className="mt-2.5 grid grid-cols-3 gap-2">
					{usable.map((take) => (
						<button
							className="overflow-hidden rounded-lg border border-shell-border transition-colors hover:border-caret-accent"
							data-interview-take={take.index}
							key={take.index}
							onClick={() => onPick(String(take.index))}
							type="button">
							<span className="block" style={{ backgroundColor: prompt.surface }}>
								<img alt="" className="block w-full" src={take.preview} />
							</span>
						</button>
					))}
				</div>
			)}
		</div>
	)
}

/**
 * Collapsed by default, and that is the point: reasoning is useful when
 * something went wrong and noise the rest of the time.
 */
function Thinking({ text }: { text: string }) {
	const [open, setOpen] = useState(false)
	return (
		<div className="text-[11.5px] text-shell-muted">
			<button className="flex items-center gap-1 hover:text-shell-text" onClick={() => setOpen(!open)} type="button">
				{open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
				Thinking
			</button>
			{/* Reasoning is markdown too — models bold their conclusions in it, and
			    those are the words you're opening this to find. */}
			{open && <Markdown className="mt-1 pl-4 leading-relaxed" text={text} />}
		</div>
	)
}

function Permission({
	entry,
}: {
	entry: Extract<TranscriptEntryWire, { kind: "permission" }>
	onRespond(requestId: string, decision: "allow" | "deny" | "allow-always"): void
}) {
	// While pending, the dock at the bottom of the sidebar is the one actionable
	// surface (see PermissionDock) — a second set of buttons here would be two
	// places answering one question. The transcript line appears once the ask is
	// settled, as the record of what was decided.
	if (entry.status === "pending") return null

	return (
		<p className="text-[11.5px] text-shell-muted" data-testid="chat-permission-resolved">
			{entry.status === "allowed" ? "Allowed" : "Refused"}
			{entry.automatic ? `: ${entry.automatic}` : ""}
		</p>
	)
}

/**
 * Replaces the composer while an ask waits — OpenCode's pattern, adopted
 * deliberately: docked ABOVE the input, the field run showed the user typing
 * "continue" into the box instead of answering. With the input gone, the
 * buttons are the only affordance, and answering brings it back. Allow is the
 * loud one; a permission ask is the agent mid-flow needing a yes far more
 * often than it needs a no.
 */
function PermissionDock({
	entry,
	onRespond,
}: {
	entry: Extract<TranscriptEntryWire, { kind: "permission" }>
	onRespond(requestId: string, decision: "allow" | "deny" | "allow-always"): void
}) {
	return (
		<div
			className="fade-in shrink-0 border-t border-caret-accent/40 bg-caret-accent/5 px-3.5 py-3"
			data-testid="chat-permission">
			<p className="mb-0.5 text-[11px] font-medium tracking-wide text-caret-accent uppercase">Waiting on you</p>
			<p className="mb-2.5 text-[12.5px] leading-relaxed">{entry.summary}</p>
			<div className="flex items-center gap-1.5">
				<button
					className="rounded-lg bg-caret-accent px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
					data-testid="chat-permission-allow"
					onClick={() => onRespond(entry.requestId, "allow")}
					type="button">
					Allow
				</button>
				<button
					className="rounded-lg px-2.5 py-1.5 text-[12px] text-shell-muted transition-colors hover:bg-white/5"
					onClick={() => onRespond(entry.requestId, "allow-always")}
					type="button">
					Always allow
				</button>
				<button
					className="rounded-lg px-2.5 py-1.5 text-[12px] text-shell-muted transition-colors hover:bg-white/5"
					data-testid="chat-permission-deny"
					onClick={() => onRespond(entry.requestId, "deny")}
					type="button">
					Refuse
				</button>
			</div>
		</div>
	)
}

/** Beyond this, the list is a wall — the count says the rest. */
const FILE_CHANGES_SHOWN = 5

/**
 * The turn's heartbeat: visible for the whole streaming window, not only until
 * first output. Long silences happen mid-turn too (thinking gaps, tool waits),
 * and this row is what says "still alive" through them. The elapsed counter is
 * the honest half — an animation loops identically whether the process is
 * alive or wedged; a counter cannot lie about time passing.
 */
/**
 * "47s", then "14m 39s", then "1h 05m" — the units a person thinks in.
 * A counter that reads 879s makes the user do the division; the whole point
 * of the counter is that the row's honesty costs the reader nothing.
 */
function elapsedLabel(seconds: number): string {
	if (seconds < 60) return `${seconds}s`
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
	return `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`
}

/**
 * How long since the LAST backend event — not since the turn began — before
 * the label softens to "Working for longer…". A long turn full of activity
 * stays plain "Working…" forever; only genuine quiet changes the words. When
 * the provider actually errors, the transcript shows the provider's own words
 * (see log-tail.ts); the label never diagnoses.
 */
const QUIET_LABEL_SECONDS = 60

function WorkingRow({ lastEventAt, waitingOn }: { lastEventAt: number | null; waitingOn: string | null }) {
	const [startedAt] = useState(() => Date.now())
	const [, tick] = useState(0)

	useEffect(() => {
		const timer = setInterval(() => tick((n) => n + 1), 1000)
		return () => clearInterval(timer)
	}, [])

	const seconds = Math.floor((Date.now() - startedAt) / 1000)
	const quiet = lastEventAt ? Math.floor((Date.now() - lastEventAt) / 1000) : 0

	// An open ask flips the row's meaning: the agent is not working, it is
	// waiting — on the reader. "Working…" here was measured costing minutes: it
	// told the user the agent was busy while everything sat on their answer.
	if (waitingOn) {
		return (
			<div className="mt-3 flex items-center gap-2.5 text-[12px] text-caret-accent" data-testid="chat-working">
				<ThinkingOrb size={20} state="breathing" theme="dark" />
				<span>Waiting for you — {waitingOn}</span>
			</div>
		)
	}

	return (
		<div className="mt-3 flex items-center gap-2.5 text-[12px] text-shell-muted" data-testid="chat-working">
			<ThinkingOrb size={20} state="working" theme="dark" />
			<span>{quiet >= QUIET_LABEL_SECONDS ? "Working for longer than usual…" : "Working…"}</span>
			{seconds >= 3 && <span className="tabular-nums text-shell-muted/70">{elapsedLabel(seconds)}</span>}
		</div>
	)
}

function FileChanges({ files }: { files: string[] }) {
	const [expanded, setExpanded] = useState(false)
	if (files.length === 0) return null

	// Unbounded, a big turn's file list eats the whole sidebar — eleven lines of
	// paths crowding out the conversation they belong to.
	const shown = expanded ? files : files.slice(0, FILE_CHANGES_SHOWN)
	const hidden = files.length - shown.length

	return (
		<div className="mt-7 border-t border-shell-border pt-2.5" data-testid="chat-files">
			<p className="mb-1.5 text-[11px] tracking-wide text-shell-muted uppercase">
				Changed {files.length > 1 ? `· ${files.length}` : ""}
			</p>
			{shown.map((file) => (
				<p className="truncate text-[11.5px] text-shell-muted" key={file} title={file}>
					{file.split("/").slice(-2).join("/")}
				</p>
			))}
			{hidden > 0 && (
				<button
					className="mt-0.5 text-[11.5px] text-shell-muted underline-offset-2 hover:text-shell-text hover:underline"
					onClick={() => setExpanded(true)}
					type="button">
					+{hidden} more…
				</button>
			)}
			{expanded && files.length > FILE_CHANGES_SHOWN && (
				<button
					className="mt-0.5 text-[11.5px] text-shell-muted underline-offset-2 hover:text-shell-text hover:underline"
					onClick={() => setExpanded(false)}
					type="button">
					Show fewer
				</button>
			)}
		</div>
	)
}

function IconButton({ children, label, onClick }: { children: React.ReactNode; label: string; onClick(): void }) {
	return (
		<button
			className="flex size-7 shrink-0 items-center justify-center rounded-lg text-shell-muted transition-colors hover:bg-white/10 hover:text-shell-text"
			onClick={onClick}
			title={label}
			type="button">
			{children}
		</button>
	)
}

/**
 * A model, named as `model (provider)`.
 *
 * This slot used to render the *backend's* display name, so the composer said
 * "OpenCode (bundled)" as though that were a model. It is not: OpenCode is the
 * agent loop Caret drives, and it reaches several providers, one of which is
 * free and one of which is not. When Caret hosts its own inference it becomes a
 * provider on the same footing.
 *
 * OpenCode's ids already carry the provider (`opencode-go/gpt-5.6-luna`); the
 * other backends' are bare, so the provider comes from the backend itself.
 */
function describeModel(model: string, providerName: string | null | undefined): string {
	if (!model) return "Automatic"

	const slash = model.lastIndexOf("/")
	if (slash === -1) return providerName ? `${model} (${providerName})` : model
	return `${model.slice(slash + 1)} (${model.slice(0, slash)})`
}
