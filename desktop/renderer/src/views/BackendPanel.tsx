/**
 * Choosing what does the work.
 *
 * Two ways an agent relates to Caret, and they are not alternatives — they are
 * opposite directions:
 *
 * - **Caret's backend** runs the things you click in Caret. This screen's top
 *   half. One is bundled, so a fresh install can already do work.
 * - **Your own agent over MCP** is you, in a terminal, telling your agent to
 *   work on the design layer. That is the bottom half, and it cannot power the
 *   buttons in this window — MCP has no way to start work from Caret's side.
 *
 * The setup names **routes**, never prices or quotas: both drift, and a screen
 * that quotes a number becomes wrong without anyone touching it.
 */

import { Check, ChevronRight, Copy, RefreshCw } from "lucide-react"
import { useCallback, useEffect, useState } from "react"

import type {
	AgentClientConfig,
	BackendReportWire,
	ModelGroupWire,
	OauthChallengeWire,
	ProjectState,
	ProviderDoorWire,
	SecretStatusWire,
} from "../../../shared/ipc"
import { invoke } from "../ipc"
import { cn } from "../lib/utils"

/** One line per backend about how it is paid for. Routes, not prices. */
const BILLING_NOTE: Record<string, string> = {
	opencode:
		"Connect a subscription you already pay for — ChatGPT, Kimi For Coding, a GLM coding plan, Copilot — or bring an API key. OpenCode's own Go and Zen plans work too.",
}

export function BackendPanel({ project, onClose }: { project: ProjectState; onClose(): void }) {
	const [backends, setBackends] = useState<BackendReportWire[] | null>(null)
	const [selected, setSelected] = useState<string | null>(null)
	const [model, setModel] = useState("")
	const [effort, setEffort] = useState("")
	const [groups, setGroups] = useState<ModelGroupWire[] | null>(null)
	const [busy, setBusy] = useState(false)

	const refresh = useCallback(async () => {
		setBusy(true)
		const [reports, state, prefs, models] = await Promise.all([
			invoke("agent:backends"),
			invoke("agent:state", project.path),
			invoke("prefs:get"),
			invoke("agent:models"),
		])
		setBackends(reports)
		setSelected(state?.backendId ?? null)
		setModel(String(prefs.backendModel ?? ""))
		setEffort(String(prefs.backendEffort ?? ""))
		setGroups(models)
		setBusy(false)
	}, [project.path])

	useEffect(() => {
		void refresh()
	}, [refresh])

	const choose = async (id: BackendReportWire["id"]) => {
		setSelected(id)
		await invoke("agent:selectBackend", id)
		await refresh()
	}

	return (
		<div className="flex-1 overflow-auto bg-shell-bg p-8" data-testid="backend-panel">
			<div className="mx-auto max-w-2xl">
				<header className="mb-6 flex items-start gap-3">
					<div className="flex-1">
						<h1 className="text-lg font-medium">Backend</h1>
						<p className="mt-1 text-shell-muted">
							What runs the work you start in Caret — syncs, edits you describe in words, and the chat.
						</p>
					</div>
					<button
						className="flex items-center gap-1.5 rounded-lg bg-white/5 px-2.5 py-1.5 transition-colors hover:bg-white/10"
						disabled={busy}
						onClick={() => void refresh()}
						type="button">
						<RefreshCw className={cn(busy && "animate-spin")} size={13} />
						Check again
					</button>
				</header>

				<div className="flex flex-col gap-2">
					{(backends ?? []).map((backend) => (
						<BackendRow
							backend={backend}
							key={backend.id}
							onChoose={() => void choose(backend.id)}
							selected={selected === backend.id}
						/>
					))}
					{backends === null && <p className="text-shell-muted">Looking for backends…</p>}
				</div>

				<label className="mt-4 block" htmlFor="backend-model">
					<span className="text-shell-muted">Model</span>
					{groups && groups.length > 0 ? (
						// Categories are providers, items are their models. One backend
						// commonly reaches several providers — the bundled OpenCode sees
						// both Go and Zen — and flattening them would hide which of them
						// costs money.
						<select
							className="mt-1 w-full rounded-lg border border-shell-border bg-shell-panel px-2.5 py-1.5 outline-none focus:border-caret-accent/60"
							data-testid="backend-model"
							id="backend-model"
							onChange={(event) => {
								setModel(event.target.value)
								void invoke("prefs:set", { backendModel: event.target.value })
							}}
							value={model}>
							<option value="">Automatic — the provider's own default</option>
							{groups.map((group) => (
								<optgroup key={group.providerId} label={group.providerName}>
									{group.models.map((option) => (
										<option key={option.id} value={option.id}>
											{option.label}
											{option.free ? " · no cost" : ""}
										</option>
									))}
								</optgroup>
							))}
						</select>
					) : (
						<input
							className="mt-1 w-full rounded-lg border border-shell-border bg-shell-panel px-2.5 py-1.5 outline-none placeholder:text-shell-muted focus:border-caret-accent/60"
							data-testid="backend-model"
							id="backend-model"
							onBlur={() => void invoke("prefs:set", { backendModel: model.trim() })}
							onChange={(event) => setModel(event.target.value)}
							placeholder="Leave empty for the backend's own default"
							value={model}
						/>
					)}
					<span className="mt-1 block text-[11.5px] leading-relaxed text-shell-muted">
						{groups && groups.length > 0
							? "Grouped by provider. Automatic follows whatever that provider considers current."
							: "This backend can't list its models, so type an id in its own naming."}
					</span>
				</label>

				<label className="mt-3 block" htmlFor="backend-effort">
					<span className="text-shell-muted">Reasoning effort</span>
					<select
						className="mt-1 w-full rounded-lg border border-shell-border bg-shell-panel px-2.5 py-1.5 outline-none focus:border-caret-accent/60"
						data-testid="backend-effort"
						id="backend-effort"
						onChange={(event) => {
							setEffort(event.target.value)
							void invoke("prefs:set", { backendEffort: event.target.value })
						}}
						value={effort}>
						<option value="">The backend's default</option>
						<option value="minimal">Minimal</option>
						<option value="low">Low</option>
						<option value="medium">Medium</option>
						<option value="high">High</option>
						<option value="xhigh">Extra high</option>
					</select>
					<span className="mt-1 block text-[11.5px] leading-relaxed text-shell-muted">
						Models that have no such setting ignore it.
					</span>
				</label>

				<p className="mt-4 text-[11.5px] leading-relaxed text-shell-muted">
					Caret runs its bundled backend from inside the app, never from your PATH, so upgrading your own copy of a tool
					can't change what Caret executes. Everything it writes to your app's own source asks first, unless you say
					otherwise for a project.
				</p>

				<ProvidersSection onChanged={refresh} />

				<KeySection
					blurb={
						<>
							Only photographs need this. Washes, textures, patterns, shapes and dividers are generated on your
							machine and need no account. The key is yours, billed to you directly, and is stored in your OS
							keychain — never in <code>.caret/</code>, which travels with the project.
						</>
					}
					name="geminiApiKey"
					placeholder="Google Gemini API key"
					testId="gemini-key"
					title="Generated photographs"
				/>

				<KeySection
					blurb={
						<>
							Only 3D objects need this. Tripo builds the model from an image in your library; a model of your
							choosing then decides how far to optimize it so it doesn't weigh the page down. Same storage rules as
							the key above.
						</>
					}
					name="tripoApiKey"
					placeholder="Tripo API key"
					testId="tripo-key"
					title="Generated 3D objects"
				/>

				<McpSection project={project} />

				<PrivacySection />

				<button
					className="mt-8 rounded-lg px-3 py-1.5 text-shell-muted transition-colors hover:bg-white/5"
					onClick={onClose}
					type="button">
					Back to canvas
				</button>
			</div>
		</div>
	)
}

/**
 * Where an account gets connected.
 *
 * This is the reason the Backend tab still exists now that models are chosen in
 * the composer: signing in and pasting keys need room, and they happen once.
 *
 * **Caret does not implement anyone's sign-in.** Each flow below is the bundled
 * backend's own, started through its API and finished in the user's browser —
 * the credential is issued to the tool the vendor sanctioned, and Caret never
 * sees it. Which providers appear, and how each one is entered, both come from
 * the server, so a flow that changes upstream changes here without a release.
 */
/**
 * The permanent home of the telemetry switch — the first-run notice points
 * here. Main reacts to the pref flip inside its `prefs:set` handler, so this
 * writes the preference and nothing else.
 */
function PrivacySection() {
	const [enabled, setEnabled] = useState<boolean | null>(null)

	useEffect(() => {
		void invoke("prefs:get").then((prefs) => setEnabled(prefs.telemetryEnabled !== false))
	}, [])

	return (
		<section className="mt-8 border-t border-shell-border pt-6" data-testid="privacy-section">
			<h2 className="font-medium">Privacy</h2>
			<label className="mt-2 flex items-start gap-2">
				<input
					checked={enabled === true}
					className="mt-1"
					disabled={enabled === null}
					onChange={(event) => {
						setEnabled(event.target.checked)
						void invoke("prefs:set", { telemetryEnabled: event.target.checked })
					}}
					type="checkbox"
				/>
				<span className="leading-relaxed">
					Send anonymous usage and crash data
					<span className="mt-0.5 block text-[11.5px] leading-relaxed text-shell-muted">
						No account, no file contents, no paths — feature names, error shapes and nothing else.{" "}
						<a
							className="underline hover:text-white"
							href="https://github.com/precious112/caret/blob/main/docs/telemetry.md">
							Exactly what's collected.
						</a>
					</span>
				</span>
			</label>
		</section>
	)
}

function ProvidersSection({ onChanged }: { onChanged(): void }) {
	const [connected, setConnected] = useState<ModelGroupWire[] | null>(null)
	const [doors, setDoors] = useState<ProviderDoorWire[] | null>(null)

	const refresh = useCallback(async () => {
		const [models, offered] = await Promise.all([invoke("agent:models"), invoke("agent:providerDoors")])
		setConnected(models ?? [])
		setDoors(offered ?? [])
		onChanged()
	}, [onChanged])

	useEffect(() => {
		void refresh()
	}, [refresh])

	return (
		<section className="mt-8 border-t border-shell-border pt-6" data-testid="providers-section">
			<h2 className="font-medium">Accounts</h2>
			<p className="mt-1 text-[11.5px] leading-relaxed text-shell-muted">
				Connect a subscription you already pay for, or an API key. Caret doesn't take a cut of either, and doesn't see the
				credential — it goes to the bundled backend, which is what makes the request.
			</p>

			<div className="mt-3 flex flex-col gap-1.5">
				{(connected ?? []).map((group) => (
					<div
						className="flex items-center gap-2 rounded-lg border border-shell-border bg-shell-panel px-3 py-2"
						data-testid={`provider-${group.providerId}`}
						key={group.providerId}>
						<Check className="shrink-0 text-emerald-300" size={13} />
						<span className="min-w-0 flex-1">
							<span className="block truncate text-[12.5px]">{group.providerName}</span>
							<span className="block text-[11px] text-shell-muted">
								{group.models.length} model{group.models.length === 1 ? "" : "s"}
								{group.subscription ? " · your plan" : ""}
							</span>
						</span>
						<button
							className="rounded-lg px-2.5 py-1 text-[11.5px] text-shell-muted transition-colors hover:bg-white/5"
							data-testid={`provider-disconnect-${group.providerId}`}
							onClick={async () => {
								await invoke("agent:disconnectProvider", group.providerId)
								await refresh()
							}}
							type="button">
							Disconnect
						</button>
					</div>
				))}

				{(doors ?? []).map((door) => (
					<ProviderDoorRow door={door} key={door.id} onConnected={refresh} />
				))}

				{connected === null && <p className="text-[11.5px] text-shell-muted">Looking for connected accounts…</p>}
			</div>
		</section>
	)
}

/**
 * One provider you could connect, and every way in that it offers.
 *
 * The methods are buttons rather than a dropdown because there are rarely more
 * than three and each is a different act — a browser sign-in, a device code, a
 * pasted key — which a dropdown would flatten into one indistinguishable
 * choice.
 */
function ProviderDoorRow({ door, onConnected }: { door: ProviderDoorWire; onConnected(): Promise<void> }) {
	const [open, setOpen] = useState<string | null>(null)
	const [key, setKey] = useState("")
	const [code, setCode] = useState("")
	const [challenge, setChallenge] = useState<OauthChallengeWire | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

	const method = door.methods.find((candidate) => candidate.id === open)

	const start = async (methodId: string, kind: "oauth" | "api-key") => {
		setOpen(methodId)
		setError(null)
		setChallenge(null)
		if (kind === "api-key") return

		setBusy(true)
		try {
			const result = await invoke("agent:connectProvider", door.id, methodId)
			if (!result?.ok) {
				setError(result?.error ?? "That sign-in could not be started.")
				return
			}
			setChallenge(result.challenge)
			// A browser flow finishes on the backend's own listener, so there is
			// nothing to type — Caret just has to notice when it lands.
			if (!result.challenge?.needsCode) void pollUntilConnected()
		} finally {
			setBusy(false)
		}
	}

	// Polled rather than pushed: the sign-in completes in a browser, in a process
	// Caret is not part of. The status endpoint is the honest signal — the first
	// version watched the model list instead, which sits behind the catalogue
	// cache AND behind the server's own stale provider registry, so a sign-in
	// that succeeded perfectly read as "didn't complete" for two minutes and
	// then gave up. Five minutes matches the server's own flow window; a failure
	// is shown the moment it is known rather than waited out.
	const pollUntilConnected = async () => {
		const deadline = Date.now() + 300_000
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 2000))
			const status = await invoke("agent:oauthStatus", door.id)
			if (status?.connected) {
				setOpen(null)
				setChallenge(null)
				await onConnected()
				return
			}
			if (status?.failure) {
				setChallenge(null)
				setError(status.failure)
				return
			}
		}
		setError("That sign-in didn't complete. Try again, or use a key instead.")
	}

	const saveKey = async () => {
		setBusy(true)
		setError(null)
		try {
			const result = await invoke("agent:connectProvider", door.id, open ?? "key", key.trim())
			if (!result?.ok) {
				setError(result?.error ?? "That key was not accepted.")
				return
			}
			setKey("")
			setOpen(null)
			await onConnected()
		} finally {
			setBusy(false)
		}
	}

	const submitCode = async () => {
		setBusy(true)
		setError(null)
		try {
			const result = await invoke("agent:completeOauth", door.id, open ?? "0", code.trim())
			if (!result?.ok) {
				setError(result?.error ?? "That code was not accepted.")
				return
			}
			setCode("")
			setOpen(null)
			setChallenge(null)
			await onConnected()
		} finally {
			setBusy(false)
		}
	}

	return (
		<div className="rounded-lg border border-shell-border bg-shell-panel px-3 py-2" data-testid={`provider-door-${door.id}`}>
			<div className="flex items-center gap-2">
				<span className="min-w-0 flex-1">
					<span className="block truncate text-[12.5px]">{door.name}</span>
					<span className="block truncate text-[11px] text-shell-muted">
						{door.subscription ? "Subscription" : "API key"}
						{door.sample.length > 0 && ` · ${door.sample.slice(0, 3).join(", ")}`}
					</span>
				</span>
				{door.methods.map((candidate) => (
					<button
						className="shrink-0 rounded-lg bg-white/5 px-2.5 py-1 text-[11.5px] transition-colors hover:bg-white/10 disabled:opacity-40"
						data-testid={`provider-connect-${door.id}-${candidate.id}`}
						disabled={busy}
						key={candidate.id}
						onClick={() => void start(candidate.id, candidate.kind)}
						title={candidate.label}
						type="button">
						{shortMethod(candidate.label, candidate.kind)}
					</button>
				))}
			</div>

			{method?.kind === "api-key" && (
				<div className="mt-2 flex items-center gap-2">
					<input
						className="min-w-0 flex-1 rounded-lg border border-shell-border bg-transparent px-3 py-1.5 font-mono text-[12.5px] outline-none"
						data-testid={`provider-key-${door.id}`}
						onChange={(event) => setKey(event.target.value)}
						onKeyDown={(event) => event.key === "Enter" && saveKey()}
						placeholder={`${door.name} API key`}
						type="password"
						value={key}
					/>
					<button
						className="rounded-lg bg-caret-accent px-3 py-1.5 text-[12.5px] text-white disabled:opacity-50"
						data-testid={`provider-key-save-${door.id}`}
						disabled={busy || !key.trim()}
						onClick={saveKey}
						type="button">
						Save
					</button>
				</div>
			)}

			{challenge && (
				<div className="mt-2">
					<p className="text-[11.5px] leading-relaxed text-shell-muted">
						{challenge.instructions ?? "Finish signing in in your browser. Caret will notice when you're done."}
					</p>
					{challenge.needsCode && (
						<div className="mt-2 flex items-center gap-2">
							<input
								className="min-w-0 flex-1 rounded-lg border border-shell-border bg-transparent px-3 py-1.5 font-mono text-[12.5px] outline-none"
								data-testid={`provider-code-${door.id}`}
								onChange={(event) => setCode(event.target.value)}
								onKeyDown={(event) => event.key === "Enter" && submitCode()}
								placeholder="Paste the code from the page"
								value={code}
							/>
							<button
								className="rounded-lg bg-caret-accent px-3 py-1.5 text-[12.5px] text-white disabled:opacity-50"
								disabled={busy || !code.trim()}
								onClick={submitCode}
								type="button">
								Done
							</button>
						</div>
					)}
				</div>
			)}

			{error && <p className="mt-2 text-[11.5px] leading-relaxed text-amber-300">{error}</p>}
		</div>
	)
}

/**
 * The provider's own method label, shortened to fit a button.
 *
 * **The parenthetical is the load-bearing part.** Dropping it, which is the
 * obvious way to shorten "ChatGPT Pro/Plus (browser)", rendered OpenAI's two
 * sign-ins as two buttons both reading "ChatGPT Pro/Plus" — a choice with no
 * visible difference. So when a label qualifies itself, the qualifier is the
 * button and the whole label is the tooltip.
 */
function shortMethod(label: string, kind: "oauth" | "api-key"): string {
	if (kind === "api-key") return "Key"
	const qualifier = /\(([^)]+)\)\s*$/.exec(label)?.[1]
	if (qualifier) {
		const word = qualifier.split(/[\s/]+/)[0]
		return word.charAt(0).toUpperCase() + word.slice(1)
	}
	return label.length > 16 ? "Sign in" : label
}

/**
 * The one credential the user ever types for generated assets.
 *
 * Deliberately small and deliberately caveated. Three of the four asset lanes
 * need no account at all, so a key field presented as *the* way to generate
 * anything would misdescribe the feature — most projects never need this. It is
 * also the monetization boundary in §11: the editor is free forever, this key is
 * the user's own, and Caret takes no cut of it.
 *
 * The value is never read back. The field shows whether a key is stored, not
 * what it is, because a key the renderer can read is a key a compromised
 * renderer can send somewhere.
 */
function KeySection({
	name,
	title,
	blurb,
	placeholder,
	testId,
}: {
	name: string
	title: string
	blurb: React.ReactNode
	placeholder: string
	testId: string
}) {
	const [status, setStatus] = useState<SecretStatusWire | null>(null)
	const [value, setValue] = useState("")
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

	const refresh = useCallback(async () => {
		setStatus((await invoke("secrets:status", name)) ?? null)
	}, [name])

	useEffect(() => {
		void refresh()
	}, [refresh])

	const save = async () => {
		setBusy(true)
		setError(null)
		try {
			const result = await invoke("secrets:set", name, value)
			if (result?.ok) {
				setValue("")
				await refresh()
			} else {
				setError(result?.error ?? "Could not store that key.")
			}
		} finally {
			setBusy(false)
		}
	}

	return (
		<section className="mt-8 border-t border-shell-border pt-6" data-testid={`${testId}-section`}>
			<h2 className="font-medium">{title}</h2>
			<p className="mt-1 text-[11.5px] leading-relaxed text-shell-muted">{blurb}</p>

			{status && !status.available ? (
				<p className="mt-3 rounded-lg border border-amber-500/40 p-3 text-[11.5px] leading-relaxed text-shell-muted">
					{status.reason}
				</p>
			) : (
				<div className="mt-3 flex items-center gap-2">
					<input
						className="min-w-0 flex-1 rounded-lg border border-shell-border bg-transparent px-3 py-1.5 font-mono text-[12.5px] outline-none"
						data-testid={testId}
						onChange={(event) => setValue(event.target.value)}
						onKeyDown={(event) => event.key === "Enter" && save()}
						placeholder={status?.present ? "A key is stored. Type a new one to replace it." : placeholder}
						type="password"
						value={value}
					/>
					<button
						className="rounded-lg bg-caret-accent px-3 py-1.5 text-[12.5px] text-white disabled:opacity-50"
						data-testid={`${testId}-save`}
						disabled={busy || !value.trim()}
						onClick={save}
						type="button">
						Save
					</button>
					{status?.present && (
						<button
							className="rounded-lg px-2.5 py-1.5 text-[12.5px] text-shell-muted hover:bg-white/5"
							data-testid={`${testId}-clear`}
							disabled={busy}
							onClick={async () => {
								await invoke("secrets:clear", name)
								await refresh()
							}}
							type="button">
							Remove
						</button>
					)}
				</div>
			)}

			{status?.present && <p className="mt-2 text-[11.5px] text-emerald-300">A key is stored.</p>}
			{error && <p className="mt-2 text-[11.5px] text-red-400">{error}</p>}
		</section>
	)
}

function BackendRow({ backend, selected, onChoose }: { backend: BackendReportWire; selected: boolean; onChoose(): void }) {
	return (
		<div
			className={cn(
				"rounded-xl border p-3.5 transition-colors",
				selected ? "border-caret-accent/60 bg-caret-accent/5" : "border-shell-border bg-shell-panel",
			)}
			data-testid={`backend-${backend.id}`}>
			<div className="flex items-center gap-2">
				<span className="font-medium">{backend.displayName}</span>

				{backend.ready ? (
					<span className="flex items-center gap-1 text-[11px] text-emerald-300">
						<Check size={11} />
						ready
					</span>
				) : (
					<span className="text-[11px] text-amber-300">{backend.installed ? "needs sign-in" : "not installed"}</span>
				)}

				<div className="flex-1" />

				{selected ? (
					<span className="text-[11px] text-caret-accent">in use</span>
				) : (
					<button
						className="flex items-center gap-1 rounded-lg bg-white/5 px-2.5 py-1 transition-colors hover:bg-white/10 disabled:opacity-40"
						disabled={!backend.ready}
						onClick={onChoose}
						type="button">
						Use this
						<ChevronRight size={12} />
					</button>
				)}
			</div>

			<p className="mt-1.5 leading-relaxed text-shell-muted">{backend.detail}</p>

			{backend.remedy && (
				<div className="mt-2">
					<p className="text-[11.5px] text-shell-muted">{backend.remedy.label}:</p>
					{backend.remedy.command && (
						// Shown to run, not run for you: these flows want a real terminal
						// (a browser hand-off, a device code), and one spawned from a GUI
						// with nowhere to type is a dead end. Press "Check again" after.
						<CopyableCommand command={backend.remedy.command} />
					)}
					{backend.remedy.url && (
						<a
							className="text-caret-accent hover:underline"
							href={backend.remedy.url}
							rel="noreferrer"
							target="_blank">
							{backend.remedy.url}
						</a>
					)}
				</div>
			)}

			<p className="mt-2 text-[11.5px] leading-relaxed text-shell-muted">{BILLING_NOTE[backend.id]}</p>
		</div>
	)
}

function CopyableCommand({ command }: { command: string }) {
	const [copied, setCopied] = useState(false)
	return (
		<div className="mt-1 flex items-center gap-2">
			<code className="flex-1 overflow-x-auto rounded-lg bg-black/40 px-2.5 py-1.5 font-mono text-[11.5px]">{command}</code>
			<button
				className="flex items-center gap-1 rounded-lg bg-white/5 px-2 py-1.5 transition-colors hover:bg-white/10"
				onClick={async () => {
					await navigator.clipboard.writeText(command)
					setCopied(true)
					setTimeout(() => setCopied(false), 1600)
				}}
				type="button">
				{copied ? <Check size={12} /> : <Copy size={12} />}
			</button>
		</div>
	)
}

/**
 * The inbound half, deliberately below the fold.
 *
 * It is real and supported, and it is secondary: it enables an agent in your own
 * terminal to work on the design layer, not the buttons in this window.
 */
function McpSection({ project }: { project: ProjectState }) {
	const [configs, setConfigs] = useState<AgentClientConfig[]>([])
	const [selected, setSelected] = useState(0)
	const [open, setOpen] = useState(false)
	const [copied, setCopied] = useState(false)

	useEffect(() => {
		if (open) void invoke("agent:clientConfigs", project.path).then(setConfigs)
	}, [open, project.path, project.mcpUrl])

	const active = configs[selected]

	return (
		<section className="mt-8 border-t border-shell-border pt-6" data-testid="mcp-section">
			<button className="flex items-center gap-1.5 font-medium" onClick={() => setOpen(!open)} type="button">
				<ChevronRight className={cn("transition-transform", open && "rotate-90")} size={14} />
				Connect your own agent to this project
			</button>
			<p className="mt-1 ml-5 leading-relaxed text-shell-muted">
				Point Claude Code, Cursor or another MCP client at this project so it can read and write the design layer from
				your terminal. This is the other direction — it doesn't power Caret's own buttons.
			</p>

			{open && (
				<div className="mt-3 ml-5">
					{!project.mcpUrl ? (
						<p className="text-shell-muted">Starting the MCP server…</p>
					) : (
						<>
							<div className="mb-3 flex flex-wrap gap-1.5">
								{configs.map((config, index) => (
									<button
										className={cn(
											"rounded-lg px-3 py-1.5 transition-colors",
											index === selected ? "bg-caret-accent text-white" : "bg-white/5 hover:bg-white/10",
										)}
										key={config.client}
										onClick={() => setSelected(index)}
										type="button">
										{config.client}
									</button>
								))}
							</div>

							{active && (
								<div className="rounded-xl border border-shell-border bg-shell-panel p-4">
									<p className="mb-2 text-shell-muted">{active.instruction}</p>
									{active.targetPath && (
										<p className="mb-2 font-mono text-[11px] text-shell-muted">{active.targetPath}</p>
									)}
									<pre className="overflow-x-auto rounded-lg bg-black/40 p-3 font-mono text-[11.5px] leading-relaxed">
										{active.snippet}
									</pre>
									<button
										className="mt-3 flex items-center gap-1.5 rounded-lg bg-white/5 px-3 py-1.5 transition-colors hover:bg-white/10"
										onClick={async () => {
											await navigator.clipboard.writeText(active.snippet)
											setCopied(true)
											setTimeout(() => setCopied(false), 1600)
										}}
										type="button">
										{copied ? <Check size={13} /> : <Copy size={13} />}
										{copied ? "Copied" : "Copy"}
									</button>
								</div>
							)}

							<p className="mt-3 text-[11.5px] leading-relaxed text-shell-muted">
								This server is bound to 127.0.0.1, serves only this project, and requires the token above. Both
								the port and the token change every time Caret starts.
							</p>
						</>
					)}
				</div>
			)}
		</section>
	)
}
