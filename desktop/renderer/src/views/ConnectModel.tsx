/**
 * "Connect a model" — in place, where the interview needed one.
 *
 * This replaced a dead end. The old screen said "Open Settings → Backend to
 * choose one" and offered a single button that LEFT the AI route; one user in
 * the field pressed Start twice, went looking in the Backend tab, picked the
 * backend, came back and quit. The commonest cause was never a missing
 * account: the bundled backend ships free models, it had simply never been
 * selected. So the first door is one click, and everything after it resumes
 * the interview by itself — the description already typed is not asked for
 * again.
 *
 * Connecting goes through the same IPC (and the same `ProviderDoorRow`) as the
 * Backend tab, so the credential write, the server dispose and the OAuth
 * callback collection cannot drift between the two.
 */
import { ArrowRight, Loader2 } from "lucide-react"
import { useCallback, useEffect, useState } from "react"

import type { ModelGroupWire, ProviderDoorWire } from "../../../shared/ipc"
import { ProviderDoorRow } from "../components/ProviderDoorRow"
import { invoke } from "../ipc"

interface Props {
	/** What the host said is missing, verbatim — shown when the quick door cannot fix it. */
	detail: string
	/** A model is now available: re-run the turn that needed it. */
	onReady(): Promise<void>
	onManual(): void
	/** The Backend tab, where an MCP agent is connected instead. */
	onOpenBackend?(): void
}

export function ConnectModel({ detail, onReady, onManual, onOpenBackend }: Props) {
	const [connected, setConnected] = useState<ModelGroupWire[] | null>(null)
	const [doors, setDoors] = useState<ProviderDoorWire[] | null>(null)
	const [continuing, setContinuing] = useState(false)
	const [stillBlocked, setStillBlocked] = useState(false)

	const load = useCallback(async () => {
		const [models, offered] = await Promise.all([
			invoke("agent:models").catch(() => null),
			invoke("agent:providerDoors").catch(() => null),
		])
		setConnected(models ?? [])
		setDoors(offered ?? [])
	}, [])

	useEffect(() => {
		void load()
	}, [load])

	// Selecting the bundled backend is what the old flow made people find on
	// their own. It is the only backend, so there is nothing to choose between.
	const continueWithBackend = useCallback(async () => {
		setContinuing(true)
		setStillBlocked(false)
		try {
			await invoke("agent:selectBackend", "opencode")
			await onReady()
		} finally {
			setContinuing(false)
			// If the retry still needs a backend, this screen is re-rendered with the
			// host's reason; say so rather than leaving the button looking inert.
			setStillBlocked(true)
		}
	}, [onReady])

	// Plans the user pays for, never "free" ones — the free tier is the quick door.
	const paid = (connected ?? []).filter((group) => group.providerId !== "opencode")
	const quickLabel = paid.length
		? `Continue with ${paid.map((group) => group.providerName).join(", ")}`
		: "Start with a free model"

	return (
		<div className="fade-in" data-testid="wizard-needs-backend">
			<h1 className="text-2xl font-medium">Connect a model to continue</h1>
			<p className="mt-2 max-w-xl leading-relaxed text-shell-muted">
				A model runs this step: it asks the questions and makes the recommendations. Use a plan you already have, or start
				free. You'll pick up exactly where you left off.
			</p>

			<div className="mt-6 flex flex-wrap items-center gap-3">
				<button
					className="flex items-center gap-2 rounded-lg bg-caret-accent px-4 py-2 font-medium text-white transition-colors hover:bg-caret-accent-hover disabled:opacity-50"
					data-testid="connect-continue"
					disabled={continuing || connected === null}
					onClick={() => void continueWithBackend()}
					type="button">
					{continuing ? <Loader2 className="animate-spin" size={14} /> : null}
					{quickLabel}
					{!continuing && <ArrowRight size={14} />}
				</button>
				{!paid.length && (
					<span className="text-[12px] text-shell-muted">No account needed. Slower than a paid plan.</span>
				)}
			</div>
			{stillBlocked && !continuing && (
				<p className="mt-3 max-w-xl text-[12px] leading-relaxed text-amber-300" data-testid="connect-still-blocked">
					{detail}
				</p>
			)}

			{(doors?.length ?? 0) > 0 && (
				<>
					<p className="mt-9 text-[11px] tracking-wider text-shell-muted uppercase">
						Or connect a plan you already pay for
					</p>
					<div className="mt-3 grid gap-1.5" data-testid="connect-doors">
						{(doors ?? []).map((door) => (
							<ProviderDoorRow
								door={door}
								key={door.id}
								onConnected={async () => {
									await load()
									await continueWithBackend()
								}}
							/>
						))}
					</div>
				</>
			)}

			{onOpenBackend && (
				<p className="mt-6 rounded-lg border border-dashed border-shell-border px-3.5 py-3 text-[12.5px] text-shell-muted">
					Already use Claude Code, Cursor or Codex?{" "}
					<button
						className="text-[#5aa2ff] underline-offset-2 hover:underline"
						data-testid="connect-mcp"
						onClick={onOpenBackend}
						type="button">
						Connect it to Caret over MCP
					</button>{" "}
					and run setup from there instead.
				</p>
			)}

			<button
				className="mt-5 text-[12.5px] text-shell-muted transition-colors hover:text-shell-text"
				data-testid="wizard-needs-backend-manual"
				onClick={onManual}
				type="button">
				Set it by hand instead
			</button>
		</div>
	)
}
