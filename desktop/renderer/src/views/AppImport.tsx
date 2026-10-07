/**
 * "Bring your app's screens in" — the code → design import, as the user meets it.
 *
 * Shown on the design-system page of a project with app code, once its design
 * system is set: the screens Caret found, each checkable, then live progress
 * while they are translated in the background. The scope is the user's call
 * because each screen is a model turn on their plan; the list says how many
 * and what, and nothing starts until they press the button.
 */
import { AlertTriangle, Check, Loader2, X } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"

import type { ImportProgressWire, ImportSurveyResultWire, ProjectState } from "../../../shared/ipc"
import { invoke, on } from "../ipc"
import { cn } from "../lib/utils"

/** Pre-checked by default; the rest are one click away, never silently left out. */
const DEFAULT_SELECTION = 12

/** The latest import progress for a project, from the push and from a catch-up ask on mount. */
export function useImportProgress(projectPath: string): ImportProgressWire | null {
	const [progress, setProgress] = useState<ImportProgressWire | null>(null)
	useEffect(() => {
		let cancelled = false
		void invoke("import:status", projectPath).then((current) => !cancelled && current && setProgress(current))
		const off = on("import:progress", (path, next) => {
			if (path === projectPath) setProgress(next)
		})
		return () => {
			cancelled = true
			off()
		}
	}, [projectPath])
	return progress
}

export function AppImportCard({
	project,
	onMakePageInstead,
	onOpenBackend,
}: {
	project: ProjectState
	onMakePageInstead?(): void
	onOpenBackend?(): void
}) {
	const progress = useImportProgress(project.path)
	const [survey, setSurvey] = useState<ImportSurveyResultWire | null>(null)
	const [chosen, setChosen] = useState<Set<string>>(new Set())
	const [starting, setStarting] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [dismissed, setDismissed] = useState(false)
	/** "Try the rest" was pressed: show a fresh survey instead of the finished run. */
	const [again, setAgain] = useState(false)
	const showProgress = progress !== null && !(again && progress.state === "finished")

	const load = useCallback(async () => {
		setSurvey(null)
		setError(null)
		const result = await invoke("import:survey", project.path)
		setSurvey(result)
		setChosen(new Set((result.survey?.screens ?? []).slice(0, DEFAULT_SELECTION).map((screen) => screen.id)))
	}, [project.path])

	// Only survey when there is no import to show — a finished one keeps its
	// summary until the user asks for the rest.
	useEffect(() => {
		if (!showProgress) void load()
	}, [showProgress, load])

	// A run that starts (from here or another surface) takes the card over again.
	useEffect(() => {
		if (progress?.state === "running") setAgain(false)
	}, [progress?.state])

	if (dismissed) return null
	if (progress && showProgress) {
		return (
			<ImportProgressView
				onImportRest={progress.state === "finished" ? () => setAgain(true) : undefined}
				progress={progress}
				projectPath={project.path}
			/>
		)
	}

	const screens = survey?.survey?.screens ?? []

	const start = async () => {
		setStarting(true)
		setError(null)
		try {
			const result = await invoke("import:start", project.path, [...chosen])
			if (!result.ok) setError(result.reason ?? "The import could not start.")
		} finally {
			setStarting(false)
		}
	}

	return (
		<section className="mb-6 rounded-xl border border-caret-accent/60 bg-shell-panel px-5 py-4" data-testid="app-import-card">
			<div className="flex items-start gap-4">
				<div className="min-w-0 flex-1">
					<div className="font-medium">Bring your app's screens in</div>
					<p className="mt-0.5 text-[12.5px] leading-relaxed text-shell-muted">
						Each screen becomes a design page in this design system, so you can edit it on the canvas and sync changes
						back. Your app is only read, never changed.
					</p>
				</div>
				<button
					aria-label="Not now"
					className="rounded-lg p-1 text-shell-muted transition-colors hover:bg-white/5 hover:text-shell-text"
					data-testid="app-import-dismiss"
					onClick={() => setDismissed(true)}
					type="button">
					<X size={14} />
				</button>
			</div>

			{survey === null && (
				<p className="mt-4 flex items-center gap-2 text-[12.5px] text-shell-muted" data-testid="app-import-surveying">
					<Loader2 className="animate-spin" size={13} />
					Finding your app's screens…
				</p>
			)}

			{survey && !survey.ok && (
				<p className="mt-4 text-[12.5px] leading-relaxed text-amber-300" data-testid="app-import-unavailable">
					{survey.reason}{" "}
					{onOpenBackend && (
						<button className="underline underline-offset-2" onClick={onOpenBackend} type="button">
							Open Backend
						</button>
					)}
				</p>
			)}

			{survey?.ok && screens.length === 0 && (
				<p className="mt-4 text-[12.5px] text-shell-muted" data-testid="app-import-nothing">
					{(survey.survey?.alreadyImported ?? 0) > 0
						? "Every screen Caret found is already in the design layer."
						: "Caret didn't find any screens to bring in."}
				</p>
			)}

			{screens.length > 0 && (
				<>
					<div className="mt-4 flex items-center justify-between text-[11px] tracking-wider text-shell-muted uppercase">
						<span>
							{screens.length} screen{screens.length === 1 ? "" : "s"} found
						</span>
						<button
							className="normal-case tracking-normal hover:text-shell-text"
							onClick={() =>
								setChosen(
									chosen.size === screens.length ? new Set() : new Set(screens.map((screen) => screen.id)),
								)
							}
							type="button">
							{chosen.size === screens.length ? "Select none" : "Select all"}
						</button>
					</div>
					<div
						className="mt-2 max-h-64 overflow-auto rounded-lg border border-shell-border"
						data-testid="app-import-list">
						{screens.map((screen) => {
							const on = chosen.has(screen.id)
							return (
								<label
									className="flex cursor-pointer items-center gap-3 border-t border-shell-border px-3 py-2 first:border-t-0 hover:bg-white/[0.03]"
									key={screen.id}>
									<input
										checked={on}
										className="accent-[#0b7aff]"
										data-testid={`app-import-screen-${screen.id}`}
										onChange={() => {
											const next = new Set(chosen)
											if (on) next.delete(screen.id)
											else next.add(screen.id)
											setChosen(next)
										}}
										type="checkbox"
									/>
									<span className="min-w-0 flex-1 truncate">{screen.title}</span>
									<span className="max-w-[45%] truncate font-mono text-[11px] text-shell-muted">
										{screen.route ?? screen.appPaths[0]}
									</span>
								</label>
							)
						})}
					</div>
					{(survey?.survey?.shell.length ?? 0) > 0 && (
						<p className="mt-2 text-[11.5px] text-shell-muted">
							Your shared layout ({survey?.survey?.shell.join(", ")}) comes in first, so every page uses one copy of
							it.
						</p>
					)}
					<div className="mt-4 flex flex-wrap items-center gap-3">
						<button
							className="rounded-lg bg-caret-accent px-4 py-2 font-medium text-white transition-colors hover:bg-caret-accent-hover disabled:opacity-40"
							data-testid="app-import-start"
							disabled={chosen.size === 0 || starting}
							onClick={() => void start()}
							type="button">
							{starting ? "Starting…" : `Import ${chosen.size} screen${chosen.size === 1 ? "" : "s"}`}
						</button>
						<span className="text-[11.5px] text-shell-muted">
							Runs in the background. Each screen is one turn on your connected model.
						</span>
					</div>
					{error && (
						<p className="mt-3 text-[12px] text-amber-300" data-testid="app-import-error">
							{error}{" "}
							{onOpenBackend && /model/i.test(error) && (
								<button className="underline underline-offset-2" onClick={onOpenBackend} type="button">
									Open Backend
								</button>
							)}
						</p>
					)}
				</>
			)}

			{onMakePageInstead && (
				<button
					className="mt-4 block text-[12px] text-shell-muted transition-colors hover:text-shell-text"
					data-testid="app-import-make-page"
					onClick={onMakePageInstead}
					type="button">
					Or make a new page instead
				</button>
			)}
		</section>
	)
}

function ImportProgressView({
	progress,
	projectPath,
	onImportRest,
}: {
	progress: ImportProgressWire
	projectPath: string
	onImportRest?(): void
}) {
	const counts = useMemo(() => countOf(progress), [progress])
	const running = progress.state === "running"

	return (
		<section
			className="mb-6 rounded-xl border border-shell-border bg-shell-panel px-5 py-4"
			data-testid="app-import-progress">
			<div className="flex items-center gap-3">
				{running ? (
					<Loader2 className="animate-spin text-caret-accent" size={15} />
				) : (
					<Check className="text-emerald-400" size={15} />
				)}
				<div className="min-w-0 flex-1">
					<div className="font-medium">
						{running
							? `Importing your app's screens: ${counts.done} of ${counts.total}`
							: `Imported ${counts.done} of ${counts.total} screen${counts.total === 1 ? "" : "s"}`}
					</div>
					<div className="text-[12px] text-shell-muted">
						{running
							? "Pages appear on the canvas as they land. You can keep working."
							: counts.failed > 0
								? `${counts.failed} didn't come through. You can try them again.`
								: "They're on the canvas, marked as from your app."}
					</div>
				</div>
				{running && (
					<button
						className="rounded-lg border border-shell-border px-3 py-1.5 text-[12px] transition-colors hover:bg-white/5"
						data-testid="app-import-stop"
						onClick={() => void invoke("import:cancel", projectPath)}
						type="button">
						Stop
					</button>
				)}
				{!running && onImportRest && counts.failed + counts.cancelled > 0 && (
					<button
						className="rounded-lg border border-shell-border px-3 py-1.5 text-[12px] transition-colors hover:bg-white/5"
						data-testid="app-import-rest"
						onClick={onImportRest}
						type="button">
						Try the rest
					</button>
				)}
			</div>

			<div className="mt-3 max-h-56 overflow-auto rounded-lg border border-shell-border" data-testid="app-import-rows">
				{progress.shell && (
					<Row
						error={progress.shell.error}
						label="Shared layout"
						status={progress.shell.status}
						sub={progress.shell.appPaths.join(", ")}
					/>
				)}
				{progress.screens.map((screen) => (
					<Row
						error={screen.error}
						key={screen.id}
						label={screen.title}
						status={screen.status}
						sub={screen.route ?? screen.appPaths[0]}
					/>
				))}
			</div>
		</section>
	)
}

function Row({ label, sub, status, error }: { label: string; sub: string; status: string; error?: string }) {
	return (
		<div className="flex items-center gap-3 border-t border-shell-border px-3 py-2 first:border-t-0" data-status={status}>
			<span className="flex w-4 justify-center">
				{status === "working" && <Loader2 className="animate-spin text-caret-accent" size={13} />}
				{status === "done" && <Check className="text-emerald-400" size={13} />}
				{status === "failed" && <AlertTriangle className="text-amber-300" size={13} />}
				{(status === "queued" || status === "cancelled") && <span className="size-1.5 rounded-full bg-shell-border" />}
			</span>
			<span className={cn("min-w-0 flex-1 truncate", status === "cancelled" && "text-shell-muted line-through")}>
				{label}
			</span>
			<span className="max-w-[45%] truncate font-mono text-[11px] text-shell-muted" title={error ?? sub}>
				{status === "failed" && error ? error : sub}
			</span>
		</div>
	)
}

function countOf(progress: ImportProgressWire) {
	const total = progress.screens.length
	const by = (status: string) => progress.screens.filter((screen) => screen.status === status).length
	return { total, done: by("done"), failed: by("failed"), cancelled: by("cancelled") }
}

/** The top-bar pill while an import runs — visible from every surface, including the canvas. */
export function ImportPill({ progress, onClick }: { progress: ImportProgressWire; onClick(): void }) {
	const { done, total } = countOf(progress)
	return (
		<button
			className="flex shrink-0 items-center gap-2 rounded-full border border-shell-border bg-white/5 py-1 pr-2.5 pl-2 text-[11.5px] transition-colors hover:bg-white/10"
			data-testid="import-pill"
			onClick={onClick}
			title="Your app's screens are being brought into the design layer"
			type="button">
			<Loader2 className="animate-spin text-caret-accent" size={12} />
			Importing screens {done}/{total}
		</button>
	)
}
