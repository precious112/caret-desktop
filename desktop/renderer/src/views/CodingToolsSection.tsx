/**
 * The Backend tab's "Your coding tools": connect Claude Code, Codex, Cursor
 * or OpenCode to Caret with one click. Once connected, a tool follows this
 * project's design skill and can search the libraries switched on here.
 */
import { useCallback, useEffect, useState } from "react"

import type { CodingToolWire, LibraryWire, ProjectState, SkillWire } from "../../../shared/ipc"
import { invoke, on } from "../ipc"

export function CodingToolsSection({ project }: { project: ProjectState }) {
	const [tools, setTools] = useState<CodingToolWire[] | null>(null)
	const [skill, setSkill] = useState<SkillWire | null>(null)
	const [libraries, setLibraries] = useState<LibraryWire[]>([])
	const [busy, setBusy] = useState<string | null>(null)
	const [problems, setProblems] = useState<Record<string, { error: string; snippet?: string }>>({})

	const refresh = useCallback(async () => {
		const [list, skills, libs] = await Promise.all([
			invoke("codingTools:list"),
			invoke("skills:list", project.path),
			invoke("libraries:list", project.path),
		])
		setTools(list ?? [])
		setSkill(skills?.find((s) => s.chosen) ?? null)
		setLibraries(libs ?? [])
	}, [project.path])

	useEffect(() => {
		void refresh()
		const offSkills = on("skills:changed", () => void refresh())
		const offLibraries = on("libraries:changed", () => void refresh())
		return () => {
			offSkills()
			offLibraries()
		}
	}, [refresh])

	const librariesOn = libraries.filter((library) => library.enabled).map((library) => library.name)

	return (
		<section className="mt-8 border-t border-shell-border pt-6" data-testid="coding-tools-section">
			<h2 className="font-medium">Your coding tools</h2>
			<p className="mt-1 max-w-2xl text-[11.5px] leading-relaxed text-shell-muted">
				"Set up" connects a coding tool to Caret. It then follows this project's design skill, and can search the
				libraries switched on here through that connection. One setup works in every project you open in Caret, and it
				keeps working after Caret restarts. Your library keys stay in Caret.
			</p>
			<ul className="mt-3 flex flex-col divide-y divide-shell-border rounded-lg border border-shell-border">
				{(tools ?? []).map((tool) => (
					<li className="px-3 py-2.5" data-testid="coding-tool" data-tool={tool.id} key={tool.id}>
						<div className="flex items-center gap-2">
							<p className="min-w-0 flex-1">
								{tool.name}{" "}
								<span className={tool.found ? "text-[11px] text-emerald-300" : "text-[11px] text-shell-muted"}>
									{tool.found ? "Found on this computer" : "Not found"}
								</span>
							</p>
							{tool.setUp ? (
								<span
									className="rounded-lg border border-emerald-500/40 px-2.5 py-1 text-[11.5px] text-emerald-300"
									data-testid="coding-tool-done">
									Connected
								</span>
							) : (
								tool.found && (
									<button
										className="rounded-lg bg-caret-accent px-2.5 py-1 text-[11.5px] text-white disabled:opacity-50"
										data-testid="coding-tool-setup"
										disabled={busy !== null}
										onClick={async () => {
											setBusy(tool.id)
											try {
												const result = await invoke("codingTools:setUp", tool.id)
												setProblems((current) => {
													const next = { ...current }
													if (result && !result.ok)
														next[tool.id] = {
															error: result.error ?? "That didn't work.",
															snippet: result.snippet,
														}
													else delete next[tool.id]
													return next
												})
												await refresh()
											} finally {
												setBusy(null)
											}
										}}
										type="button">
										{busy === tool.id ? "Setting up…" : "Set up"}
									</button>
								)
							)}
						</div>
						{tool.setUp && (
							<ul
								className="mt-1.5 list-disc pl-5 text-[11.5px] leading-relaxed text-shell-muted"
								data-testid="coding-tool-details">
								<li>
									Design skill:{" "}
									{skill ? `${skill.name}, in ${tool.skillsFolder}/` : "none chosen for this project"}
								</li>
								<li>Connected to Caret (keeps working after Caret restarts)</li>
								<li>
									Libraries through that connection:{" "}
									{librariesOn.length ? librariesOn.join(", ") : "none switched on"}
								</li>
							</ul>
						)}
						{problems[tool.id] && (
							<div className="mt-1.5" data-testid="coding-tool-problem">
								<p className="text-[11.5px] text-amber-300">{problems[tool.id].error}</p>
								{problems[tool.id].snippet && (
									<pre className="mt-1 overflow-x-auto rounded-md bg-black/30 p-2 text-[11px]">
										{problems[tool.id].snippet}
									</pre>
								)}
							</div>
						)}
					</li>
				))}
				{tools === null && <li className="px-3 py-2.5 text-shell-muted">Looking for coding tools…</li>}
			</ul>
		</section>
	)
}
