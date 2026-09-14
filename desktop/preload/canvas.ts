/**
 * Preload for the canvas `WebContentsView`.
 *
 * The canvas is generated code served by Vite (`.caret/lib/canvas/`) and it was
 * written to talk to its host with `window.parent.postMessage`, because under VS
 * Code it lived inside an iframe. Here it is a top-level document, so
 * `window.parent === window` and those messages come straight back to itself.
 *
 * That turns out to be exactly what we want: this preload listens for them on
 * the same window and forwards them over IPC. The canvas needs no porting at all
 * — including the nested relay it already runs for the focused-page iframe.
 */
import { contextBridge, ipcRenderer } from "electron"

const CANVAS_SOURCE = "caret-vite"
const HOST_SOURCE = "caret-host"

// Messages the canvas exchanges with its own nested page iframe. They must not
// be forwarded to main — they are internal to the canvas document.
const CANVAS_INTERNAL_SOURCES = new Set(["caret-page-iframe", "caret-sim-navigate"])

window.addEventListener("message", (event: MessageEvent) => {
	const data = event.data
	if (!data || typeof data !== "object") return
	if (data.source !== CANVAS_SOURCE) return
	if (CANVAS_INTERNAL_SOURCES.has(data.source)) return
	ipcRenderer.send("canvas:toHost", data)
})

ipcRenderer.on("canvas:fromHost", (_event, message: unknown) => {
	// Re-post into the page so the canvas's own listener picks it up, unchanged.
	window.postMessage(message, "*")
})

// Nothing else is exposed. The canvas renders untrusted, agent-generated code,
// so it gets a one-way message pipe and no filesystem or Node surface.
contextBridge.exposeInMainWorld("__caretCanvasHost", { source: HOST_SOURCE })
