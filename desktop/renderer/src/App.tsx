/**
 * The app chrome.
 *
 * Deliberately thin. The canvas is a native view sitting under this document,
 * not a React tree, so everything here is the frame around it: which project is
 * open, whether an agent is connected, and the full-window surfaces (foundation
 * wizard, agent setup, preferences) that temporarily take the canvas's place.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { landsInChat, type ProjectState } from "../../shared/ipc"
import { invoke, on } from "./ipc"
import { AssetsView } from "./views/AssetsView"
import { AssetViewer } from "./views/AssetViewer"
import { BackendPanel } from "./views/BackendPanel"
import { CHAT_SIDEBAR_WIDTH, ChatSidebar } from "./views/ChatSidebar"
import { FoundationView } from "./views/FoundationView"
import { NotificationStack } from "./views/NotificationStack"
import { ProjectPicker } from "./views/ProjectPicker"
import { TelemetryNotice } from "./views/TelemetryNotice"
import { TopBar } from "./views/TopBar"

/** Which full-window surface is covering the canvas, if any. */
export type Surface = "canvas" | "foundation" | "agent" | "assets"

export function App() {
	const [project, setProject] = useState<ProjectState | null>(null)
	const [surface, setSurface] = useState<Surface>("canvas")
	const [chatOpen, setChatOpen] = useState(false)
	/**
	 * The asset being viewed large, if any. Held here rather than in the chat
	 * because the viewer covers the canvas column while the chat stays beside it,
	 * and because opening it must also hide the native canvas view — which is
	 * this component's job, in the visibility effect below.
	 */
	const [viewerTag, setViewerTag] = useState<string | null>(null)
	/**
	 * True while a playground exploration is open. The playground lives in the
	 * canvas view, which other surfaces hide entirely — without this the chrome
	 * gives no sign that takes are generating or waiting for a pick.
	 */
	const [exploreOpen, setExploreOpen] = useState(false)
	/**
	 * True while an agent is blocked on a question. Nothing may navigate away
	 * from the foundation surface until it is answered — the token editor closes
	 * itself on a timer after saving, and that timer landing mid-interview would
	 * silently remove the screen the agent is waiting on.
	 *
	 * Held in a ref rather than state because the callers that need vetoing are
	 * exactly the ones holding a *stale* callback: a `setTimeout` scheduled before
	 * the interview began captured an older closure, so a dependency-based guard
	 * reads `false` and lets it through. The ref is always current, and nothing
	 * renders from this, so state would only add a needless re-render.
	 */
	const interviewPendingRef = useRef(false)

	const markInterviewPending = useCallback((pending: boolean) => {
		interviewPendingRef.current = pending
	}, [])
	const topBarRef = useRef<HTMLDivElement>(null)

	// Main pushes project state whenever Vite comes up, an agent connects, or
	// tokens change — the renderer never polls for it.
	useEffect(() => on("project:stateChanged", (next) => setProject(next)), [])

	useEffect(
		() =>
			on("explore:open-changed", (projectPath, open) => {
				if (projectPath === project?.path) setExploreOpen(open)
			}),
		[project?.path],
	)

	// The canvas view is positioned by main, which cannot measure the top bar.
	// Report its height whenever it changes, including on window resize.
	useEffect(() => {
		if (!project) return
		const element = topBarRef.current
		if (!element) return

		const report = () =>
			invoke("canvas:setBounds", project.path, {
				top: element.getBoundingClientRect().height,
				// The sidebar is a real DOM element beside the canvas view, so main
				// has to narrow the view by exactly its width or the two overlap.
				right: chatOpen ? CHAT_SIDEBAR_WIDTH : 0,
			})
		report()

		const observer = new ResizeObserver(report)
		observer.observe(element)
		return () => observer.disconnect()
	}, [project, chatOpen])

	// The asset viewer is a React overlay, which the native canvas view would
	// simply sit on top of — so viewing an asset hides the canvas exactly the
	// way switching surfaces does, and closing restores it.
	useEffect(() => {
		if (project) invoke("canvas:setVisible", project.path, surface === "canvas" && viewerTag === null)
	}, [project, surface, viewerTag])

	// A stale tag from the last project would open the viewer onto "nothing is
	// tagged that" in the new one.
	useEffect(() => setViewerTag(null), [project?.path])

	// An agent asking the user a direct question has to reach them. Left on the
	// canvas they would see nothing at all while the agent waited indefinitely,
	// so an arriving prompt takes them to it. Chat-placed prompts are the
	// exception — asset picks, and anything a chat-lane tool marked
	// `place: "chat"`, like generation consent: they render docked in the chat,
	// beside whatever the user was looking at, and switching them to Foundation
	// would hide the surface they answer on.
	useEffect(
		() =>
			on("interview:prompt", (prompt) => {
				// Same principle, different surface: the prompt has to land where
				// somebody will see it, or the agent blocks forever.
				if (landsInChat(prompt)) {
					setChatOpen(true)
					return
				}
				markInterviewPending(true)
				setViewerTag(null)
				setSurface("foundation")
			}),
		[],
	)

	// And a prompt that arrived before this listener existed still has to land.
	// An agent can call a blocking tool the instant the MCP endpoint is up, which
	// is earlier than the chrome finishes mounting — and a prompt lost in that
	// window blocks the agent forever on a question nobody ever saw. Asking once
	// on mount is the only thing that closes it, because the event that would
	// have switched the surface is the same event that was missed.
	useEffect(() => {
		if (!project) return
		void invoke("interview:pending").then((waiting) => {
			if (!waiting) return
			if (landsInChat(waiting)) {
				setChatOpen(true)
				return
			}
			markInterviewPending(true)
			setSurface("foundation")
		})
	}, [project])

	// A project with no foundation gets the wizard first. Generating pages before
	// tokens exist means re-styling all of them later, which is the exact rework
	// the design layer is supposed to prevent.
	useEffect(() => {
		if (project && !project.hasFoundation) setSurface("foundation")
	}, [project])

	/**
	 * Surface changes that a pending interview is allowed to veto.
	 *
	 * The flag is renderer-local but the truth lives in main, and the two can
	 * drift: a tool call abandoned by its client, or a prompt cancelled when a
	 * project closed, clears the prompt in main and never tells the renderer.
	 * The flag would then be stuck on forever and every button in the top bar
	 * would silently do nothing — a far worse failure than the one the veto
	 * exists to prevent. So a veto is confirmed against main before it is
	 * honoured, which makes the flag self-healing.
	 */
	const requestSurface = useCallback((next: Surface) => {
		// Only navigations that actually land are reported — a vetoed switch
		// never reaches either emit, so the funnel counts what users saw.
		if (!interviewPendingRef.current || next === "foundation") {
			setSurface(next)
			void invoke("analytics:event", "surface_switched", { surface: next })
			return
		}

		void invoke("interview:pending").then((pending) => {
			// A pending chat-placed prompt never vetoes: it is answered in the
			// chat, which travels with the user across surfaces.
			if (pending && !landsInChat(pending)) return
			interviewPendingRef.current = false
			setSurface(next)
			void invoke("analytics:event", "surface_switched", { surface: next })
		})
	}, [])

	const openProject = useCallback(async (projectPath: string) => {
		const state = await invoke("project:open", projectPath)
		if (state) setProject(state)
	}, [])

	if (!project) {
		return (
			<>
				<ProjectPicker onOpen={openProject} />
				<NotificationStack />
				{/* Also here: a first run can end without a project ever opening,
				    and the telemetry notice still has to have been seen. */}
				<TelemetryNotice />
			</>
		)
	}

	return (
		// `data-surface` is what the shell is actually showing, as opposed to what
		// was last clicked. The two diverge whenever a pending interview vetoes a
		// navigation, and without it that divergence shows up only as a selector
		// that never appears.
		<div className="flex h-full flex-col" data-surface={surface} data-testid="app-shell">
			<TopBar
				chatOpen={chatOpen}
				exploreOpen={exploreOpen}
				onSurfaceChange={requestSurface}
				onToggleChat={() => setChatOpen((open) => !open)}
				project={project}
				ref={topBarRef}
				surface={surface}
			/>

			<div className="flex min-h-0 flex-1">
				{/* `relative` so the asset viewer can blanket exactly this column —
				    the canvas's own footprint — while the chat stays beside it. */}
				<div className="relative flex min-w-0 flex-1 flex-col">
					{surface === "foundation" && (
						<FoundationView
							onDone={() => requestSurface("canvas")}
							onInterviewAnswered={() => markInterviewPending(false)}
							project={project}
						/>
					)}
					{surface === "agent" && <BackendPanel onClose={() => requestSurface("canvas")} project={project} />}
					{surface === "assets" && <AssetsView onClose={() => requestSurface("canvas")} project={project} />}
					{viewerTag && <AssetViewer onClose={() => setViewerTag(null)} project={project} tag={viewerTag} />}
				</div>

				{chatOpen && (
					<ChatSidebar
						onClose={() => setChatOpen(false)}
						onOpenBackendSetup={() => requestSurface("agent")}
						onViewAsset={setViewerTag}
						project={project}
					/>
				)}
			</div>

			<NotificationStack rightInset={chatOpen ? CHAT_SIDEBAR_WIDTH + 16 : 16} />
			<TelemetryNotice />
		</div>
	)
}
