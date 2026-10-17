/**
 * The Skills tab: hand-picked design skills to install, and the one this
 * project uses.
 *
 * A design skill is written guidance on how to design. One per project:
 * Caret's chat follows it, and Caret copies it into the project's folders so
 * coding tools follow the same one.
 */
import { useCallback, useEffect, useState } from "react"

import type { ProjectState, SkillWire } from "../../../shared/ipc"
import { invoke, on } from "../ipc"
import { cn } from "../lib/utils"
import { BUTTON, CatalogCard, CatalogFrame, CatalogTabs, DONE_BADGE, QUIET_BUTTON } from "./CatalogParts"

type Tab = "browse" | "installed"

export function SkillsView({
	project,
	onClose,
	onOpenCodingTools,
}: {
	project: ProjectState
	onClose(): void
	onOpenCodingTools(): void
}) {
	const [skills, setSkills] = useState<SkillWire[] | null>(null)
	const [tab, setTab] = useState<Tab>("browse")
	const [busy, setBusy] = useState<string | null>(null)
	const [errors, setErrors] = useState<Record<string, string>>({})

	const refresh = useCallback(async () => {
		setSkills((await invoke("skills:list", project.path)) ?? [])
	}, [project.path])

	useEffect(() => {
		void refresh()
		return on("skills:changed", (changed) => {
			if (!changed || changed === project.path) void refresh()
		})
	}, [refresh, project.path])

	const act = async (id: string, work: () => Promise<unknown>) => {
		setBusy(id)
		setErrors((current) => ({ ...current, [id]: "" }))
		try {
			const result = (await work()) as { ok: boolean; error?: string } | undefined
			if (result && !result.ok) setErrors((current) => ({ ...current, [id]: result.error ?? "That didn't work." }))
			await refresh()
		} finally {
			setBusy(null)
		}
	}

	const installed = (skills ?? []).filter((skill) => skill.installed)
	const chosen = (skills ?? []).find((skill) => skill.chosen)

	return (
		<CatalogFrame
			onClose={onClose}
			strip={
				<>
					<span data-testid="skills-strip">
						{chosen ? `This project uses ${chosen.name}.` : "This project uses no design skill."}
					</span>
					<button className="text-caret-accent hover:underline" onClick={onOpenCodingTools} type="button">
						Your coding tools
					</button>
				</>
			}
			subtitle="Design skills are written guidance that tells the AI how to design. Caret picks a short list of good ones so you don't have to search for them."
			testId="skills-view"
			title="Skills">
			<CatalogTabs<Tab>
				onChange={setTab}
				options={[
					{ value: "browse", label: "Browse" },
					{ value: "installed", label: `Installed (${installed.length})` },
				]}
				value={tab}
			/>

			{skills === null && <p className="text-shell-muted">Loading…</p>}

			{tab === "browse" && skills && (
				<div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
					{skills.map((skill) => (
						<CatalogCard
							action={
								skill.installed ? (
									<span className={DONE_BADGE}>Installed</span>
								) : (
									<button
										className={BUTTON}
										data-testid="skill-install"
										disabled={busy !== null}
										onClick={() => act(skill.id, () => invoke("skills:install", skill.id))}
										type="button">
										{busy === skill.id ? "Installing…" : "Install"}
									</button>
								)
							}
							by={skill.by}
							error={errors[skill.id]}
							id={skill.id}
							key={skill.id}
							tags={["Free", skill.licence]}
							testId="skill-card"
							text={skill.does}
							title={skill.name}
						/>
					))}
				</div>
			)}

			{tab === "installed" && skills && (
				<section>
					<h2 className="text-[11px] tracking-wider text-shell-muted uppercase">Design skill for this project</h2>
					<p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-shell-muted">
						One at a time. Caret's chat follows it, and Caret puts the same one in this project's folders so your
						coding tools follow it too. Skills often disagree with each other, so only one is used. Your foundation
						(fonts, colours, spacing) always wins over what a skill suggests.
					</p>
					<ul className="mt-3 flex max-w-2xl flex-col gap-2" data-testid="skills-installed">
						{[null, ...installed].map((skill) => {
							const id = skill?.id ?? ""
							const isChosen = skill ? skill.chosen : !chosen
							return (
								<li
									className={cn(
										"flex items-center gap-3 rounded-lg border px-3.5 py-3",
										isChosen ? "border-caret-accent bg-caret-accent/10" : "border-shell-border",
									)}
									data-chosen={isChosen}
									data-id={id || "none"}
									data-testid="skill-row"
									key={id || "none"}>
									<button
										aria-pressed={isChosen}
										className="flex min-w-0 flex-1 items-center gap-3 text-left"
										data-testid="skill-choose"
										disabled={busy !== null}
										onClick={() =>
											act(id || "none", () => invoke("skills:choose", project.path, skill?.id ?? null))
										}
										type="button">
										<span
											className={cn(
												"size-4 shrink-0 rounded-full border-[1.5px]",
												isChosen
													? "border-caret-accent bg-caret-accent shadow-[inset_0_0_0_3px_var(--color-shell-bg)]"
													: "border-shell-muted",
											)}
										/>
										<span className="min-w-0">
											<span className="block">{skill?.name ?? "No design skill"}</span>
											<span className="block text-[11.5px] text-shell-muted">
												{skill?.by ?? "Caret's own rules only"}
											</span>
										</span>
									</button>
									{skill && (
										<button
											className={QUIET_BUTTON}
											data-testid="skill-remove"
											disabled={busy !== null}
											onClick={() =>
												act(skill.id, async () => invoke("skills:remove", project.path, skill.id))
											}
											type="button">
											Remove
										</button>
									)}
									{errors[id || "none"] && (
										<span className="text-[11.5px] text-red-400">{errors[id || "none"]}</span>
									)}
								</li>
							)
						})}
					</ul>
					{installed.length === 0 && (
						<p className="mt-3 text-[12.5px] text-shell-muted">Nothing installed yet. Install a skill from Browse.</p>
					)}
				</section>
			)}
		</CatalogFrame>
	)
}
