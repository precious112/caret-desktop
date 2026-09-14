/**
 * The chrome's last line of defence: a render throw used to blank the whole
 * window with nothing on screen and nothing in any log. The boundary reports
 * the failure (main scrubs it before anything leaves the machine) and offers
 * a reload instead of a void.
 */
import { Component, type ReactNode } from "react"

import { invoke } from "./ipc"

interface ErrorBoundaryState {
	failed: boolean
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
	override state: ErrorBoundaryState = { failed: false }

	static getDerivedStateFromError(): ErrorBoundaryState {
		return { failed: true }
	}

	override componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
		void invoke("analytics:event", "renderer_exception", {
			message: error.message,
			stack: `${error.stack ?? ""}\n${info.componentStack ?? ""}`,
		})
	}

	override render(): ReactNode {
		if (!this.state.failed) return this.props.children
		return (
			<div className="flex h-full flex-col items-center justify-center gap-3">
				<p className="text-shell-muted">Caret's window hit an error.</p>
				<button
					className="rounded-lg bg-caret-accent px-3 py-1.5 font-medium text-white transition-colors hover:bg-caret-accent-hover"
					onClick={() => window.location.reload()}
					type="button">
					Reload
				</button>
			</div>
		)
	}
}
