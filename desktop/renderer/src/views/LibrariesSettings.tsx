/**
 * The component and reference libraries the AI can search: on/off, and the
 * key or sign-in a library needs.
 */
import { useCallback, useEffect, useState } from "react"

import type { LibraryWire, ProjectState } from "../../../shared/ipc"
import { invoke } from "../ipc"
import { cn } from "../lib/utils"

const STATE_TEXT: Record<LibraryWire["state"], string> = {
	ready: "Ready",
	connecting: "Connecting…",
	"sign-in": "Sign in",
	key: "Paste key",
	resting: "Resting after a rate limit",
	failed: "Not reachable",
	off: "Off",
}

export function LibrariesSettings({ project }: { project: ProjectState }) {
	const [libraries, setLibraries] = useState<LibraryWire[] | null>(null)

	const refresh = useCallback(async () => {
		setLibraries((await invoke("libraries:list", project.path)) ?? [])
	}, [project.path])

	useEffect(() => {
		void refresh()
	}, [refresh])

	return (
		<section className="mt-8 border-t border-shell-border pt-6" data-testid="libraries-section">
			<h2 className="font-medium">Libraries</h2>
			<p className="mt-1 text-[11.5px] leading-relaxed text-shell-muted">
				Component and reference libraries the AI can search. Caret only ever uses their search and read tools.
			</p>
			<ul className="mt-3 flex flex-col divide-y divide-shell-border rounded-lg border border-shell-border">
				{(libraries ?? []).map((library) => (
					<LibraryRow key={library.id} library={library} onChanged={refresh} projectPath={project.path} />
				))}
				{libraries === null && <li className="px-3 py-2.5 text-shell-muted">Checking libraries…</li>}
			</ul>
		</section>
	)
}

export function LibraryRow({
	library,
	projectPath,
	onChanged,
}: {
	library: LibraryWire
	projectPath: string
	onChanged(): void
}) {
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
		<li className="px-3 py-2.5" data-library={library.id} data-testid="library-row">
			<div className="flex items-center gap-2">
				<div className="min-w-0 flex-1">
					<p className={cn(!library.enabled && "text-shell-muted")}>{library.name}</p>
					<p className="text-[11px] leading-relaxed text-shell-muted">{library.gives}</p>
				</div>
				{library.enabled && library.state === "sign-in" && (
					<button
						className="rounded-lg bg-caret-accent px-2.5 py-1 text-[11.5px] text-white disabled:opacity-50"
						data-testid="library-signin"
						disabled={busy}
						onClick={() => run(() => invoke("libraries:signIn", projectPath, library.id))}
						type="button">
						{busy ? "Waiting for the browser…" : "Sign in"}
					</button>
				)}
				{library.enabled && library.state === "key" && !pasting && (
					<button
						className="rounded-lg bg-caret-accent px-2.5 py-1 text-[11.5px] text-white"
						data-testid="library-key"
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
						data-testid="library-state">
						{STATE_TEXT[library.state]}
					</span>
				)}
				<button
					aria-pressed={library.enabled}
					className={cn(
						"rounded-md border px-2 py-0.5 text-[11px] transition-colors",
						library.enabled ? "border-caret-accent/50 text-shell-text" : "border-shell-border text-shell-muted",
					)}
					data-testid="library-toggle"
					disabled={busy}
					onClick={() => run(() => invoke("libraries:set", library.id, !library.enabled))}
					title={library.enabled ? "Skip this library" : "Use this library"}
					type="button">
					{library.enabled ? "On" : "Off"}
				</button>
			</div>
			{pasting && (
				<div className="mt-2 flex items-center gap-2">
					<input
						className="min-w-0 flex-1 rounded-lg border border-shell-border bg-transparent px-3 py-1.5 font-mono text-[12px] outline-none"
						data-testid="library-key-input"
						onChange={(event) => setKey(event.target.value)}
						placeholder={`${library.name} API key`}
						type="password"
						value={key}
					/>
					<button
						className="rounded-lg bg-caret-accent px-3 py-1.5 text-[12px] text-white disabled:opacity-50"
						data-testid="library-key-save"
						disabled={busy || !key.trim()}
						onClick={() =>
							run(async () => {
								const result = await invoke("libraries:setKey", projectPath, library.id, key)
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
