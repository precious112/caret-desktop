/**
 * The take board: every take of one sitting as a tree.
 *
 * The first takes sit together in one box on the left. Changing a take grows a
 * branch from that exact take, one column to the right, joined to it by a line
 * in the branch's own colour that starts on the take itself. Nothing is ever
 * replaced: going back to an earlier take and trying another direction just
 * grows another branch. The side panel acts on the selected take: change it,
 * or name it and use it. Using a take keeps the board, so several can be saved.
 */
import { Loader2, Maximize2, X } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { BoardStartWire, BoardTakeWire, BoardWire, ProjectState } from "../../../../shared/ipc"
import { invoke, on } from "../../ipc"
import { cn } from "../../lib/utils"
import { branchColour, DEFAULT_SIZES, type LayoutSizes, layoutBoard, pathTo } from "./board-layout"

/** The change chips offered for a photograph, in the panel's order. */
export const CHANGE_CHIPS = ["Warmer light", "Closer in", "Simpler background", "More room for text", "Different angle"]

const PANEL_WIDTH = 340

/** Take boxes are a fixed width; their height follows the board's shape, within reason. */
function sizesFor(aspect: string): LayoutSizes {
	const [w, h] = aspect.split(":").map(Number)
	const ratio = w && h ? w / h : 3 / 2
	const takeWidth = 200
	return { ...DEFAULT_SIZES, takeWidth, takeHeight: Math.round(Math.min(260, Math.max(90, takeWidth / ratio))) }
}

/** A tag from the person's words, so the name field opens with something usable. */
export function suggestTag(text: string): string {
	const words = text
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.split(/\s+/)
		.filter((word) => word && !["a", "an", "the", "of", "and", "with", "on", "for", "in"].includes(word))
	return words.slice(0, 3).join("-") || "asset"
}

export function TakeBoard({
	project,
	start,
	onDone,
	onNewPrompt,
}: {
	project: ProjectState
	start: BoardStartWire
	onDone(saved: string | null): void
	onNewPrompt(): void
}) {
	const [board, setBoard] = useState<BoardWire | null>(null)
	const boardId = useRef<string | null>(null)
	const [selected, setSelected] = useState<string | null>(null)
	const [chips, setChips] = useState<string[]>([])
	const [strength, setStrength] = useState<"subtle" | "strong">("subtle")
	const [note, setNote] = useState("")
	const [tag, setTag] = useState(() => suggestTag(start.request.text))
	const [saving, setSaving] = useState(false)
	const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null)
	const [lastSaved, setLastSaved] = useState<string | null>(null)
	const [promptView, setPromptView] = useState<"yours" | "brief">("brief")
	const [full, setFull] = useState<{ takeId: string; picture: string | null } | null>(null)
	const noteRef = useRef<HTMLTextAreaElement>(null)
	const nameRef = useRef<HTMLInputElement>(null)

	/** Only ever moves forward: a late update for this board never replaces a newer one. */
	const accept = useCallback((next: BoardWire) => {
		if (boardId.current && next.id !== boardId.current) return
		boardId.current = next.id
		setBoard((current) => (current && current.id === next.id && current.version > next.version ? current : next))
	}, [])

	// Started once per mount. StrictMode mounts effects twice in development, and
	// a second start would close the first board and pay for its takes twice.
	const started = useRef(false)
	useEffect(() => {
		const off = on("generate:board", (path, next) => {
			if (path === project.path) accept(next)
		})
		if (!started.current) {
			started.current = true
			invoke("generate:boardStart", project.path, start).then((first) => {
				if (first) {
					boardId.current = first.id
					accept(first)
					setSelected((current) => current ?? first.takes[0]?.id ?? null)
				}
			})
		}
		return off
	}, [project.path, start, accept])

	const takes = useMemo(() => new Map((board?.takes ?? []).map((take) => [take.id, take])), [board])
	const branches = board?.branches ?? []
	const sizes = useMemo(() => sizesFor(board?.aspect ?? start.aspect), [board?.aspect, start.aspect])
	const layout = useMemo(() => layoutBoard(branches, sizes), [branches, sizes])
	const path = selected ? pathTo(branches, selected) : []
	const onPath = new Set(path.map((step) => step.branch.id))
	const current = selected ? takes.get(selected) : undefined
	const currentBranch = current ? branches.find((branch) => branch.id === current.branchId) : undefined
	const running = (board?.takes ?? []).filter((take) => take.status === "waiting" || take.status === "working").length
	const takeLabel = (take: BoardTakeWire) => {
		const branch = branches.find((candidate) => candidate.id === take.branchId)
		return `${branch?.label ?? "Takes"}, take ${take.index + 1}`
	}

	const grow = async () => {
		if (!current || current.status !== "ready") return
		setMessage(null)
		const result = await invoke("generate:boardBranch", project.path, current.id, { chips, note, strength })
		if (!result) return
		if (!result.ok) {
			setMessage({ tone: "error", text: result.error })
			return
		}
		accept(result.board)
		const branch = result.board.branches[result.board.branches.length - 1]
		setSelected(branch.takeIds[0])
		setChips([])
		setNote("")
	}

	const save = async () => {
		if (!current || current.status !== "ready" || saving) return
		setSaving(true)
		setMessage(null)
		try {
			const result = await invoke("generate:boardSave", project.path, current.id, tag)
			if (result?.ok) {
				setLastSaved(result.tag ?? tag)
				setMessage({ tone: "ok", text: `Saved as @${result.tag ?? tag}. You can use another take too, or press Done.` })
			} else {
				setMessage({ tone: "error", text: result?.error ?? "That couldn't be saved." })
			}
		} finally {
			setSaving(false)
		}
	}

	const cancel = (takeIds?: string[]) =>
		invoke("generate:boardCancel", project.path, takeIds).then((next) => next && accept(next))

	const openFull = useCallback(
		async (takeId: string) => {
			setFull({ takeId, picture: null })
			const picture = await invoke("generate:boardPicture", project.path, takeId)
			setFull((now) => (now?.takeId === takeId ? { takeId, picture } : now))
		},
		[project.path],
	)

	// Full size: Escape closes it, the arrows move between the takes of one branch.
	useEffect(() => {
		if (!full) return
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setFull(null)
			if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
			const take = takes.get(full.takeId)
			const branch = take && branches.find((candidate) => candidate.id === take.branchId)
			const ready = (branch?.takeIds ?? []).filter((id) => takes.get(id)?.status === "ready")
			if (ready.length < 2) return
			const at = ready.indexOf(full.takeId)
			const next = ready[(at + (event.key === "ArrowRight" ? 1 : ready.length - 1)) % ready.length]
			setSelected(next)
			void openFull(next)
		}
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [full, takes, branches, openFull])

	const showBrief = board?.brief && promptView === "brief"

	return (
		<div className="flex min-h-0 flex-1 flex-col" data-board-id={board?.id ?? ""} data-testid="take-board">
			<div className="flex items-start gap-3 border-b border-shell-border px-6 py-2.5" data-testid="board-prompt">
				{board?.mode === "exact" ? (
					<span className="mt-0.5 shrink-0 rounded-full border border-shell-border px-2 py-0.5 text-[11px] text-shell-muted">
						Your words, exactly
					</span>
				) : board?.brief ? (
					<span className="flex shrink-0 rounded-md border border-shell-border p-0.5 text-[11.5px]">
						{(["yours", "brief"] as const).map((view) => (
							<button
								className={cn(
									"rounded px-2 py-0.5",
									promptView === view ? "bg-shell-border text-shell-fg" : "text-shell-muted",
								)}
								data-testid={`board-prompt-${view}`}
								key={view}
								onClick={() => setPromptView(view)}
								type="button">
								{view === "yours" ? "Your words" : "Caret's brief"}
							</button>
						))}
					</span>
				) : null}
				<p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-shell-muted" data-testid="board-prompt-text">
					{board?.preparing ? (
						<span data-testid="board-preparing">
							<Loader2 className="mr-1.5 inline animate-spin align-[-2px]" size={12} />
							{board.preparing}
						</span>
					) : board?.briefing ? (
						<span>
							<Loader2 className="mr-1.5 inline animate-spin align-[-2px]" size={12} />
							Caret is writing the brief from your words…
						</span>
					) : showBrief ? (
						board?.brief
					) : (
						(board?.yourWords ?? start.request.text)
					)}
				</p>
				{running > 0 && (
					<button
						className="shrink-0 rounded-md border border-shell-border px-2.5 py-1 text-xs"
						data-testid="board-stop-all"
						onClick={() => cancel()}
						type="button">
						Stop all ({running})
					</button>
				)}
			</div>
			{board?.briefNote && (
				<p
					className="border-b border-shell-border bg-amber-500/10 px-6 py-1.5 text-xs text-amber-200"
					data-testid="board-brief-note">
					{board.briefNote}
				</p>
			)}
			<div
				className="flex min-h-[42px] flex-wrap items-center gap-1.5 border-b border-shell-border px-6 py-1.5 text-xs"
				data-testid="board-path">
				<span className="mr-1 text-shell-muted">You are on</span>
				{path.map((step, index) => {
					const take = takes.get(step.takeId)
					return (
						<span className="flex items-center gap-1.5" key={step.takeId}>
							{index > 0 && <span className="text-shell-muted">›</span>}
							<button
								className="flex items-center gap-1.5 rounded-md border bg-shell-panel py-0.5 pr-2 pl-0.5"
								data-take-id={step.takeId}
								onClick={() => setSelected(step.takeId)}
								style={{ borderColor: `${branchColour(branches, step.branch.id)}66` }}
								type="button">
								{take?.preview ? (
									<img alt="" className="h-5 w-8 rounded-sm object-cover" src={take.preview} />
								) : (
									<span className="h-5 w-8 rounded-sm bg-shell-border/40" />
								)}
								<span
									className="size-2 rounded-full"
									style={{ backgroundColor: branchColour(branches, step.branch.id) }}
								/>
								{take ? takeLabel(take) : step.takeId}
							</button>
						</span>
					)
				})}
			</div>

			<div className="flex min-h-0 flex-1">
				<div
					className="relative min-w-0 flex-1 overflow-auto"
					data-testid="board-canvas"
					style={{ background: "radial-gradient(circle at 1px 1px, #1a1f2a 1px, transparent 0) 0 0 / 22px 22px" }}>
					<div className="relative" style={{ width: layout.width + 40, height: layout.height + 40 }}>
						{layout.branches.map((box) => {
							const branch = branches.find((candidate) => candidate.id === box.id)
							const colour = branchColour(branches, box.id)
							return (
								<div key={box.id}>
									<div
										className="absolute rounded-xl border bg-shell-panel/60"
										data-branch-id={box.id}
										data-testid="board-branch"
										style={{
											left: box.x,
											top: box.y,
											width: box.width,
											height: box.height,
											borderColor: onPath.has(box.id) ? colour : undefined,
											borderStyle: onPath.has(box.id) ? "solid" : "dashed",
										}}
									/>
									<div
										className="absolute flex max-w-[220px] items-center gap-1.5 truncate text-[11.5px] text-shell-muted"
										style={{ left: box.x + 12, top: box.y + 6 }}>
										<span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: colour }} />
										<b className="truncate font-semibold text-shell-fg">{branch?.label}</b>
										{branch?.strength && <span>· {branch.strength}</span>}
										{!branch?.parentTakeId && board && (
											<span>
												·{" "}
												{board.mode === "exact"
													? "your words"
													: branch?.source === "brief"
														? "Caret's brief"
														: "your words"}
											</span>
										)}
									</div>
								</div>
							)
						})}

						<svg
							className="pointer-events-none absolute top-0 left-0"
							height={layout.height + 40}
							style={{ zIndex: 2 }}
							width={layout.width + 40}>
							{layout.lines.map((line) => {
								const colour = branchColour(branches, line.branchId)
								const hot = onPath.has(line.branchId)
								const { from, to } = line
								const x1 = from.x + 9
								return (
									<g data-line-for={line.branchId} key={line.branchId}>
										<path
											d={`M${x1},${from.y} C${x1 + 48},${from.y} ${to.x - 48},${to.y} ${to.x - 2},${to.y}`}
											fill="none"
											stroke={colour}
											strokeOpacity={hot ? 1 : 0.7}
											strokeWidth={hot ? 2.5 : 1.6}
										/>
										<path
											d={`M${to.x - 9},${to.y - 5} L${to.x - 2},${to.y} L${to.x - 9},${to.y + 5}`}
											fill="none"
											stroke={colour}
											strokeWidth={2}
										/>
									</g>
								)
							})}
						</svg>

						{layout.branches.flatMap((box) =>
							box.takes.map((spot) => {
								const take = takes.get(spot.id)
								if (!take) return null
								const kids = branches.filter((branch) => branch.parentTakeId === take.id)
								const ring =
									kids.length === 1 ? branchColour(branches, kids[0].id) : kids.length > 1 ? "#e6e9ef" : null
								return (
									<TakeCard
										height={sizes.takeHeight}
										isSelected={selected === take.id}
										key={take.id}
										kids={kids.length}
										onCancel={() => cancel([take.id])}
										onChange={() => {
											setSelected(take.id)
											requestAnimationFrame(() => noteRef.current?.focus())
										}}
										onFull={() => openFull(take.id)}
										onSelect={() => setSelected(take.id)}
										onUse={() => {
											setSelected(take.id)
											requestAnimationFrame(() => nameRef.current?.focus())
										}}
										ring={ring}
										surface={board?.surface ?? "#ffffff"}
										take={take}
										width={sizes.takeWidth}
										x={spot.x}
										y={spot.y}
									/>
								)
							}),
						)}
					</div>
				</div>

				<aside
					className="flex shrink-0 flex-col overflow-y-auto border-l border-shell-border p-4"
					data-testid="board-inspector"
					style={{ width: PANEL_WIDTH }}>
					{!current ? (
						<p className="text-sm text-shell-muted">Pick a take to change it or use it.</p>
					) : (
						<>
							<button
								className="block w-full overflow-hidden rounded-lg border border-shell-border disabled:cursor-default"
								data-testid="board-inspector-preview"
								disabled={current.status !== "ready"}
								onClick={() => openFull(current.id)}
								style={{ backgroundColor: board?.surface }}
								type="button">
								{current.preview ? (
									<img alt="" className="block w-full" src={current.preview} />
								) : (
									<div className="aspect-[3/2] w-full animate-pulse bg-shell-border/30" />
								)}
							</button>
							<div className="mt-2.5 flex items-baseline gap-2 text-sm" data-testid="board-inspector-title">
								<span
									className="size-2 shrink-0 rounded-full"
									style={{
										backgroundColor: currentBranch ? branchColour(branches, currentBranch.id) : undefined,
									}}
								/>
								<b className="min-w-0 truncate">{takeLabel(current)}</b>
								{current.savedAs && <span className="text-xs text-emerald-400">saved as @{current.savedAs}</span>}
							</div>

							{current.status !== "ready" ? (
								<p className="mt-2 text-xs text-shell-muted" data-testid="board-inspector-status">
									{current.status === "waiting"
										? "Waiting its turn. It appears here the moment it's made; pick another take meanwhile."
										: current.status === "working"
											? "Being made. It appears here the moment it's ready; pick another take meanwhile."
											: current.status === "cancelled"
												? "Cancelled. Nothing was made for it."
												: current.error}
								</p>
							) : (
								<>
									<div className="mt-4 text-xs">
										<b>Change it</b> <span className="text-shell-muted">· grows 2 takes out of this one</span>
									</div>
									<div className="mt-2 flex flex-wrap gap-1.5">
										{CHANGE_CHIPS.map((chip) => (
											<button
												className={cn(
													"rounded-full border px-2.5 py-0.5 text-xs",
													chips.includes(chip)
														? "border-caret-accent bg-caret-accent/15 text-blue-300"
														: "border-shell-border hover:border-shell-muted",
												)}
												data-chip={chip}
												data-testid="board-change-chip"
												key={chip}
												onClick={() =>
													setChips((now) =>
														now.includes(chip) ? now.filter((c) => c !== chip) : [...now, chip],
													)
												}
												type="button">
												{chip}
											</button>
										))}
									</div>
									<div className="mt-2.5 inline-flex rounded-md border border-shell-border p-0.5 text-xs">
										{(["subtle", "strong"] as const).map((value) => (
											<button
												className={cn(
													"rounded px-2.5 py-0.5",
													strength === value ? "bg-shell-border text-shell-fg" : "text-shell-muted",
												)}
												data-testid={`board-strength-${value}`}
												key={value}
												onClick={() => setStrength(value)}
												type="button">
												{value === "subtle" ? "Subtle" : "Strong"}
											</button>
										))}
									</div>
									<span className="ml-2 text-[11px] text-shell-muted">
										{strength === "strong"
											? "Keeps the subject; framing and light may change."
											: "Changes only what you name."}
									</span>
									<textarea
										className="mt-2 w-full resize-none rounded-md border border-shell-border bg-shell-panel px-2.5 py-2 text-[13px] outline-none focus:border-caret-accent"
										data-testid="board-change-note"
										onChange={(event) => setNote(event.target.value)}
										onKeyDown={(event) => {
											if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void grow()
										}}
										placeholder={
											'or say what to change: "keycaps all cream", "less clutter on the desk", "harder shadow"'
										}
										ref={noteRef}
										rows={3}
										value={note}
									/>
									<button
										className="mt-2 w-full rounded-md border border-shell-border py-1.5 text-sm hover:border-shell-muted"
										data-testid="board-grow"
										onClick={grow}
										type="button">
										Grow 2 from this
									</button>

									<div className="mt-4 border-t border-shell-border pt-4">
										<div className="text-xs text-shell-muted">
											Name it. This is what you and the AI will type.
										</div>
										<div className="mt-1.5 flex items-center gap-1.5">
											<span className="text-shell-muted">@</span>
											<input
												className="min-w-0 flex-1 rounded-md border border-shell-border bg-shell-panel px-2 py-1.5 font-mono text-[12.5px] outline-none focus:border-caret-accent"
												data-testid="board-name"
												onChange={(event) => setTag(event.target.value)}
												onKeyDown={(event) => event.key === "Enter" && void save()}
												ref={nameRef}
												value={tag}
											/>
											<button
												className="rounded-md bg-caret-accent px-3 py-1.5 text-sm text-white disabled:opacity-50"
												data-testid="board-use"
												disabled={saving || !tag.trim()}
												onClick={save}
												type="button">
												{saving ? <Loader2 className="animate-spin" size={14} /> : "Use"}
											</button>
										</div>
									</div>
								</>
							)}
							{message && (
								<p
									className={cn("mt-3 text-xs", message.tone === "ok" ? "text-emerald-400" : "text-red-400")}
									data-testid={message.tone === "ok" ? "board-saved-note" : "board-error"}>
									{message.text}
								</p>
							)}
						</>
					)}
				</aside>
			</div>

			<div className="flex items-center justify-end gap-2 border-t border-shell-border px-6 py-2.5">
				<button
					className="mr-auto text-xs text-shell-muted hover:text-shell-fg"
					data-testid="board-new-prompt"
					onClick={onNewPrompt}
					type="button">
					← New prompt
				</button>
				<button
					className="rounded-md bg-caret-accent px-4 py-1.5 text-sm text-white"
					data-testid="board-done"
					onClick={() => onDone(lastSaved)}
					type="button">
					Done
				</button>
			</div>

			{full && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-8"
					data-testid="board-full"
					onClick={() => setFull(null)}>
					<button className="absolute top-4 right-4 rounded-md border border-white/20 p-2 text-white/80" type="button">
						<X size={16} />
					</button>
					{full.picture ? (
						<img
							alt=""
							className="max-h-[88vh] max-w-full rounded-lg"
							onClick={(event) => event.stopPropagation()}
							src={full.picture}
						/>
					) : (
						<Loader2 className="animate-spin text-white/70" size={24} />
					)}
					<p className="absolute bottom-4 text-xs text-white/60">Esc closes · ← → move between this branch's takes</p>
				</div>
			)}
		</div>
	)
}

function TakeCard({
	take,
	x,
	y,
	width,
	height,
	surface,
	isSelected,
	ring,
	kids,
	onSelect,
	onUse,
	onChange,
	onFull,
	onCancel,
}: {
	take: BoardTakeWire
	x: number
	y: number
	width: number
	height: number
	surface: string
	isSelected: boolean
	ring: string | null
	kids: number
	onSelect(): void
	onUse(): void
	onChange(): void
	onFull(): void
	onCancel(): void
}) {
	const running = take.status === "waiting" || take.status === "working"
	return (
		<div className="absolute" style={{ left: x, top: y, width, height, zIndex: 3 }}>
			<div
				className={cn(
					"group relative h-full w-full cursor-pointer overflow-hidden rounded-lg border border-shell-border",
					isSelected && "outline outline-2 outline-offset-2 outline-caret-accent",
				)}
				data-status={take.status}
				data-take-id={take.id}
				data-testid="board-take"
				onClick={onSelect}
				style={{
					backgroundColor: take.status === "ready" ? surface : "#14171f",
					boxShadow: ring ? `0 0 0 2px ${ring}` : undefined,
				}}>
				{take.status === "ready" && take.preview ? (
					<img alt="" className="h-full w-full object-contain" src={take.preview} />
				) : running ? (
					<div className="flex h-full w-full animate-pulse items-center justify-center bg-shell-border/30 text-[11px] text-shell-muted">
						{take.status === "waiting" ? "waiting…" : "making…"}
					</div>
				) : (
					<p
						className="h-full overflow-hidden p-2 text-[11px] leading-snug break-words text-shell-muted"
						data-testid="board-take-error">
						{take.status === "cancelled" ? "Cancelled." : take.error}
					</p>
				)}
				<span className="absolute top-1.5 left-1.5 rounded bg-black/60 px-1.5 text-[10.5px] text-white">
					{take.index + 1}
				</span>
				{take.savedAs && (
					<span className="absolute bottom-1.5 left-1.5 rounded bg-emerald-500 px-1.5 text-[10px] font-semibold text-emerald-950">
						@{take.savedAs}
					</span>
				)}
				{running && (
					<button
						className="absolute top-1 right-1 rounded bg-black/60 p-0.5 text-white/80 hover:text-white"
						data-testid="board-take-cancel"
						onClick={(event) => {
							event.stopPropagation()
							onCancel()
						}}
						title="Cancel this take"
						type="button">
						<X size={12} />
					</button>
				)}
				{take.status === "ready" && (
					<div className="absolute inset-x-0 bottom-0 flex gap-1 bg-gradient-to-t from-black/75 to-transparent p-1.5 pt-5 opacity-0 transition-opacity group-hover:opacity-100">
						<button
							className="rounded bg-caret-accent px-2 py-0.5 text-[11px] text-white"
							data-testid="board-take-use"
							onClick={(event) => {
								event.stopPropagation()
								onUse()
							}}
							type="button">
							Use
						</button>
						<button
							className="rounded border border-white/15 bg-black/60 px-2 py-0.5 text-[11px] text-white"
							data-testid="board-take-change"
							onClick={(event) => {
								event.stopPropagation()
								onChange()
							}}
							type="button">
							Change
						</button>
						<button
							className="ml-auto rounded border border-white/15 bg-black/60 p-1 text-white"
							data-testid="board-take-full"
							onClick={(event) => {
								event.stopPropagation()
								onFull()
							}}
							title="View full size"
							type="button">
							<Maximize2 size={11} />
						</button>
					</div>
				)}
			</div>
			{kids > 0 && (
				<span
					className="absolute flex size-[18px] items-center justify-center rounded-full text-[10.5px] font-bold text-shell-bg"
					data-count={kids}
					data-testid="board-kids"
					style={{
						right: -9,
						top: height / 2 - 9,
						backgroundColor: ring ?? "#e6e9ef",
						boxShadow: "0 0 0 3px var(--color-shell-bg)",
						zIndex: 4,
					}}
					title={`${kids} branch${kids > 1 ? "es" : ""} grown from this take`}>
					{kids}
				</span>
			)}
		</div>
	)
}
