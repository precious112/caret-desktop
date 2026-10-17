/**
 * The Libraries tab: hand-picked component and reference libraries to install,
 * and the ones this project uses.
 *
 * A library is a service the AI can search: ready-made components to build
 * with, or screenshots of real products for reference. Caret connects to each
 * one itself and passes its search tools on to Caret's chat and to every coding
 * tool connected to Caret; keys stay in Caret.
 */
import { useCallback, useEffect, useState } from "react"

import type { LibraryWire, ProjectState } from "../../../shared/ipc"
import { invoke, on } from "../ipc"
import { cn } from "../lib/utils"
import { BUTTON, CatalogCard, CatalogFrame, CatalogTabs, DONE_BADGE } from "./CatalogParts"

type Tab = "browse" | "installed"

const STATE_TEXT: Record<LibraryWire["state"], string> = {
	ready: "Ready",
	connecting: "Connecting…",
	"sign-in": "Sign in",
	key: "Paste key",
	resting: "Resting after a rate limit",
	failed: "Not reachable",
	off: "Off",
}

const ACCESS_TAG: Record<LibraryWire["access"], string> = {
	none: "Free, no account",
	"free-token": "Free account, set up for you",
	"sign-in": "Paid, sign in",
	key: "Paid, your key",
}

export function LibrariesView({
	project,
	onClose,
	onOpenCodingTools,
}: {
	project: ProjectState
	onClose(): void
	onOpenCodingTools(): void
}) {
	const [libraries, setLibraries] = useState<LibraryWire[] | null>(null)
	const [tab, setTab] = useState<Tab>("browse")
	const [busy, setBusy] = useState<string | null>(null)

	const refresh = useCallback(async () => {
		setLibraries((await invoke("libraries:list", project.path)) ?? [])
	}, [project.path])

	useEffect(() => {
		void refresh()
		return on("libraries:changed", (changed) => {
			if (!changed || changed === project.path) void refresh()
		})
	}, [refresh, project.path])

	const installed = (libraries ?? []).filter((library) => library.installed)
	const onCount = installed.filter((library) => library.enabled).length

	const card = (library: LibraryWire) => (
		<CatalogCard
			action={
				library.installed ? (
					<span className={DONE_BADGE}>Installed</span>
				) : (
					<button
						className={BUTTON}
						data-testid="library-install"
						disabled={busy !== null}
						onClick={async () => {
							setBusy(library.id)
							try {
								await invoke("libraries:install", library.id)
								await refresh()
							} finally {
								setBusy(null)
							}
						}}
						type="button">
						{busy === library.id ? "Installing…" : "Install"}
					</button>
				)
			}
			id={library.id}
			key={library.id}
			tags={[ACCESS_TAG[library.access]]}
			testId="library-card"
			text={library.gives}
			title={library.name}
		/>
	)

	return (
		<CatalogFrame
			onClose={onClose}
			strip={
				<>
					<span data-testid="libraries-strip">{`${onCount} switched on in this project.`}</span>
					<button className="text-caret-accent hover:underline" onClick={onOpenCodingTools} type="button">
						Your coding tools
					</button>
				</>
			}
			subtitle="Libraries the AI can search: ready-made components to build with, and screenshots of real products for reference. Caret picks a short list of good ones so you don't have to search for them."
			testId="libraries-view"
			title="Libraries">
			<CatalogTabs<Tab>
				onChange={setTab}
				options={[
					{ value: "browse", label: "Browse" },
					{ value: "installed", label: `Installed (${installed.length})` },
				]}
				value={tab}
			/>

			{libraries === null && <p className="text-shell-muted">Loading…</p>}

			{tab === "browse" && libraries && (
				<>
					<h2 className="mb-2 text-[11px] tracking-wider text-shell-muted uppercase">Components</h2>
					<div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
						{libraries.filter((library) => library.kind === "components").map(card)}
					</div>
					<h2 className="mt-6 mb-2 text-[11px] tracking-wider text-shell-muted uppercase">References</h2>
					<div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
						{libraries.filter((library) => library.kind === "inspiration").map(card)}
					</div>
				</>
			)}

			{tab === "installed" && libraries && (
				<section className="max-w-3xl">
					<h2 className="text-[11px] tracking-wider text-shell-muted uppercase">Libraries in this project</h2>
					<p className="mt-1 text-[12.5px] leading-relaxed text-shell-muted">
						The AI can search the libraries switched on here, in Caret's chat and in your coding tools. Caret only
						ever uses their search and read tools. Your keys stay in Caret; they are never written into project files.
					</p>
					<ul
						className={cn(
							"mt-3 flex flex-col divide-y divide-shell-border rounded-lg border border-shell-border",
							installed.length === 0 && "hidden",
						)}
						data-testid="libraries-section">
						{installed.map((library) => (
							<LibraryRow key={library.id} library={library} onChanged={refresh} projectPath={project.path} />
						))}
					</ul>
					{installed.length === 0 && (
						<p className="mt-3 text-[12.5px] text-shell-muted">
							Nothing installed yet. Install a library from Browse.
						</p>
					)}
				</section>
			)}
		</CatalogFrame>
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
					className="rounded-md border border-shell-border px-2 py-0.5 text-[11px] text-shell-muted hover:text-shell-text disabled:opacity-50"
					data-testid="library-remove"
					disabled={busy}
					onClick={() => run(async () => invoke("libraries:remove", library.id))}
					type="button">
					Remove
				</button>
				<button
					aria-pressed={library.enabled}
					className={cn(
						"rounded-md border px-2 py-0.5 text-[11px] transition-colors",
						library.enabled ? "border-caret-accent/50 text-shell-text" : "border-shell-border text-shell-muted",
					)}
					data-testid="library-toggle"
					disabled={busy}
					onClick={() => run(() => invoke("libraries:set", projectPath, library.id, !library.enabled))}
					title={library.enabled ? "Switch off in this project" : "Switch on in this project"}
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
