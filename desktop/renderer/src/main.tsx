import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { App } from "./App"
import { ErrorBoundary } from "./ErrorBoundary"
import { invoke } from "./ipc"
import "./styles.css"

// Renderer errors have nowhere to go on their own — devtools is closed in a
// packaged app and the CSP blocks any network — so they cross to main, which
// scrubs and budgets them before anything leaves the machine.
window.addEventListener("error", (event) => {
	void invoke("analytics:event", "renderer_exception", {
		message: String(event.message ?? "renderer error"),
		stack: event.error instanceof Error ? (event.error.stack ?? "") : "",
	})
})
window.addEventListener("unhandledrejection", (event) => {
	const reason = event.reason
	void invoke("analytics:event", "renderer_exception", {
		message: reason instanceof Error ? reason.message : String(reason),
		stack: reason instanceof Error ? (reason.stack ?? "") : "",
	})
})

const container = document.getElementById("root")
if (!container) throw new Error("Renderer root element is missing")

createRoot(container).render(
	<StrictMode>
		<ErrorBoundary>
			<App />
		</ErrorBoundary>
	</StrictMode>,
)
