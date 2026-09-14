/**
 * What you see before a project is open.
 *
 * Recents that no longer exist are shown as unavailable rather than hidden — a
 * project silently vanishing from the list reads as data loss, and telling
 * someone the folder moved is more useful than pretending it was never there.
 */

import { FolderOpen, FolderX } from "lucide-react"
import { useEffect, useState } from "react"

import type { ProjectSummary } from "../../../shared/ipc"
import caretIcon from "../assets/caret-icon.png"
import { invoke } from "../ipc"
import { cn } from "../lib/utils"

export function ProjectPicker({ onOpen }: { onOpen(projectPath: string): void }) {
	const [recents, setRecents] = useState<ProjectSummary[]>([])

	useEffect(() => {
		void invoke("project:recents").then(setRecents)
	}, [])

	const pickFolder = async () => {
		const picked = await invoke("project:pickFolder")
		if (picked) onOpen(picked)
	}

	return (
		<div className="titlebar-drag flex h-full flex-col items-center justify-center gap-8 px-8" data-testid="project-picker">
			<div className="flex flex-col items-center text-center">
				{/* White rounded tile behind the mark, as on the landing page. */}
				<span className="mb-4 flex size-16 items-center justify-center rounded-2xl bg-white shadow-sm ring-1 ring-black/10">
					<img alt="" className="size-11" draggable={false} src={caretIcon} />
				</span>
				<h1 className="text-2xl font-medium tracking-tight">Caret</h1>
				<p className="mt-1 text-shell-muted">A design layer that lives in your repo.</p>
			</div>

			<button
				className="titlebar-nodrag flex items-center gap-2 rounded-xl bg-caret-accent px-5 py-2.5 font-medium text-white transition-colors hover:bg-caret-accent-hover active:bg-caret-accent-press"
				onClick={pickFolder}
				type="button">
				<FolderOpen size={16} />
				Open a project
			</button>

			{recents.length > 0 && (
				<div className="titlebar-nodrag w-full max-w-md">
					<h2 className="mb-2 text-[11px] uppercase tracking-wider text-shell-muted">Recent</h2>
					<ul className="flex flex-col gap-0.5">
						{recents.map((project) => (
							<li key={project.path}>
								<button
									className={cn(
										"flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors",
										project.exists ? "hover:bg-white/5" : "cursor-not-allowed opacity-45",
									)}
									disabled={!project.exists}
									onClick={() => onOpen(project.path)}
									title={project.exists ? project.path : `${project.path} — no longer on disk`}
									type="button">
									{project.exists ? (
										<FolderOpen className="shrink-0 text-shell-muted" size={14} />
									) : (
										<FolderX className="shrink-0 text-shell-muted" size={14} />
									)}
									<span className="truncate font-medium">{project.name}</span>
									<span className="truncate text-[11px] text-shell-muted">{project.path}</span>
									{project.exists && !project.hasDesignLayer && (
										<span className="ml-auto shrink-0 rounded-md bg-white/5 px-1.5 py-0.5 text-[10px] text-shell-muted">
											no design layer yet
										</span>
									)}
								</button>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	)
}
