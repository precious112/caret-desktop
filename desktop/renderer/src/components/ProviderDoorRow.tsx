/**
 * One provider you could connect, shared by the Backend tab and the inline
 * "connect a model" step of setup — one connect path, so the inline step
 * cannot drift from the tab (the credential write, the server dispose, the
 * OAuth callback collection all live behind these same IPC calls).
 */
import { useState } from "react"

import type { OauthChallengeWire, ProviderDoorWire } from "../../../shared/ipc"
import { invoke } from "../ipc"

/**
 * One provider you could connect, and every way in that it offers.
 *
 * The methods are buttons rather than a dropdown because there are rarely more
 * than three and each is a different act — a browser sign-in, a device code, a
 * pasted key — which a dropdown would flatten into one indistinguishable
 * choice.
 */
export function ProviderDoorRow({ door, onConnected }: { door: ProviderDoorWire; onConnected(): Promise<void> }) {
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
