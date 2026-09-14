/**
 * The one strip of Caret chrome that is always visible.
 *
 * It carries the four things the user needs to know at a glance — which project,
 * whether the preview is up, whether an agent is connected, and how to sync —
 * and nothing else. Everything competing for space here competes with the design
 * work below it.
 */

import { Blocks, ChevronDown, FlaskConical, Images, MessageSquare, Palette, RefreshCw } from "lucide-react"
import { forwardRef, useCallback, useEffect, useRef, useState } from "react"

import type { ProjectState, ProjectSummary } from "../../../shared/ipc"
import type { Surface } from "../App"
import caretIcon from "../assets/caret-icon.png"
import { invoke, platform } from "../ipc"
import { cn } from "../lib/utils"

interface TopBarProps {
	project: ProjectState
	surface: Surface
	chatOpen: boolean
	/** A playground exploration is open — takes generating or waiting for a pick. */
	exploreOpen: boolean
	onSurfaceChange(surface: Surface): void
	onToggleChat(): void
}

export const TopBar = forwardRef<HTMLDivElement, TopBarProps>(function TopBar(
	{ project, surface, chatOpen, exploreOpen, onSurfaceChange, onToggleChat },
	ref,
) {
	return (
		<div
			className={cn(
				"titlebar-drag flex h-11 shrink-0 items-center gap-2 border-b border-shell-border bg-shell-panel px-3",
				// Leaves room for the macOS traffic lights, which sit over the content
				// under `titleBarStyle: hiddenInset`.
				platform === "darwin" && "pl-20",
			)}
			data-testid="top-bar"
			ref={ref}>
			{/* The mark rides a white rounded tile, matching the landing page — on the
			    dark shell the bare dark-on-transparent PNG had no contrast. */}
			<span className="flex size-[22px] shrink-0 items-center justify-center rounded-md bg-white">
				<img alt="Caret" className="size-4" draggable={false} src={caretIcon} />
			</span>
			<ProjectSwitcher project={project} />

			<StatusDot label={project.canvasUrl ? "Preview running" : "Starting preview…"} ok={project.canvasUrl !== null} />

			<div className="flex-1" />

			<div className="titlebar-nodrag flex items-center gap-1">
				{/* Only while an exploration is open: the playground lives in the
				    canvas, which other surfaces hide entirely — this is the way back. */}
				{exploreOpen && (
					<TopBarButton
						active={false}
						icon={<FlaskConical size={14} />}
						label="Exploring"
						onClick={() => onSurfaceChange("canvas")}
						tone="warn"
					/>
				)}

				<TopBarButton
					active={surface === "foundation"}
					icon={<Palette size={14} />}
					label="Foundation"
					onClick={() => onSurfaceChange(surface === "foundation" ? "canvas" : "foundation")}
				/>

				<TopBarButton
					active={surface === "assets"}
					icon={<Images size={14} />}
					label="Assets"
					onClick={() => onSurfaceChange(surface === "assets" ? "canvas" : "assets")}
				/>

				<TopBarButton active={chatOpen} icon={<MessageSquare size={14} />} label="Chat" onClick={onToggleChat} />

				<TopBarButton
					active={surface === "agent"}
					icon={<Blocks size={14} />}
					label="Backend"
					onClick={() => onSurfaceChange(surface === "agent" ? "canvas" : "agent")}
				/>

				<TopBarButton icon={<RefreshCw size={14} />} label="Sync" onClick={() => invoke("sync:now", project.path)} />
			</div>
		</div>
	)
})

/**
 * Which project you are in, and the way to a different one.
 *
 * The window is per-project — each one owns a Vite server, an MCP endpoint, a
 * healer and a backend session — so switching opens or focuses that project's
 * own window rather than swapping the directory underneath this one.
 *
 * It exists here because the only route used to be the application menu, and the
 * menu's recents list was a snapshot taken at startup: on a fresh install it read
 * "No Recent Projects" forever, however many projects you opened. Between the two
 * there was no way at all to reach a second project from inside the app.
 */
function ProjectSwitcher({ project }: { project: ProjectState }) {
	const [open, setOpen] = useState(false)
	const [recents, setRecents] = useState<ProjectSummary[]>([])
	const box = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (!open) return
		void invoke("project:recents").then((list) => setRecents(list ?? []))
	}, [open])

	// Any press outside closes it, and Escape does too — a menu you can only
	// dismiss by choosing something is a trap.
	useEffect(() => {
		if (!open) return
		const away = (event: MouseEvent) => {
			if (!box.current?.contains(event.target as Node)) setOpen(false)
		}
		const key = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false)
		document.addEventListener("mousedown", away, true)
		document.addEventListener("keydown", key)
		return () => {
			document.removeEventListener("mousedown", away, true)
			document.removeEventListener("keydown", key)
		}
	}, [open])

	const openProject = useCallback(async (projectPath: string) => {
		setOpen(false)
		await invoke("project:open", projectPath)
	}, [])

	const pick = useCallback(async () => {
		setOpen(false)
		const chosen = await invoke("project:pickFolder")
		if (chosen) await invoke("project:open", chosen)
	}, [])

	const others = recents.filter((entry) => entry.path !== project.path)

	return (
		<div className="titlebar-nodrag relative" ref={box}>
			<button
				className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[13px] font-medium transition-colors hover:bg-white/5"
				data-testid="project-switcher"
				onClick={() => setOpen((was) => !was)}
				title={project.path}
				type="button">
				<span className="max-w-[16rem] truncate">{project.name}</span>
				<ChevronDown className="shrink-0 opacity-50" size={13} />
			</button>

			{open && (
				<div
					className="absolute left-0 top-full z-50 mt-1 w-80 overflow-hidden rounded-lg border border-shell-border bg-shell-panel py-1 shadow-xl"
					data-testid="project-switcher-menu">
					{others.length > 0 && (
						<>
							<p className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-shell-muted">Recent</p>
							{others.map((entry) => (
								<button
									className="block w-full px-3 py-1.5 text-left hover:bg-white/5 disabled:opacity-40"
									data-project-recent={entry.path}
									disabled={!entry.exists}
									key={entry.path}
									onClick={() => openProject(entry.path)}
									title={entry.path}
									type="button">
									<span className="block truncate text-[13px]">{entry.name}</span>
									<span className="block truncate text-[11px] text-shell-muted">
										{entry.exists ? entry.path : "No longer on disk"}
									</span>
								</button>
							))}
							<div className="my-1 border-t border-shell-border" />
						</>
					)}
					<button
						className="block w-full px-3 py-1.5 text-left text-[13px] hover:bg-white/5"
						data-testid="project-open-other"
						onClick={pick}
						type="button">
						Open project…
					</button>
				</div>
			)}
		</div>
	)
}

function StatusDot({ ok, label }: { ok: boolean; label: string }) {
	return (
		<span className="flex items-center gap-1.5 text-[11px] text-shell-muted" title={label}>
			<span aria-hidden className={cn("size-1.5 rounded-full", ok ? "bg-emerald-400" : "animate-pulse bg-amber-400")} />
			{label}
		</span>
	)
}

interface TopBarButtonProps {
	icon: React.ReactNode
	label: string
	onClick(): void
	active?: boolean
	tone?: "ok" | "warn"
}

function TopBarButton({ icon, label, onClick, active, tone }: TopBarButtonProps) {
	return (
		<button
			className={cn(
				"flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] transition-colors",
				"hover:bg-white/5",
				active && "bg-caret-accent/15 text-caret-accent",
				tone === "warn" && !active && "text-amber-300",
				tone === "ok" && !active && "text-emerald-300",
			)}
			onClick={onClick}
			type="button">
			{icon}
			{label}
		</button>
	)
}
