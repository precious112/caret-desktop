/**
 * The first-run telemetry notice — the disclosure half of opt-out consent.
 *
 * Rendered by the App shell in both its states (launcher and project window),
 * because a first run can end without a project ever being opened and the
 * notice still has to have been seen. Shown once: both buttons record
 * `telemetryNoticeShown`, and "Turn off" also flips the pref that main reacts
 * to by tearing the analytics client down.
 */
import { useEffect, useState } from "react"

import { invoke } from "../ipc"

export function TelemetryNotice() {
	const [visible, setVisible] = useState(false)

	useEffect(() => {
		void invoke("prefs:get").then((prefs) => {
			if (prefs.telemetryNoticeShown !== true) setVisible(true)
		})
	}, [])

	if (!visible) return null

	const dismiss = (disable: boolean) => {
		setVisible(false)
		void invoke(
			"prefs:set",
			disable ? { telemetryNoticeShown: true, telemetryEnabled: false } : { telemetryNoticeShown: true },
		)
	}

	return (
		<div
			className="fixed bottom-4 left-1/2 z-50 w-[520px] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-xl border border-shell-border bg-shell-panel/95 p-4 shadow-lg backdrop-blur"
			data-testid="telemetry-notice">
			<p className="leading-relaxed">
				Caret sends anonymous usage and crash data to help improve it — no account, no file contents, no paths.{" "}
				{/* External links route through the OS browser via main's navigation guard. */}
				<a className="underline hover:text-white" href="https://github.com/precious112/caret/blob/main/docs/telemetry.md">
					See exactly what's collected.
				</a>
			</p>
			<div className="mt-3 flex items-center justify-end gap-1.5">
				<button
					className="rounded-lg px-2.5 py-1 text-shell-muted transition-colors hover:bg-white/5"
					onClick={() => dismiss(true)}
					type="button">
					Turn off
				</button>
				<button
					className="rounded-lg bg-caret-accent px-2.5 py-1 font-medium text-white transition-colors hover:bg-caret-accent-hover"
					onClick={() => dismiss(false)}
					type="button">
					OK
				</button>
			</div>
		</div>
	)
}
