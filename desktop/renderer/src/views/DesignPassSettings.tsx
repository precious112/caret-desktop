/**
 * The backend tab's Design pass section: the helper model, and the libraries
 * the designer explores. Set once, not per message — the composer keeps only
 * the main model and effort, so there is never a second model picker to
 * confuse with the first.
 */
import { useCallback, useEffect, useRef, useState } from "react"

import type { DesignLibraryWire, ModelGroupWire, ProjectState } from "../../../shared/ipc"
import { invoke } from "../ipc"
import { cn } from "../lib/utils"

const STATE_TEXT: Record<DesignLibraryWire["state"], string> = {
	ready: "Ready",
	connecting: "Connecting…",
	"sign-in": "Sign in",
	key: "Paste key",
	resting: "Resting after a rate limit",
	failed: "Not reachable",
	off: "Off",
}

export function DesignPassSettings({
	project,
	groups,
	focus,
}: {
	project: ProjectState
	groups: ModelGroupWire[] | null
	focus: boolean
}) {
	const [on, setOn] = useState<boolean | null>(null)
	const [helper, setHelper] = useState("")
	const [automatic, setAutomatic] = useState<string | null>(null)
	const [libraries, setLibraries] = useState<DesignLibraryWire[] | null>(null)
	const section = useRef<HTMLElement>(null)

	const refresh = useCallback(async () => {
		const [state, prefs, list, auto] = await Promise.all([
			invoke("agent:state", project.path),
			invoke("prefs:get"),
			invoke("designPass:libraries", project.path),
			invoke("designPass:automaticHelper"),
		])
		setOn(state?.designPass ?? null)
		setHelper(typeof prefs?.designPassHelperModel === "string" ? prefs.designPassHelperModel : "")
		setLibraries(list ?? [])
		setAutomatic(auto ?? null)
	}, [project.path])

	useEffect(() => {
		void refresh()
	}, [refresh])

	useEffect(() => {
		if (focus) section.current?.scrollIntoView({ block: "start" })
	}, [focus])

	return (
		<section className="mt-8 border-t border-shell-border pt-6" data-testid="design-pass-section" ref={section}>
			<div className="flex items-center gap-3">
				<h2 className="font-medium">Design pass</h2>
				{on !== null && (
					<button
						aria-pressed={on}
						className={cn(
							"rounded-lg border px-2 py-0.5 text-[11px] transition-colors",
							on
								? "border-caret-accent/50 bg-caret-accent/15 text-shell-text"
								: "border-shell-border text-shell-muted",
						)}
						data-testid="design-pass-settings-switch"
						onClick={async () => {
							await invoke("designPass:set", project.path, !on, "settings")
							setOn(!on)
						}}
						type="button">
						{on ? "On for this project" : "Off for this project"}
					</button>
				)}
			</div>
			<p className="mt-1 text-[11.5px] leading-relaxed text-shell-muted">
				Before a page is built, the AI plans it section by section, removes the habits people keep reporting in AI-made
				designs, and a seasoned designer polishes every section. It takes a few extra minutes.
			</p>

			<label className="mt-4 block" htmlFor="design-pass-helper">
				<span className="text-shell-muted">Helper model (checks and judges)</span>
				<select
					className="mt-1 w-full rounded-lg border border-shell-border bg-shell-panel px-2.5 py-1.5 outline-none focus:border-caret-accent/60"
					data-testid="design-pass-helper"
					id="design-pass-helper"
					onChange={(event) => {
						setHelper(event.target.value)
						void invoke("prefs:set", { designPassHelperModel: event.target.value })
					}}
					value={helper}>
					<option value="">Automatic (fastest connected){automatic ? ` · ${automatic}` : ""}</option>
					{(groups ?? []).map((group) => (
						<optgroup key={group.providerId} label={group.providerName}>
							{group.models.map((option) => (
								<option key={option.id} value={option.id}>
									{option.label}
								</option>
							))}
						</optgroup>
					))}
				</select>
				<span className="mt-1 block text-[11.5px] leading-relaxed text-shell-muted">
					Checking is matching a plan against a list, not designing, so a fast model does it well. Your main model still
					plans, refines and builds. With only one model connected, it does both jobs.
				</span>
			</label>

			<p className="mt-5 text-shell-muted">Libraries the designer can explore</p>
			<ul className="mt-2 flex flex-col divide-y divide-shell-border rounded-lg border border-shell-border">
				{(libraries ?? []).map((library) => (
					<LibraryRow key={library.id} library={library} onChanged={refresh} projectPath={project.path} />
				))}
				{libraries === null && <li className="px-3 py-2.5 text-shell-muted">Checking libraries…</li>}
			</ul>
			<p className="mt-2 text-[11.5px] leading-relaxed text-shell-muted">
				Caret only ever uses their search and read tools. When one is rate-limited or down, the designer moves on to the
				next. Choosing no component is a perfectly good outcome.
			</p>
		</section>
	)
}

function LibraryRow({ library, projectPath, onChanged }: { library: DesignLibraryWire; projectPath: string; onChanged(): void }) {
	const [key, setKey] = useState("")
	const [pasting, setPasting] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const run = async (work: () => Promise<{ ok: boolean; error?: string } | undefined | void>) => {
		setBusy(true)
		setError(null)
		try {
			const result = await work()
			if (result && !result.ok) setError(result.error ?? "That didn't work.")
			onChanged()
		} finally {
			setBusy(false)
		}
	}

	return (
		<li className="px-3 py-2.5" data-library={library.id} data-testid="design-pass-library">
			<div className="flex items-center gap-2">
				<div className="min-w-0 flex-1">
					<p className={cn(!library.enabled && "text-shell-muted")}>{library.name}</p>
					<p className="text-[11px] leading-relaxed text-shell-muted">{library.gives}</p>
				</div>
				{library.enabled && library.state === "sign-in" && (
					<button
						className="rounded-lg bg-caret-accent px-2.5 py-1 text-[11.5px] text-white disabled:opacity-50"
						data-testid="design-pass-library-signin"
						disabled={busy}
						onClick={() => run(() => invoke("designPass:signIn", projectPath, library.id))}
						type="button">
						{busy ? "Waiting for the browser…" : "Sign in"}
					</button>
				)}
				{library.enabled && library.state === "key" && !pasting && (
					<button
						className="rounded-lg bg-caret-accent px-2.5 py-1 text-[11.5px] text-white"
						data-testid="design-pass-library-key"
						onClick={() => setPasting(true)}
						type="button">
						Paste key
					</button>
				)}
				{library.state !== "sign-in" && library.state !== "key" && (
					<span
						className={cn(
							"text-[11px]",
							library.state === "ready"
								? "text-emerald-300"
								: library.state === "failed"
									? "text-amber-300"
									: "text-shell-muted",
						)}
						data-testid="design-pass-library-state">
						{STATE_TEXT[library.state]}
					</span>
				)}
				<button
					aria-pressed={library.enabled}
					className={cn(
						"rounded-md border px-2 py-0.5 text-[11px] transition-colors",
						library.enabled ? "border-caret-accent/50 text-shell-text" : "border-shell-border text-shell-muted",
					)}
					data-testid="design-pass-library-toggle"
					disabled={busy}
					onClick={() => run(() => invoke("designPass:setLibrary", library.id, !library.enabled))}
					title={library.enabled ? "Skip this library" : "Use this library"}
					type="button">
					{library.enabled ? "On" : "Off"}
				</button>
			</div>
			{pasting && (
				<div className="mt-2 flex items-center gap-2">
					<input
						className="min-w-0 flex-1 rounded-lg border border-shell-border bg-transparent px-3 py-1.5 font-mono text-[12px] outline-none"
						data-testid="design-pass-library-key-input"
						onChange={(event) => setKey(event.target.value)}
						placeholder={`${library.name} API key`}
						type="password"
						value={key}
					/>
					<button
						className="rounded-lg bg-caret-accent px-3 py-1.5 text-[12px] text-white disabled:opacity-50"
						data-testid="design-pass-library-key-save"
						disabled={busy || !key.trim()}
						onClick={() =>
							run(async () => {
								const result = await invoke("designPass:setKey", projectPath, library.id, key)
								if (result?.ok) {
									setKey("")
									setPasting(false)
								}
								return result
							})
						}
						type="button">
						Save
					</button>
				</div>
			)}
			{library.state === "key" && library.site && (
				<p className="mt-1 text-[11px] text-shell-muted">
					Get a key at {library.site.replace(/^https:\/\//, "")}. Free searches; downloads count toward its daily limit.
				</p>
			)}
			{error && <p className="mt-1.5 text-[11px] text-red-400">{error}</p>}
		</li>
	)
}
