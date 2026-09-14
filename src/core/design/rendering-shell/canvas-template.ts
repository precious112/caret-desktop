import * as fs from "fs/promises"
import * as path from "path"

import { SHADER_RUNNER_SOURCE } from "../authoring/shader-runner"
import { dedent } from "./template-utils"

export async function generateCanvasFiles(caretDir: string): Promise<void> {
	const libDir = path.join(caretDir, "lib")
	const canvasDir = path.join(libDir, "canvas")

	await fs.mkdir(canvasDir, { recursive: true })

	await Promise.all([
		fs.writeFile(path.join(canvasDir, "types.ts"), generateTypes()),
		fs.writeFile(path.join(canvasDir, "CanvasApp.tsx"), generateCanvasApp()),
		fs.writeFile(path.join(canvasDir, "CanvasView.tsx"), generateCanvasView()),
		fs.writeFile(path.join(canvasDir, "PageThumbnail.tsx"), generatePageThumbnail()),
		fs.writeFile(path.join(canvasDir, "FocusedPageView.tsx"), generateFocusedPageView()),
		fs.writeFile(path.join(canvasDir, "ErrorBoundary.tsx"), generateErrorBoundary()),
		fs.writeFile(path.join(canvasDir, "OverlayPainter.tsx"), generateOverlayPainter()),
		fs.writeFile(path.join(canvasDir, "CaretStateContext.tsx"), generateCaretStateContext()),
		fs.writeFile(path.join(canvasDir, "CaretNavigator.tsx"), generateCaretNavigator()),
		fs.writeFile(path.join(canvasDir, "SimulationView.tsx"), generateSimulationView()),
		fs.writeFile(path.join(canvasDir, "ExploreView.tsx"), generateExploreView()),
		fs.writeFile(path.join(canvasDir, "canvas.css"), generateCanvasCSS()),
		fs.writeFile(path.join(libDir, "bridge.ts"), generateBridge()),
		fs.writeFile(path.join(libDir, "edit-pill.ts"), generateEditPill()),
		fs.writeFile(path.join(libDir, "param-panel.ts"), generateParamPanel()),
		fs.writeFile(path.join(libDir, "size-resolver.ts"), generateSizeResolver()),
		fs.writeFile(path.join(libDir, "layers-panel.ts"), generateLayersPanel()),
		fs.writeFile(path.join(libDir, "asset-picker.ts"), generateAssetPicker()),
		fs.writeFile(path.join(libDir, "caret-grab-plugin.ts"), generateCaretGrabPlugin()),
		// The shader runner ships with the boot set, not only at shader accept:
		// this whole directory is cleared at project open (removeStaleShell), and
		// the first live shader accept proved what a write-once file here means —
		// the runner vanished on the next launch and every shader component's
		// import 500'd the shell.
		fs.writeFile(path.join(libDir, "CaretShader.tsx"), SHADER_RUNNER_SOURCE),
	])
}

function generateTypes(): string {
	return dedent`
		export interface PageInfo {
		  id: string
		  title: string
		  type: string
		  states: string[]
		  tags: string[]
		  /** Set when the page dir has no importable index.tsx (bad AI output). */
		  broken?: boolean
		  /** Set on an exploration take — hidden from the grid, shown only by the playground. */
		  variantOf?: string
		}

		export interface ExploreNode {
		  id: string
		  parentId: string
		  instruction: string
		  angleLabel: string
		  label: string
		  status: "working" | "ready" | "failed" | "cancelled"
		  error?: string
		  startedAt: string
		}

		export interface Exploration {
		  version: 2
		  mode: "page" | "new"
		  pageId: string
		  title?: string
		  instruction: string
		  kind?: "explore" | "drift-proposal"
		  nodes: ExploreNode[]
		}

		export interface CanvasTransform {
		  x: number
		  y: number
		  scale: number
		}

		export type LayoutMode = "auto" | "manual"

		export interface CanvasLayout {
		  mode: LayoutMode
		  positions: Record<string, { x: number; y: number }>
		}

		export type ViewportPreset = "desktop-1440" | "desktop-1280" | "tablet-768" | "mobile-390" | "mobile-375"

		export const VIEWPORT_PRESETS: Record<ViewportPreset, { name: string; width: number; icon: string }> = {
		  "desktop-1440": { name: "Desktop", width: 1440, icon: "🖥" },
		  "desktop-1280": { name: "Laptop", width: 1280, icon: "💻" },
		  "tablet-768":   { name: "Tablet", width: 768, icon: "📱" },
		  "mobile-390":   { name: "iPhone 14", width: 390, icon: "📱" },
		  "mobile-375":   { name: "iPhone SE", width: 375, icon: "📱" },
		}

		export interface FlowStep {
		  page: string
		  label?: string
		  next: string[]
		  onError?: string[]
		}

		export interface FlowDefinition {
		  id: string
		  name: string
		  description?: string
		  steps: FlowStep[]
		  /** Set when the flow file is corrupt/invalid; steps will be empty. */
		  invalid?: boolean
		  error?: string
		}
	`
}

function generateCanvasApp(): string {
	return dedent`
		import React, { useState, useEffect, useCallback, useRef } from "react"
		import { routes, pageMetas } from "virtual:caret-router"
		import { CanvasView } from "./CanvasView"
		import { FocusedPageView } from "./FocusedPageView"
		import { ErrorBoundary } from "./ErrorBoundary"
		import { SimulationView } from "./SimulationView"
		import { ExploreView } from "./ExploreView"
		import type { PageInfo, ViewportPreset, FlowDefinition, Exploration } from "./types"
		import "./canvas.css"

		export function CanvasApp() {
		  const [mode, setMode] = useState<"canvas" | "focused" | "simulation" | "explore">("canvas")
		  const [focusedPageId, setFocusedPageId] = useState<string | null>(null)
		  const [pages, setPages] = useState<PageInfo[]>(pageMetas || [])

		  // Routes as LIVE state, fed by the router module announcing each of its
		  // evaluations. The static import above is only the initial value: a page
		  // added mid-session used to render its thumbnail (metas refresh over
		  // REST) while staying unclickable, because hasRoute consulted this
		  // import's frozen array forever.
		  const [liveRoutes, setLiveRoutes] = useState(routes)
		  useEffect(() => {
		    const onRoutes = (e: Event) => {
		      const detail = (e as CustomEvent).detail
		      if (detail?.routes) setLiveRoutes(detail.routes)
		      if (detail?.pageMetas) setPages(detail.pageMetas)
		    }
		    window.addEventListener("caret:routes-updated", onRoutes)
		    return () => window.removeEventListener("caret:routes-updated", onRoutes)
		  }, [])
		  const [viewport, setViewport] = useState<ViewportPreset>("desktop-1440")
		  const [flows, setFlows] = useState<FlowDefinition[]>([])
		  const [exploration, setExploration] = useState<Exploration | null>(null)
		  // The page the playground's start screen preselects — set by the focused
		  // view's Experiment button so "riff on the page I'm looking at" is one click.
		  const [explorePreselect, setExplorePreselect] = useState<string | null>(null)

		  const log = (msg: string) => window.parent.postMessage({ source: "caret-vite", type: "log", payload: { message: msg } }, "*")

		  useEffect(() => {
		    log("CanvasApp mounted, fetching flows-meta...")
		    fetch("/__caret/flows-meta")
		      .then(r => { log("flows-meta response: " + r.status); return r.ok ? r.json() : [] })
		      .then(f => { log("flows loaded: " + f.length + " " + JSON.stringify(f.map((x: any) => x.id))); setFlows(f) })
		      .catch(e => { log("flows-meta fetch FAILED: " + String(e)) })

		    // An exploration left open (an app restart mid-generation) must come back up.
		    const refetchVariants = () => {
		      fetch("/__caret/variants")
		        .then(r => r.ok ? r.json() : null)
		        .then(raw => setExploration(raw && raw.version === 2 && Array.isArray(raw.nodes) ? raw : null))
		        .catch(() => {})
		    }
		    refetchVariants()

		    if (import.meta.hot) {
		      import.meta.hot.on("caret:pages-changed", () => {
		        fetch("/__caret/pages-meta")
		          .then(r => r.json())
		          .then(metas => setPages(metas))
		          .catch(() => {})
		      })
		      import.meta.hot.on("caret:flows-changed", () => {
		        log("[HMR] caret:flows-changed received, refetching...")
		        fetch("/__caret/flows-meta")
		          .then(r => r.ok ? r.json() : [])
		          .then(f => { log("[HMR] flows refetched: " + f.length); setFlows(f) })
		          .catch(e => { log("[HMR] flows refetch failed: " + e) })
		      })
		      import.meta.hot.on("caret:variants-changed", refetchVariants)
		    }
		  }, [])

		  // Exploration takes are working copies for the playground, not pages in
		  // their own right — the grid must never show them.
		  const gridPages = pages.filter(p => !p.variantOf)

		  // Where the playground was entered from, so its back arrow returns there.
		  const exploreOrigin = useRef<"canvas" | "focused">("canvas")

		  const handleExplore = useCallback((pageId?: string) => {
		    exploreOrigin.current = mode === "focused" ? "focused" : "canvas"
		    setExplorePreselect(pageId ?? null)
		    setMode("explore")
		  }, [mode])

		  const handleExploreBack = useCallback(() => {
		    if (exploreOrigin.current === "focused" && focusedPageId) setMode("focused")
		    else { setMode("canvas"); setFocusedPageId(null) }
		  }, [focusedPageId])

		  const handleVariantPick = useCallback((variantId: string) => {
		    window.parent.postMessage({ source: "caret-vite", type: "variant-pick", payload: { variantId } }, "*")
		    // Optimistic: the host resolves the exploration and deletes the scratch,
		    // which pushes caret:variants-changed; hiding now keeps the click responsive.
		    setExploration(null)
		    handleExploreBack()
		  }, [handleExploreBack])

		  const handleFocus = useCallback((pageId: string) => {
		    setFocusedPageId(pageId)
		    setMode("focused")
		  }, [])

		  const handleBack = useCallback(() => {
		    setMode("canvas")
		    setFocusedPageId(null)
		  }, [])

		  // Tracks where simulation was entered from so exiting returns there.
		  const simOrigin = useRef<"canvas" | "focused">("focused")

		  const handleSimulate = useCallback(() => {
		    simOrigin.current = "focused"
		    setMode("simulation")
		  }, [])

		  const handleSimulateFromCanvas = useCallback((pageId: string) => {
		    simOrigin.current = "canvas"
		    setFocusedPageId(pageId)
		    setMode("simulation")
		  }, [])

		  const handleExitSimulation = useCallback(() => {
		    if (simOrigin.current === "canvas") {
		      setMode("canvas")
		      setFocusedPageId(null)
		    } else {
		      setMode("focused")
		    }
		  }, [])

		  // The playground never hijacks the surface. While an exploration is open
		  // in any other mode, this pill is the standing way back to it.
		  const workingCount = exploration ? exploration.nodes.filter(n => n.status === "working").length : 0
		  const explorePill = exploration ? (
		    <button className="caret-explore-pill" data-testid="explore-open-pill" onClick={() => handleExplore()}>
		      ⚗ Exploration open — {exploration.nodes.length} take{exploration.nodes.length === 1 ? "" : "s"}{workingCount > 0 ? " · " + workingCount + " working" : ""}
		    </button>
		  ) : null

		  if (mode === "explore") {
		    return (
		      <ErrorBoundary fallback={<CanvasErrorFallback />}>
		        <ExploreView
		          exploration={exploration}
		          pages={gridPages}
		          preselect={explorePreselect}
		          onPick={handleVariantPick}
		          onBack={handleExploreBack}
		        />
		      </ErrorBoundary>
		    )
		  }

		  if (mode === "simulation" && focusedPageId) {
		    return (
		      <ErrorBoundary fallback={<CanvasErrorFallback />}>
		        <SimulationView
		          initialPageId={focusedPageId}
		          pages={pages}
		          viewport={viewport}
		          onSetViewport={setViewport}
		          onExit={handleExitSimulation}
		        />
		        {explorePill}
		      </ErrorBoundary>
		    )
		  }

		  if (mode === "focused" && focusedPageId) {
		    const page = pages.find(p => p.id === focusedPageId)
		    return (
		      <ErrorBoundary fallback={<FocusedErrorFallback onBack={() => { setMode("canvas"); setFocusedPageId(null) }} />}>
		        <FocusedPageView
		          pageId={focusedPageId}
		          title={page?.title || focusedPageId}
		          tags={page?.tags || []}
		          states={page?.states || []}
		          onBack={handleBack}
		          onSimulate={handleSimulate}
		          onExplore={() => handleExplore(focusedPageId)}
		          viewport={viewport}
		          onSetViewport={setViewport}
		        />
		        {explorePill}
		      </ErrorBoundary>
		    )
		  }

		  return (
		    <ErrorBoundary fallback={<CanvasErrorFallback />}>
		      <CanvasView
		        pages={gridPages}
		        routes={liveRoutes}
		        onFocus={handleFocus}
		        onSimulate={handleSimulateFromCanvas}
		        onExplore={() => handleExplore()}
		        flows={flows}
		        viewport={viewport}
		        onSetViewport={setViewport}
		      />
		      {explorePill}
		    </ErrorBoundary>
		  )
		}

		function FocusedErrorFallback({ onBack }: { onBack: () => void }) {
		  return (
		    <div className="caret-focused-shell">
		      <div className="caret-focused-toolbar">
		        <button onClick={onBack} className="caret-focused-toolbar-btn" title="Back to canvas">←</button>
		      </div>
		      <div className="caret-canvas-error">
		        <h2>Page failed to render</h2>
		        <p>Check .caret/vite.log for compilation errors.</p>
		      </div>
		    </div>
		  )
		}

		function CanvasErrorFallback() {
		  return (
		    <div className="caret-canvas-error">
		      <h2>Canvas error</h2>
		      <p>Something went wrong. Try reloading the preview.</p>
		    </div>
		  )
		}
	`
}

function generateExploreView(): string {
	return dedent`
		import React, { useEffect, useRef, useState } from "react"
		import type { Exploration, ExploreNode, PageInfo } from "./types"

		/**
		 * The playground: exploration on its own canvas mode, never an overlay.
		 * With nothing open it is the start screen. With an exploration open the
		 * view is a centered lineage walked downward: the current round's takes
		 * side by side — skeletons while they generate, the live page the moment
		 * each finishes — and branching clears the siblings, keeps the pick, and
		 * grows the next round below it. Clicking a page shows it full size.
		 */

		function send(type: string, payload: any) {
		  window.parent.postMessage({ source: "caret-vite", type, payload }, "*")
		}

		/** A live page iframe scaled to exactly fill its card — no dead space at any column width. */
		function ScaledFrame({ pageId, border }: { pageId: string; border?: string }) {
		  const box = useRef<HTMLDivElement>(null)
		  const [scale, setScale] = useState(0.24)
		  useEffect(() => {
		    const el = box.current
		    if (!el) return
		    const measure = () => { if (el.clientWidth > 0) setScale(el.clientWidth / 1440) }
		    measure()
		    const ro = new ResizeObserver(measure)
		    ro.observe(el)
		    return () => ro.disconnect()
		  }, [])
		  return (
		    <div ref={box} style={{ position: "relative", borderRadius: 10, overflow: "hidden",
		      border: border || "1px solid #2a2a3a", background: "#fff", aspectRatio: "16 / 10" }}>
		      {/* Stable key: a finished take updates live over HMR — no remount flash. */}
		      <iframe key={pageId} src={"/?page=" + pageId} title={pageId}
		        style={{ width: 1440, height: 900, border: "none",
		          transform: "scale(" + scale + ")", transformOrigin: "top left", pointerEvents: "none" }} />
		    </div>
		  )
		}

		function elapsedLabel(startedAt: string): string {
		  const s = Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000))
		  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0")
		}

		export function ExploreView({ exploration, pages, preselect, onPick, onBack }: {
		  exploration: Exploration | null
		  pages: PageInfo[]
		  preselect: string | null
		  onPick: (variantId: string) => void
		  onBack: () => void
		}) {
		  return (
		    <div className="caret-explore" data-testid="explore-view">
		      {exploration
		        ? <OpenExploration exploration={exploration} onPick={onPick} onBack={onBack} />
		        : <StartScreen pages={pages} preselect={preselect} onBack={onBack} />}
		    </div>
		  )
		}

		/**
		 * The door you came through IS the choice — no chooser screen. Entering
		 * from a focused page (preselect set) experiments on THAT page; entering
		 * from the canvas flask starts something new. Nothing here asks the user
		 * to restate where they just clicked.
		 */
		function StartScreen({ pages, preselect, onBack }: { pages: PageInfo[]; preselect: string | null; onBack: () => void }) {
		  const pageId = preselect
		  const page = pageId ? pages.find(p => p.id === pageId) : null
		  const [pageInstruction, setPageInstruction] = useState("")
		  const [newName, setNewName] = useState("")
		  const [newInstruction, setNewInstruction] = useState("")
		  const [starting, setStarting] = useState(false)
		  const [error, setError] = useState<string | null>(null)

		  // A refused start (no backend, an exploration already open elsewhere)
		  // arrives as a failed edit-result — it must be readable, not a lost toast.
		  useEffect(() => {
		    const onMsg = (e: MessageEvent) => {
		      const d = e.data
		      if (!d || d.source !== "caret-host" || d.type !== "edit-result") return
		      if (d.payload && d.payload.success === false && d.payload.error) {
		        setError(String(d.payload.error))
		        setStarting(false)
		      }
		    }
		    window.addEventListener("message", onMsg)
		    return () => window.removeEventListener("message", onMsg)
		  }, [])

		  useEffect(() => {
		    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onBack() }
		    window.addEventListener("keydown", onKey)
		    return () => window.removeEventListener("keydown", onKey)
		  }, [onBack])

		  const startPage = () => {
		    if (!pageId || !pageInstruction.trim() || starting) return
		    setError(null); setStarting(true)
		    send("variant-request", { pageId, instruction: pageInstruction.trim() })
		  }
		  const startNew = () => {
		    if (!newName.trim() || !newInstruction.trim() || starting) return
		    setError(null); setStarting(true)
		    send("variant-request", { newPage: { name: newName.trim() }, instruction: newInstruction.trim() })
		  }

		  const cardStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 12, padding: 24,
		    borderRadius: 14, border: "1px solid #2a2a3a", background: "#15151f", width: 440, maxWidth: "90%" }
		  const inputStyle: React.CSSProperties = { padding: "10px 14px", borderRadius: 8, border: "1px solid #3a3a4a",
		    background: "#1e1e2a", color: "#e5e7eb", fontSize: 13.5, outline: "none" }

		  return (
		    <>
		      <div className="caret-explore-header">
		        <button className="caret-explore-btn" data-testid="explore-back" onClick={onBack} title="Back to canvas">←</button>
		        <div style={{ minWidth: 0, flex: 1 }}>
		          <div style={{ fontSize: 15, fontWeight: 600 }}>{pageId ? "Experiment with " + ((page && page.title) || pageId) : "Something new"}</div>
		          <div style={{ fontSize: 12.5, color: "#8b93a7" }}>Three independent takes per round — pick one, or branch a direction further.</div>
		        </div>
		      </div>
		      {starting && <div style={{ padding: "10px 24px", fontSize: 13, color: "#8b93a7", textAlign: "center" }}>Starting the first round…</div>}
		      {error && <div data-testid="explore-start-error" style={{ padding: "10px 24px", fontSize: 13, color: "#f87171", textAlign: "center" }}>{error}</div>}
		      <div style={{ flex: 1, display: "flex", justifyContent: "center", alignItems: "flex-start", paddingTop: "14vh" }}>
		        {pageId ? (
		        <div data-testid="explore-start-page" style={cardStyle}>
		          <div style={{ fontSize: 14, fontWeight: 600 }}>Variants of {(page && page.title) || pageId}</div>
		          <div style={{ fontSize: 12, color: "#8b93a7" }}>The winner replaces the page; the page is untouched until then.</div>
		          <input autoFocus data-testid="explore-instruction" style={inputStyle} placeholder="What should the takes explore?"
		            value={pageInstruction} onChange={e => setPageInstruction(e.target.value)}
		            onKeyDown={e => { if (e.key === "Enter") startPage() }} />
		          <button className="caret-explore-primary" data-testid="explore-start-page-go" disabled={starting} onClick={startPage}>Generate 3 takes</button>
		        </div>
		        ) : (
		        <div data-testid="explore-start-new" style={cardStyle}>
		          <div style={{ fontSize: 14, fontWeight: 600 }}>Something new</div>
		          <div style={{ fontSize: 12, color: "#8b93a7" }}>A page that doesn't exist yet — settling adds it to the canvas.</div>
		          <input autoFocus data-testid="explore-new-name" style={inputStyle} placeholder="Page name, e.g. Pricing"
		            value={newName} onChange={e => setNewName(e.target.value)} />
		          <input data-testid="explore-new-instruction" style={inputStyle} placeholder="What should it be?"
		            value={newInstruction} onChange={e => setNewInstruction(e.target.value)}
		            onKeyDown={e => { if (e.key === "Enter") startNew() }} />
		          <button className="caret-explore-primary" data-testid="explore-start-new-go" disabled={starting} onClick={startNew}>Generate 3 takes</button>
		        </div>
		        )}
		      </div>
		    </>
		  )
		}

		function OpenExploration({ exploration, onPick, onBack }: {
		  exploration: Exploration
		  onPick: (variantId: string) => void
		  onBack: () => void
		}) {
		  const nodes = exploration.nodes
		  const isNew = exploration.mode === "new"
		  const isProposal = exploration.kind === "drift-proposal"
		  const [expandedId, setExpandedId] = useState<string | null>(null)
		  // The verdict beat: set on settle. The winner rings, the rest fall back,
		  // and the pick itself posts a beat later. Unmount clears the timer, so
		  // leaving the exploration during the beat cancels the settle.
		  const [settlingId, setSettlingId] = useState<string | null>(null)
		  const settleTimer = useRef(0)
		  useEffect(() => () => window.clearTimeout(settleTimer.current), [])
		  const [branchingId, setBranchingId] = useState<string | null>(null)
		  const [branchText, setBranchText] = useState("")
		  // Set on branch submit; renders three skeletons until the round registers.
		  const [pendingBranch, setPendingBranch] = useState<string | null>(null)

		  const byId: Record<string, ExploreNode> = {}
		  nodes.forEach(n => { byId[n.id] = n })

		  // The lineage: every branch point picked so far, oldest first. Branching
		  // commits to it — the passed-over siblings leave the view (the header's
		  // discard is still the way out of the whole exploration). Derived from
		  // the data on mount so a reopened exploration lands on its deepest round.
		  const [lineage, setLineage] = useState<string[]>(() => {
		    const map: Record<string, ExploreNode> = {}
		    nodes.forEach(n => { map[n.id] = n })
		    const chain: string[] = []
		    let p = nodes.length ? nodes[nodes.length - 1].parentId : ""
		    while (p && map[p]) { chain.unshift(p); p = map[p].parentId }
		    return chain
		  })

		  const branchPoint = lineage.length ? lineage[lineage.length - 1] : exploration.pageId
		  const row = nodes.filter(n => n.parentId === branchPoint)

		  // The submitted branch's skeletons are placeholders only until the real
		  // nodes land in the scratch — then the row IS the round.
		  useEffect(() => {
		    if (pendingBranch && nodes.some(n => n.parentId === pendingBranch)) setPendingBranch(null)
		  }, [nodes.length, pendingBranch])

		  // Re-render each second while anything generates, for the elapsed tickers.
		  const workingCount = nodes.filter(n => n.status === "working").length
		  const [, setTick] = useState(0)
		  useEffect(() => {
		    if (workingCount === 0) return
		    const t = setInterval(() => setTick(x => x + 1), 1000)
		    return () => clearInterval(t)
		  }, [workingCount])

		  const readyIds = nodes.filter(n => n.status === "ready").map(n => n.id)

		  const cancelBranch = () => {
		    setBranchingId(null); setBranchText("")
		    // Un-commit: the passed-over siblings come back.
		    setLineage(l => l.slice(0, -1))
		  }

		  useEffect(() => {
		    const onKey = (e: KeyboardEvent) => {
		      if (settlingId) return
		      if (e.key === "Escape") {
		        if (expandedId) setExpandedId(null)
		        else if (branchingId) cancelBranch()
		        else onBack()
		      }
		      if (expandedId && (e.key === "ArrowLeft" || e.key === "ArrowRight") && readyIds.length > 1) {
		        const i = readyIds.indexOf(expandedId)
		        if (i >= 0) setExpandedId(readyIds[(i + (e.key === "ArrowRight" ? 1 : readyIds.length - 1)) % readyIds.length])
		      }
		    }
		    window.addEventListener("keydown", onKey)
		    return () => window.removeEventListener("keydown", onKey)
		  }, [expandedId, branchingId, settlingId, readyIds.join(","), onBack])

		  const discard = () => {
		    if (workingCount > 0 && !window.confirm("Takes are still generating — discard the whole exploration?")) return
		    onPick("")
		  }
		  const settle = (id: string) => {
		    if (settlingId) return
		    if (workingCount > 0 && !window.confirm("Takes are still generating — settle on this one and drop the rest?")) return
		    // The pick reads as a verdict before the view moves on: half a second
		    // of the winner ringed and the passed-over takes falling back. From
		    // full size, collapse first so the beat is visible.
		    setExpandedId(null)
		    setSettlingId(id)
		    settleTimer.current = window.setTimeout(() => onPick(id), 500)
		  }
		  const startBranch = (id: string) => {
		    setLineage(l => [...l, id])
		    setBranchingId(id)
		    setBranchText("")
		  }
		  const submitBranch = () => {
		    if (!branchingId || !branchText.trim()) return
		    const picked = byId[branchingId]
		    if (picked) {
		      // Branching IS the verdict on this round — passed-over siblings still
		      // generating are cancelled, not left spending quietly out of view.
		      nodes
		        .filter(n => n.parentId === picked.parentId && n.id !== branchingId && n.status === "working")
		        .forEach(n => send("variant-cancel", { nodeId: n.id }))
		    }
		    send("variant-request", { fromId: branchingId, instruction: branchText.trim() })
		    setPendingBranch(branchingId)
		    setBranchingId(null)
		    setBranchText("")
		  }

		  const useLabel = isProposal ? "Use the app's version" : isNew ? "Add to canvas" : "Use this one"
		  const keepLabel = isProposal ? "Keep the design" : isNew ? "Discard" : "Keep the original"
		  const title = isNew
		    ? "New page: " + (exploration.title || exploration.pageId)
		    : isProposal ? "Review: " + exploration.pageId + " vs the app" : "Exploring " + exploration.pageId

		  if (expandedId) {
		    const node = byId[expandedId]
		    return (
		      <div data-testid="explore-expanded" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
		        <div className="caret-explore-header">
		          <button className="caret-explore-btn" data-testid="explore-collapse" onClick={() => setExpandedId(null)} title="Back to the cards (Esc)">←</button>
		          <div style={{ minWidth: 0, flex: 1 }}>
		            <div style={{ fontSize: 14, fontWeight: 600 }}>{node ? node.label : "Current design"}{node ? " · " + node.angleLabel : ""}</div>
		            <div style={{ fontSize: 12, color: "#8b93a7" }}>full size — ←/→ compares, Esc goes back</div>
		          </div>
		          {node && node.status === "ready" && (
		            <button className="caret-explore-primary" data-testid={"variant-use-" + node.id} onClick={() => settle(node.id)}>{useLabel}</button>
		          )}
		        </div>
		        <div style={{ flex: 1, overflow: "auto", background: "#0d0d14", display: "flex", justifyContent: "center" }}>
		          <iframe key={expandedId} src={"/?page=" + expandedId} title={expandedId}
		            style={{ width: 1440, height: "100%", border: "none", background: "#fff", flexShrink: 0 }} />
		        </div>
		      </div>
		    )
		  }

		  // One take, rendered for any position in the lineage. What a take shows
		  // is decided by its status alone: a skeleton while the model works, the
		  // live page the moment it lands, a readable message when it didn't.
		  // Actions live BELOW the frame so every frame in a row starts at the
		  // same height, and the frame itself is the click target for full size.
		  const takeCard = (node: ExploreNode, opts: { ancestor?: boolean } = {}) => (
		    <div key={node.id} data-testid={"variant-card-" + node.id}
		      className={"caret-explore-card" + (settlingId ? (settlingId === node.id ? " settling-won" : " settling-lost") : "")}
		      style={{ width: opts.ancestor ? 380 : 400, display: "flex", flexDirection: "column", gap: 10,
		        pointerEvents: settlingId ? "none" : undefined }}>
		      <div style={{ display: "flex", alignItems: "baseline", gap: 8, whiteSpace: "nowrap" }}>
		        <span style={{ fontSize: 13, fontWeight: 600 }}>{node.label}</span>
		        <span style={{ fontSize: 11.5, color: "#8b93a7" }}>{node.angleLabel}</span>
		        <span style={{ marginLeft: "auto" }} />
		        {node.status === "working" && (
		          <>
		            <span style={{ fontSize: 12, color: "#8b93a7", fontVariantNumeric: "tabular-nums" }}>{elapsedLabel(node.startedAt)}</span>
		            <button className="caret-explore-mini" data-testid={"explore-cancel-" + node.id}
		              title="Cancel this take" onClick={() => send("variant-cancel", { nodeId: node.id })}>×</button>
		          </>
		        )}
		      </div>

		      {node.status === "working" && (
		        <div className="caret-explore-skel" data-testid={"explore-skeleton-" + node.id}>
		          <div className="caret-explore-skel-bar" style={{ width: "42%", height: 22 }} />
		          <div className="caret-explore-skel-bar" style={{ width: "88%" }} />
		          <div className="caret-explore-skel-bar" style={{ width: "76%" }} />
		          <div className="caret-explore-skel-bar" style={{ width: "82%", height: 64 }} />
		          <div className="caret-explore-skel-bar" style={{ width: "64%" }} />
		        </div>
		      )}
		      {node.status === "ready" && (
		        <div className="caret-explore-frame" data-testid={"explore-preview-" + node.id}
		          title="Click to see it full size" onClick={() => setExpandedId(node.id)}>
		          <ScaledFrame pageId={node.id} />
		        </div>
		      )}
		      {(node.status === "failed" || node.status === "cancelled") && (
		        <div style={{ borderRadius: 10, border: "1px solid #4a2a2a", background: "#1c1216", padding: 16,
		          fontSize: 12.5, color: "#f0a8a8", lineHeight: 1.5, minHeight: 80 }}>
		          {node.status === "cancelled"
		            ? "Cancelled." + (node.error ? " " + node.error : "")
		            : (node.error || "This take failed — the other cards are unaffected.")}
		        </div>
		      )}

		      {node.status === "ready" && (
		        <div style={{ display: "flex", justifyContent: "center", gap: 10 }}>
		          <button className="caret-explore-primary" data-testid={"variant-use-" + node.id} onClick={() => settle(node.id)}>{useLabel}</button>
		          {!isProposal && !opts.ancestor && (
		            <button className="caret-explore-ghost" data-testid={"explore-branch-" + node.id} onClick={() => startBranch(node.id)}>Branch</button>
		          )}
		        </div>
		      )}
		    </div>
		  )

		  const skeletonPlaceholder = (index: number) => (
		    <div key={"pending-" + index} data-testid={"explore-skeleton-pending-" + index} style={{ width: 400 }}>
		      <div className="caret-explore-skel" style={{ marginTop: 30 }}>
		        <div className="caret-explore-skel-bar" style={{ width: "42%", height: 22 }} />
		        <div className="caret-explore-skel-bar" style={{ width: "88%" }} />
		        <div className="caret-explore-skel-bar" style={{ width: "76%" }} />
		        <div className="caret-explore-skel-bar" style={{ width: "82%", height: 64 }} />
		      </div>
		    </div>
		  )

		  return (
		    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
		      <div className="caret-explore-header">
		        <button className="caret-explore-btn" data-testid="explore-back" onClick={onBack} title="Back to canvas — the exploration stays open">←</button>
		        <div style={{ minWidth: 0, flex: 1 }}>
		          <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
		          <div style={{ fontSize: 12.5, color: "#8b93a7", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
		            title={exploration.instruction}>
		            “{exploration.instruction}”{workingCount > 0 ? " — " + workingCount + " take" + (workingCount === 1 ? "" : "s") + " generating" : ""}
		          </div>
		        </div>
		        {workingCount > 0 && (
		          <button className="caret-explore-btn" data-testid="explore-stop-all" onClick={() => send("variant-cancel", {})}>Stop generating</button>
		        )}
		        <button className="caret-explore-btn" data-testid="variant-keep-original" onClick={discard}>{keepLabel}</button>
		      </div>

		      <div style={{ flex: 1, overflow: "auto", padding: "36px 24px 80px" }}>
		        <div style={{ maxWidth: 1320, margin: "0 auto", display: "flex", flexDirection: "column", alignItems: "center", gap: 32 }}>
		          {/* A drift review is a comparison — the current design stays visible
		              beside the app's version. Everywhere else the original earns no
		              card: the exploration is about where the page is going. */}
		          {isProposal && (
		            <div data-testid={"variant-card-" + exploration.pageId}
		              className={"caret-explore-card" + (settlingId ? " settling-lost" : "")}
		              style={{ width: 400, display: "flex", flexDirection: "column", gap: 10 }}>
		              <div style={{ fontSize: 13, fontWeight: 600 }}>Current design</div>
		              <div className="caret-explore-frame" data-testid={"explore-preview-" + exploration.pageId}
		                title="Click to see it full size" onClick={() => setExpandedId(exploration.pageId)}>
		                <ScaledFrame pageId={exploration.pageId} border="1px solid #3a3a4a" />
		              </div>
		            </div>
		          )}

		          {/* The lineage: each branch point picked so far, walked downward. */}
		          {lineage.map(id => byId[id] && takeCard(byId[id], { ancestor: true }))}

		          {branchingId && (
		            <input autoFocus data-testid={"explore-branch-input-" + branchingId}
		              style={{ width: 400, padding: "10px 14px", borderRadius: 8, border: "1px solid #0b7aff88",
		                background: "#1e1e2a", color: "#e5e7eb", fontSize: 13.5, outline: "none" }}
		              placeholder="How should the next round push this? — Enter to generate, Esc to go back"
		              value={branchText} onChange={e => setBranchText(e.target.value)}
		              onKeyDown={e => { if (e.key === "Enter") submitBranch() }} />
		          )}

		          <div style={{ display: "flex", gap: 24, justifyContent: "center", alignItems: "flex-start", flexWrap: "wrap", width: "100%" }}>
		            {row.map(node => takeCard(node))}
		            {pendingBranch && row.length === 0 && [0, 1, 2].map(skeletonPlaceholder)}
		          </div>
		        </div>
		      </div>
		    </div>
		  )
		}
	`
}

function generateCanvasView(): string {
	return dedent`
		import React, { useState, useRef, useCallback, useEffect } from "react"
		import { BrokenPageCard, PageThumbnail } from "./PageThumbnail"
		import type { PageInfo, CanvasTransform, CanvasLayout, LayoutMode, ViewportPreset, FlowDefinition } from "./types"
		import { VIEWPORT_PRESETS } from "./types"

		/* Ids the canvas has already shown this session — see the entrance note in
		   CanvasView. Module scope on purpose: HMR of the router re-renders the view
		   without re-evaluating this module, so an entrance plays exactly once. */
		const seenPageIds = new Set<string>()
		let seenPageIdsPrimed = false

		const THUMB_WIDTH = 380
		const THUMB_HEIGHT = 238
		const FRAME_WIDTH = 1440
		const FRAME_HEIGHT = 900
		const GAP = 40
		const COLS = 3
		const MIN_SCALE = 0.1
		const MAX_SCALE = 3.0
		const DRAG_THRESHOLD = 5
		const GROUP_HEADER_HEIGHT = 32
		const GROUP_GAP = 48
		// Height of the title label above each thumbnail frame (20px min-height + 6px padding).
		const LABEL_H = 26
		// Manual positions are stored in reference space: thumbnail height at desktop-1440.
		// Other viewports scale y at render time so saved layouts stay viewport-independent.
		const REF_THUMB_HEIGHT = FRAME_HEIGHT * (THUMB_WIDTH / 1440)

		interface Props {
		  pages: PageInfo[]
		  routes: Array<{ path: string; name: string; loader: () => Promise<{ default: React.ComponentType }> }>
		  onFocus: (pageId: string) => void
		  onSimulate: (pageId: string) => void
		  onExplore: () => void
		  flows: FlowDefinition[]
		  viewport: ViewportPreset
		  onSetViewport: (v: ViewportPreset) => void
		}

		function groupPagesByTag(pages: PageInfo[]): Array<{ tag: string; pages: PageInfo[] }> {
		  const groups: Record<string, PageInfo[]> = {}
		  for (const page of pages) {
		    const tag = page.tags?.[0] || "other"
		    if (!groups[tag]) groups[tag] = []
		    groups[tag].push(page)
		  }
		  return Object.entries(groups)
		    .sort(([a], [b]) => (a === "other" ? 1 : b === "other" ? -1 : a.localeCompare(b)))
		    .map(([tag, pages]) => ({ tag, pages }))
		}

		function computeAutoPositions(pages: PageInfo[], thumbHeight: number): Array<{ page: PageInfo; x: number; y: number; groupTag?: string }> {
		  const groups = groupPagesByTag(pages)
		  const items: Array<{ page: PageInfo; x: number; y: number; groupTag?: string }> = []
		  let yOffset = 0
		  const rowHeight = thumbHeight + GAP + 24

		  for (const group of groups) {
		    yOffset += GROUP_HEADER_HEIGHT
		    group.pages.forEach((page, i) => {
		      const col = i % COLS
		      const row = Math.floor(i / COLS)
		      items.push({
		        page,
		        x: col * (THUMB_WIDTH + GAP),
		        y: yOffset + row * rowHeight,
		        groupTag: i === 0 ? group.tag : undefined,
		      })
		    })
		    const rows = Math.ceil(group.pages.length / COLS)
		    yOffset += rows * rowHeight + GROUP_GAP
		  }
		  return items
		}

		let saveTimeout: ReturnType<typeof setTimeout> | null = null
		function saveLayout(layout: CanvasLayout) {
		  if (saveTimeout) clearTimeout(saveTimeout)
		  saveTimeout = setTimeout(() => {
		    fetch("/__caret/canvas-layout", {
		      method: "PUT",
		      headers: { "Content-Type": "application/json" },
		      body: JSON.stringify(layout),
		    }).catch(() => {})
		  }, 500)
		}

		export function CanvasView({ pages, routes, onFocus, onSimulate, onExplore, flows, viewport, onSetViewport }: Props) {
		  // First-appearance entrance: a page id never seen this session animates in
		  // once. Everything present on the canvas's first render is seeded silently
		  // (opening a project must not replay N entrances), and the module-scope set
		  // survives router HMR and view remounts, so nothing ever replays.
		  if (!seenPageIdsPrimed) { pages.forEach(p => seenPageIds.add(p.id)); seenPageIdsPrimed = true }
		  const entering = (id: string) => (seenPageIds.has(id) ? "" : " entering")
		  useEffect(() => { pages.forEach(p => seenPageIds.add(p.id)) })
		  const [transform, setTransform] = useState<CanvasTransform>({ x: 40, y: 40, scale: 1 })
		  const [showFlows, setShowFlows] = useState(false)
		  const [activeFlowId, setActiveFlowId] = useState<string | null>(null)
		  const [isPanning, setIsPanning] = useState(false)
		  const [panStart, setPanStart] = useState({ x: 0, y: 0 })
		  const [layoutMode, setLayoutMode] = useState<LayoutMode>("auto")
		  const [manualPositions, setManualPositions] = useState<Record<string, { x: number; y: number }>>({})
		  const [dragState, setDragState] = useState<{ pageId: string; startX: number; startY: number; origX: number; origY: number; moved: boolean } | null>(null)
		  const [edgeDrag, setEdgeDrag] = useState<{ fromPage: string; mouseX: number; mouseY: number; originX: number; originY: number; reassignFlowId?: string; reassignOldTo?: string; reassignIsError?: boolean } | null>(null)
		  const [selectedEdge, setSelectedEdge] = useState<{ flowId: string; from: string; to: string; isError?: boolean } | null>(null)
		  const containerRef = useRef<HTMLDivElement>(null)
		  const contentRef = useRef<HTMLDivElement>(null)
		  const log = (msg: string) => window.parent.postMessage({ source: "caret-vite", type: "log", payload: { message: msg } }, "*")

		  // The acceptance checker's findings, shown whether or not anything asked
		  // for them — an enforced check that only reports into a log nobody opens
		  // is the honor-system checker with extra steps.
		  const [checkResults, setCheckResults] = useState<Array<{ pageId: string; findings: Array<{ check: string; severity: string; message: string }> }>>([])
		  const [showChecks, setShowChecks] = useState(false)
		  useEffect(() => {
		    const refetch = () => {
		      fetch("/__caret/checks")
		        .then(r => r.ok ? r.json() : { pages: [] })
		        .then(d => setCheckResults((d.pages || []).filter((p: any) => (p.findings || []).length > 0)))
		        .catch(() => {})
		    }
		    refetch()
		    if (import.meta.hot) import.meta.hot.on("caret:checks-changed", refetch)
		  }, [])
		  const checkCount = checkResults.reduce((n, p) => n + p.findings.length, 0)

		  const activeFrameWidth = VIEWPORT_PRESETS[viewport].width
		  const activeThumbHeight = FRAME_HEIGHT * (THUMB_WIDTH / activeFrameWidth)
		  const autoItems = layoutMode === "auto" ? computeAutoPositions(pages, activeThumbHeight) : null

		  /**
		   * Which cards get a live iframe (Phase 10.7). Two gates, both measured:
		   *
		   * - **On screen.** The card's box after the pan/zoom must land within a
		   *   margin of the window.
		   * - **Big enough to be worth it.** The canvas fits everything on open,
		   *   so 200 artboards open at ~4% zoom where every card IS on screen but
		   *   renders 12px wide. A live iframe there is a whole page load showing
		   *   a smudge — 200 of them wedge the main thread for nothing. Below the
		   *   legibility floor the card is a placeholder, and real renders swap in
		   *   as the user zooms into what they are actually looking at.
		   */
		  const LIVE_MARGIN = 500
		  const LEGIBLE_PX = 60

		  // The live set is computed from a SETTLED transform, not the live one.
		  // Panning at high zoom otherwise drags fresh cards into range on every
		  // frame, and each one is a whole page load mid-gesture (measured: 91ms
		  // median frames while panning 200 artboards). Frozen during the
		  // gesture, the pan is just a CSS transform; the set fills in when the
		  // hand stops.
		  const [settledTransform, setSettledTransform] = useState(transform)
		  useEffect(() => {
		    const timer = setTimeout(() => setSettledTransform(transform), 140)
		    return () => clearTimeout(timer)
		  }, [transform])

		  function isLive(x: number, y: number): boolean {
		    const width = THUMB_WIDTH * settledTransform.scale
		    if (width < LEGIBLE_PX) return false
		    const left = x * settledTransform.scale + settledTransform.x
		    const top = y * settledTransform.scale + settledTransform.y
		    const height = (LABEL_H + activeThumbHeight) * settledTransform.scale
		    return (
		      left < window.innerWidth + LIVE_MARGIN &&
		      left + width > -LIVE_MARGIN &&
		      top < window.innerHeight + LIVE_MARGIN &&
		      top + height > -LIVE_MARGIN
		    )
		  }
		  // Scaling the full card pitch (thumb + label) keeps cards that fit at the
		  // reference viewport from ever overlapping at taller viewports.
		  const layoutScaleY = (activeThumbHeight + LABEL_H) / (REF_THUMB_HEIGHT + LABEL_H)
		  const manualDisplayPositions = React.useMemo(() => {
		    const out: Record<string, { x: number; y: number }> = {}
		    pages.forEach((p, i) => {
		      const ref = manualPositions[p.id] || { x: (i % COLS) * (THUMB_WIDTH + GAP), y: Math.floor(i / COLS) * (REF_THUMB_HEIGHT + GAP + LABEL_H) }
		      out[p.id] = { x: ref.x, y: ref.y * layoutScaleY }
		    })
		    return out
		  }, [pages, manualPositions, layoutScaleY])

		  // y + LABEL_H so edges anchor on the visible frame, not the title label above it.
		  const getRect = (pageId: string) => {
		    if (autoItems) {
		      const item = autoItems.find(i => i.page.id === pageId)
		      if (item) return { x: item.x, y: item.y + LABEL_H, w: THUMB_WIDTH, h: activeThumbHeight }
		    } else {
		      const pos = manualDisplayPositions[pageId]
		      if (pos) return { x: pos.x, y: pos.y + LABEL_H, w: THUMB_WIDTH, h: activeThumbHeight }
		    }
		    return null
		  }

		  const visibleFlows = activeFlowId ? flows.filter(f => f.id === activeFlowId) : flows

		  // Edge "ports": every edge endpoint — and the right-side connector ring — gets
		  // its own slot along the card side it touches, ordered by where the other end
		  // of the edge lies. Endpoints therefore never stack on each other or on the
		  // connector. SIDE_DIRS are the outward normals used for bezier control points.
		  const edgePorts = (() => {
		    const SIDE_DIRS: Record<string, { dx: number; dy: number }> = {
		      left: { dx: -1, dy: 0 }, right: { dx: 1, dy: 0 }, top: { dx: 0, dy: -1 }, bottom: { dx: 0, dy: 1 },
		    }
		    const groups: Record<string, Array<{ key: string; sortVal: number }>> = {}
		    const addItem = (pageId: string, side: string, key: string, sortVal: number) => {
		      const gk = pageId + "|" + side
		      if (!groups[gk]) groups[gk] = []
		      groups[gk].push({ key, sortVal })
		    }
		    pages.forEach(p => addItem(p.id, "right", "connector", Infinity))
		    const edges: Array<{ key: string; from: string; to: string; fromSide: string; toSide: string }> = []
		    if (showFlows) {
		      for (const flow of visibleFlows) {
		        for (const step of flow.steps) {
		          const targets = [
		            ...step.next.map(t => ({ to: t, err: "n" })),
		            ...(step.onError || []).map(t => ({ to: t, err: "e" })),
		          ]
		          for (const t of targets) {
		            const fr = getRect(step.page), tr = getRect(t.to)
		            if (!fr || !tr) continue
		            const fcx = fr.x + fr.w / 2, fcy = fr.y + fr.h / 2
		            const tcx = tr.x + tr.w / 2, tcy = tr.y + tr.h / 2
		            const dx = tcx - fcx, dy = tcy - fcy
		            const horizontal = Math.abs(dx) > Math.abs(dy)
		            const fromSide = horizontal ? (dx > 0 ? "right" : "left") : (dy > 0 ? "bottom" : "top")
		            const toSide = horizontal ? (dx > 0 ? "left" : "right") : (dy > 0 ? "top" : "bottom")
		            const key = flow.id + "|" + step.page + "|" + t.to + "|" + t.err
		            edges.push({ key, from: step.page, to: t.to, fromSide, toSide })
		            addItem(step.page, fromSide, key + "|from", horizontal ? tcy : tcx)
		            addItem(t.to, toSide, key + "|to", horizontal ? fcy : fcx)
		          }
		        }
		      }
		    }
		    const portPos: Record<string, { x: number; y: number }> = {}
		    for (const gk of Object.keys(groups)) {
		      const sep = gk.lastIndexOf("|")
		      const rect = getRect(gk.slice(0, sep))
		      if (!rect) continue
		      const side = gk.slice(sep + 1)
		      const items = groups[gk].slice().sort((a, b) => (a.sortVal - b.sortVal) || (a.key < b.key ? -1 : 1))
		      items.forEach((item, i) => {
		        const frac = (i + 1) / (items.length + 1)
		        portPos[gk + "|" + item.key] =
		          side === "left" ? { x: rect.x, y: rect.y + rect.h * frac }
		          : side === "right" ? { x: rect.x + rect.w, y: rect.y + rect.h * frac }
		          : side === "top" ? { x: rect.x + rect.w * frac, y: rect.y }
		          : { x: rect.x + rect.w * frac, y: rect.y + rect.h }
		      })
		    }
		    const anchors: Record<string, { fx: number; fy: number; tx: number; ty: number; fdx: number; fdy: number; tdx: number; tdy: number }> = {}
		    for (const e of edges) {
		      const fp = portPos[e.from + "|" + e.fromSide + "|" + e.key + "|from"]
		      const tp = portPos[e.to + "|" + e.toSide + "|" + e.key + "|to"]
		      if (!fp || !tp) continue
		      anchors[e.key] = {
		        fx: fp.x, fy: fp.y, tx: tp.x, ty: tp.y,
		        fdx: SIDE_DIRS[e.fromSide].dx, fdy: SIDE_DIRS[e.fromSide].dy,
		        tdx: SIDE_DIRS[e.toSide].dx, tdy: SIDE_DIRS[e.toSide].dy,
		      }
		    }
		    const connectors: Record<string, { x: number; y: number }> = {}
		    pages.forEach(p => {
		      const cp = portPos[p.id + "|right|connector"]
		      if (cp) connectors[p.id] = cp
		    })
		    return { anchors, connectors }
		  })()

		  useEffect(() => {
		    fetch("/__caret/canvas-layout")
		      .then(r => r.ok ? r.json() : null)
		      .then(data => {
		        if (data?.mode) setLayoutMode(data.mode)
		        if (data?.positions) setManualPositions(data.positions)
		      })
		      .catch((e) => log("[canvas] canvas-layout.json is unreadable — falling back to auto layout (" + e + ")"))
		  }, [])

		  /**
		   * A pan is a DOM transform, not a React render (Phase 10.7). Committing
		   * every wheel event to state re-renders every artboard on the canvas —
		   * measured at 41ms median frames with 200 of them, and it grows with the
		   * project. The gesture writes the element's transform directly and
		   * commits to state once it settles, which is also what makes the live
		   * set stable during the gesture.
		   */
		  const pendingTransform = useRef(transform)
		  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
		  const applyTransform = useCallback((next: CanvasTransform) => {
		    pendingTransform.current = next
		    const node = contentRef.current
		    if (node) node.style.transform = "translate(" + next.x + "px, " + next.y + "px) scale(" + next.scale + ")"
		    if (commitTimer.current) clearTimeout(commitTimer.current)
		    commitTimer.current = setTimeout(() => setTransform(pendingTransform.current), 140)
		  }, [])
		  useEffect(() => {
		    pendingTransform.current = transform
		  }, [transform])

		  const handleWheel = useCallback((e: React.WheelEvent) => {
		    e.preventDefault()
		    const prev = pendingTransform.current
		    if (e.ctrlKey || e.metaKey) {
		      const rect = containerRef.current?.getBoundingClientRect()
		      if (!rect) return
		      const mx = e.clientX - rect.left
		      const my = e.clientY - rect.top
		      const factor = e.deltaY > 0 ? 0.9 : 1.1
		      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev.scale * factor))
		      const ratio = newScale / prev.scale
		      applyTransform({ x: mx - (mx - prev.x) * ratio, y: my - (my - prev.y) * ratio, scale: newScale })
		    } else {
		      applyTransform({ ...prev, x: prev.x - e.deltaX, y: prev.y - e.deltaY })
		    }
		  }, [applyTransform])

		  const handlePointerDown = useCallback((e: React.PointerEvent) => {
		    if (selectedEdge) setSelectedEdge(null)
		    if (e.button === 1 || (e.button === 0 && e.altKey)) {
		      e.preventDefault()
		      setIsPanning(true)
		      setPanStart({ x: e.clientX, y: e.clientY })
		      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
		    }
		  }, [selectedEdge])

		  const handlePointerMove = useCallback((e: React.PointerEvent) => {
		    if (edgeDrag) {
		      const rect = containerRef.current?.getBoundingClientRect()
		      if (rect) {
		        setEdgeDrag(prev => prev ? { ...prev, mouseX: (e.clientX - rect.left - transform.x) / transform.scale, mouseY: (e.clientY - rect.top - transform.y) / transform.scale } : null)
		      }
		      return
		    }
		    if (dragState) {
		      const dx = (e.clientX - dragState.startX) / transform.scale
		      const dy = (e.clientY - dragState.startY) / transform.scale
		      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD || dragState.moved) {
		        setDragState(prev => prev ? { ...prev, moved: true } : null)
		        setManualPositions(prev => ({
		          ...prev,
		          [dragState.pageId]: { x: dragState.origX + dx, y: dragState.origY + dy / layoutScaleY },
		        }))
		      }
		      return
		    }
		    if (!isPanning) return
		    const dx = e.clientX - panStart.x
		    const dy = e.clientY - panStart.y
		    setPanStart({ x: e.clientX, y: e.clientY })
		    setTransform(prev => ({ ...prev, x: prev.x + dx, y: prev.y + dy }))
		  }, [isPanning, panStart, dragState, transform.scale, edgeDrag, transform.x, transform.y, layoutScaleY])

		  const handlePointerUp = useCallback((e: React.PointerEvent) => {
		    if (edgeDrag) {
		      const rect = containerRef.current?.getBoundingClientRect()
		      if (rect) {
		        const canvasX = (e.clientX - rect.left - transform.x) / transform.scale
		        const canvasY = (e.clientY - rect.top - transform.y) / transform.scale
		        const wrapperHeight = activeThumbHeight + LABEL_H
		        const allPositions = autoItems
		          ? autoItems.map(i => ({ id: i.page.id, x: i.x, y: i.y }))
		          : pages.map(p => ({ id: p.id, ...manualDisplayPositions[p.id] }))
		        const target = allPositions.find(p => p.id !== edgeDrag.fromPage && canvasX >= p.x && canvasX <= p.x + THUMB_WIDTH && canvasY >= p.y && canvasY <= p.y + wrapperHeight)
		        // New edges go to: the reassigned edge's flow, else the legend-selected
		        // flow, else the flow that already contains the source page as a step.
		        const sourceFlow = flows.find(f => f.steps.some(s => s.page === edgeDrag.fromPage))
		        const flowId = edgeDrag.reassignFlowId || activeFlowId || sourceFlow?.id || (flows.length > 0 ? flows[0].id : null)
		        if (target && flowId) {
		          if (edgeDrag.reassignOldTo && edgeDrag.reassignFlowId) {
		            log("[edge-reassign] " + edgeDrag.fromPage + ": " + edgeDrag.reassignOldTo + " → " + target.id + " flow=" + edgeDrag.reassignFlowId)
		            window.parent.postMessage({ source: "caret-vite", type: "flow-edge-update", payload: { flowId: edgeDrag.reassignFlowId, fromPage: edgeDrag.fromPage, oldToPage: edgeDrag.reassignOldTo, newToPage: target.id, isError: edgeDrag.reassignIsError || false } }, "*")
		          } else {
		            log("[edge-create] " + edgeDrag.fromPage + " → " + target.id + " flow=" + flowId)
		            window.parent.postMessage({ source: "caret-vite", type: "flow-edge-create", payload: { flowId, fromPage: edgeDrag.fromPage, toPage: target.id } }, "*")
		          }
		        } else {
		          log("[edge-drag-cancel] from=" + edgeDrag.fromPage + " canvasX=" + canvasX.toFixed(0) + " canvasY=" + canvasY.toFixed(0) + " positions=" + JSON.stringify(allPositions.map(p => p.id + ":" + p.x + "," + p.y).join("|")) + " wH=" + wrapperHeight.toFixed(0))
		        }
		      }
		      setEdgeDrag(null)
		      return
		    }
		    if (dragState?.moved) {
		      saveLayout({ mode: layoutMode, positions: manualPositions })
		    }
		    setDragState(null)
		    setIsPanning(false)
		  }, [dragState, layoutMode, manualPositions, manualDisplayPositions, edgeDrag, transform, autoItems, pages, activeFlowId, flows, activeThumbHeight])

		  const handleThumbPointerDown = useCallback((pageId: string, x: number, y: number, e: React.PointerEvent) => {
		    if (layoutMode !== "manual" || e.button !== 0) return
		    e.stopPropagation()
		    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
		    // x/y arrive in display space; the drag origin is kept in reference space
		    // because drag moves write back into manualPositions (reference space).
		    setDragState({ pageId, startX: e.clientX, startY: e.clientY, origX: x, origY: y / layoutScaleY, moved: false })
		  }, [layoutMode, layoutScaleY])

		  const fitAll = useCallback(() => {
		    if (!containerRef.current || pages.length === 0) return
		    const rect = containerRef.current.getBoundingClientRect()
		    const positioned = layoutMode === "manual"
		      ? pages.map(p => manualDisplayPositions[p.id])
		      : computeAutoPositions(pages, activeThumbHeight).map(item => ({ x: item.x, y: item.y }))
		    const maxX = Math.max(...positioned.map(p => p.x)) + THUMB_WIDTH
		    const maxY = Math.max(...positioned.map(p => p.y)) + activeThumbHeight + LABEL_H
		    const padding = 60
		    const scaleX = (rect.width - padding * 2) / maxX
		    const scaleY = (rect.height - padding * 2) / maxY
		    const scale = Math.min(scaleX, scaleY, 1.5)
		    const x = (rect.width - maxX * scale) / 2
		    const y = (rect.height - maxY * scale) / 2
		    setTransform({ x, y, scale })
		  }, [pages, layoutMode, manualDisplayPositions, activeThumbHeight])

		  useEffect(() => { fitAll() }, [fitAll])

		  useEffect(() => {
		    if (!selectedEdge) return
		    const handleKey = (e: KeyboardEvent) => {
		      if (e.key === "Delete" || e.key === "Backspace") {
		        e.preventDefault()
		        log("[edge-delete] " + selectedEdge.from + " → " + selectedEdge.to + " flow=" + selectedEdge.flowId)
		        window.parent.postMessage({ source: "caret-vite", type: "flow-edge-delete", payload: { flowId: selectedEdge.flowId, fromPage: selectedEdge.from, toPage: selectedEdge.to, isError: selectedEdge.isError || false } }, "*")
		        setSelectedEdge(null)
		      } else if (e.key === "Escape") {
		        setSelectedEdge(null)
		      }
		    }
		    window.addEventListener("keydown", handleKey)
		    return () => window.removeEventListener("keydown", handleKey)
		  }, [selectedEdge])

		  const toggleLayout = useCallback(() => {
		    const newMode = layoutMode === "auto" ? "manual" : "auto"
		    if (newMode === "manual" && Object.keys(manualPositions).length === 0) {
		      const auto = computeAutoPositions(pages, REF_THUMB_HEIGHT)
		      const positions: Record<string, { x: number; y: number }> = {}
		      auto.forEach(item => { positions[item.page.id] = { x: item.x, y: item.y } })
		      setManualPositions(positions)
		      saveLayout({ mode: newMode, positions })
		    } else {
		      saveLayout({ mode: newMode, positions: manualPositions })
		    }
		    setLayoutMode(newMode)
		  }, [layoutMode, manualPositions, pages])

		  React.useEffect(() => {
		    log("[canvas] viewport=" + viewport + " activeFrameWidth=" + activeFrameWidth + " activeThumbHeight=" + activeThumbHeight.toFixed(0))
		  }, [viewport, activeFrameWidth])

		  // The simulation entry point is the page no flow edge points to (the flow root).
		  // Cyclic flows have no root, so fall back to the first step, then the first page.
		  const getSimStartPage = (): string | null => {
		    const pageExists = (id: string) => pages.some(p => p.id === id && !p.broken)
		    const candidateFlows = activeFlowId ? flows.filter(f => f.id === activeFlowId) : flows
		    const targets = new Set<string>()
		    for (const flow of candidateFlows) {
		      for (const step of flow.steps) {
		        step.next.forEach(t => targets.add(t))
		        ;(step.onError || []).forEach(t => targets.add(t))
		      }
		    }
		    for (const flow of candidateFlows) {
		      const root = flow.steps.find(s => !targets.has(s.page) && pageExists(s.page))
		      if (root) return root.page
		    }
		    for (const flow of candidateFlows) {
		      const first = flow.steps.find(s => pageExists(s.page))
		      if (first) return first.page
		    }
		    return pages.length > 0 ? pages[0].id : null
		  }

		  // Visible reliability signals: corrupt flow files and edges referencing
		  // pages that no longer exist. Shown even when the flows overlay is hidden,
		  // so bad AI output never just silently disappears.
		  const invalidFlows = flows.filter(f => f.invalid)
		  const missingEdgeCount = (() => {
		    const pageIds = new Set(pages.map(p => p.id))
		    let count = 0
		    for (const flow of flows) {
		      if (flow.invalid) continue
		      for (const step of flow.steps) {
		        for (const t of [...step.next, ...(step.onError || [])]) {
		          if (!pageIds.has(step.page) || !pageIds.has(t)) count++
		        }
		      }
		    }
		    return count
		  })()

		  if (pages.length === 0) {
		    return (
		      <div className="caret-canvas-empty">
		        <div className="caret-canvas-empty-icon">◇</div>
		        <h2>No pages yet</h2>
		        <p>Use Caret in design mode to create pages.</p>
		      </div>
		    )
		  }

		  return (
		    <div
		      ref={containerRef}
		      className="caret-canvas-container"
		      onWheel={handleWheel}
		      onPointerDown={handlePointerDown}
		      onPointerMove={handlePointerMove}
		      onPointerUp={handlePointerUp}
		      style={{ cursor: isPanning ? "grabbing" : dragState ? "grabbing" : "default" }}
		    >
		      {showFlows && flows.length > 0 && (
		        <div className="caret-flow-legend">
		          {flows.map((flow, i) => (
		            flow.invalid ? (
		              <span key={flow.id} className="caret-flow-legend-item invalid" title={flow.error || "Invalid flow file"}>
		                <span className="caret-flow-legend-warn">⚠</span>
		                {flow.name}
		              </span>
		            ) : (
		              <span key={flow.id} className={"caret-flow-legend-item" + (activeFlowId === flow.id ? " active" : "")} onClick={() => setActiveFlowId(activeFlowId === flow.id ? null : flow.id)}>
		                <span className="caret-flow-legend-dot" style={{ background: ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#a855f7"][i % 5] }} />
		                {flow.name}
		              </span>
		            )
		          ))}
		        </div>
		      )}
		      <div className="caret-canvas-toolbar">
		        <button onClick={fitAll} className="caret-tb-btn" title="Fit all">
		          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5"/><rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5"/><rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5"/><rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5"/></svg>
		        </button>
		        <button onClick={toggleLayout} className={"caret-tb-btn" + (layoutMode === "manual" ? " active" : "")} title={layoutMode === "auto" ? "Switch to manual layout" : "Switch to auto layout"}>
		          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v4M6 4h4M3 8h10M3 8c-1 0-1.5.5-1.5 1.5S2.5 11 3 12M13 8c1 0 1.5.5 1.5 1.5S13.5 11 13 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
		        </button>
		        <div className="caret-tb-sep" />
		        <button onClick={() => onSetViewport("desktop-1440")} className={"caret-tb-btn" + (viewport === "desktop-1440" ? " active" : "")} title="Desktop 1440">
		          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="2" width="14" height="10" rx="1" stroke="currentColor" strokeWidth="1.5"/><path d="M5 14h6M8 12v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
		        </button>
		        <button onClick={() => onSetViewport("desktop-1280")} className={"caret-tb-btn" + (viewport === "desktop-1280" ? " active" : "")} title="Laptop 1280">
		          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="8" rx="1" stroke="currentColor" strokeWidth="1.5"/><path d="M1 13h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
		        </button>
		        <button onClick={() => onSetViewport("tablet-768")} className={"caret-tb-btn" + (viewport === "tablet-768" ? " active" : "")} title="Tablet 768">
		          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="3" y="1" width="10" height="14" rx="2" stroke="currentColor" strokeWidth="1.5"/><circle cx="8" cy="13" r="0.5" fill="currentColor"/></svg>
		        </button>
		        <button onClick={() => onSetViewport("mobile-390")} className={"caret-tb-btn" + (viewport === "mobile-390" ? " active" : "")} title="Mobile 390">
		          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="4" y="1" width="8" height="14" rx="2" stroke="currentColor" strokeWidth="1.5"/><path d="M7 13h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
		        </button>
		        <div className="caret-tb-sep" />
		        {flows.length > 0 && (
		          <button onClick={() => setShowFlows(!showFlows)} className={"caret-tb-btn" + (showFlows ? " active" : "")} title={showFlows ? "Hide flows" : "Show flows"}>
		            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 8h4M10 8h4M8 4v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><path d="M6 8l2-2 2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
		          </button>
		        )}
		        <div className="caret-tb-sep" />
		        <button onClick={() => window.parent.postMessage({ source: "caret-vite", type: "design-sync-now", payload: {} }, "*")} className="caret-tb-btn" title="Sync design to app">
		          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><path d="M13.5 2.5v3h-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
		        </button>
		        <button onClick={() => { const start = getSimStartPage(); if (start) onSimulate(start) }} className="caret-tb-btn" title="Simulate">
		          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M5 3l8 5-8 5V3z" fill="currentColor"/></svg>
		        </button>
		        <button onClick={onExplore} className="caret-tb-btn" data-testid="explore-enter" title="Playground — explore a page that doesn't exist yet">
		          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 2h4M7 2v4.5L3.5 12a2 2 0 0 0 1.8 3h5.4a2 2 0 0 0 1.8-3L9 6.5V2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M5 11h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
		        </button>
		        <span className="caret-canvas-zoom-label">{Math.round(transform.scale * 100)}%</span>
		      </div>
		      {(invalidFlows.length > 0 || missingEdgeCount > 0) && (
		        <div className="caret-canvas-warnings" title={invalidFlows.map(f => f.name + ": " + (f.error || "invalid")).join("; ")}>
		          ⚠ {[
		            invalidFlows.length > 0 ? invalidFlows.length + " invalid flow file" + (invalidFlows.length > 1 ? "s" : "") + " in .caret/flows/" : null,
		            missingEdgeCount > 0 ? missingEdgeCount + " flow edge" + (missingEdgeCount > 1 ? "s" : "") + " reference missing pages" : null,
		          ].filter(Boolean).join(" · ")}
		        </div>
		      )}
		      {checkCount > 0 && (
		        <div className="caret-canvas-checks" data-testid="design-checks-chip" onClick={() => setShowChecks(!showChecks)}>
		          ✓ {checkCount} design check finding{checkCount === 1 ? "" : "s"} — click for details
		        </div>
		      )}
		      {showChecks && checkCount > 0 && (
		        <div className="caret-canvas-checks-panel" data-testid="design-checks-panel">
		          {checkResults.map(p => (
		            <React.Fragment key={p.pageId}>
		              <h4>{p.pageId}</h4>
		              <ul style={{ margin: 0, padding: 0 }}>
		                {p.findings.map((f, i) => (
		                  <li key={i} className={"check-" + f.severity}>{f.message} <span style={{ opacity: 0.6 }}>({f.check})</span></li>
		                ))}
		              </ul>
		            </React.Fragment>
		          ))}
		        </div>
		      )}
		      <div
		        ref={contentRef}
		        className="caret-canvas-content"
		        style={{
		          transform: \`translate(\${transform.x}px, \${transform.y}px) scale(\${transform.scale})\`,
		          transformOrigin: "0 0",
		        }}
		      >
		        {autoItems ? (
		          autoItems.map(({ page, x, y, groupTag }) => {
		            const hasRoute = routes.some(r => r.name === page.id)
		            const conn = edgePorts.connectors[page.id] || { x: x + THUMB_WIDTH, y: y + LABEL_H + activeThumbHeight / 2 }
		            return (
		              <React.Fragment key={page.id}>
		                {groupTag && (
		                  <div className="caret-canvas-group-header" style={{ position: "absolute", left: 0, top: y - GROUP_HEADER_HEIGHT, width: COLS * (THUMB_WIDTH + GAP) }}>
		                    {groupTag}
		                  </div>
		                )}
		                <div className={"caret-canvas-thumb-wrapper" + entering(page.id)} style={{ position: "absolute", left: x, top: y }}>
		                  {page.broken
		                    ? <BrokenPageCard pageId={page.id} title={page.title || page.id} thumbWidth={THUMB_WIDTH} thumbHeight={activeThumbHeight} />
		                    : <PageThumbnail pageId={page.id} title={page.title || page.id} tags={page.tags || []} frameWidth={activeFrameWidth} frameHeight={FRAME_HEIGHT} thumbWidth={THUMB_WIDTH} live={isLive(x, y)} onClick={hasRoute ? () => onFocus(page.id) : undefined} />}
		                  {showFlows && (
		                    <div className="caret-edge-connector" style={{ top: conn.y - y }} onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); log("[edge-drag-start] from=" + page.id); setEdgeDrag({ fromPage: page.id, mouseX: conn.x, mouseY: conn.y, originX: conn.x, originY: conn.y }) }} />
		                  )}
		                </div>
		              </React.Fragment>
		            )
		          })
		        ) : (
		          pages.map((page) => {
		            const pos = manualDisplayPositions[page.id]
		            const hasRoute = routes.some(r => r.name === page.id)
		            const conn = edgePorts.connectors[page.id] || { x: pos.x + THUMB_WIDTH, y: pos.y + LABEL_H + activeThumbHeight / 2 }
		            return (
		              <div
		                key={page.id}
		                className={"caret-canvas-thumb-wrapper" + entering(page.id) + (dragState?.pageId === page.id ? " dragging" : "")}
		                style={{ position: "absolute", left: pos.x, top: pos.y }}
		                onPointerDown={(e) => handleThumbPointerDown(page.id, pos.x, pos.y, e)}
		              >
		                {page.broken
		                  ? <BrokenPageCard pageId={page.id} title={page.title || page.id} thumbWidth={THUMB_WIDTH} thumbHeight={activeThumbHeight} />
		                  : <PageThumbnail pageId={page.id} title={page.title || page.id} tags={page.tags || []} frameWidth={activeFrameWidth} frameHeight={FRAME_HEIGHT} thumbWidth={THUMB_WIDTH}
		                      live={isLive(pos.x, pos.y)}
		                      onClick={hasRoute && !dragState?.moved ? () => onFocus(page.id) : undefined} />}
		                {showFlows && (
		                  <div className="caret-edge-connector" style={{ top: conn.y - pos.y }} onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); log("[edge-drag-start] from=" + page.id); setEdgeDrag({ fromPage: page.id, mouseX: conn.x, mouseY: conn.y, originX: conn.x, originY: conn.y }) }} />
		                )}
		              </div>
		            )
		          })
		        )}
		        {showFlows && flows.length > 0 && (() => {
		          const FLOW_COLORS = ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#a855f7"]
		          // Anchors come from the shared port distribution (edgePorts) so endpoints
		          // never collide with each other or the connector ring. The outward unit
		          // vectors (fdx/fdy, tdx/tdy) make the bezier end tangent enter the
		          // destination, keeping orient="auto" arrowheads pointing forward.
		          const getEdgeAnchors = (flowId: string, fromId: string, toId: string, err: string) =>
		            edgePorts.anchors[flowId + "|" + fromId + "|" + toId + "|" + err] || null
		          const makePath = (a: { fx: number; fy: number; tx: number; ty: number; fdx: number; fdy: number; tdx: number; tdy: number }) => {
		            const dist = Math.sqrt((a.tx - a.fx) ** 2 + (a.ty - a.fy) ** 2)
		            const cp = Math.max(20, Math.min(dist * 0.4, 150))
		            return "M " + a.fx + " " + a.fy + " C " + (a.fx + a.fdx * cp) + " " + (a.fy + a.fdy * cp) + ", " + (a.tx + a.tdx * cp) + " " + (a.ty + a.tdy * cp) + ", " + a.tx + " " + a.ty
		          }
		          return (
		            <svg className="caret-canvas-flow-overlay" style={{ width: 10000, height: 10000 }}>
		              {/* userSpaceOnUse keeps arrows a fixed size (no stroke-width scaling);
		                  refX=21 parks the tip 7px short of the endpoint, on the rim of the r=7 dot. */}
		              <defs>
		                {flows.map((flow, i) => (
		                  <marker key={flow.id} id={"caret-arrow-" + flow.id} markerWidth="14" markerHeight="10" refX="21" refY="5" orient="auto" markerUnits="userSpaceOnUse">
		                    <polygon points="0 0, 14 5, 0 10" fill={FLOW_COLORS[i % 5]} />
		                  </marker>
		                ))}
		                <marker id="caret-arrow-error" markerWidth="14" markerHeight="10" refX="21" refY="5" orient="auto" markerUnits="userSpaceOnUse">
		                  <polygon points="0 0, 14 5, 0 10" fill="#ef4444" />
		                </marker>
		              </defs>
		              {visibleFlows.map((flow, fi) => {
		                const color = FLOW_COLORS[flows.indexOf(flow) % 5]
		                return flow.steps.flatMap(step => {
		                  const nextEdges = step.next.map(nextPage => {
		                    const anchors = getEdgeAnchors(flow.id, step.page, nextPage, "n")
		                    if (!anchors) return null
		                    const d = makePath(anchors)
		                    const isSelected = selectedEdge?.flowId === flow.id && selectedEdge?.from === step.page && selectedEdge?.to === nextPage
		                    return <g key={flow.id + "-" + step.page + "-" + nextPage}>
		                      <path d={d} stroke="transparent" strokeWidth={14} fill="none" style={{ cursor: "pointer", pointerEvents: "stroke" }} onClick={(e) => { e.stopPropagation(); log("[edge-select] " + step.page + " → " + nextPage + " flow=" + flow.id); setSelectedEdge({ flowId: flow.id, from: step.page, to: nextPage, isError: false }) }} />
		                      <path d={d} stroke={isSelected ? "#fff" : color} strokeWidth={isSelected ? 3 : 2} fill="none" opacity={isSelected ? 1 : 0.7} markerEnd={"url(#caret-arrow-" + flow.id + ")"} style={{ pointerEvents: "none" }} />
		                      <circle cx={anchors.tx} cy={anchors.ty} r={7} fill={isSelected ? "#fff" : color} stroke={isSelected ? color : "#0a0a0a"} strokeWidth={2} style={{ cursor: "grab", pointerEvents: "all" }} onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); log("[edge-reassign-start] " + step.page + " → " + nextPage + " flow=" + flow.id); setEdgeDrag({ fromPage: step.page, mouseX: anchors.tx, mouseY: anchors.ty, originX: anchors.fx, originY: anchors.fy, reassignFlowId: flow.id, reassignOldTo: nextPage, reassignIsError: false }) }} />
		                    </g>
		                  })
		                  const errorEdges = (step.onError || []).map(errorPage => {
		                    const anchors = getEdgeAnchors(flow.id, step.page, errorPage, "e")
		                    if (!anchors) return null
		                    const d = makePath(anchors)
		                    const isSelected = selectedEdge?.flowId === flow.id && selectedEdge?.from === step.page && selectedEdge?.to === errorPage
		                    return <g key={flow.id + "-error-" + step.page + "-" + errorPage}>
		                      <path d={d} stroke="transparent" strokeWidth={14} fill="none" style={{ cursor: "pointer", pointerEvents: "stroke" }} onClick={(e) => { e.stopPropagation(); setSelectedEdge({ flowId: flow.id, from: step.page, to: errorPage, isError: true }) }} />
		                      <path d={d} stroke={isSelected ? "#fff" : "#ef4444"} strokeWidth={isSelected ? 3 : 2} fill="none" opacity={isSelected ? 1 : 0.7} strokeDasharray="6 3" markerEnd="url(#caret-arrow-error)" style={{ pointerEvents: "none" }} />
		                      <circle cx={anchors.tx} cy={anchors.ty} r={7} fill={isSelected ? "#fff" : "#ef4444"} stroke="#0a0a0a" strokeWidth={2} style={{ cursor: "grab", pointerEvents: "all" }} onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); log("[edge-reassign-start] " + step.page + " → " + errorPage + " flow=" + flow.id + " (error)"); setEdgeDrag({ fromPage: step.page, mouseX: anchors.tx, mouseY: anchors.ty, originX: anchors.fx, originY: anchors.fy, reassignFlowId: flow.id, reassignOldTo: errorPage, reassignIsError: true }) }} />
		                    </g>
		                  })
		                  return [...nextEdges, ...errorEdges]
		                })
		              })}
		              {edgeDrag && (
		                <line x1={edgeDrag.originX} y1={edgeDrag.originY} x2={edgeDrag.mouseX} y2={edgeDrag.mouseY} stroke="#3b82f6" strokeWidth={2} strokeDasharray="6 3" opacity={0.8} style={{ pointerEvents: "none" }} />
		              )}
		            </svg>
		          )
		        })()}
		      </div>
		    </div>
		  )
		}
	`
}

function generatePageThumbnail(): string {
	return dedent`
		import React from "react"

		interface Props {
		  pageId: string
		  title: string
		  tags: string[]
		  frameWidth: number
		  frameHeight: number
		  thumbWidth: number
		  onClick?: () => void
		  /** Near enough to the viewport to be worth a live iframe (Phase 10.7). */
		  live?: boolean
		}

		export function BrokenPageCard({ pageId, title, thumbWidth, thumbHeight }: { pageId: string; title: string; thumbWidth: number; thumbHeight: number }) {
		  return (
		    <div className="caret-canvas-frame">
		      <div className="caret-canvas-frame-label">
		        <span className="caret-canvas-frame-title">{title}</span>
		        <div className="caret-canvas-frame-tags">
		          <span className="caret-canvas-frame-tag broken">broken</span>
		        </div>
		      </div>
		      <div className="caret-canvas-frame-viewport caret-canvas-frame-broken" style={{ width: thumbWidth, height: thumbHeight }}>
		        <div className="caret-canvas-frame-broken-inner">
		          <div className="caret-canvas-frame-broken-icon">⚠</div>
		          <div>pages/{pageId}/index.tsx is missing or invalid</div>
		          <div className="caret-canvas-frame-broken-hint">Fix or regenerate this page</div>
		        </div>
		      </div>
		    </div>
		  )
		}

		export function PageThumbnail({ pageId, title, tags, frameWidth, frameHeight, thumbWidth, onClick, live = true }: Props) {
		  const scale = thumbWidth / frameWidth
		  const thumbHeight = frameHeight * scale

		  // Virtualized (Phase 10.7): liveness is decided by the CANVAS, which knows
		  // both the card's position and the pan/zoom transform — plain geometry,
		  // no observer. IntersectionObserver was tried first and reported every
		  // card as intersecting inside the transformed, overflow-hidden canvas
		  // (measured: 209 live iframes for 209 cards), so the canvas computes it
		  // instead of asking the browser.
		  const near = live

		  React.useEffect(() => {
		    window.parent.postMessage({ source: "caret-vite", type: "log", payload: { message: "[thumb] " + pageId + " frameWidth=" + frameWidth + " scale=" + scale.toFixed(4) + " thumbHeight=" + thumbHeight.toFixed(1) } }, "*")
		  }, [pageId, frameWidth])

		  return (
		    <div className="caret-canvas-frame" onClick={onClick} style={{ cursor: onClick ? "pointer" : "default" }}>
		      <div className="caret-canvas-frame-label">
		        <span className="caret-canvas-frame-title">{title}</span>
		        {tags.length > 0 && (
		          <div className="caret-canvas-frame-tags">
		            {tags.slice(0, 3).map(tag => (
		              <span key={tag} className="caret-canvas-frame-tag">{tag}</span>
		            ))}
		          </div>
		        )}
		      </div>
		      <div className="caret-canvas-frame-viewport" style={{ width: thumbWidth, height: thumbHeight }}>
		        {near ? (
		          <iframe
		            src={\`/?page=\${encodeURIComponent(pageId)}\`}
		            className="caret-canvas-frame-iframe"
		            title={title}
		            style={{
		              width: frameWidth,
		              height: frameHeight,
		              transform: \`scale(\${scale})\`,
		            }}
		            tabIndex={-1}
		          />
		        ) : (
		          <div className="caret-canvas-frame-placeholder" style={{ width: thumbWidth, height: thumbHeight, background: "linear-gradient(135deg, #1b1b26, #14141d)" }} />
		        )}
		      </div>
		    </div>
		  )
		}
	`
}

function generateFocusedPageView(): string {
	return dedent`
		import React, { useRef, useEffect } from "react"
		import type { ViewportPreset } from "./types"
		import { VIEWPORT_PRESETS } from "./types"

		interface Props {
		  pageId: string
		  title: string
		  tags: string[]
		  states: string[]
		  onBack: () => void
		  onSimulate: () => void
		  onExplore: () => void
		  viewport: ViewportPreset
		  onSetViewport: (v: ViewportPreset) => void
		}

		export function FocusedPageView({ pageId, title, states, onBack, onSimulate, onExplore, viewport, onSetViewport }: Props) {
		  const iframeRef = useRef<HTMLIFrameElement>(null)
		  const preset = VIEWPORT_PRESETS[viewport]

		  useEffect(() => {
		    const log = (msg: string) => window.parent.postMessage({ source: "caret-vite", type: "log", payload: { message: msg } }, "*")
		    log("[focused] mounted pageId=" + pageId + " viewport=" + viewport + " preset.width=" + preset.width + "px (this is the iframe inline width)")
		    const iframe = iframeRef.current
		    if (iframe) {
		      const computed = window.getComputedStyle(iframe)
		      log("[focused] iframe computedWidth=" + computed.width + " computedMaxWidth=" + computed.maxWidth + " containerWidth=" + iframe.parentElement?.getBoundingClientRect().width)
		    }
		    const handler = (e: MessageEvent) => {
		      const iframe = iframeRef.current
		      if (!iframe?.contentWindow) return

		      if (e.data?.source === "caret-vite" && e.source === iframe.contentWindow) {
		        // Forward up only when there IS an up. In the VS Code webview the
		        // canvas was itself an iframe, so this hop carried the message to the
		        // host. In the desktop app the canvas is the top-level document —
		        // window.parent === window — and re-posting here lands the message
		        // back on this same window, where the preload forwards it to main a
		        // SECOND time. Every inline edit then applied twice: the first write
		        // succeeded, the duplicate hit the raw text fallback, and because the
		        // old text was a prefix of the new one, "lane" -> "lanes" became
		        // "laness". The original event already reaches every listener on this
		        // window (including the preload), so at top level there is nothing to
		        // relay to.
		        if (window.parent !== window) {
		          log("relay: iframe->parent type=" + e.data.type)
		          window.parent.postMessage(e.data, "*")
		        }
		        return
		      }

		      if (e.data?.source === "caret-host") {
		        log("relay: parent->iframe type=" + e.data.type)
		        iframe.contentWindow.postMessage(e.data, "*")
		        return
		      }

		      if (e.data?.source === "caret-page-iframe" && e.source === iframe.contentWindow) {
		        log("relay: iframe control: " + e.data.type)
		        if (e.data.type === "back") onBack()
		        if (e.data.type === "simulate") onSimulate()
		        return
		      }
		    }

		    window.addEventListener("message", handler)
		    return () => window.removeEventListener("message", handler)
		  }, [onBack, onSimulate])

		  useEffect(() => {
		    const vlog = (msg: string) => window.parent.postMessage({ source: "caret-vite", type: "log", payload: { message: msg } }, "*")
		    vlog("[focused] viewport changed to " + viewport + " preset.width=" + preset.width)
		    const iframe = iframeRef.current
		    if (iframe) {
		      requestAnimationFrame(() => {
		        const rect = iframe.getBoundingClientRect()
		        vlog("[focused] after viewport change: iframe actual rendered width=" + rect.width + " height=" + rect.height)
		      })
		    }
		  }, [viewport, preset.width])

		  return (
		    <div className="caret-focused-shell">
		      <div className="caret-focused-toolbar">
		        <button onClick={onBack} className="caret-focused-toolbar-btn" title="Back to canvas">←</button>
		        <span className="caret-focused-toolbar-title">{title}</span>
		        <div className="caret-focused-viewport-selector">
		          {(Object.entries(VIEWPORT_PRESETS) as [ViewportPreset, { name: string; width: number; icon: string }][]).map(([key, p]) => (
		            <button key={key} onClick={() => { onSetViewport(key); window.parent.postMessage({ source: "caret-vite", type: "log", payload: { message: "[focused] viewport button clicked: " + key + " width=" + p.width } }, "*") }} className={"caret-focused-toolbar-btn" + (viewport === key ? " active" : "")} title={p.name}>
		              {p.icon} {p.width}
		            </button>
		          ))}
		        </div>
		        <button onClick={onExplore} className="caret-focused-toolbar-btn" data-testid="explore-enter-focused" title="Experiment with this page in the playground">⚗ Experiment</button>
		      </div>
		      <div className="caret-focused-iframe-container">
		        <iframe
		          ref={iframeRef}
		          src={"/?page=" + encodeURIComponent(pageId) + "&mode=focused"}
		          className="caret-focused-iframe"
		          style={{ width: preset.width }}
		          title={title}
		        />
		      </div>
		    </div>
		  )
		}
	`
}

function generateErrorBoundary(): string {
	return dedent`
		import React from "react"

		interface Props {
		  children: React.ReactNode
		  fallback: React.ReactNode
		}

		interface State {
		  hasError: boolean
		}

		export class ErrorBoundary extends React.Component<Props, State> {
		  constructor(props: Props) {
		    super(props)
		    this.state = { hasError: false }
		  }

		  static getDerivedStateFromError(): State {
		    return { hasError: true }
		  }

		  componentDidCatch(error: Error, info: React.ErrorInfo) {
		    console.error("Canvas error boundary caught:", error, info.componentStack)
		  }

		  render() {
		    if (this.state.hasError) return this.props.fallback
		    return this.props.children
		  }
		}
	`
}

function generateCaretStateContext(): string {
	return dedent`
		import React, { createContext, useContext } from "react"

		const CaretStateContext = createContext<string>("default")

		export function CaretStateProvider({ value, children }: { value: string; children: React.ReactNode }) {
		  return <CaretStateContext.Provider value={value}>{children}</CaretStateContext.Provider>
		}

		export function useCaretState() {
		  return useContext(CaretStateContext)
		}
	`
}

function generateCaretNavigator(): string {
	return dedent`
		import { useState, useCallback } from "react"

		export function useCaretNavigator(initialPageId: string) {
		  const [history, setHistory] = useState<string[]>([initialPageId])
		  const [historyIndex, setHistoryIndex] = useState(0)

		  const currentPageId = history[historyIndex]

		  const navigate = useCallback((pageId: string) => {
		    window.parent.postMessage({ source: "caret-sim-navigate", pageId }, "*")
		    setHistory(prev => [...prev.slice(0, historyIndex + 1), pageId])
		    setHistoryIndex(prev => prev + 1)
		  }, [historyIndex])

		  const goBack = useCallback(() => {
		    if (historyIndex > 0) setHistoryIndex(prev => prev - 1)
		  }, [historyIndex])

		  const goForward = useCallback(() => {
		    if (historyIndex < history.length - 1) setHistoryIndex(prev => prev + 1)
		  }, [historyIndex])

		  const canGoBack = historyIndex > 0
		  const canGoForward = historyIndex < history.length - 1

		  return { currentPageId, navigate, goBack, goForward, canGoBack, canGoForward }
		}
	`
}

function generateSimulationView(): string {
	return dedent`
		import React, { useRef, useEffect } from "react"
		import { useCaretNavigator } from "./CaretNavigator"
		import type { ViewportPreset, PageInfo } from "./types"
		import { VIEWPORT_PRESETS } from "./types"

		interface Props {
		  initialPageId: string
		  pages: PageInfo[]
		  viewport: ViewportPreset
		  onSetViewport: (v: ViewportPreset) => void
		  onExit: () => void
		}

		export function SimulationView({ initialPageId, pages, viewport, onSetViewport, onExit }: Props) {
		  const { currentPageId, navigate, goBack, goForward, canGoBack, canGoForward } = useCaretNavigator(initialPageId)
		  const iframeRef = useRef<HTMLIFrameElement>(null)
		  const preset = VIEWPORT_PRESETS[viewport]
		  const currentPage = pages.find(p => p.id === currentPageId)

		  const simLog = (msg: string) => window.parent.postMessage({ source: "caret-vite", type: "log", payload: { message: msg } }, "*")

		  useEffect(() => {
		    simLog("[sim] SimulationView mounted, listening for caret-sim-navigate. initialPageId=" + initialPageId)
		    const handler = (e: MessageEvent) => {
		      if (e.data?.source === "caret-sim-navigate") {
		        simLog("[sim] received caret-sim-navigate, navigating to: " + e.data.pageId)
		        navigate(e.data.pageId)
		      }
		    }
		    window.addEventListener("message", handler)
		    return () => window.removeEventListener("message", handler)
		  }, [navigate])

		  return (
		    <div className="caret-simulation-shell">
		      <div className="caret-simulation-toolbar">
		        <button onClick={onExit} className="caret-sim-btn" title="Exit simulation">✕</button>
		        <button onClick={goBack} className="caret-sim-btn" disabled={!canGoBack} title="Back">←</button>
		        <button onClick={goForward} className="caret-sim-btn" disabled={!canGoForward} title="Forward">→</button>
		        <span className="caret-sim-page-label">{currentPage?.title || currentPageId}</span>
		        <div className="caret-sim-viewport-selector">
		          {(Object.entries(VIEWPORT_PRESETS) as [ViewportPreset, { name: string; width: number; icon: string }][]).map(([key, p]) => (
		            <button key={key} onClick={() => onSetViewport(key)} className={"caret-sim-btn" + (viewport === key ? " active" : "")} title={p.name}>
		              {p.icon} {p.width}
		            </button>
		          ))}
		        </div>
		      </div>
		      <div className="caret-simulation-content">
		        {simLog("[sim] device frame: viewport=" + viewport + " width=" + preset.width + " (no maxWidth clamp)")}
		        <div className="caret-simulation-device-frame" style={{ width: preset.width }}>
		          <iframe
		            ref={iframeRef}
		            key={currentPageId}
		            src={"/?page=" + encodeURIComponent(currentPageId)}
		            className="caret-simulation-iframe"
		            title={currentPage?.title || currentPageId}
		          />
		        </div>
		      </div>
		    </div>
		  )
		}
	`
}

function generateOverlayPainter(): string {
	return dedent`
		import React, { useState, useRef, useCallback } from "react"
		import { domToCanvas } from "modern-screenshot"
		import { bridge } from "../bridge"
		import { ackEdit } from "../edit-pill"
		import { attachAssetPicker } from "../asset-picker"

		interface Props {
		  onClose: () => void
		}

		export function OverlayPainter({ onClose }: Props) {
		  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
		  const [drawing, setDrawing] = useState(false)
		  const [instruction, setInstruction] = useState("")
		  const [sending, setSending] = useState(false)
		  const startRef = useRef({ x: 0, y: 0 })
		  const detachPicker = useRef<null | (() => void)>(null)

		  // Attached to the element rather than reimplemented in React state: the
		  // AI-edit box is react-grab's and cannot be a component, and one @ that
		  // behaves differently per surface is worse than none.
		  //
		  // A callback ref rather than an effect, because the input mounts on a
		  // condition no effect dependency here describes: the rect exists while
		  // the pointer is still dragging, and the prompt box only appears once
		  // the drag finishes. An effect keyed on the rect fired too early and
		  // attached to nothing.
		  const inputRef = useCallback((el: HTMLInputElement | null) => {
		    detachPicker.current?.()
		    detachPicker.current = el ? attachAssetPicker(el) : null
		  }, [])

		  const handlePointerDown = useCallback((e: React.PointerEvent) => {
		    if ((e.target as HTMLElement).closest(".caret-overlay-prompt")) return
		    setDrawing(true)
		    startRef.current = { x: e.clientX, y: e.clientY }
		    setRect(null)
		    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
		  }, [])

		  const handlePointerMove = useCallback((e: React.PointerEvent) => {
		    if (!drawing) return
		    const x = Math.min(startRef.current.x, e.clientX)
		    const y = Math.min(startRef.current.y, e.clientY)
		    const w = Math.abs(e.clientX - startRef.current.x)
		    const h = Math.abs(e.clientY - startRef.current.y)
		    setRect({ x, y, w, h })
		  }, [drawing])

		  const handlePointerUp = useCallback(() => {
		    setDrawing(false)
		  }, [])

		  const handleSubmit = useCallback(async () => {
		    if (!rect || !instruction.trim()) return
		    setSending(true)

		    try {
		      const focusedPage = (window as any).__CARET_FOCUSED_PAGE__
		      let screenshotDataUrl = ""

		      try {
		        // modern-screenshot rasterizes via SVG foreignObject — the browser's
		        // own engine does the layout/painting, so modern CSS (cascade layers,
		        // nesting, oklch) renders exactly like the live page. Its predecessor
		        // html2canvas re-parsed CSS itself and mangled Tailwind v4 output,
		        // shifting content relative to the user's crop.
		        // The focused page scrolls inside a fixed .caret-focused container, so
		        // window.scrollY is always 0 — the real scroll is on that container.
		        // Capture the full-height CONTENT element and translate the painted
		        // (viewport) rect into its coordinate space via its bounding rect, which
		        // is correct no matter which ancestor actually scrolls.
		        const captureEl = (document.querySelector(".caret-focused-content") as HTMLElement) || document.documentElement
		        const fullW = Math.max(captureEl.scrollWidth, captureEl.clientWidth)
		        const fullH = Math.max(captureEl.scrollHeight, captureEl.clientHeight)
		        const pageCanvas = await domToCanvas(captureEl, {
		          width: fullW,
		          height: fullH,
		          scale: 1,
		          filter: (node: Node) => {
		            const el = node as Element
		            // Caret's own chrome must never appear in the screenshot the agent
		            // is asked to reproduce — including the edit pill, which by the
		            // second overlay edit of a session is still on screen.
		            if (el.hasAttribute && el.hasAttribute("data-caret-edit-pill")) return false
		            return !(el.classList && (el.classList.contains("caret-overlay") || el.classList.contains("caret-focused-fab")))
		          },
		        })

		        const cropCanvas = document.createElement("canvas")
		        cropCanvas.width = rect.w
		        cropCanvas.height = rect.h
		        const cropCtx = cropCanvas.getContext("2d")
		        if (!cropCtx) throw new Error("Failed to get crop canvas context")
		        // rect is viewport/client coords; subtract the capture element's current
		        // viewport position to get coords within the full-content canvas.
		        const captureRect = captureEl.getBoundingClientRect()
		        cropCtx.drawImage(pageCanvas, rect.x - captureRect.left, rect.y - captureRect.top, rect.w, rect.h, 0, 0, rect.w, rect.h)

		        screenshotDataUrl = cropCanvas.toDataURL("image/png")
		      } catch (captureErr: any) {
		        bridge.send({ type: "log", payload: { level: "error", message: "[caret] Screenshot capture failed: " + (captureErr?.message || captureErr) } })
		      }

		      // Measure what is under the painted region. The model does move/align
		      // arithmetic on these rects instead of eyeballing the crop — rects are
		      // crop-local (origin at the painted rect) so they map 1:1 onto the
		      // screenshot's pixels. Best-effort: a page that throws mid-measure
		      // still sends a usable instruction.
		      let elements: any[] = []
		      try {
		        const scope = (document.querySelector(".caret-focused-content") as HTMLElement) || document.documentElement
		        const hits: Array<{ overlap: number; info: any }> = []
		        scope.querySelectorAll("[data-caret-id]").forEach((el) => {
		          const r = el.getBoundingClientRect()
		          const ox = Math.max(0, Math.min(r.right, rect.x + rect.w) - Math.max(r.left, rect.x))
		          const oy = Math.max(0, Math.min(r.bottom, rect.y + rect.h) - Math.max(r.top, rect.y))
		          if (ox <= 0 || oy <= 0 || r.width <= 0 || r.height <= 0) return
		          const info: any = {
		            caretId: el.getAttribute("data-caret-id"),
		            tag: el.tagName.toLowerCase(),
		            rect: {
		              x: Math.round(r.left - rect.x),
		              y: Math.round(r.top - rect.y),
		              width: Math.round(r.width),
		              height: Math.round(r.height),
		            },
		          }
		          const src = el.tagName === "IMG" ? el.getAttribute("src") : null
		          if (src) info.src = src
		          hits.push({ overlap: ox * oy, info })
		        })
		        hits.sort((a, b) => b.overlap - a.overlap)
		        elements = hits.slice(0, 12).map((h) => h.info)
		      } catch {}

		      bridge.send({
		        type: "overlay-edit",
		        payload: {
		          instruction: instruction.trim(),
		          screenshotDataUrl,
		          regionBounds: { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
		          filePath: focusedPage?.filePath || "",
		          elements,
		          viewport: { width: window.innerWidth, height: window.innerHeight },
		        },
		      })
		      // The pill takes over from here: instant ack, live narration, cancel.
		      ackEdit(instruction.trim())

		      setRect(null)
		      setInstruction("")
		      onClose()
		    } catch (err) {
		      console.error("[caret] Overlay submit failed:", err)
		    } finally {
		      setSending(false)
		    }
		  }, [rect, instruction, onClose])

		  return (
		    <div
		      className="caret-overlay"
		      onPointerDown={handlePointerDown}
		      onPointerMove={handlePointerMove}
		      onPointerUp={handlePointerUp}
		    >
		      {rect && (
		        <>
		          <div className="caret-overlay-rect" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} />
		          {!drawing && rect.w > 20 && rect.h > 20 && (
		            <div className="caret-overlay-prompt" style={{ left: rect.x, top: rect.y + rect.h + 8 }}>
		              <input
		                ref={inputRef}
		                autoFocus
		                placeholder="Describe the change, @ for an asset"
		                value={instruction}
		                onChange={e => setInstruction(e.target.value)}
		                onKeyDown={e => { if (e.key === "Enter") handleSubmit(); if (e.key === "Escape") { setRect(null); onClose() } }}
		                disabled={sending}
		              />
		              <button onClick={handleSubmit} disabled={sending || !instruction.trim()}>
		                {sending ? "..." : "→"}
		              </button>
		            </div>
		          )}
		        </>
		      )}
		    </div>
		  )
		}
	`
}

function generateCanvasCSS(): string {
	return dedent`
		.caret-canvas-container {
		  position: fixed;
		  inset: 0;
		  overflow: hidden;
		  background: #0a0a0a;
		  user-select: none;
		}

		.caret-canvas-content {
		  position: absolute;
		  top: 0;
		  left: 0;
		  will-change: transform;
		}

		.caret-canvas-toolbar {
		  position: fixed;
		  bottom: 16px;
		  left: 50%;
		  transform: translateX(-50%);
		  display: flex;
		  align-items: center;
		  gap: 2px;
		  padding: 4px 6px;
		  background: #1e1e1e;
		  border: 1px solid #333;
		  border-radius: 24px;
		  z-index: 100;
		  box-shadow: 0 4px 16px rgba(0,0,0,0.5);
		}

		.caret-tb-btn {
		  background: none;
		  border: none;
		  color: #999;
		  width: 32px;
		  height: 32px;
		  display: flex;
		  align-items: center;
		  justify-content: center;
		  border-radius: 50%;
		  cursor: pointer;
		  padding: 0;
		  transition: background 0.15s, color 0.15s;
		}
		.caret-tb-btn:hover { background: #333; color: #ddd; }
		.caret-tb-btn.active { background: #2563eb; color: #fff; }

		.caret-tb-sep {
		  width: 1px;
		  height: 20px;
		  background: #444;
		  margin: 0 4px;
		  flex-shrink: 0;
		}

		.caret-canvas-zoom-label {
		  color: #888;
		  font-size: 11px;
		  font-family: monospace;
		  min-width: 36px;
		  text-align: center;
		  padding: 0 4px;
		}

		.caret-flow-legend {
		  position: fixed;
		  bottom: 60px;
		  left: 50%;
		  transform: translateX(-50%);
		  display: flex;
		  gap: 16px;
		  padding: 6px 14px;
		  background: #1e1e1e;
		  border: 1px solid #333;
		  border-radius: 8px;
		  z-index: 100;
		  box-shadow: 0 2px 8px rgba(0,0,0,0.3);
		}

		.caret-flow-legend-item {
		  display: flex;
		  align-items: center;
		  gap: 6px;
		  font-size: 12px;
		  color: #999;
		  cursor: pointer;
		  white-space: nowrap;
		}
		.caret-flow-legend-item:hover { color: #ddd; }
		.caret-flow-legend-item.active { color: #fff; }
		.caret-flow-legend-item.invalid { color: #f87171; cursor: default; }
		.caret-flow-legend-item.invalid:hover { color: #f87171; }
		.caret-flow-legend-warn { flex-shrink: 0; }

		.caret-flow-legend-dot {
		  width: 8px;
		  height: 8px;
		  border-radius: 50%;
		  flex-shrink: 0;
		}

		.caret-canvas-warnings {
		  position: absolute;
		  top: 12px;
		  left: 50%;
		  transform: translateX(-50%);
		  z-index: 60;
		  background: rgba(69, 10, 10, 0.92);
		  color: #fecaca;
		  border: 1px solid rgba(239, 68, 68, 0.45);
		  border-radius: 8px;
		  padding: 6px 14px;
		  font-size: 12px;
		  pointer-events: none;
		  white-space: nowrap;
		}

		.caret-canvas-checks {
		  position: absolute;
		  top: 48px;
		  left: 50%;
		  transform: translateX(-50%);
		  z-index: 60;
		  background: rgba(42, 30, 5, 0.92);
		  color: #fde68a;
		  border: 1px solid rgba(245, 158, 11, 0.45);
		  border-radius: 8px;
		  padding: 6px 14px;
		  font-size: 12px;
		  cursor: pointer;
		  white-space: nowrap;
		}

		.caret-canvas-checks-panel {
		  position: absolute;
		  top: 84px;
		  left: 50%;
		  transform: translateX(-50%);
		  z-index: 61;
		  background: rgba(20, 20, 30, 0.96);
		  color: #e5e7eb;
		  border: 1px solid #3a3a4a;
		  border-radius: 10px;
		  padding: 12px 16px;
		  font-size: 12.5px;
		  max-width: 560px;
		  max-height: 50vh;
		  overflow: auto;
		  box-shadow: 0 8px 32px rgba(0,0,0,0.4);
		}

		.caret-canvas-checks-panel h4 {
		  margin: 10px 0 4px;
		  font-size: 12px;
		  color: #8b93a7;
		  font-weight: 600;
		}

		.caret-canvas-checks-panel h4:first-child { margin-top: 0; }

		.caret-canvas-checks-panel li {
		  margin: 2px 0 2px 16px;
		  line-height: 1.45;
		}

		.caret-canvas-checks-panel li.check-error { color: #fca5a5; }
		.caret-canvas-checks-panel li.check-warn { color: #fde68a; }
		.caret-canvas-checks-panel li.check-info { color: #8b93a7; }

		.caret-canvas-empty {
		  position: fixed;
		  inset: 0;
		  display: flex;
		  flex-direction: column;
		  align-items: center;
		  justify-content: center;
		  background: #0a0a0a;
		  color: #666;
		}
		.caret-canvas-empty-icon { font-size: 48px; margin-bottom: 16px; }
		.caret-canvas-empty h2 { font-size: 20px; color: #999; margin-bottom: 8px; }
		.caret-canvas-empty p { font-size: 14px; }

		/* Frame — Figma-style artboard */
		.caret-canvas-frame {
		  display: flex;
		  flex-direction: column;
		}

		.caret-canvas-frame-label {
		  display: flex;
		  align-items: center;
		  gap: 8px;
		  padding: 0 0 6px;
		  min-height: 20px;
		}

		.caret-canvas-frame-title {
		  font-size: 12px;
		  color: #888;
		  font-weight: 500;
		  white-space: nowrap;
		  overflow: hidden;
		  text-overflow: ellipsis;
		}

		.caret-canvas-frame:hover .caret-canvas-frame-title {
		  color: #ddd;
		}

		.caret-canvas-frame-tags {
		  display: flex;
		  gap: 4px;
		}

		.caret-canvas-frame-tag {
		  font-size: 9px;
		  padding: 1px 5px;
		  border-radius: 3px;
		  background: #222;
		  color: #666;
		}

		.caret-canvas-frame-viewport {
		  position: relative;
		  overflow: hidden;
		  border-radius: 4px;
		  box-shadow: 0 1px 3px rgba(0,0,0,0.4);
		  background: #fff;
		}

		/* Broken page (missing/invalid index.tsx) */
		.caret-canvas-frame-broken {
		  background: #1a0e0e;
		  border: 1px solid rgba(239, 68, 68, 0.45);
		  display: flex;
		  align-items: center;
		  justify-content: center;
		}
		.caret-canvas-frame-broken-inner {
		  text-align: center;
		  color: #fca5a5;
		  font-size: 13px;
		  padding: 16px;
		  font-family: ui-monospace, monospace;
		}
		.caret-canvas-frame-broken-icon {
		  font-size: 28px;
		  margin-bottom: 8px;
		}
		.caret-canvas-frame-broken-hint {
		  color: #9ca3af;
		  font-size: 11px;
		  margin-top: 6px;
		}
		.caret-canvas-frame-tag.broken {
		  background: rgba(239, 68, 68, 0.2);
		  color: #f87171;
		}

		.caret-canvas-frame:hover .caret-canvas-frame-viewport {
		  box-shadow: 0 2px 12px rgba(0,0,0,0.5), 0 0 0 1px rgba(59,130,246,0.5);
		}

		.caret-canvas-frame-iframe {
		  transform-origin: top left;
		  border: none;
		  pointer-events: none;
		  display: block;
		}

		/* Focused page view */
		.caret-focused {
		  position: fixed;
		  inset: 0;
		  overflow-y: auto;
		  background: #fff;
		}

		.caret-focused-fab {
		  position: fixed;
		  top: 12px;
		  left: 12px;
		  z-index: 9999;
		  width: 36px;
		  height: 36px;
		  display: flex;
		  align-items: center;
		  justify-content: center;
		  background: rgba(255, 255, 255, 0.15);
		  color: #fff;
		  border: 1px solid rgba(255, 255, 255, 0.2);
		  border-radius: 50%;
		  cursor: pointer;
		  font-size: 16px;
		  backdrop-filter: blur(12px);
		  -webkit-backdrop-filter: blur(12px);
		  transition: background 0.15s, border-color 0.15s;
		  box-shadow: 0 2px 8px rgba(0,0,0,0.2);
		  padding: 0;
		  line-height: 1;
		}
		.caret-focused-fab:hover {
		  background: rgba(255, 255, 255, 0.25);
		  border-color: rgba(255, 255, 255, 0.35);
		}
		/* Dark variant applied when the page behind the buttons is light.
		   The fabs-on-light class is toggled on the shell root by FocusedApp. */
		.caret-focused.fabs-on-light .caret-focused-fab:not(.active) {
		  background: rgba(17, 24, 39, 0.65);
		  border-color: rgba(17, 24, 39, 0.45);
		}
		.caret-focused.fabs-on-light .caret-focused-fab:not(.active):hover {
		  background: rgba(17, 24, 39, 0.85);
		  border-color: rgba(17, 24, 39, 0.65);
		}

		.caret-focused-content {
		  min-height: 100%;
		}

		/* Group headers */
		.caret-canvas-group-header {
		  font-size: 12px;
		  font-weight: 600;
		  color: #666;
		  text-transform: uppercase;
		  letter-spacing: 0.05em;
		  padding: 4px 0;
		  white-space: nowrap;
		}

		/* Drag states */
		.caret-canvas-thumb-wrapper.dragging {
		  z-index: 10;
		  opacity: 0.85;
		}
		.caret-canvas-thumb-wrapper {
		  transition: none;
		}

		/* First appearance of a page on the canvas — once, ever, per session. */
		.caret-canvas-thumb-wrapper.entering {
		  animation: caret-thumb-enter 0.24s ease-out;
		}
		@keyframes caret-thumb-enter {
		  from { opacity: 0; transform: scale(0.965); }
		  to { opacity: 1; transform: none; }
		}

		@media (prefers-reduced-motion: reduce) {
		  .caret-canvas-thumb-wrapper.entering { animation: none; }
		  .caret-explore-card { transition: none; }
		}

		/* Error fallback */
		.caret-canvas-error {
		  display: flex;
		  flex-direction: column;
		  align-items: center;
		  justify-content: center;
		  min-height: 50vh;
		  color: #888;
		  text-align: center;
		}
		.caret-canvas-error h2 { font-size: 18px; color: #ccc; margin-bottom: 8px; }
		.caret-canvas-error p { font-size: 13px; }

		/* Focused shell (thin iframe wrapper) */
		.caret-focused-shell {
		  position: fixed;
		  inset: 0;
		  display: flex;
		  flex-direction: column;
		  background: #0a0a0a;
		}

		.caret-focused-toolbar {
		  display: flex;
		  align-items: center;
		  gap: 8px;
		  padding: 6px 12px;
		  background: #1a1a1a;
		  border-bottom: 1px solid #333;
		  z-index: 10;
		  flex-shrink: 0;
		}

		.caret-focused-toolbar-btn {
		  background: none;
		  border: 1px solid #444;
		  color: #ccc;
		  padding: 4px 8px;
		  border-radius: 4px;
		  cursor: pointer;
		  font-size: 13px;
		  white-space: nowrap;
		}
		.caret-focused-toolbar-btn:hover { background: #333; }
		.caret-focused-toolbar-btn.active { background: #2563eb; border-color: #2563eb; color: #fff; }

		.caret-focused-toolbar-title {
		  color: #999;
		  font-size: 13px;
		  font-weight: 500;
		  margin-right: auto;
		  white-space: nowrap;
		  overflow: hidden;
		  text-overflow: ellipsis;
		}

		.caret-focused-viewport-selector {
		  display: flex;
		  gap: 4px;
		}

		/* ---- The playground (explore mode) ---- */
		.caret-explore {
		  position: fixed;
		  inset: 0;
		  display: flex;
		  flex-direction: column;
		  background: #10101a;
		  color: #e5e7eb;
		  font-family: system-ui, sans-serif;
		}
		.caret-explore > * { min-height: 0; }
		.caret-explore-header {
		  display: flex;
		  align-items: center;
		  gap: 12px;
		  padding: 12px 20px;
		  border-bottom: 1px solid #2a2a3a;
		  flex-shrink: 0;
		}
		.caret-explore-btn {
		  background: none;
		  border: 1px solid #3a3a4a;
		  color: #c7cad3;
		  border-radius: 8px;
		  padding: 6px 12px;
		  font-size: 13px;
		  cursor: pointer;
		}
		.caret-explore-btn:hover { background: #ffffff10; }
		.caret-explore-primary {
		  background: linear-gradient(180deg, #2f8bff, #0b6de6);
		  border: 1px solid #0b6de6;
		  color: #fff;
		  border-radius: 9px;
		  padding: 8px 20px;
		  font-size: 13px;
		  font-weight: 600;
		  letter-spacing: 0.01em;
		  white-space: nowrap;
		  cursor: pointer;
		  box-shadow: 0 2px 10px rgba(11, 122, 255, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.18);
		  transition: filter 120ms ease, transform 120ms ease;
		}
		.caret-explore-primary:hover { filter: brightness(1.1); transform: translateY(-1px); }
		.caret-explore-primary:active { transform: translateY(0); }
		.caret-explore-primary:disabled { opacity: 0.55; cursor: default; transform: none; }
		.caret-explore-ghost {
		  background: transparent;
		  border: 1px solid #3a3a4a;
		  color: #c7cad3;
		  border-radius: 9px;
		  padding: 8px 16px;
		  font-size: 13px;
		  white-space: nowrap;
		  cursor: pointer;
		  transition: background 120ms ease, border-color 120ms ease;
		}
		.caret-explore-ghost:hover { background: #ffffff0a; border-color: #4a4a5a; }
		.caret-explore-mini {
		  background: #1e1e2a;
		  border: 1px solid #3a3a4a;
		  color: #c7cad3;
		  border-radius: 6px;
		  padding: 4px 9px;
		  font-size: 12px;
		  cursor: pointer;
		}
		.caret-explore-mini:hover { background: #2a2a3a; }
		/* The frame IS the click target for full size — no Expand button. */
		.caret-explore-frame {
		  cursor: zoom-in;
		  border-radius: 10px;
		  transition: box-shadow 140ms ease, transform 140ms ease;
		}
		.caret-explore-frame:hover { box-shadow: 0 0 0 2px #0b7aff66, 0 8px 24px rgba(0, 0, 0, 0.35); transform: translateY(-2px); }
		/* A take being generated: quiet shimmer, no agent logs, no stale page. */
		.caret-explore-skel {
		  aspect-ratio: 16 / 10;
		  border-radius: 10px;
		  border: 1px solid #2a2a3a;
		  background: #15151f;
		  padding: 22px;
		  display: flex;
		  flex-direction: column;
		  gap: 12px;
		}
		.caret-explore-skel-bar {
		  height: 12px;
		  border-radius: 6px;
		  background: linear-gradient(90deg, #23232f 25%, #2e2e3d 45%, #23232f 65%);
		  background-size: 200% 100%;
		  animation: caret-skel-shimmer 1.4s ease-in-out infinite;
		}
		@keyframes caret-skel-shimmer {
		  0% { background-position: 180% 0; }
		  100% { background-position: -60% 0; }
		}
		/* The verdict beat on settle: the winner rings, the passed-over cards fall
		   back, then the pick posts. Half a second — a confirmation, not a ceremony. */
		.caret-explore-card { transition: opacity 0.22s ease; }
		.caret-explore-card.settling-lost { opacity: 0.35; }
		.caret-explore-card.settling-won .caret-explore-frame {
		  box-shadow: 0 0 0 2px #0b7aff, 0 10px 28px rgba(0, 0, 0, 0.4);
		  transform: translateY(-2px);
		}

		/* The way back to an open exploration from any other canvas mode. Sits
		   below the focused view's toolbar so it never covers its controls. */
		.caret-explore-pill {
		  position: fixed;
		  top: 56px;
		  right: 16px;
		  z-index: 5000;
		  background: #15151f;
		  border: 1px solid #0b7aff88;
		  color: #cfe5ff;
		  border-radius: 999px;
		  padding: 7px 14px;
		  font-size: 12.5px;
		  cursor: pointer;
		  box-shadow: 0 4px 16px rgba(0,0,0,0.35);
		}
		.caret-explore-pill:hover { border-color: #0b7aff; background: #1a1a28; }

		.caret-focused-iframe-container {
		  flex: 1;
		  display: flex;
		  justify-content: center;
		  overflow: auto;
		  background: #111;
		}

		.caret-focused-iframe {
		  border: none;
		  height: 100%;
		  background: #fff;
		}

		/* Simulation mode */
		.caret-simulation-shell {
		  position: fixed;
		  inset: 0;
		  display: flex;
		  flex-direction: column;
		  background: #0a0a0a;
		}

		.caret-simulation-toolbar {
		  display: flex;
		  align-items: center;
		  gap: 8px;
		  padding: 6px 12px;
		  background: #1a1a1a;
		  border-bottom: 1px solid #333;
		  z-index: 10;
		  flex-shrink: 0;
		}

		.caret-sim-btn {
		  background: none;
		  border: 1px solid #444;
		  color: #ccc;
		  padding: 4px 8px;
		  border-radius: 4px;
		  cursor: pointer;
		  font-size: 13px;
		  white-space: nowrap;
		}
		.caret-sim-btn:hover { background: #333; }
		.caret-sim-btn:disabled { opacity: 0.4; cursor: default; }
		.caret-sim-btn.active { background: #2563eb; border-color: #2563eb; color: #fff; }

		.caret-sim-page-label {
		  color: #999;
		  font-size: 13px;
		  margin-right: auto;
		}

		.caret-sim-viewport-selector {
		  display: flex;
		  gap: 4px;
		}

		.caret-simulation-content {
		  flex: 1;
		  display: flex;
		  justify-content: center;
		  align-items: flex-start;
		  overflow: auto;
		  padding: 24px;
		}

		.caret-simulation-device-frame {
		  background: #fff;
		  border-radius: 8px;
		  overflow: hidden;
		  box-shadow: 0 4px 24px rgba(0,0,0,0.4);
		  height: calc(100vh - 100px);
		}

		.caret-simulation-iframe {
		  width: 100%;
		  height: 100%;
		  border: none;
		}

		/* Canvas flow overlay */
		.caret-canvas-flow-overlay {
		  position: absolute;
		  top: 0;
		  left: 0;
		  pointer-events: none;
		  overflow: visible;
		}
		.caret-canvas-flow-overlay g { pointer-events: auto; }

		/* Edge connector dots — hollow ring, distinct from solid destination dots */
		.caret-edge-connector {
		  position: absolute;
		  right: -7px;
		  /* top is set inline per page from the edge-port distribution */
		  transform: translateY(-50%);
		  width: 14px;
		  height: 14px;
		  border-radius: 50%;
		  background: transparent;
		  border: 3px solid #3b82f6;
		  cursor: crosshair;
		  z-index: 10;
		  opacity: 1;
		  transition: transform 0.15s, background 0.15s;
		}
		.caret-edge-connector:hover {
		  transform: translateY(-50%) scale(1.2);
		  background: #3b82f6;
		}

		/* (old canvas viewport selector removed — integrated into toolbar) */

		/* Paint mode button */
		.caret-focused-paint-btn {
		  top: 12px;
		  left: 56px;
		}

		.caret-focused-sim-btn {
		  top: 12px;
		  left: 100px;
		}
		.caret-focused-paint-btn.active {
		  background: rgba(59, 130, 246, 0.4);
		  border-color: rgba(59, 130, 246, 0.6);
		}

		/* Overlay painter */
		.caret-overlay {
		  position: fixed;
		  inset: 0;
		  z-index: 9998;
		  cursor: crosshair;
		  background: rgba(0, 0, 0, 0.1);
		}

		.caret-overlay-rect {
		  position: fixed;
		  border: 2px solid #3b82f6;
		  background: rgba(59, 130, 246, 0.08);
		  pointer-events: none;
		}

		.caret-overlay-prompt {
		  position: fixed;
		  display: flex;
		  gap: 4px;
		  z-index: 9999;
		}

		.caret-overlay-prompt input {
		  padding: 6px 10px;
		  border: 1px solid #555;
		  border-radius: 6px;
		  background: #1a1a1a;
		  color: #eee;
		  font-size: 13px;
		  width: 280px;
		  outline: none;
		}
		.caret-overlay-prompt input:focus {
		  border-color: #3b82f6;
		}

		.caret-overlay-prompt button {
		  padding: 6px 10px;
		  border: 1px solid #555;
		  border-radius: 6px;
		  background: #3b82f6;
		  color: #fff;
		  cursor: pointer;
		  font-size: 13px;
		}
		.caret-overlay-prompt button:disabled {
		  opacity: 0.5;
		  cursor: default;
		}
	`
}

function generateBridge(): string {
	return dedent`
		type MessageHandler = (data: any) => void

		const listeners: Map<string, Set<MessageHandler>> = new Map()

		function showToast(message: string, isError: boolean) {
		  const el = document.createElement("div")
		  el.setAttribute("data-caret-bridge-toast", isError ? "error" : "success")
		  el.textContent = message
		  Object.assign(el.style, {
		    position: "fixed", bottom: "20px", right: "20px", zIndex: "99999",
		    padding: "8px 16px", borderRadius: "6px", fontSize: "13px",
		    background: isError ? "#dc2626" : "#16a34a", color: "#fff",
		    boxShadow: "0 2px 8px rgba(0,0,0,0.3)", transition: "opacity 0.3s",
		  })
		  document.body.appendChild(el)
		  setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 300) }, 2500)
		}

		// Feedback belongs to the frame that acted. This bridge loads in the
		// canvas document AND the focused iframe, and both hear every result —
		// so an untracked toast here doubled (or tripled) whatever surface owned
		// the edit. The generic toast now serves only results no dedicated
		// surface owns (param edits, resizes — untagged), and only in the frame
		// that actually sent an edit.
		let editSentFromThisFrame = false
		let undoSentFromThisFrame = false

		window.addEventListener("message", (e) => {
		  if (e.data?.source !== "caret-host") return

		  if (e.data.type === "edit-result") {
		    const { success, error, kind } = e.data.payload
		    // Tagged results have owners: "inline" → the grab plugin's card/toast,
		    // "agent" → the edit pill. Toasting them here says it twice.
		    if (!success && kind === undefined && editSentFromThisFrame) showToast(error || "Edit failed", true)
		  }

		  if (e.data.type === "undo-result" && undoSentFromThisFrame) {
		    const { undone, label, error, redo } = e.data.payload
		    const verb = redo ? "Redid" : "Undid"
		    showToast(undone ? \`\${verb}: \${label}\` : (error || (redo ? "Nothing to redo" : "Nothing to undo")), !undone)
		  }

		  const handlers = listeners.get(e.data.type)
		  if (handlers) {
		    handlers.forEach(fn => fn(e.data.payload))
		  }
		})

		export const bridge = {
		  send(message: { type: string; payload: unknown }) {
		    if (message.type === "param-edit" || message.type === "resize-commit" || message.type === "inline-edit") {
		      editSentFromThisFrame = true
		    }
		    if (message.type === "design-undo" || message.type === "design-redo") undoSentFromThisFrame = true
		    window.parent.postMessage({ source: "caret-vite", ...message }, "*")
		  },

		  on(type: string, handler: MessageHandler) {
		    if (!listeners.has(type)) listeners.set(type, new Set())
		    listeners.get(type)!.add(handler)
		    return () => { listeners.get(type)?.delete(handler) }
		  },
		}
	`
}

/**
 * The `@` picker: asset autocomplete on any instruction box.
 *
 * Written as a vanilla attach-to-an-input function rather than a React
 * component because the two surfaces that need it are not alike. The overlay
 * painter's input is ours; the AI-edit box is react-grab's, living in a shadow
 * root we do not control. One implementation that takes an element covers both,
 * and a second implementation would eventually disagree with the first about
 * what a tag is.
 *
 * Two details are load-bearing:
 *
 * - **The native value setter.** Both inputs are React-controlled, and React
 *   installs a value tracker that swallows a plain `input.value = …`. Writing
 *   through the prototype setter and dispatching `input` is the only way the
 *   component's own state follows what the user picked.
 * - **Capture-phase Enter, attached first.** The grab plugin submits on Enter
 *   from its own capture listener on the same element. The picker has to see
 *   that key first and stop it, or choosing an asset also sends the instruction.
 */
function generateAssetPicker(): string {
	return dedent`
		export interface AssetSummary {
		  tag: string
		  file: string
		  kind: "image" | "vector" | "video" | "model"
		  width: number | null
		  height: number | null
		  alt: string
		  description: string
		}

		let cached: AssetSummary[] = []
		let loaded = false

		/** The index, fetched once per page load and refreshed on every open. */
		export async function loadAssets(): Promise<AssetSummary[]> {
		  try {
		    const response = await fetch("/__caret/assets-index")
		    const body = await response.json()
		    cached = Array.isArray(body?.assets) ? body.assets : []
		    loaded = true
		  } catch {
		    // A canvas that cannot reach the index still has to accept typing; the
		    // instruction goes through with a bare @tag and the host expands it.
		    if (!loaded) cached = []
		  }
		  return cached
		}

		export function assetUrl(asset: AssetSummary): string {
		  return "/caret-assets/" + encodeURIComponent(asset.file)
		}

		/** The partial tag being typed immediately before the caret, or null. */
		function queryAt(value: string, caret: number): { query: string; start: number } | null {
		  const before = value.slice(0, caret)
		  const match = before.match(/(^|[\\s(\\[{>])@([a-z0-9-]*)$/i)
		  if (!match) return null
		  return { query: match[2].toLowerCase(), start: caret - match[2].length - 1 }
		}

		function rank(assets: AssetSummary[], query: string): AssetSummary[] {
		  if (!query) return assets.slice(0, 8)
		  const starts = assets.filter(a => a.tag.startsWith(query))
		  const contains = assets.filter(a => !a.tag.startsWith(query) && (a.tag.includes(query) || (a.description || "").toLowerCase().includes(query)))
		  return starts.concat(contains).slice(0, 8)
		}

		function setValue(input: HTMLInputElement | HTMLTextAreaElement, value: string, caret: number) {
		  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
		  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set
		  if (setter) setter.call(input, value)
		  else input.value = value
		  input.dispatchEvent(new Event("input", { bubbles: true }))
		  try { input.setSelectionRange(caret, caret) } catch {}
		}

		/**
		 * Attaches the picker to an input. Returns a detach function.
		 *
		 * The popup goes in \`document.body\` even when the input is in a shadow
		 * root: a fixed-position element inside someone else's subtree inherits
		 * their transforms and clipping, and react-grab's overlay has both.
		 */
		export function attachAssetPicker(input: HTMLInputElement | HTMLTextAreaElement): () => void {
		  let popup: HTMLDivElement | null = null
		  let rows: HTMLDivElement[] = []
		  let matches: AssetSummary[] = []
		  let highlighted = 0
		  let anchor: { start: number } | null = null

		  void loadAssets()

		  const close = () => {
		    popup?.remove()
		    popup = null
		    rows = []
		    matches = []
		    anchor = null
		  }

		  /** The highlight, and nothing else. Kept apart from building the list. */
		  const paint = () => {
		    rows.forEach((row, i) => {
		      row.style.background = i === highlighted ? "rgba(11,122,255,0.18)" : "transparent"
		    })
		  }

		  const render = () => {
		    if (!popup) {
		      popup = document.createElement("div")
		      popup.setAttribute("data-caret-asset-picker", "")
		      // react-grab's own escape hatch, and it is required rather than
		      // optional: in prompt mode it treats any pointerdown outside the
		      // selection as "dismiss" and puts up "Discard?", and one inside the
		      // selection as "submit". Both fire from a window-level capture
		      // listener, so the picker has to be invisible to it — the attribute is
		      // matched through composedPath(), which is why this works even though
		      // the popup lives in document.body. Their own textarea carries it too.
		      popup.setAttribute("data-react-grab-ignore-events", "")
		      Object.assign(popup.style, {
		        // Both of these are about being *hittable*, not visible, and the
		        // difference is what made this so misleading: the list rendered
		        // perfectly and simply received nothing.
		        //
		        // pointer-events is an inherited property, and react-grab sets none
		        // on the body while it is active so the page cannot be clicked out
		        // from under it. Our popup is a body child, so it inherited that and
		        // every press fell through to the document — where react-grab read it
		        // as a dismissal and offered to discard the user's text.
		        //
		        // The z-index matches their overlay's, which is the maximum; being
		        // later in the body settles the tie in our favour.
		        pointerEvents: "auto",
		        position: "fixed", zIndex: "2147483647", minWidth: "260px", maxWidth: "360px",
		        maxHeight: "260px", overflowY: "auto", background: "#15161a",
		        border: "1px solid #2c2e36", borderRadius: "10px", padding: "4px",
		        boxShadow: "0 12px 32px rgba(0,0,0,0.45)", fontFamily: "system-ui, sans-serif",
		      })
		      // Keep the input focused: react-grab exits prompt mode on blur, so a
		      // click that steals focus would close the box being typed into.
		      popup.addEventListener("mousedown", e => e.preventDefault())
		      document.body.appendChild(popup)
		    }

		    const box = input.getBoundingClientRect()
		    popup.style.left = Math.max(8, Math.min(box.left, window.innerWidth - 380)) + "px"
		    const below = window.innerHeight - box.bottom
		    if (below > 280) {
		      popup.style.top = (box.bottom + 6) + "px"
		      popup.style.bottom = ""
		    } else {
		      popup.style.bottom = (window.innerHeight - box.top + 6) + "px"
		      popup.style.top = ""
		    }

		    popup.innerHTML = ""
		    rows = []
		    if (matches.length === 0) {
		      const empty = document.createElement("div")
		      empty.textContent = cached.length === 0
		        ? "No assets yet — add them in the Assets library"
		        : "No asset matches that"
		      Object.assign(empty.style, { padding: "10px 12px", fontSize: "12px", color: "#8b8d98" })
		      popup.appendChild(empty)
		      return
		    }

		    matches.forEach((asset, i) => {
		      const row = document.createElement("div")
		      row.setAttribute("data-caret-asset-option", asset.tag)
		      Object.assign(row.style, {
		        display: "flex", gap: "10px", alignItems: "center", padding: "6px",
		        borderRadius: "7px", cursor: "pointer",
		      })
		      // Hovering repaints the highlight; it must never rebuild the list. It
		      // did, and replacing the element under the cursor meant mousedown and
		      // mouseup landed on different nodes, so no click ever fired and picking
		      // an asset silently left the bare "@" behind.
		      row.addEventListener("mouseenter", () => { highlighted = i; paint() })
		      // Chosen on mousedown, not click: one event, before focus can move,
		      // and it cannot be split across a re-render.
		      row.addEventListener("mousedown", (event) => {
		        event.preventDefault()
		        accept(asset, true)
		      })
		      rows.push(row)

		      const thumb = document.createElement("div")
		      Object.assign(thumb.style, {
		        width: "44px", height: "32px", flexShrink: "0", borderRadius: "4px",
		        overflow: "hidden", background: "#0c0d10", display: "flex",
		        alignItems: "center", justifyContent: "center",
		      })
		      if (asset.kind === "image" || asset.kind === "vector") {
		        const img = document.createElement("img")
		        img.src = assetUrl(asset)
		        img.alt = ""
		        Object.assign(img.style, { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" })
		        thumb.appendChild(img)
		      } else {
		        const label = document.createElement("span")
		        label.textContent = asset.kind === "video" ? "VID" : "3D"
		        Object.assign(label.style, { fontSize: "9px", letterSpacing: "0.06em", color: "#8b8d98" })
		        thumb.appendChild(label)
		      }
		      row.appendChild(thumb)

		      const text = document.createElement("div")
		      Object.assign(text.style, { minWidth: "0", flex: "1" })
		      const tag = document.createElement("div")
		      tag.textContent = "@" + asset.tag
		      Object.assign(tag.style, { fontSize: "12px", color: "#e6e7ea", fontFamily: "ui-monospace, monospace" })
		      text.appendChild(tag)
		      const detail = document.createElement("div")
		      // The description is what makes the pick informed — the dimensions say
		      // whether it fits, the description says whether text can sit on it.
		      detail.textContent = asset.description || (asset.width && asset.height ? asset.width + "×" + asset.height : asset.kind)
		      Object.assign(detail.style, {
		        fontSize: "11px", color: "#8b8d98", whiteSpace: "nowrap",
		        overflow: "hidden", textOverflow: "ellipsis",
		      })
		      text.appendChild(detail)
		      row.appendChild(text)

		      popup!.appendChild(row)
		    })
		    paint()
		  }

		  /**
		   * Closes once the current press has finished being delivered.
		   *
		   * react-grab ignores any event whose composedPath contains our popup, and
		   * that path is hit-tested per event. Removing the popup on mousedown would
		   * put the pointerup and click of the *same gesture* on the page instead,
		   * where react-grab is watching for exactly that — a press outside its
		   * selection means dismiss, and dismissing with text typed raises
		   * "Discard?" over the user's instruction. So the element stays until the
		   * gesture it belongs to has finished being delivered.
		   */
		  const closeAfterGesture = () => {
		    const finish = () => {
		      window.removeEventListener("click", finish, true)
		      close()
		    }
		    window.addEventListener("click", finish, true)
		    // A press that never produces a click — dragged off the row, cancelled by
		    // the OS — must not leave the list on screen forever.
		    window.setTimeout(finish, 600)
		  }

		  const accept = (asset: AssetSummary, viaPointer?: boolean) => {
		    if (!anchor) return
		    const caret = input.selectionStart ?? input.value.length
		    const next = input.value.slice(0, anchor.start) + "@" + asset.tag + " " + input.value.slice(caret)
		    setValue(input, next, anchor.start + asset.tag.length + 2)
		    // Cleared now so a second press cannot insert twice; only the element's
		    // removal is deferred.
		    anchor = null
		    matches = []
		    if (viaPointer) closeAfterGesture()
		    else close()
		    input.focus()
		  }

		  const refresh = () => {
		    const caret = input.selectionStart ?? input.value.length
		    const found = queryAt(input.value, caret)
		    if (!found) return close()
		    anchor = { start: found.start }
		    matches = rank(cached, found.query)
		    highlighted = 0
		    render()
		  }

		  const onInput = () => {
		    // Refresh the index lazily: an asset added while the canvas was open
		    // should be typeable without a reload.
		    if (!loaded) void loadAssets().then(() => { if (anchor) refresh() })
		    refresh()
		  }

		  const onKeyDown = (event: KeyboardEvent) => {
		    if (!popup) return
		    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
		      if (matches.length === 0) return
		      event.preventDefault()
		      event.stopImmediatePropagation()
		      highlighted = (highlighted + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length
		      paint()
		      return
		    }
		    if (event.key === "Enter" || event.key === "Tab") {
		      if (matches.length === 0) return
		      event.preventDefault()
		      // Immediate, not plain stopPropagation: the submit handler lives on
		      // this same element, so choosing an asset would otherwise also send.
		      event.stopImmediatePropagation()
		      accept(matches[highlighted])
		      return
		    }
		    if (event.key === "Escape") {
		      event.preventDefault()
		      event.stopImmediatePropagation()
		      close()
		    }
		  }

		  // Delayed, because a click on a row blurs before it lands.
		  const onBlur = () => setTimeout(close, 120)

		  input.addEventListener("input", onInput)
		  input.addEventListener("keydown", onKeyDown, true)
		  input.addEventListener("blur", onBlur)

		  return () => {
		    input.removeEventListener("input", onInput)
		    input.removeEventListener("keydown", onKeyDown, true)
		    input.removeEventListener("blur", onBlur)
		    close()
		  }
		}
	`
}

/**
 * The edit pill: the live surface for a canvas-initiated AI edit.
 *
 * The gap it closes was read as a freeze: Enter on an AI edit, then seconds of
 * nothing (up to a minute on a slow model), then a toast. The chat sidebar had
 * the feedback all along — but feedback belongs where the intent was expressed,
 * and edits are deliberately decoupled from the chat's UI.
 *
 * Lifecycle: `ackEdit()` shows it instantly and locally, before any backend
 * round-trip; `edit-status` pushes drive the live line, the inline permission
 * prompt and the terminal states; `edit-result` doubles as a resolve signal so
 * the pill also settles on hosts that never send statuses (the browser-only
 * shell harness). Plain DOM on purpose — it renders inside the user's page,
 * where the canvas gets no React runtime of its own to lean on.
 */
function generateEditPill(): string {
	return dedent`
		import { bridge } from "./bridge"

		let root: HTMLDivElement | null = null
		let active = false
		let glowTarget: HTMLElement | null = null
		let hideTimer: number | null = null

		export function editPillActive(): boolean {
		  return active
		}

		const GLOW_CLASS = "caret-edit-glow"

		function ensureStyles() {
		  if (document.getElementById("caret-edit-pill-style")) return
		  const style = document.createElement("style")
		  style.id = "caret-edit-pill-style"
		  style.textContent = \`
		    @keyframes caret-pill-spin { to { transform: rotate(360deg) } }
		    @keyframes caret-edit-pulse {
		      0%, 100% { box-shadow: 0 0 0 2px rgba(11,122,255,0.55), 0 0 18px 2px rgba(11,122,255,0.25) }
		      50%      { box-shadow: 0 0 0 2px rgba(11,122,255,0.25), 0 0 10px 1px rgba(11,122,255,0.12) }
		    }
		    .\${GLOW_CLASS} { animation: caret-edit-pulse 1.6s ease-in-out infinite; border-radius: 4px; }
		  \`
		  document.head.appendChild(style)
		}

		function setGlow(el: HTMLElement | null) {
		  if (glowTarget && glowTarget !== el) glowTarget.classList.remove(GLOW_CLASS)
		  glowTarget = el
		  if (el) el.classList.add(GLOW_CLASS)
		}

		function ensureRoot(): HTMLDivElement {
		  if (root && document.body.contains(root)) return root
		  root = document.createElement("div")
		  root.setAttribute("data-caret-edit-pill", "")
		  root.style.cssText = [
		    "position:fixed", "left:50%", "bottom:18px", "transform:translateX(-50%)",
		    "z-index:2147483000", "max-width:min(560px, calc(100vw - 32px))",
		    "background:rgba(18,21,28,0.92)", "backdrop-filter:blur(8px)",
		    "border:1px solid rgba(255,255,255,0.09)", "border-radius:12px",
		    "padding:10px 14px", "color:#e6e9ef",
		    "font-family:ui-sans-serif,system-ui,sans-serif", "font-size:12.5px",
		    "box-shadow:0 8px 28px rgba(0,0,0,0.45)",
		    "display:flex", "flex-direction:column", "gap:6px",
		  ].join(";")
		  document.body.appendChild(root)
		  return root
		}

		function clearHideTimer() {
		  if (hideTimer !== null) { clearTimeout(hideTimer); hideTimer = null }
		}

		function hide(afterMs: number) {
		  clearHideTimer()
		  hideTimer = window.setTimeout(() => {
		    root?.remove()
		    root = null
		  }, afterMs)
		}

		function esc(s: string): string {
		  const div = document.createElement("div")
		  div.textContent = s
		  return div.innerHTML
		}

		let instruction = ""

		function render(html: string) {
		  ensureStyles()
		  ensureRoot().innerHTML = html
		}

		function headerRow(body: string, showCancel: boolean): string {
		  const cancel = showCancel
		    ? '<button data-pill-cancel title="Cancel this edit" style="all:unset;cursor:pointer;color:#8b93a7;padding:0 2px;font-size:14px;line-height:1">×</button>'
		    : ""
		  return '<div style="display:flex;align-items:center;gap:9px">' + body + '<div style="flex:1"></div>' + cancel + "</div>"
		}

		// A dotted ring, not a solid arc: it rhymes with the chat's thinking orb,
		// so "Caret's agent is working" has one visual signature everywhere.
		const SPINNER = '<span style="display:inline-block;width:12px;height:12px;border:2px dotted rgba(11,122,255,0.8);border-radius:50%;animation:caret-pill-spin 1.6s linear infinite;flex-shrink:0"></span>'

		function wire() {
		  if (!root) return
		  root.querySelector("[data-pill-cancel]")?.addEventListener("click", () => {
		    bridge.send({ type: "edit-cancel", payload: {} })
		    render(headerRow('<span style="color:#8b93a7">Cancelling…</span>', false))
		  })
		  for (const btn of Array.from(root.querySelectorAll("[data-pill-perm]"))) {
		    btn.addEventListener("click", () => {
		      const decision = (btn as HTMLElement).getAttribute("data-pill-perm")
		      const requestId = (btn as HTMLElement).getAttribute("data-pill-req") || ""
		      bridge.send({ type: "edit-permission", payload: { requestId, decision } })
		      showWorking(undefined)
		    })
		  }
		}

		function showWorking(detail?: string) {
		  const line = detail
		    ? '<div style="color:#8b93a7;font-size:11.5px;padding-left:20px">' + esc(detail) + "</div>"
		    : ""
		  render(
		    headerRow(SPINNER + '<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Working on it — “' + esc(instruction) + '”</span>', true) + line,
		  )
		  wire()
		}

		/**
		 * Instant, local acknowledgement — called at the submit site, before any
		 * backend round-trip. This is the 200ms that kills "did it freeze?".
		 */
		export function ackEdit(text: string, target?: Element | null) {
		  active = true
		  instruction = text
		  clearHideTimer()
		  setGlow((target as HTMLElement) || null)
		  showWorking()
		}

		// Held briefly past resolve so the plugin's own edit-result toast handler
		// can tell "the pill already told them" from an inline edit's result.
		let engagedUntil = 0

		export function editPillEngaged(): boolean {
		  return active || Date.now() < engagedUntil
		}

		function resolveDone() {
		  if (!active) return
		  active = false
		  engagedUntil = Date.now() + 1500
		  setGlow(null)
		  render(headerRow('<span style="color:#4ade80">✓</span><span>Edit applied</span>', false))
		  hide(2200)
		}

		function resolveFailed(message?: string) {
		  if (!active) return
		  active = false
		  engagedUntil = Date.now() + 1500
		  setGlow(null)
		  render(headerRow('<span style="color:#f87171">✕</span><span style="min-width:0">' + esc(message || "The edit failed") + "</span>", false))
		  hide(7000)
		}

		bridge.on("edit-status", (payload: any) => {
		  if (!payload || typeof payload !== "object") return
		  if (!active && payload.phase === "working") {
		    // A status can arrive before ackEdit on hosts where submit happens in a
		    // different frame — adopt it rather than dropping the narration.
		    active = true
		    instruction = payload.instruction || instruction
		  }
		  if (!active) return

		  if (payload.phase === "working") {
		    if (payload.instruction) instruction = payload.instruction
		    showWorking(payload.detail)
		  } else if (payload.phase === "needs-permission" && payload.permission) {
		    const p = payload.permission
		    render(
		      headerRow('<span style="color:#0b7aff">●</span><span>Needs your OK</span>', true) +
		      '<div style="color:#8b93a7;font-size:11.5px;padding-left:20px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(p.summary || "") + "</div>" +
		      '<div style="display:flex;gap:8px;padding-left:20px">' +
		        '<button data-pill-perm="allow" data-pill-req="' + esc(p.requestId) + '" style="all:unset;cursor:pointer;background:#0b7aff;color:#fff;padding:3px 10px;border-radius:7px;font-size:12px">Allow</button>' +
		        '<button data-pill-perm="allow-always" data-pill-req="' + esc(p.requestId) + '" style="all:unset;cursor:pointer;color:#8b93a7;padding:3px 6px;font-size:12px">Always</button>' +
		        '<button data-pill-perm="deny" data-pill-req="' + esc(p.requestId) + '" style="all:unset;cursor:pointer;color:#8b93a7;padding:3px 6px;font-size:12px">Deny</button>' +
		      "</div>",
		    )
		    wire()
		  } else if (payload.phase === "done") {
		    resolveDone()
		  } else if (payload.phase === "cancelled") {
		    active = false
		    engagedUntil = Date.now() + 1500
		    setGlow(null)
		    render(headerRow('<span style="color:#8b93a7">Cancelled</span>', false))
		    hide(1800)
		  } else if (payload.phase === "failed") {
		    resolveFailed(payload.error)
		  }
		})

		// The resolve signal on hosts that never push statuses (the browser-only
		// shell harness), and a second, idempotent one everywhere else.
		bridge.on("edit-result", (payload: any) => {
		  if (!active || !payload || typeof payload !== "object") return
		  if (payload.success) resolveDone()
		  else resolveFailed(payload.error)
		})
	`
}

function generateLayersPanel(): string {
	return dedent`
		import { bridge } from "./bridge"
		import { showParamPanel } from "./param-panel"

		/**
		 * The layers panel — the page's element tree, mirrored from the LIVE DOM
		 * (Phase 10.6). Built from rendered data-caret-id elements rather than a
		 * source parse: what you see is what is actually on screen, iterator rows
		 * and all, and clicking a row is exactly the click-on-canvas selection.
		 * Toggled with L, closed with Escape or ×.
		 */

		let host: HTMLDivElement | null = null

		export function isLayersOpen(): boolean {
		  return !!host?.isConnected
		}

		export function toggleLayersPanel(filePath: string) {
		  if (isLayersOpen()) {
		    closeLayersPanel()
		    return
		  }
		  host = document.createElement("div")
		  host.id = "caret-layers-panel"
		  host.setAttribute("data-react-grab-ignore-events", "")
		  host.style.cssText =
		    "position:fixed;top:64px;left:16px;width:220px;max-height:70vh;overflow:auto;z-index:99998;background:rgba(20,20,30,0.97);border:1px solid #3a3a4a;border-radius:12px;padding:10px 6px;font:12px/1.6 system-ui;color:#c9cede;pointer-events:auto;"
		  document.body.appendChild(host)
		  render(filePath)
		}

		export function closeLayersPanel() {
		  host?.remove()
		  host = null
		}

		function render(filePath: string) {
		  if (!host) return
		  const rows: string[] = []
		  const elements = Array.from(document.querySelectorAll("[data-caret-id]")).filter(
		    (el) => !el.closest("#caret-param-panel") && !el.closest("#caret-layers-panel"),
		  )
		  for (const el of elements) {
		    let depth = 0
		    let node = el.parentElement
		    while (node) {
		      if (node.hasAttribute("data-caret-id")) depth++
		      node = node.parentElement
		    }
		    const id = el.getAttribute("data-caret-id") ?? ""
		    rows.push(
		      \`<div data-layer="\${id}" style="padding:2px 8px 2px \${8 + depth * 14}px;cursor:pointer;border-radius:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">\` +
		        \`<span style="color:#8b93a7">\${el.tagName.toLowerCase()}</span> \${id}</div>\`,
		    )
		  }
		  host.innerHTML =
		    '<div style="display:flex;justify-content:space-between;align-items:center;padding:0 8px 6px"><strong style="font-size:11px;letter-spacing:0.06em;color:#8b93a7">LAYERS</strong>' +
		    '<button data-layers-close style="all:unset;cursor:pointer;color:#8b93a7">×</button></div>' +
		    (rows.join("") || '<div style="padding:0 8px;color:#8b93a7">no addressable elements</div>')

		  host.querySelector("[data-layers-close]")?.addEventListener("click", closeLayersPanel)
		  for (const row of host.querySelectorAll<HTMLElement>("[data-layer]")) {
		    row.addEventListener("click", () => {
		      const id = row.dataset.layer ?? ""
		      // First rendered instance: for .map() rows that IS row 1, which
		      // matches what a canvas click on the first row selects.
		      const el = document.querySelector(\`[data-caret-id="\${id}"]\`)
		      if (!el) return
		      el.scrollIntoView({ block: "nearest", behavior: "smooth" })
		      showParamPanel(el, filePath, 0)
		      row.style.background = "#2d2d40"
		      setTimeout(() => { row.style.background = "" }, 600)
		    })
		  }
		}

		/**
		 * The keyboard map (Phase 10.8) — one discoverable place, showing only
		 * what actually exists. Opened with ?.
		 */
		export function toggleShortcuts() {
		  const existing = document.getElementById("caret-shortcuts")
		  if (existing) {
		    existing.remove()
		    return
		  }
		  const overlay = document.createElement("div")
		  overlay.id = "caret-shortcuts"
		  overlay.setAttribute("data-react-grab-ignore-events", "")
		  overlay.style.cssText =
		    "position:fixed;inset:0;z-index:99999;background:rgba(10,10,16,0.72);display:flex;align-items:center;justify-content:center;pointer-events:auto;"
		  const SHORTCUTS: Array<[string, string]> = [
		    ["Click", "select an element (opens the property panel)"],
		    ["Shift+Click", "grow the selection — one edit hits all of it"],
		    ["Drag a handle", "resize; flex and grid preview through a clamp"],
		    ["Enter (in a panel row)", "commit the value"],
		    ["\u2318Z / Ctrl+Z", "undo the last design change (one step per gesture)"],
		    ["\u21e7\u2318Z / Ctrl+Shift+Z", "redo what you just undid"],
		    ["L", "toggle the layers panel"],
		    ["Esc", "close panels, cancel a drag, deselect"],
		    ["?", "this map"],
		  ]
		  overlay.innerHTML =
		    '<div style="background:#16161f;border:1px solid #3a3a4a;border-radius:14px;padding:20px 26px;min-width:380px;font:13px/2 system-ui;color:#c9cede">' +
		    '<strong style="display:block;margin-bottom:8px;color:#fff">Keyboard & gestures</strong>' +
		    SHORTCUTS.map(
		      (s) =>
		        \`<div style="display:flex;gap:16px"><code style="min-width:130px;color:#a5b4fc">\${s[0]}</code><span>\${s[1]}</span></div>\`,
		    ).join("") +
		    "</div>"
		  overlay.addEventListener("click", () => overlay.remove())
		  document.body.appendChild(overlay)
		}

		window.addEventListener("keydown", (e) => {
		  const active = document.activeElement as HTMLElement | null
		  if (active && (active.isContentEditable || active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return
		  if (e.key === "?") {
		    e.preventDefault()
		    toggleShortcuts()
		  }
		  if (e.key.toLowerCase() === "l" && !e.metaKey && !e.ctrlKey && !e.altKey) {
		    const page = (window as any).__CARET_FOCUSED_PAGE__
		    if (!page?.filePath) return
		    e.preventDefault()
		    toggleLayersPanel(page.filePath)
		  }
		  if (e.key === "Escape") {
		    closeLayersPanel()
		    document.getElementById("caret-shortcuts")?.remove()
		  }
		})

		// Keep the module referenced so the bundler includes the listeners.
		void bridge
	`
}

function generateSizeResolver(): string {
	return dedent`
		/**
		 * The layout-context resolver — Phase 10's foundation, in the browser
		 * where the truth lives.
		 *
		 * A measured size is a FACT that says nothing about which declaration
		 * produced it. Classification (flex item? grid item? block?) is one level
		 * up; ATTRIBUTION is not — width:auto blocks forward the question to their
		 * parent, arbitrarily deep, and position:absolute skips to the containing
		 * block. So the resolver walks and returns the whole CHAIN of
		 * participants, not one guessed target: the panel can say "this width is
		 * decided by 3 things" and let the user choose.
		 *
		 * The axes are NOT symmetric: width:auto FILLS the parent (resolves
		 * upward); height:auto HUGS the content (resolves downward). A flex row
		 * child's height is the tallest sibling (align-items:stretch), its width
		 * is a share. Measured, not reasoned — see CARET-V2-PLAN §5.
		 */

		export type Axis = "width" | "height"

		export type SizeKind =
		  | "declared"          // the element's own utility/inline style decides
		  | "containing-block"  // position:absolute + inset — the CB decides
		  | "grid-track"        // width of a grid item — the parent's columns
		  | "grid-row"          // height of a grid item — the row (auto = tallest)
		  | "flex-main"         // main-axis share (flex-grow/basis against siblings)
		  | "flex-cross"        // cross-axis — stretch to tallest, or self height
		  | "hug"               // height:auto in normal flow — content decides
		  | "content"           // explicit hug on width (w-fit / w-max)
		  | "fill-chain"        // width:auto fills upward to the first constrainer
		  | "viewport-root"     // nothing declared all the way up — the viewport

		export interface ChainLink {
		  element: Element
		  role: "self" | "pass-through" | "decider"
		  note: string
		}

		export interface SizeContext {
		  axis: Axis
		  kind: SizeKind
		  /** The element whose declaration (or track/algorithm) decides the size. */
		  decider: Element
		  chain: ChainLink[]
		  /** The preview channel a drag must use in THIS context. el.style.width
		   * does NOTHING on a flex-basis:0 child (measured), so flex and grid
		   * preview through a min/max clamp — which is byte-identical geometry to
		   * the basis/width commit and never shows a state the commit can't make. */
		  previewChannel: "size" | "minmax-clamp"
		}

		/** The element's own axis declaration, read from utilities + inline style. */
		function ownDeclaration(el: Element, axis: Axis): { fixed?: string; hug?: string } {
		  const style = (el as HTMLElement).style
		  const inline = axis === "width" ? style.width : style.height
		  if (inline && inline !== "auto") return { fixed: \`inline \${axis}:\${inline}\` }
		  const classes = (el.getAttribute("class") ?? "").split(/\\s+/)
		  const prefix = axis === "width" ? "w-" : "h-"
		  for (const cls of classes) {
		    const base = cls.includes(":") ? cls.slice(cls.lastIndexOf(":") + 1) : cls
		    if (!base.startsWith(prefix)) continue
		    const suffix = base.slice(prefix.length)
		    if (suffix === "auto") continue
		    if (suffix === "fit" || suffix === "max" || suffix === "min") return { hug: base }
		    if (suffix === "full" || suffix === "screen" || /^\\d/.test(suffix) || suffix.startsWith("[")) {
		      return { fixed: base }
		    }
		  }
		  if (axis === "width") {
		    for (const cls of classes) {
		      const base = cls.includes(":") ? cls.slice(cls.lastIndexOf(":") + 1) : cls
		      if (base.startsWith("basis-") && base !== "basis-auto") return { fixed: base }
		    }
		  }
		  return {}
		}

		/** display:contents parents don't lay anything out — skip to the grandparent. */
		function layoutParent(el: Element): Element | null {
		  let parent = el.parentElement
		  while (parent && getComputedStyle(parent).display === "contents") parent = parent.parentElement
		  return parent
		}

		/** The containing block for an absolutely positioned element. */
		function containingBlockOf(el: Element): Element {
		  let node = el.parentElement
		  while (node) {
		    const cs = getComputedStyle(node)
		    if (
		      cs.position !== "static" ||
		      cs.transform !== "none" ||
		      cs.filter !== "none" ||
		      cs.contain.includes("layout") ||
		      cs.contain.includes("paint")
		    ) {
		      return node
		    }
		    node = node.parentElement
		  }
		  return document.documentElement
		}

		/** Does this ancestor DECLARE a size on the axis (ending a fill chain)? */
		function constrains(el: Element, axis: Axis): string | null {
		  const own = ownDeclaration(el, axis)
		  if (own.fixed) return own.fixed
		  const classes = (el.getAttribute("class") ?? "").split(/\\s+/)
		  if (axis === "width") {
		    for (const cls of classes) {
		      const base = cls.includes(":") ? cls.slice(cls.lastIndexOf(":") + 1) : cls
		      if (base.startsWith("max-w-") && base !== "max-w-none") return base
		    }
		  }
		  return null
		}

		function isMainAxis(container: Element, axis: Axis): boolean {
		  const direction = getComputedStyle(container).flexDirection
		  const horizontal = direction === "row" || direction === "row-reverse"
		  return (axis === "width") === horizontal
		}

		export function resolveSizeContext(el: Element, axis: Axis): SizeContext {
		  const chain: ChainLink[] = [{ element: el, role: "self", note: "the selected element" }]
		  const own = ownDeclaration(el, axis)
		  const cs = getComputedStyle(el)

		  const done = (kind: SizeKind, decider: Element, note: string, previewChannel: "size" | "minmax-clamp" = "size"): SizeContext => {
		    if (decider !== el) chain.push({ element: decider, role: "decider", note })
		    else chain[0].note = note
		    return { axis, kind, decider, chain, previewChannel }
		  }

		  if (own.fixed) return done("declared", el, own.fixed)
		  if (cs.position === "absolute" || cs.position === "fixed") {
		    return done("containing-block", containingBlockOf(el), "the containing block")
		  }

		  // Classification is one level; the parent's display decides the branch.
		  const parent = layoutParent(el)
		  if (parent) {
		    const parentDisplay = getComputedStyle(parent).display
		    if (parentDisplay === "grid" || parentDisplay === "inline-grid") {
		      return axis === "width"
		        ? done("grid-track", parent, "the parent's column tracks", "minmax-clamp")
		        : done("grid-row", parent, "the row — auto rows size to the tallest item", "minmax-clamp")
		    }
		    if (parentDisplay === "flex" || parentDisplay === "inline-flex") {
		      return isMainAxis(parent, axis)
		        ? done("flex-main", parent, "a main-axis share against the siblings", "minmax-clamp")
		        : done("flex-cross", parent, "the cross axis — stretch makes it the tallest sibling", "size")
		    }
		  }

		  // THE ASYMMETRY: auto is HUG on height, FILL on width.
		  if (axis === "height") return done("hug", el, "height:auto hugs the content")
		  if (own.hug) return done("content", el, own.hug)

		  // width:auto in flow — the question forwards upward until something
		  // declares. Bounded by DOM depth; every visited ancestor joins the chain.
		  let node: Element | null = el
		  while (node) {
		    const ancestor = layoutParent(node)
		    if (!ancestor || ancestor === document.documentElement.parentElement) break
		    const declared = constrains(ancestor, axis)
		    if (declared) {
		      chain.push({ element: ancestor, role: "decider", note: declared })
		      return { axis, kind: "fill-chain", decider: ancestor, chain, previewChannel: "size" }
		    }
		    const ancestorDisplay = getComputedStyle(ancestor).display
		    if (ancestorDisplay === "grid" || ancestorDisplay === "inline-grid") {
		      chain.push({ element: ancestor, role: "decider", note: "the grid's column tracks" })
		      return { axis, kind: "grid-track", decider: ancestor, chain, previewChannel: "minmax-clamp" }
		    }
		    if (ancestorDisplay === "flex" || ancestorDisplay === "inline-flex") {
		      chain.push({ element: ancestor, role: "decider", note: "the flex container" })
		      return { axis, kind: "flex-main", decider: ancestor, chain, previewChannel: "minmax-clamp" }
		    }
		    chain.push({ element: ancestor, role: "pass-through", note: "width:auto — decides nothing" })
		    if (ancestor === document.documentElement || ancestor === document.body) break
		    node = ancestor
		  }
		  const root = document.documentElement
		  return { axis, kind: "viewport-root", decider: root, chain, previewChannel: "size" }
		}
	`
}

function generateParamPanel(): string {
	return dedent`
		import { bridge } from "./bridge"
		import { resolveSizeContext, type SizeContext } from "./size-resolver"

		/**
		 * The property panel — the Param model's face. Opens on element selection
		 * in the focused view: every supported property resolved FROM SOURCE by
		 * the host (token vs literal vs inherited visible, the active responsive
		 * variant named), verified against the runtime, edited as a splice.
		 *
		 * Panel edits default to precision, not detach: a value that names a
		 * token writes the token class; anything else writes an exact value onto
		 * the variant that is active at this viewport.
		 */

		interface PanelParam {
		  property: string
		  type: string
		  value: string | null
		  origin: string
		  writable: boolean
		  reason?: string
		  token?: string
		  variant: string | null
		  utility: string | null
		}

		let panel: HTMLDivElement | null = null
		let currentTarget: { filePath: string; caretId: string; lineNumber: number; element: Element } | null = null
		let lastParams: Map<string, PanelParam> = new Map()

		/** Multi-select (shift-click): the rest of the selection behind currentTarget. */
		let alsoSelected: Array<{ caretId: string; element: Element }> = []
		let shiftHeld = false
		window.addEventListener("keydown", (e) => { if (e.key === "Shift") shiftHeld = true })
		window.addEventListener("keyup", (e) => { if (e.key === "Shift") shiftHeld = false })
		window.addEventListener("blur", () => { shiftHeld = false })
		// The pointer event carries the REAL modifier state. Key events alone
		// miss it whenever the keydown went somewhere else (another frame, a
		// surface that stopped it), and then a genuine shift-click quietly
		// replaces the selection instead of growing it.
		//
		// BOTH pointerdown and mousedown: not every input source produces
		// pointer events (Electron's synthetic input notably does not), and
		// react-grab decides its selection on mousedown — so a pointer-only
		// reading is both incomplete and too late.
		window.addEventListener("pointerdown", (e) => { shiftHeld = e.shiftKey }, true)
		window.addEventListener("mousedown", (e) => { shiftHeld = e.shiftKey }, true)

		function outline(el: Element, on: boolean) {
		  ;(el as HTMLElement).style.outline = on ? "2px solid #7c6cf3" : ""
		  ;(el as HTMLElement).style.outlineOffset = on ? "2px" : ""
		}

		function clearSelectionExtras() {
		  for (const extra of alsoSelected) outline(extra.element, false)
		  if (currentTarget) outline(currentTarget.element, false)
		  alsoSelected = []
		}

		function viewportWidth(): number {
		  return window.innerWidth
		}

		function ensurePanel(): HTMLDivElement {
		  if (panel && panel.isConnected) return panel
		  panel = document.createElement("div")
		  panel.id = "caret-param-panel"
		  panel.setAttribute("data-react-grab-ignore-events", "")
		  panel.style.cssText = "position:fixed;top:64px;right:16px;width:264px;max-height:70vh;overflow:auto;z-index:99998;background:rgba(20,20,30,0.97);border:1px solid #3a3a4a;border-radius:12px;padding:12px 14px;font:12.5px/1.5 system-ui,sans-serif;color:#e5e7eb;box-shadow:0 8px 32px rgba(0,0,0,0.4);pointer-events:auto;"
		  document.body.appendChild(panel)
		  return panel
		}

		export function hideParamPanel() {
		  panel?.remove()
		  removeResizeHandles()
		  clearSelectionExtras()
		  currentTarget = null
		}

		/* The panel must sit BESIDE the selection, never on it. Its home is the
		 * top-right corner — which is exactly where a hero image or nav lives, so
		 * a fixed corner covered the very element being edited (reported in the
		 * field on a top-right photo). Order of preference: the home corner, the
		 * mirrored left corner, and for an element wide enough to own both, below
		 * it (or above when there is no room below). Recomputed on every show and
		 * every render, since the panel's height depends on its rows. */
		function positionPanel() {
		  if (!panel || !currentTarget || !currentTarget.element.isConnected) return
		  // Start from the home corner so measurement is deterministic.
		  panel.style.left = "auto"
		  panel.style.right = "16px"
		  panel.style.top = "64px"
		  const el = currentTarget.element.getBoundingClientRect()
		  const pad = 12
		  const box = panel.getBoundingClientRect()
		  const hits = (b: { left: number; right: number; top: number; bottom: number }) =>
		    el.left < b.right + pad && el.right > b.left - pad && el.top < b.bottom + pad && el.bottom > b.top - pad
		  if (!hits(box)) return
		  const mirrored = { left: 16, right: 16 + box.width, top: box.top, bottom: box.bottom }
		  if (!hits(mirrored)) {
		    panel.style.right = "auto"
		    panel.style.left = "16px"
		    return
		  }
		  // The element spans both corners: go below it, or above when the bottom
		  // of the viewport leaves no room.
		  let top = el.bottom + pad
		  if (top + box.height > window.innerHeight - pad) top = el.top - box.height - pad
		  panel.style.top = \`\${Math.max(12, Math.min(top, window.innerHeight - box.height - pad))}px\`
		}

		/* ── resize handles — Phase 10.2 ─────────────────────────────────────────
		 * The resolver runs AT POINTERDOWN (the preview channel depends on the
		 * layout context, so it must be known before the first frame), the drag
		 * previews through that channel (flex/grid via a min/max clamp —
		 * el.style.width does nothing on a flex-basis:0 child), and release
		 * clears the preview and commits ONCE through the source path. The
		 * preview never shows a state the commit cannot reproduce. */

		let handleHost: HTMLDivElement | null = null

		function removeResizeHandles() {
		  handleHost?.remove()
		  handleHost = null
		}

		function positionResizeHandles() {
		  if (!handleHost || !currentTarget) return
		  const rect = currentTarget.element.getBoundingClientRect()
		  const right = handleHost.children[0] as HTMLElement
		  const bottom = handleHost.children[1] as HTMLElement
		  right.style.cssText =
		    "position:fixed;z-index:99997;width:10px;height:28px;border-radius:5px;background:#7c6cf3;cursor:ew-resize;pointer-events:auto;" +
		    \`left:\${rect.right - 5}px;top:\${rect.top + rect.height / 2 - 14}px;\`
		  bottom.style.cssText =
		    "position:fixed;z-index:99997;width:28px;height:10px;border-radius:5px;background:#7c6cf3;cursor:ns-resize;pointer-events:auto;" +
		    \`left:\${rect.left + rect.width / 2 - 14}px;top:\${rect.bottom - 5}px;\`
		}

		function attachResizeHandles() {
		  removeResizeHandles()
		  if (!currentTarget) return
		  handleHost = document.createElement("div")
		  handleHost.id = "caret-resize-handles"
		  handleHost.setAttribute("data-react-grab-ignore-events", "")
		  const right = document.createElement("div")
		  right.dataset.axis = "width"
		  const bottom = document.createElement("div")
		  bottom.dataset.axis = "height"
		  handleHost.append(right, bottom)
		  document.body.appendChild(handleHost)
		  positionResizeHandles()

		  for (const handle of [right, bottom]) {
		    handle.addEventListener("pointerdown", (e) => startResizeDrag(e, handle.dataset.axis as "width" | "height"))
		  }
		}

		function startResizeDrag(e: PointerEvent, axis: "width" | "height") {
		  if (!currentTarget) return
		  e.preventDefault()
		  e.stopPropagation()
		  const el = currentTarget.element as HTMLElement
		  const target = currentTarget

		  // The resolver runs NOW — the preview channel must be known before the
		  // first frame of the drag.
		  const context: SizeContext = resolveSizeContext(el, axis)
		  const startRect = el.getBoundingClientRect()
		  const startPointer = axis === "width" ? e.clientX : e.clientY
		  let lastPx = axis === "width" ? startRect.width : startRect.height

		  const preview = (px: number) => {
		    if (context.previewChannel === "minmax-clamp") {
		      if (axis === "width") {
		        el.style.minWidth = el.style.maxWidth = \`\${px}px\`
		      } else {
		        el.style.minHeight = el.style.maxHeight = \`\${px}px\`
		      }
		    } else if (axis === "width") {
		      el.style.width = \`\${px}px\`
		    } else {
		      el.style.height = \`\${px}px\`
		    }
		  }
		  const clearPreview = () => {
		    el.style.removeProperty("width")
		    el.style.removeProperty("height")
		    el.style.removeProperty("min-width")
		    el.style.removeProperty("max-width")
		    el.style.removeProperty("min-height")
		    el.style.removeProperty("max-height")
		  }

		  const onMove = (ev: PointerEvent) => {
		    const delta = (axis === "width" ? ev.clientX : ev.clientY) - startPointer
		    lastPx = Math.max(8, Math.round((axis === "width" ? startRect.width : startRect.height) + delta))
		    preview(lastPx)
		    positionResizeHandles()
		  }
		  const onUp = () => {
		    window.removeEventListener("pointermove", onMove, true)
		    window.removeEventListener("pointerup", onUp, true)
		    window.removeEventListener("keydown", onKey, true)
		    clearPreview()
		    // The neighbourhood snapshot, BEFORE the commit: a write can succeed,
		    // verify clean on the node, and still break a sibling (measured on
		    // grid tracks). Verify the neighbourhood, not the node.
		    const snapshot = snapshotNeighbourhood(el)
		    bridge.send({
		      type: "resize-commit",
		      payload: {
		        filePath: target.filePath,
		        caretId: target.caretId,
		        axis,
		        px: lastPx,
		        kind: context.kind,
		        viewportWidth: viewportWidth(),
		      },
		    })
		    pendingVerify = { caretId: target.caretId, axis, wantPx: lastPx, snapshot, chainNote: context.chain[context.chain.length - 1]?.note ?? "" }
		  }
		  const onKey = (ev: KeyboardEvent) => {
		    if (ev.key !== "Escape") return
		    ev.stopPropagation()
		    window.removeEventListener("pointermove", onMove, true)
		    window.removeEventListener("pointerup", onUp, true)
		    window.removeEventListener("keydown", onKey, true)
		    clearPreview()
		    positionResizeHandles()
		  }
		  window.addEventListener("pointermove", onMove, true)
		  window.addEventListener("pointerup", onUp, true)
		  window.addEventListener("keydown", onKey, true)
		}

		/** Opens (or refreshes) the panel for a selected element. */
		export function showParamPanel(element: Element, filePath: string, lineNumber: number) {
		  const caretId = element.getAttribute("data-caret-id") || ""
		  if (!caretId) {
		    hideParamPanel()
		    return
		  }
		  // Shift-click grows the selection; a plain click resets it. The clicked
		  // element always becomes the one whose Params the rows show.
		  if (shiftHeld && currentTarget && currentTarget.filePath === filePath && currentTarget.caretId !== caretId) {
		    const previous = currentTarget
		    if (!alsoSelected.some((s) => s.caretId === previous.caretId)) {
		      alsoSelected.push({ caretId: previous.caretId, element: previous.element })
		    }
		    alsoSelected = alsoSelected.filter((s) => s.caretId !== caretId)
		  } else {
		    clearSelectionExtras()
		  }
		  currentTarget = { filePath, caretId, lineNumber, element }
		  outline(element, true)
		  for (const extra of alsoSelected) outline(extra.element, true)
		  const host = ensurePanel()
		  host.dataset.selectionCount = String(alsoSelected.length + 1)
		  // The panel's subject, known before its rows resolve.
		  host.dataset.caretId = caretId
		  attachResizeHandles()
		  host.innerHTML = '<div style="color:#8b93a7">resolving…</div>'
		  positionPanel()
		  bridge.send({ type: "param-resolve", payload: { filePath, caretId, viewportWidth: viewportWidth() } })
		}

		function requestRefresh() {
		  if (!currentTarget) return
		  bridge.send({
		    type: "param-resolve",
		    payload: { filePath: currentTarget.filePath, caretId: currentTarget.caretId, viewportWidth: viewportWidth() },
		  })
		}

		const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")

		function render(params: PanelParam[]) {
		  if (!currentTarget) return
		  lastParams = new Map(params.map((p) => [p.property, p]))
		  const host = ensurePanel()
		  const computed = window.getComputedStyle(currentTarget.element)

		  const rows = params.map((p) => {
		    // Runtime verification: when source resolution names a value and the
		    // runtime disagrees, something else is in play (an inline style, a
		    // wrapper) — say so instead of writing the wrong thing confidently.
		    const runtime = computed.getPropertyValue(p.property)
		    const disagrees = p.value !== null && p.type === "length" && runtime && p.value !== runtime && p.value !== "auto"

		    const originLabel =
		      p.origin === "token" ? \`token \${p.token}\` :
		      p.origin === "literal" ? (p.variant ? \`editing \${p.variant}: (\${p.variant === "sm" ? "640" : p.variant === "md" ? "768" : p.variant === "lg" ? "1024" : p.variant === "xl" ? "1280" : "1536"}px and up)\` : "literal") :
		      p.origin === "inherited" ? "inherited · sets here" :
		      p.origin

		    const disabled = !p.writable
		    const shown = p.value ?? runtime ?? ""
		    const swatch = p.type === "color" && shown
		      ? \`<span style="display:inline-block;width:10px;height:10px;border-radius:3px;border:1px solid #555;background:\${esc(shown)};margin-right:5px;vertical-align:-1px"></span>\`
		      : ""

		    return \`<div style="margin-bottom:8px" data-param-row="\${esc(p.property)}">
		      <div style="display:flex;justify-content:space-between;color:#8b93a7;font-size:11px">
		        <span>\${esc(p.property)}</span>
		        <span title="\${esc(p.reason || "")}">\${disagrees ? "≠ runtime · " : ""}\${esc(originLabel)}</span>
		      </div>
		      <div style="display:flex;align-items:center;gap:4px">
		        \${swatch}
		        <input data-param-input="\${esc(p.property)}" value="\${esc(p.token ?? shown)}" \${disabled || disagrees ? "disabled" : ""}
		          style="flex:1;background:#161622;border:1px solid #3a3a4a;border-radius:6px;color:\${disabled || disagrees ? "#666" : "#e5e7eb"};padding:3px 8px;font-size:12px;outline:none" />
		      </div>
		    </div>\`
		  }).join("")

		  // A .map() row: same template id rendered N times. Look edits are shared
		  // through the template; content comes from this row's data item.
		  const twins = Array.from(document.querySelectorAll(\`[data-caret-id="\${currentTarget.caretId}"]\`))
		  const bulkLine =
		    alsoSelected.length > 0
		      ? \`<div style="color:#c4b5fd;font-size:11px;margin:-6px 0 8px">\${alsoSelected.length + 1} elements selected · edits apply to all</div>\`
		      : ""
		  const rowLine =
		    twins.length > 1
		      ? \`<div style="color:#8b93a7;font-size:11px;margin:-6px 0 8px">row \${twins.indexOf(currentTarget.element) + 1} of \${twins.length} · look shared · content from item \${twins.indexOf(currentTarget.element) + 1}</div>\`
		      : ""

		  // Sizing modes — intent exposed, not inferred from a drag (Phase 10.3).
		  // Height leads with Hug: a pixel height clips when copy grows, so fixing
		  // it deserves more friction than fixing a width.
		  const chip = (axis: string, mode: string, label: string) =>
		    \`<button data-size-mode="\${axis}:\${mode}" style="all:unset;cursor:pointer;border:1px solid #3a3a4a;border-radius:6px;padding:1px 7px;font-size:11px;color:#c9cede">\${label}</button>\`
		  const modesLine =
		    alsoSelected.length === 0
		      ? \`<div style="display:flex;gap:6px;align-items:center;margin:-2px 0 10px;color:#8b93a7;font-size:11px">
		          <span>W</span>\${chip("width", "hug", "Hug")}\${chip("width", "fill", "Fill")}\${chip("width", "fixed", "Fixed")}
		          <span style="margin-left:6px">H</span>\${chip("height", "hug", "Hug")}\${chip("height", "fill", "Fill")}\${chip("height", "fixed", "Fixed")}
		        </div>\`
		      : ""

		  host.innerHTML = \`
		    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
		      <strong style="font-size:12px">\${esc(currentTarget.caretId)}</strong>
		      <button data-param-close style="all:unset;cursor:pointer;color:#8b93a7;font-size:15px;line-height:1">×</button>
		    </div>
		    \${bulkLine}\${rowLine}\${modesLine}\${rows}\`

		  host.querySelector("[data-param-close]")?.addEventListener("click", hideParamPanel)
		  for (const button of host.querySelectorAll<HTMLButtonElement>("[data-size-mode]")) {
		    button.addEventListener("click", () => {
		      if (!currentTarget) return
		      const [axis, mode] = (button.dataset.sizeMode ?? "").split(":") as ["width" | "height", string]
		      const el = currentTarget.element as HTMLElement
		      const rect = el.getBoundingClientRect()
		      const context = resolveSizeContext(el, axis)
		      let property = axis as string
		      let write: { token?: string; raw?: string }
		      if (mode === "hug") {
		        write = { token: axis === "width" ? "fit" : "auto" }
		      } else if (mode === "fill") {
		        if (axis === "width" && (context.kind === "flex-main" || context.kind === "flex-cross")) {
		          property = "flex"
		          write = { token: "1" }
		        } else {
		          write = { token: "full" }
		        }
		      } else {
		        write = { raw: \`\${Math.round(axis === "width" ? rect.width : rect.height)}px\` }
		      }
		      bridge.send({
		        type: "param-edit",
		        payload: {
		          filePath: currentTarget.filePath,
		          caretId: currentTarget.caretId,
		          property,
		          ...write,
		          viewportWidth: viewportWidth(),
		        },
		      })
		    })
		  }
		  for (const input of host.querySelectorAll<HTMLInputElement>("[data-param-input]")) {
		    input.addEventListener("keydown", (e) => {
		      if (e.key !== "Enter" || !currentTarget) return
		      const property = input.getAttribute("data-param-input") || ""
		      const raw = input.value.trim()
		      if (!raw) return
		      // A value that names a token writes the token; anything else is exact.
		      const looksLikeToken = /^(brand(-\\d+)?|neutral-\\d+|success|warning|error|info)$/.test(raw)
		      bridge.send({
		        type: "param-edit",
		        payload: {
		          filePath: currentTarget.filePath,
		          caretId: currentTarget.caretId,
		          property,
		          ...(looksLikeToken ? { token: raw } : { raw }),
		          viewportWidth: viewportWidth(),
		          ...(alsoSelected.length > 0 ? { alsoCaretIds: alsoSelected.map((s) => s.caretId) } : {}),
		        },
		      })
		    })
		  }
		  positionPanel()
		}

		export function isParamPanelOpen(): boolean {
		  return !!currentTarget && !!panel?.isConnected
		}

		/**
		 * Grows the selection from a raw shift-click. react-grab swallows
		 * modifier-clicks (its overlay never reports them as selections), so the
		 * grab plugin catches them in the capture phase and hands them here. The
		 * clicked element joins the open panel's page — same file by construction.
		 */
		export function extendParamSelection(element: Element) {
		  if (!currentTarget) return
		  const caretId = element.getAttribute("data-caret-id") || ""
		  if (!caretId || caretId === currentTarget.caretId) return
		  const previous = currentTarget
		  if (!alsoSelected.some((s) => s.caretId === previous.caretId)) {
		    alsoSelected.push({ caretId: previous.caretId, element: previous.element })
		  }
		  alsoSelected = alsoSelected.filter((s) => s.caretId !== caretId)
		  currentTarget = { filePath: previous.filePath, caretId, lineNumber: previous.lineNumber, element }
		  outline(element, true)
		  for (const extra of alsoSelected) outline(extra.element, true)
		  const host = ensurePanel()
		  host.dataset.selectionCount = String(alsoSelected.length + 1)
		  host.dataset.caretId = caretId
		  host.innerHTML = '<div style="color:#8b93a7">resolving…</div>'
		  bridge.send({
		    type: "param-resolve",
		    payload: { filePath: currentTarget.filePath, caretId, viewportWidth: viewportWidth() },
		  })
		}

		/* ── neighbourhood verification — Phase 10.4 ─────────────────────────────
		 * The verifier's own failure modes are designed against (all measured):
		 * transitions mid-animation report mismatches that don't exist, so they
		 * are suppressed during measurement; fonts settle first; comparison uses
		 * an epsilon (0.5px) because grid tracks are fractional and Math.round
		 * is not integer-safe. A verifier that cries wolf is worse than none. */

		interface NeighbourSnapshot {
		  siblings: Array<{ el: Element; left: number; top: number; width: number; overlapped: boolean }>
		  parentOverflowed: boolean
		}
		let pendingVerify: { caretId: string; axis: "width" | "height"; wantPx: number; snapshot: NeighbourSnapshot; chainNote: string } | null = null

		function snapshotNeighbourhood(el: Element): NeighbourSnapshot {
		  const parent = el.parentElement
		  const own = el.getBoundingClientRect()
		  const siblings = parent
		    ? Array.from(parent.children)
		        .filter((child) => child !== el)
		        .map((child) => {
		          const r = child.getBoundingClientRect()
		          const overlapped =
		            own.left < r.right - 1 && r.left < own.right - 1 && own.top < r.bottom - 1 && r.top < own.bottom - 1
		          return { el: child, left: r.left, top: r.top, width: r.width, overlapped }
		        })
		    : []
		  const parentOverflowed = parent ? parent.scrollWidth > parent.clientWidth + 1 : false
		  return { siblings, parentOverflowed }
		}

		function verifyToast(message: string, isWarn: boolean) {
		  const el = document.createElement("div")
		  el.dataset.caretVerifyToast = isWarn ? "warn" : "ok"
		  el.textContent = message
		  el.style.cssText =
		    "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:99999;padding:8px 16px;border-radius:8px;font:12.5px system-ui;color:#fff;box-shadow:0 2px 12px rgba(0,0,0,0.35);background:" +
		    (isWarn ? "#b45309" : "#16a34a")
		  document.body.appendChild(el)
		  setTimeout(() => el.remove(), isWarn ? 6000 : 2200)
		}

		async function runPendingVerify() {
		  const job = pendingVerify
		  pendingVerify = null
		  if (!job) return

		  // Settle protocol: transitions suppressed, fonts ready, two settled
		  // frames — then measure. Without this the verifier reports the middle
		  // of an animation as a mismatch.
		  const suppress = document.createElement("style")
		  suppress.textContent = "* { transition: none !important; animation: none !important; }"
		  document.head.appendChild(suppress)
		  try {
		    await document.fonts.ready
		    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

		    // HMR may have remounted the page — re-find by caret-id, never by handle.
		    const el = document.querySelector(\`[data-caret-id="\${job.caretId}"]\`)
		    if (!el) return
		    const rect = el.getBoundingClientRect()
		    const got = job.axis === "width" ? rect.width : rect.height

		    if (Math.abs(got - job.wantPx) > 0.5) {
		      verifyToast(
		        \`The \${job.axis} is \${Math.round(got)}px, not \${job.wantPx}px — it is decided by \${job.chainNote || "a parent constraint"}. Select that element to change it.\`,
		        true,
		      )
		      return
		    }

		    // The node is right — now the neighbourhood. REFLOW IS NOT DAMAGE:
		    // growing a flex child necessarily moves the ones after it, and
		    // flagging that would make the verifier cry wolf on every legitimate
		    // resize, which is the haunted feeling this whole design exists to
		    // prevent. Damage is: the container starts overflowing, a sibling is
		    // squeezed out of shape, or boxes that were apart now overlap.
		    const regressions: string[] = []
		    const parent = el.parentElement
		    if (parent && parent.scrollWidth > parent.clientWidth + 1 && !job.snapshot.parentOverflowed) {
		      regressions.push("the container now overflows")
		    }
		    for (const before of job.snapshot.siblings) {
		      if (!before.el.isConnected) continue
		      const now = before.el.getBoundingClientRect()
		      const shrink = before.width > 0 ? (before.width - now.width) / before.width : 0
		      if (shrink > 0.25) {
		        regressions.push(\`a sibling shrank \${Math.round(shrink * 100)}%\`)
		        continue
		      }
		      const overlapsNow =
		        rect.left < now.right - 1 && now.left < rect.right - 1 && rect.top < now.bottom - 1 && now.top < rect.bottom - 1
		      if (overlapsNow && !before.overlapped) regressions.push("it now overlaps a sibling")
		    }
		    if (regressions.length > 0) {
		      verifyToast(\`Resized to \${job.wantPx}px, but \${regressions[0]} — Cmd+Z undoes it.\`, true)
		    } else {
		      verifyToast(\`\${job.axis === "width" ? "Width" : "Height"} \${job.wantPx}px ✓\`, false)
		    }
		  } finally {
		    suppress.remove()
		  }
		}

		bridge.on("param-resolve-result", (payload: any) => {
		  if (!currentTarget || payload?.caretId !== currentTarget.caretId) return
		  render((payload.params || []) as PanelParam[])
		})

		/* react-grab FREEZES the selected element while its UI is up: ~80 computed
		 * properties (colors, padding, radius, transform, ...) are pinned as
		 * !important inline styles so the page holds still under the overlay. A
		 * class change applied by HMR is invisible behind those pins until
		 * deselect — the field report was a text-color edit that said "applied"
		 * and only showed after the panel closed. Unfreeze restores the element's
		 * pre-freeze inline style per property (usually none), so a pin removed
		 * early just makes that restore a no-op. Page code never writes
		 * !important inline styles and Caret's own preview pin is
		 * normal-priority, so the priority IS the signature of react-grab's pins. */
		function releaseFreezePins(root: Element) {
		  for (const node of [root, ...Array.from(root.querySelectorAll("*"))]) {
		    const style = (node as HTMLElement).style
		    if (!style || style.length === 0) continue
		    for (let i = style.length - 1; i >= 0; i--) {
		      const prop = style[i]
		      if (style.getPropertyPriority(prop) === "important") style.removeProperty(prop)
		    }
		  }
		}

		// After any successful edit, re-resolve — spans have moved. A resize's
		// verify runs after the HMR that applies it has had a beat to land.
		bridge.on("edit-result", (payload: any) => {
		  if (payload?.success && currentTarget) {
		    releaseFreezePins(currentTarget.element)
		    setTimeout(requestRefresh, 250)
		  }
		  if (payload?.success && pendingVerify) setTimeout(() => void runPendingVerify(), 700)
		  if (payload?.success === false) pendingVerify = null
		})
	`
}

function generateCaretGrabPlugin(): string {
	return dedent`
		import { bridge } from "./bridge"
		import { ackEdit, editPillEngaged } from "./edit-pill"
		import { attachAssetPicker } from "./asset-picker"
		import { extendParamSelection, hideParamPanel, isParamPanelOpen, showParamPanel } from "./param-panel"
		import "./layers-panel"

		// react-grab never reports a modifier-click as a selection, so shift-click
		// multi-select is the plugin's own gesture. Two subtleties: react-grab's
		// overlay is what the event actually hits, so the design element must be
		// resolved by POINT through the stack, not from e.target; and react-grab
		// may stop the click entirely, so pointerdown is handled too (extending
		// with the same element twice is a no-op, double-firing is safe).
		function shiftPick(e: MouseEvent) {
		  if (!e.shiftKey || !isParamPanelOpen()) return
		  // Hit-test the addressable elements by GEOMETRY rather than walking the
		  // element stack: react-grab's overlay sits above the page and its shape
		  // changes as it re-arms, so a stack walk silently stops finding the box
		  // under the pointer. The deepest element containing the point wins.
		  let target: Element | null = null
		  let bestDepth = -1
		  for (const el of Array.from(document.querySelectorAll("[data-caret-id]"))) {
		    if (el.closest("#caret-param-panel") || el.closest("#caret-layers-panel")) continue
		    const r = el.getBoundingClientRect()
		    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) continue
		    let depth = 0
		    let node = el.parentElement
		    while (node) {
		      depth++
		      node = node.parentElement
		    }
		    if (depth > bestDepth) {
		      bestDepth = depth
		      target = el
		    }
		  }
		  if (!target) return
		  e.preventDefault()
		  e.stopPropagation()
		  extendParamSelection(target)
		}
		window.addEventListener("pointerdown", shiftPick, true)
		window.addEventListener("mousedown", shiftPick, true)
		window.addEventListener("click", shiftPick, true)

		window.addEventListener("keydown", (e) => {
		  if (e.key === "Escape") hideParamPanel()
		  // The design layer's unified undo. Not while typing — contentEditable
		  // and inputs keep their native undo.
		  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
		    const active = document.activeElement as HTMLElement | null
		    if (active && (active.isContentEditable || active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return
		    e.preventDefault()
		    bridge.send({ type: e.shiftKey ? "design-redo" : "design-undo", payload: {} })
		  }
		})

		/**
		 * The rendered box of the element an edit is aimed at.
		 *
		 * Sent with the instruction so the host can tell the agent when a named
		 * asset is a poor fit for the space it is going into — a 400px logo in a
		 * 2400px hero should get a stated reason, not a silent upscale.
		 */
		function boxOf(el: Element | null): { width: number; height: number } | undefined {
		  if (!el) return undefined
		  const rect = el.getBoundingClientRect()
		  if (!rect.width || !rect.height) return undefined
		  return { width: Math.round(rect.width), height: Math.round(rect.height) }
		}

		function log(...args: unknown[]) {
		  console.log("[caret-grab]", ...args)
		  bridge.send({ type: "log", payload: { level: "info", message: args.map(String).join(" ") } })
		}

		function logError(...args: unknown[]) {
		  console.error("[caret-grab]", ...args)
		  bridge.send({ type: "log", payload: { level: "error", message: args.map(String).join(" ") } })
		}

		function getFocusedPage(): { pageId: string; filePath: string } | null {
		  return (window as any).__CARET_FOCUSED_PAGE__ || null
		}

		function isCanvasInfraFile(fp: string): boolean {
		  if (!fp) return true
		  return fp.includes("/lib/canvas/") || fp.includes("CanvasApp") || fp.includes("FocusedPageView") || fp.includes("PageThumbnail") || fp.includes("ErrorBoundary")
		}

		function getFiberFromElement(element: Element | Node): any {
		  let el: any = element
		  if (el.nodeType === 3) el = el.parentElement
		  if (!el) return null

		  const fiberKey = Object.keys(el).find((k: string) => k.startsWith("__reactFiber$"))
		  if (fiberKey) return el[fiberKey]

		  let parent = el.parentElement
		  while (parent) {
		    const key = Object.keys(parent).find((k: string) => k.startsWith("__reactFiber$"))
		    if (key) return parent[key]
		    parent = parent.parentElement
		  }
		  return null
		}

		type SourceLocation = { filePath: string; lineNumber: number; columnNumber: number; componentName: string }

		function parseDebugStack(debugStack: any): SourceLocation | null {
		  if (!debugStack) return null

		  let stackStr: string
		  if (typeof debugStack === "string") {
		    stackStr = debugStack
		  } else if (debugStack instanceof Error || typeof debugStack?.stack === "string") {
		    stackStr = debugStack.stack
		  } else {
		    return null
		  }

		  const lines = stackStr.split("\\n")
		  for (const line of lines) {
		    const match = line.match(/at\\s+(?:(\\S+)\\s+)?\\(?https?:\\/\\/[^/]+\\/(.+?):(\\d+):(\\d+)\\)?/)
		    if (!match) continue

		    const [, componentName, urlPath, lineStr] = match
		    const lineNumber = parseInt(lineStr, 10)

		    if (isCanvasInfraFile(urlPath)) continue
		    if (urlPath.includes("node_modules/")) continue
		    if (urlPath.startsWith("@") || urlPath.startsWith("vite/")) continue

		    return { filePath: urlPath, lineNumber, columnNumber: 0, componentName: componentName || "" }
		  }
		  return null
		}

		function resolveSourceFromFiber(element: Element | Node): SourceLocation | null {
		  try {
		    const fiber = getFiberFromElement(element)
		    if (!fiber) return null

		    const sourceMap: WeakMap<object, any> | undefined = (window as any).__caretSourceMap

		    let current = fiber
		    let depth = 0
		    while (current && depth < 30) {
		      // Priority 1: SWC __source via patched jsxDEV (exact line numbers)
		      if (sourceMap) {
		        const props = current.memoizedProps || current.pendingProps
		        if (props && typeof props === "object") {
		          const caretSource = sourceMap.get(props)
		          if (caretSource && caretSource.fileName) {
		            const rawPath = caretSource.fileName as string
		            const urlMatch = rawPath.match(/https?:\\/\\/[^/]+\\/(.+)/)
		            const filePath = urlMatch ? urlMatch[1] : rawPath
		            if (!isCanvasInfraFile(filePath) && !filePath.includes("node_modules/")) {
		              const componentName = typeof current.type === "function" ? (current.type.displayName || current.type.name || "") : ""
		              log("resolveSourceFromFiber: __caretSource hit", filePath, "line:", caretSource.lineNumber, "col:", caretSource.columnNumber)
		              return { filePath, lineNumber: caretSource.lineNumber || 0, columnNumber: caretSource.columnNumber || 0, componentName }
		            }
		          }
		        }
		      }
		      // Priority 2: _debugStack from React 19 (approximate line numbers)
		      if (current._debugStack) {
		        const result = parseDebugStack(current._debugStack)
		        if (result) return result
		      }
		      current = current.return
		      depth++
		    }
		    return null
		  } catch (err) {
		    logError("resolveSourceFromFiber failed:", err)
		    return null
		  }
		}

		let lastResolvedSource: SourceLocation | null = null

		/**
		 * Same-id elements FROM THE SAME SOURCE FILE, in DOM order. Caret-ids are
		 * unique per file, not per document: a page and its AppShell each have
		 * their own "span-3", and both render into one document. Counting twins
		 * with a bare id query shifted every .map() row's instance index by the
		 * number of colliding elements rendered before it — the host then edited
		 * the WRONG data item and refused with a mismatch (found in the field:
		 * AppShell's wordmark span-3 sat before the tasting-tag chips).
		 */
		function sameFileTwins(el: Element, filePath: string): Element[] {
		  const id = el.getAttribute("data-caret-id")
		  if (!id) return [el]
		  return Array.from(document.querySelectorAll('[data-caret-id="' + id + '"]')).filter((twin) => {
		    if (twin === el) return true
		    const source = resolveSourceFromFiber(twin)
		    return !!source && source.filePath === filePath
		  })
		}

		/* ── the colour popover — replaces the browser's <input type=color> ─────
		 * The Chromium colour popup broke three ways inside the embedded canvas
		 * view: paste never reached its hex field (the popup sits outside the
		 * app menu's ⌘V routing), clearing the field streamed garbage values
		 * straight to disk (every input event was a file write), and it anchored
		 * to a hidden input at 0,0. So colour edits get a surface Caret owns:
		 * the foundation's own tokens as swatches, a hex field that accepts
		 * typing AND paste, the system eyedropper, and an SV/hue area. The
		 * element previews live through an inline style; the FILE is written
		 * once, when a colour is settled on (swatch click, Enter in the hex
		 * field, drag release, eyedropper pick) — a stray drag or a cleared
		 * field can no longer land on disk. */
		let colorPopoverState: {
		  host: HTMLDivElement
		  el: HTMLElement
		  cssProp: string
		  outside: (e: Event) => void
		} | null = null

		/* The one live preview pin. Caret pages never use inline styles (the
		 * authoring rules ban them), so the preview can own the inline property
		 * outright: pin when a colour is being tried, unpin to hand back to the
		 * stylesheet. Tracking the pin module-wide is what keeps a second popover
		 * from mistaking the first one's leftover pin for the element's real
		 * style — that leak showed in the field as an edit that "didn't apply"
		 * until the element was deselected. */
		let colorPreviewPin: { el: HTMLElement; cssProp: string } | null = null
		let colorPreviewUnpinTimer: number | null = null

		function pinPreview(el: HTMLElement, cssProp: string, hex: string) {
		  if (colorPreviewPin && colorPreviewPin.el !== el) unpinPreview()
		  el.style.setProperty(cssProp, hex)
		  colorPreviewPin = { el, cssProp }
		}

		function unpinPreview() {
		  if (colorPreviewUnpinTimer !== null) {
		    window.clearTimeout(colorPreviewUnpinTimer)
		    colorPreviewUnpinTimer = null
		  }
		  if (colorPreviewPin) {
		    colorPreviewPin.el.style.removeProperty(colorPreviewPin.cssProp)
		    colorPreviewPin = null
		  }
		}

		// The colour the user settled on. The detach toast's promote action reads
		// this rather than the hex that rode in the edit-result.
		let lastPickedHex = ""

		function cssColorToHex(c: string): string {
		  const m = c.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/)
		  if (!m) return c && c.startsWith("#") ? c : "#000000"
		  return "#" + [m[1], m[2], m[3]].map((v) => parseInt(v).toString(16).padStart(2, "0")).join("")
		}

		function hexToHsv(hex: string): { h: number; s: number; v: number } {
		  const n = hex.replace("#", "")
		  const full = n.length === 3 ? n.split("").map((c) => c + c).join("") : n
		  const r = parseInt(full.slice(0, 2), 16) / 255
		  const g = parseInt(full.slice(2, 4), 16) / 255
		  const b = parseInt(full.slice(4, 6), 16) / 255
		  const max = Math.max(r, g, b)
		  const min = Math.min(r, g, b)
		  const d = max - min
		  let h = 0
		  if (d !== 0) {
		    if (max === r) h = ((g - b) / d) % 6
		    else if (max === g) h = (b - r) / d + 2
		    else h = (r - g) / d + 4
		    h *= 60
		    if (h < 0) h += 360
		  }
		  return { h, s: max === 0 ? 0 : d / max, v: max }
		}

		function hsvToHex(h: number, s: number, v: number): string {
		  const c = v * s
		  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
		  const m = v - c
		  let r = 0, g = 0, b = 0
		  if (h < 60) { r = c; g = x } else if (h < 120) { r = x; g = c } else if (h < 180) { g = c; b = x }
		  else if (h < 240) { g = x; b = c } else if (h < 300) { r = x; b = c } else { r = c; b = x }
		  return "#" + [r + m, g + m, b + m].map((ch) => Math.round(ch * 255).toString(16).padStart(2, "0")).join("")
		}

		function normalizeHexInput(raw: string): string | null {
		  const cleaned = raw.trim().replace(/^#/, "")
		  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(cleaned)) return null
		  const full = cleaned.length === 3 ? cleaned.split("").map((c) => c + c).join("") : cleaned
		  return "#" + full.toLowerCase()
		}

		/** The foundation's bindable colours, read from the theme's own CSS vars. */
		function tokenSwatchGroups(): Array<{ label: string; entries: Array<{ token: string; hex: string }> }> {
		  const rootStyle = window.getComputedStyle(document.documentElement)
		  const steps = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"]
		  const groups: Array<{ label: string; entries: Array<{ token: string; hex: string }> }> = []
		  for (const family of ["brand", "secondary", "accent", "neutral"]) {
		    const entries: Array<{ token: string; hex: string }> = []
		    for (const step of steps) {
		      const value = rootStyle.getPropertyValue("--color-" + family + "-" + step).trim()
		      if (value) entries.push({ token: family + "-" + step, hex: value })
		    }
		    if (entries.length > 0) groups.push({ label: family, entries })
		  }
		  const semantic: Array<{ token: string; hex: string }> = []
		  for (const name of ["success", "warning", "error", "info"]) {
		    const value = rootStyle.getPropertyValue("--color-" + name).trim()
		    if (value) semantic.push({ token: name, hex: value })
		  }
		  if (semantic.length > 0) groups.push({ label: "semantic", entries: semantic })
		  return groups
		}

		function closeColorPopover(cancelled: boolean) {
		  const state = colorPopoverState
		  if (!state) return
		  colorPopoverState = null
		  document.removeEventListener("pointerdown", state.outside, true)
		  state.host.remove()
		  if (cancelled) {
		    // Nothing was written: hand straight back to the stylesheet.
		    unpinPreview()
		  } else {
		    // Committed: the pin already shows the NEW colour (commit paints it
		    // before closing), so the screen is right immediately. Drop the pin
		    // once HMR has applied the real class underneath — same colour, so
		    // the handover is invisible.
		    if (colorPreviewUnpinTimer !== null) window.clearTimeout(colorPreviewUnpinTimer)
		    colorPreviewUnpinTimer = window.setTimeout(() => {
		      colorPreviewUnpinTimer = null
		      unpinPreview()
		    }, 1800)
		  }
		  try { (window as any).__REACT_GRAB__?.activate?.() } catch {}
		}

		function openColorPopover(el: HTMLElement, filePath: string, lineNumber: number) {
		  closeColorPopover(true)
		  // Any pin left by a previous popover (including a post-commit handover
		  // still waiting on its timer) must be gone BEFORE the starting colour
		  // is read, or this popover opens on the preview instead of the truth.
		  unpinPreview()
		  ;(window as any).__REACT_GRAB__?.deactivate?.()

		  // The runtime is the only honest source for the starting colour — a
		  // token class (bg-brand-500) carries no parseable hex. But a fully
		  // transparent background is "no background", not black: fall through
		  // to the text colour rather than opening on #000000.
		  const computed = window.getComputedStyle(el)
		  const bg = computed.backgroundColor
		  const bgTransparent = !bg || bg === "transparent" || /rgba\\([^)]*,\\s*0\\)\\s*$/.test(bg)
		  const cssProp = bgTransparent ? "color" : "background-color"
		  let hsv = hexToHsv(cssColorToHex(bgTransparent ? computed.color : bg))

		  const host = document.createElement("div")
		  host.id = "caret-color-popover"
		  host.setAttribute("data-react-grab-ignore-events", "")
		  host.style.cssText = "position:fixed;z-index:99999;width:236px;background:rgba(20,20,30,0.97);border:1px solid #3a3a4a;border-radius:12px;padding:12px;font:12px/1.4 system-ui,sans-serif;color:#e5e7eb;box-shadow:0 8px 32px rgba(0,0,0,0.4);pointer-events:auto;"
		  const eye = (window as any).EyeDropper ? '<button data-color-eye title="Pick from screen" style="all:unset;cursor:pointer;font-size:14px;padding:2px 4px">💧</button>' : ""
		  const groupsHtml = tokenSwatchGroups()
		    .map(function (group) {
		      const swatches = group.entries
		        .map(function (entry) {
		          return '<span data-color-token="' + entry.hex + '" title="' + entry.token + " " + entry.hex + '" style="display:inline-block;width:15px;height:15px;border-radius:3px;margin:1px;cursor:pointer;border:1px solid rgba(255,255,255,0.15);background:' + entry.hex + '"></span>'
		        })
		        .join("")
		      return '<div style="margin-top:6px"><div style="font-size:9.5px;text-transform:uppercase;letter-spacing:0.06em;color:#8b93a7">' + group.label + "</div><div>" + swatches + "</div></div>"
		    })
		    .join("")
		  host.innerHTML =
		    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><strong style="font-size:11.5px">Colour</strong><button data-color-close style="all:unset;cursor:pointer;color:#8b93a7;font-size:14px;line-height:1">×</button></div>' +
		    '<canvas data-color-sv width="212" height="118" style="display:block;border-radius:6px;cursor:crosshair"></canvas>' +
		    '<canvas data-color-hue width="212" height="12" style="display:block;border-radius:6px;cursor:crosshair;margin-top:8px"></canvas>' +
		    '<div style="display:flex;align-items:center;gap:6px;margin-top:8px">' +
		    '<span data-color-preview style="display:inline-block;width:22px;height:22px;border-radius:5px;border:1px solid rgba(255,255,255,0.2)"></span>' +
		    '<input data-color-hex spellcheck="false" style="flex:1;min-width:0;background:#12121c;border:1px solid #3a3a4a;border-radius:6px;color:#e5e7eb;font:11.5px ui-monospace,monospace;padding:4px 6px;outline:none" />' +
		    eye +
		    "</div>" +
		    groupsHtml
		  document.body.appendChild(host)

		  // Beside the element, clamped to the viewport — never on it, never at 0,0.
		  const rect = el.getBoundingClientRect()
		  const size = host.getBoundingClientRect()
		  let x = rect.right + 12
		  if (x + size.width > window.innerWidth - 8) x = rect.left - size.width - 12
		  if (x < 8) x = Math.min(Math.max(8, rect.left), window.innerWidth - size.width - 8)
		  const y = Math.min(Math.max(8, rect.top), window.innerHeight - size.height - 8)
		  host.style.left = Math.round(x) + "px"
		  host.style.top = Math.round(y) + "px"

		  const sv = host.querySelector("[data-color-sv]") as HTMLCanvasElement
		  const hue = host.querySelector("[data-color-hue]") as HTMLCanvasElement
		  const hexInput = host.querySelector("[data-color-hex]") as HTMLInputElement
		  const preview = host.querySelector("[data-color-preview]") as HTMLElement

		  function currentHex(): string { return hsvToHex(hsv.h, hsv.s, hsv.v) }

		  function drawSv() {
		    const ctx = sv.getContext("2d")
		    if (!ctx) return
		    ctx.fillStyle = hsvToHex(hsv.h, 1, 1)
		    ctx.fillRect(0, 0, sv.width, sv.height)
		    const white = ctx.createLinearGradient(0, 0, sv.width, 0)
		    white.addColorStop(0, "rgba(255,255,255,1)")
		    white.addColorStop(1, "rgba(255,255,255,0)")
		    ctx.fillStyle = white
		    ctx.fillRect(0, 0, sv.width, sv.height)
		    const black = ctx.createLinearGradient(0, 0, 0, sv.height)
		    black.addColorStop(0, "rgba(0,0,0,0)")
		    black.addColorStop(1, "rgba(0,0,0,1)")
		    ctx.fillStyle = black
		    ctx.fillRect(0, 0, sv.width, sv.height)
		    ctx.beginPath()
		    ctx.arc(hsv.s * sv.width, (1 - hsv.v) * sv.height, 5, 0, Math.PI * 2)
		    ctx.strokeStyle = "#fff"
		    ctx.lineWidth = 2
		    ctx.stroke()
		  }

		  function drawHue() {
		    const ctx = hue.getContext("2d")
		    if (!ctx) return
		    for (let i = 0; i < hue.width; i++) {
		      ctx.fillStyle = "hsl(" + Math.round((i / hue.width) * 360) + ",100%,50%)"
		      ctx.fillRect(i, 0, 1, hue.height)
		    }
		    const x = (hsv.h / 360) * hue.width
		    ctx.fillStyle = "#fff"
		    ctx.fillRect(Math.round(x) - 1, 0, 2, hue.height)
		  }

		  function refresh(options?: { fromInput?: boolean; paint?: boolean }) {
		    drawSv()
		    drawHue()
		    const hex = currentHex()
		    preview.style.background = hex
		    if (!options?.fromInput) hexInput.value = hex
		    // Paint the element only for a real colour interaction — pinning the
		    // STARTING colour at open masked every later change until the pin
		    // dropped, which read as "the edit didn't apply".
		    if (options?.paint !== false) pinPreview(el, cssProp, hex)
		  }

		  function commit(hex: string) {
		    // The screen changes the instant the user decides, whatever the path
		    // in — swatch, Enter, drag release, eyedropper.
		    pinPreview(el, cssProp, hex)
		    lastPickedHex = hex
		    sentInlineEditHere = true
		    bridge.send({
		      type: "inline-edit",
		      payload: {
		        editType: "color",
		        filePath,
		        lineNumber,
		        oldValue: "",
		        newValue: hex,
		        caretId: el.getAttribute("data-caret-id") || "",
		        // The property this popover previewed — the host edits the class
		        // the user was looking at, not the first colour-ish one.
		        targetProperty: cssProp === "background-color" ? "background" : "text",
		      },
		    })
		    closeColorPopover(false)
		  }

		  function dragOn(canvas: HTMLCanvasElement, update: (e: PointerEvent) => void) {
		    canvas.addEventListener("pointerdown", (e) => {
		      e.preventDefault()
		      canvas.setPointerCapture(e.pointerId)
		      update(e)
		      const move = (ev: PointerEvent) => update(ev)
		      const up = () => {
		        canvas.removeEventListener("pointermove", move)
		        canvas.removeEventListener("pointerup", up)
		        commit(currentHex())
		      }
		      canvas.addEventListener("pointermove", move)
		      canvas.addEventListener("pointerup", up)
		    })
		  }

		  dragOn(sv, (e) => {
		    const box = sv.getBoundingClientRect()
		    hsv.s = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width))
		    hsv.v = Math.min(1, Math.max(0, 1 - (e.clientY - box.top) / box.height))
		    refresh()
		  })
		  dragOn(hue, (e) => {
		    const box = hue.getBoundingClientRect()
		    hsv.h = Math.min(359.9, Math.max(0, ((e.clientX - box.left) / box.width) * 360))
		    refresh()
		  })

		  hexInput.addEventListener("input", () => {
		    const hex = normalizeHexInput(hexInput.value)
		    if (hex) {
		      hsv = hexToHsv(hex)
		      refresh({ fromInput: true })
		    }
		  })
		  hexInput.addEventListener("keydown", (e) => {
		    e.stopPropagation()
		    if (e.key === "Enter") {
		      const hex = normalizeHexInput(hexInput.value)
		      if (hex) commit(hex)
		    }
		    if (e.key === "Escape") closeColorPopover(true)
		  })

		  host.addEventListener("click", (e) => {
		    const target = e.target as HTMLElement
		    if (target.closest("[data-color-close]")) closeColorPopover(true)
		    const swatch = target.closest("[data-color-token]") as HTMLElement | null
		    if (swatch) commit(swatch.getAttribute("data-color-token") || currentHex())
		    if (target.closest("[data-color-eye]")) {
		      new (window as any).EyeDropper().open().then(
		        (picked: { sRGBHex: string }) => commit(picked.sRGBHex),
		        () => {},
		      )
		    }
		  })

		  const outside = (e: Event) => {
		    if (!(e.target as Element)?.closest?.("#caret-color-popover")) closeColorPopover(true)
		  }
		  window.setTimeout(() => document.addEventListener("pointerdown", outside, true), 0)

		  colorPopoverState = { host, el, cssProp, outside }
		  refresh({ paint: false })
		  hexInput.focus()
		  hexInput.select()
		}

		/** True once THIS frame has sent an inline edit — the feedback gate. */
		let sentInlineEditHere = false
		/** The text edit in flight, so a failure can put the original back. */
		let pendingTextRevert: { el: Element; original: string; newText: string } | null = null

		const dynamicRangesMap: Map<string, Array<{ startLine: number; startCol: number; endLine: number; endCol: number; diagnostics: string[] }>> = new Map()

		// macOS aliases /var to /private/var, and the fiber's path and the host's
		// resolved path can land on opposite sides of it. A miss here silently
		// disables the whole dynamic-content gate, so both spellings are one key.
		function normalizeRangePath(p: string): string {
		  return p.replace(/^\\/private\\//, "/")
		}

		function isInDynamicRange(filePath: string, line: number, col: number, diagnosticType?: string): boolean {
		  const ranges = dynamicRangesMap.get(normalizeRangePath(filePath))
		  if (!ranges) return false
		  return ranges.some(r => {
		    const afterStart = line > r.startLine || (line === r.startLine && col >= r.startCol)
		    const beforeEnd = line < r.endLine || (line === r.endLine && col <= r.endCol)
		    const matches = afterStart && beforeEnd
		    return matches && (!diagnosticType || r.diagnostics.includes(diagnosticType))
		  })
		}

		function resolveElementSource(rgSource: any, element?: Element | Node): SourceLocation | null {
		  const page = getFocusedPage()
		  if (!page) return rgSource || null

		  if (element) {
		    const fiberSource = resolveSourceFromFiber(element)
		    if (fiberSource && !isCanvasInfraFile(fiberSource.filePath)) {
		      log("resolveElementSource: fiber hit", JSON.stringify(fiberSource))
		      lastResolvedSource = fiberSource
		      return fiberSource
		    }
		  }

		  if (rgSource && !isCanvasInfraFile(rgSource.filePath)) {
		    lastResolvedSource = rgSource
		    return rgSource
		  }

		  const fallback = { filePath: page.filePath, lineNumber: 0, columnNumber: 0, componentName: rgSource?.componentName || "" }
		  lastResolvedSource = fallback
		  return fallback
		}

		function showToast(message: string, type: "success" | "error") {
		  const toast = document.createElement("div")
		  toast.setAttribute("data-caret-toast", type)
		  toast.textContent = message
		  toast.style.cssText = \`position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:99999;padding:10px 20px;border-radius:8px;font-size:13px;font-family:system-ui,sans-serif;color:#fff;pointer-events:none;opacity:0;transition:opacity 0.2s;\${type === "success" ? "background:#16a34a;" : "background:#dc2626;"}\`
		  document.body.appendChild(toast)
		  requestAnimationFrame(() => { toast.style.opacity = "1" })
		  setTimeout(() => {
		    toast.style.opacity = "0"
		    setTimeout(() => toast.remove(), 200)
		  }, 3000)
		}

		/**
		 * The one actionable toast: an inline colour edit just detached an element
		 * from a foundation token. The alternative — edit the token, reaching every
		 * use — stays one click away without a modal in the gesture's path.
		 * Replaces itself on successive drag events rather than stacking.
		 */
		function showDetachToast(payload: any) {
		  const existing = document.getElementById("caret-detach-toast")
		  if (existing) existing.remove()
		  const target = payload.editTarget
		  if (!target || !target.filePath) return

		  const toast = document.createElement("div")
		  toast.id = "caret-detach-toast"
		  // pointer-events must be explicit: active react-grab sets none on the
		  // body and the property inherits — a button that paints but cannot be
		  // clicked is the exact failure the asset picker already hit.
		  toast.setAttribute("data-react-grab-ignore-events", "")
		  toast.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:99999;display:flex;align-items:center;gap:12px;padding:10px 16px;border-radius:8px;font-size:13px;font-family:system-ui,sans-serif;color:#fff;background:#1e1e2e;border:1px solid #444;box-shadow:0 8px 24px rgba(0,0,0,0.35);pointer-events:auto;opacity:0;transition:opacity 0.2s;"

		  const msg = document.createElement("span")
		  msg.textContent = "Detached from " + payload.detachedFrom + "."
		  toast.appendChild(msg)

		  const uses = typeof payload.tokenUses === "number" ? payload.tokenUses : 0
		  const btn = document.createElement("button")
		  btn.textContent = "Change the token instead" + (uses > 0 ? " (" + uses + " place" + (uses === 1 ? "" : "s") + ")" : "")
		  btn.style.cssText = "all:unset;cursor:pointer;color:#0b7aff;font-weight:500;white-space:nowrap;"
		  btn.addEventListener("click", () => {
		    bridge.send({
		      type: "promote-token",
		      payload: {
		        token: payload.detachedFrom,
		        hex: lastPickedHex || "",
		        filePath: target.filePath,
		        lineNumber: target.lineNumber || 0,
		        caretId: target.caretId || "",
		      },
		    })
		    toast.remove()
		  })
		  toast.appendChild(btn)

		  document.body.appendChild(toast)
		  requestAnimationFrame(() => { toast.style.opacity = "1" })
		  setTimeout(() => {
		    if (!toast.isConnected) return
		    toast.style.opacity = "0"
		    setTimeout(() => toast.remove(), 200)
		  }, 8000)
		}

		function showAiEditFallback(errorMessage: string) {
		  const existing = document.getElementById("caret-ai-edit-fallback")
		  if (existing) existing.remove()

		  const card = document.createElement("div")
		  card.id = "caret-ai-edit-fallback"
		  card.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:99999;background:#1e1e2e;border:1px solid #444;border-radius:12px;padding:16px 20px;font-family:system-ui,sans-serif;box-shadow:0 8px 32px rgba(0,0,0,0.4);max-width:400px;width:90%;"

		  const closeBtn = document.createElement("button")
		  closeBtn.textContent = "×"
		  closeBtn.style.cssText = "position:absolute;top:8px;right:12px;background:none;border:none;color:#a1a1aa;font-size:20px;cursor:pointer;padding:0;line-height:1;"
		  closeBtn.addEventListener("click", () => card.remove())
		  card.appendChild(closeBtn)

		  const msg = document.createElement("p")
		  msg.textContent = errorMessage
		  msg.style.cssText = "margin:0 0 12px;font-size:13px;color:#f87171;line-height:1.4;padding-right:20px;"
		  card.appendChild(msg)

		  const label = document.createElement("p")
		  label.textContent = "Describe what you want to change:"
		  label.style.cssText = "margin:0 0 8px;font-size:12px;color:#a1a1aa;"
		  card.appendChild(label)

		  const row = document.createElement("div")
		  row.style.cssText = "display:flex;gap:8px;"

		  const input = document.createElement("input")
		  input.type = "text"
		  input.placeholder = "e.g. Change text to 'Hello World', or @ for an asset"
		  input.style.cssText = "flex:1;padding:8px 12px;border-radius:6px;border:1px solid #555;background:#2a2a3e;color:#fff;font-size:13px;outline:none;"
		  row.appendChild(input)

		  const btn = document.createElement("button")
		  btn.textContent = "Send"
		  btn.style.cssText = "padding:8px 16px;border-radius:6px;border:none;background:#6366f1;color:#fff;font-size:13px;cursor:pointer;font-weight:500;"
		  row.appendChild(btn)

		  card.appendChild(row)
		  document.body.appendChild(card)
		  input.focus()

		  const detachPicker = attachAssetPicker(input)

		  const submit = () => {
		    const text = input.value.trim()
		    if (!text || !lastResolvedSource) return
		    log("ai-edit-fallback: submitting", text)
		    const selectedEl = document.querySelector("[data-rg-selected]") as HTMLElement | null
		    bridge.send({
		      type: "ai-edit-request",
		      payload: {
		        instruction: text,
		        filePath: lastResolvedSource.filePath,
		        lineNumber: lastResolvedSource.lineNumber,
		        columnNumber: lastResolvedSource.columnNumber,
		        componentName: lastResolvedSource.componentName,
		        caretId: "",
		        componentStack: "",
		        box: boxOf(selectedEl),
		      },
		    })
		    ackEdit(text, selectedEl)
		    detachPicker()
		    card.remove()
		  }

		  btn.addEventListener("click", submit)
		  input.addEventListener("keydown", (e: KeyboardEvent) => {
		    if (e.key === "Enter") submit()
		    if (e.key === "Escape") { detachPicker(); card.remove() }
		  })
		}

		async function initPlugin() {
		  log("initializing caret-grab-plugin")

		  bridge.on("edit-result", (payload: any) => {
		    // Only the frame that SENT an inline edit gives feedback. This plugin
		    // loads in the canvas document AND in the focused iframe, and both hear
		    // every result — the iframe (which knows the edit's source) showed the
		    // fallback card while the canvas document fell to the generic branch
		    // and showed a toast: one failure, two surfaces, reported in the field.
		    if (!sentInlineEditHere) return
		    // A failed text edit must not leave the typed text on screen: the next
		    // attempt would capture it as the "before" value and be refused as
		    // stale — one transient failure then poisons every retry. Restore the
		    // original, exactly as Escape does. Guarded so an HMR-applied change is
		    // never clobbered: only text still reading as the rejected input reverts.
		    if (!payload.success && pendingTextRevert) {
		      const { el, original, newText } = pendingTextRevert
		      if (el.isConnected && (el.textContent || "") === newText) el.textContent = original
		    }
		    pendingTextRevert = null
		    // AI/overlay edits resolve at the pill; a toast on top would say the
		    // same thing twice in two visual languages. Inline edits keep the toast.
		    if (editPillEngaged()) return
		    if (payload.success) {
		      log("edit-result: SUCCESS")
		      if (payload.detachedFrom) {
		        showDetachToast(payload)
		      } else if (payload.boundTo) {
		        const stale = document.getElementById("caret-detach-toast")
		        if (stale) stale.remove()
		        showToast("Matched " + payload.boundTo + " — bound to the token", "success")
		      } else {
		        showToast("Edit applied", "success")
		      }
		    } else if (payload.suggestAiEdit && lastResolvedSource) {
		      logError("edit-result: FAILED (suggesting AI edit) -", payload.error)
		      showAiEditFallback(payload.error || "This content can't be edited inline.")
		    } else {
		      logError("edit-result: FAILED -", payload.error || "unknown error")
		      showToast(payload.error || "Edit failed", "error")
		    }
		  })

		  bridge.on("precompute-result", (payload: any) => {
		    if (payload.filePath && Array.isArray(payload.dynamicRanges)) {
		      dynamicRangesMap.set(normalizeRangePath(payload.filePath), payload.dynamicRanges)
		      log("precompute-result: loaded", payload.dynamicRanges.length, "dynamic ranges for", payload.filePath)
		    }
		  })

		  const rg = await import("react-grab")
		  const api = (window as any).__REACT_GRAB__
		  log("react-grab loaded, api exists:", !!api)

		  if (!api) {
		    logError("window.__REACT_GRAB__ is null after import — react-grab failed to self-init")
		    return
		  }

		  // react-grab's "navigate element hierarchy" tree (the dark component-list
		  // panel) opens on arrow/Tab navigation AND whenever its shift-held tracker
		  // is set — and that tracker sticks: the macOS screen-recording chord
		  // (⌘⇧5) delivers Shift-down to this window while the system HUD swallows
		  // the keyup, so every hover afterwards grows a component tree over the
		  // page. There is no API to disable the panel. It is display-only by
		  // design (react-grab renders it with interactive={false}), so hiding it
		  // in the shadow root removes every trigger at once without touching any
		  // input handling — selection, arrows, prompt mode all behave as before,
		  // minus the panel. The host mounts lazily, hence the retry.
		  const killHierarchyPanel = (attempts = 0) => {
		    const host = document.querySelector("[data-react-grab]")
		    if (!host?.shadowRoot) {
		      if (attempts < 100) setTimeout(() => killHierarchyPanel(attempts + 1), 100)
		      else logError("hierarchy-panel kill: [data-react-grab] host never appeared")
		      return
		    }
		    const style = document.createElement("style")
		    style.textContent = "[data-react-grab-hierarchy-menu] { display: none !important; }"
		    host.shadowRoot.appendChild(style)
		    log("hierarchy panel hidden")
		  }
		  killHierarchyPanel()

		  rg.registerPlugin({
		    name: "caret",
		    hooks: {
		      async onElementSelect(element: Element) {
		        try {
		          const rgSource = await api.getSource(element)
		          const source = resolveElementSource(rgSource, element)
		          log("onElementSelect:", JSON.stringify(source), "(raw:", JSON.stringify(rgSource), ")")
		          if (!source) return true
		          // Selection payload v2: the caret-id addresses the Param model, the
		          // box carries geometry, and the computed values are the runtime's
		          // half of source-resolves-runtime-verifies.
		          const rect = element.getBoundingClientRect()
		          const cs = window.getComputedStyle(element)
		          const computed: Record<string, string> = {}
		          for (const prop of ["color", "background-color", "border-color", "font-size", "font-weight", "padding-top", "padding-right", "padding-bottom", "padding-left", "margin-top", "gap", "width", "height", "border-radius", "opacity"]) {
		            computed[prop] = cs.getPropertyValue(prop)
		          }
		          bridge.send({
		            type: "element-selected",
		            payload: {
		              filePath: source.filePath,
		              lineNumber: source.lineNumber,
		              componentName: source.componentName,
		              tagName: element.tagName.toLowerCase(),
		              props: {},
		              caretId: element.getAttribute("data-caret-id") || "",
		              box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
		              computed,
		            },
		          })
		          showParamPanel(element, source.filePath, source.lineNumber)
		          // react-grab consumes its activation when a selection is handled,
		          // so without re-arming it only the FIRST element of a session is
		          // ever selectable: click one box, click another, nothing happens.
		          // Re-armed on the next tick (activate() is idempotent).
		          setTimeout(() => {
		            try {
		              ;(window as any).__REACT_GRAB__?.activate?.()
		            } catch {}
		          }, 0)
		        } catch (err) {
		          logError("onElementSelect error:", err)
		        }
		        return true
		      },

		      onOpenFile(filePath: string, lineNumber?: number) {
		        const page = getFocusedPage()
		        if (page && isCanvasInfraFile(filePath)) {
		          const resolved = lastResolvedSource?.filePath || page.filePath
		          const resolvedLine = lastResolvedSource?.lineNumber || lineNumber
		          log("onOpenFile:", resolved, resolvedLine, "(from cached fiber source)")
		          bridge.send({ type: "open-file", payload: { filePath: resolved, lineNumber: resolvedLine } })
		        } else {
		          log("onOpenFile:", filePath, lineNumber)
		          bridge.send({ type: "open-file", payload: { filePath, lineNumber } })
		        }
		        return true
		      },

		      onPromptModeChange(isPrompt: boolean) {
		        if (!isPrompt) return
		        log("prompt mode activated, waiting for input element")

		        let attempts = 0
		        const tryAttach = () => {
		          attempts++
		          const host = document.querySelector("[data-react-grab]")
		          if (!host?.shadowRoot) { logError("prompt mode: no shadow root"); return }
		          const input = host.shadowRoot.querySelector("textarea") || host.shadowRoot.querySelector("input[type=text]") || host.shadowRoot.querySelector("input")
		          if (!input) {
		            if (attempts < 20) { setTimeout(tryAttach, 50); return }
		            logError("prompt mode: no input element found after " + attempts + " attempts")
		            return
		          }
		          log("prompt mode: input found after " + attempts + " attempts")
		          let pendingValue = ""
		          const onInput = () => { pendingValue = (input as HTMLInputElement | HTMLTextAreaElement).value }
		          // Before the submit handler on purpose. Both are capture listeners
		          // on the same element, so they fire in registration order, and the
		          // picker has to consume Enter first or picking an asset also sends.
		          const detachPicker = attachAssetPicker(input as HTMLInputElement | HTMLTextAreaElement)
		          const handler = (e: KeyboardEvent) => {
		            if (e.key !== "Enter" || e.shiftKey) return
		            const prompt = pendingValue.trim() || (input as HTMLInputElement | HTMLTextAreaElement).value.trim()
		            if (!prompt || !lastResolvedSource) {
		              log("prompt submit skipped: prompt=" + JSON.stringify(prompt) + " source=" + JSON.stringify(lastResolvedSource))
		              return
		            }
		            log("prompt submitted:", prompt, "source:", JSON.stringify(lastResolvedSource))
		            const selectedEl = document.querySelector("[data-rg-selected]") as HTMLElement | null
		            bridge.send({
		              type: "ai-edit-request",
		              payload: {
		                instruction: prompt,
		                filePath: lastResolvedSource.filePath,
		                lineNumber: lastResolvedSource.lineNumber,
		                columnNumber: lastResolvedSource.columnNumber,
		                componentName: lastResolvedSource.componentName,
		                caretId: selectedEl?.getAttribute("data-caret-id") || "",
		                componentStack: "",
		                box: boxOf(selectedEl),
		              },
		            })
		            ackEdit(prompt, selectedEl)
		            detachPicker()
		            input.removeEventListener("keydown", handler, true)
		            input.removeEventListener("input", onInput)
		          }
		          input.addEventListener("input", onInput)
		          input.addEventListener("keydown", handler, true)
		        }
		        tryAttach()
		      },
		    },

		    actions: [
		      {
		        id: "caret-ai-edit",
		        label: "AI Edit",
		        onAction(ctx: any) {
		          const el = ctx.element
		          if (el) {
		            const source = resolveElementSource(null, el)
		            log("ai-edit action: resolved source before prompt mode", JSON.stringify(source))
		          }
		          ctx.enterPromptMode?.()
		        },
		      },
		      {
		        id: "caret-edit-text",
		        label: "Edit text",
		        enabled: (ctx: any) => {
		          const el = ctx.element
		          if (!el) return false
		          const directText = Array.from(el.childNodes).filter((n: any) => n.nodeType === 3).map((n: any) => n.textContent || "").join("")
		          if (!directText.trim()) return false
		          const allText = el.textContent || ""
		          if (directText.trim() !== allText.trim()) return false
		          const source = resolveSourceFromFiber(el)
		          if (source && isInDynamicRange(source.filePath, source.lineNumber, source.columnNumber, "dynamic-text")) {
		            // A .map() row (one template id, many rendered instances) IS
		            // editable: the content edit routes to the row's data item
		            // (Phase 8.6). Only single-instance dynamic text stays blocked.
		            // Twins counted per source file — another file's same-named id
		            // must not make a lone dynamic span look like a row.
		            if (!el.getAttribute("data-caret-id") || sameFileTwins(el, source.filePath).length < 2) return false
		          }
		          return true
		        },
		        async onAction(ctx: any) {
		          const el = ctx.element
		          if (!el) return
		          const source = resolveElementSource(null, el)
		          const filePath = source?.filePath
		          if (!filePath) { logError("edit-text: no filePath"); return }
		          const lineNumber = source?.lineNumber || 0
		          log("edit-text action:", filePath, "line:", lineNumber, el.tagName, el.textContent?.slice(0, 40))

		          const original = el.textContent || ""
		          // The selection layer stands down while the text is edited.
		          // react-grab is deliberately re-armed after every selection, so a
		          // click inside the editable — the user placing their cursor —
		          // reads to it as a grab: it copies element context, toasts
		          // "Copied", and the focus theft blurs the edit closed after one
		          // keystroke-less click. Re-armed on finish and on Escape.
		          ;(window as any).__REACT_GRAB__?.deactivate?.()
		          el.contentEditable = "true"
		          el.focus()

		          let editSent = false
		          const finish = () => {
		            if (editSent) return
		            editSent = true
		            el.contentEditable = "false"
		            el.removeEventListener("blur", onBlur)
		            el.removeEventListener("keydown", onKeyDown)
		            try { (window as any).__REACT_GRAB__?.activate?.() } catch {}
		            const newText = el.textContent || ""
		            if (newText !== original) {
		              log("edit-text: sending", filePath, JSON.stringify(original), "->", JSON.stringify(newText))
		              // Same-id siblings FROM THIS FILE mean a .map() template: say
		              // WHICH row this is, so the host can route the content edit to
		              // that data item. The index counts this file's instances only —
		              // ids are per-file, and another component's same-named id in
		              // the document must not shift it.
		              const twins = sameFileTwins(el, filePath)
		              sentInlineEditHere = true
		              pendingTextRevert = { el, original, newText }
		              bridge.send({
		                type: "inline-edit",
		                payload: {
		                  editType: "text",
		                  filePath,
		                  lineNumber,
		                  oldValue: original,
		                  newValue: newText,
		                  tagName: el.tagName.toLowerCase(),
		                  caretId: el.getAttribute("data-caret-id") || "",
		                  ...(twins.length > 1 ? { instanceIndex: twins.indexOf(el) } : {}),
		                },
		              })
		            }
		          }

		          const onBlur = () => finish()
		          const onKeyDown = (e: KeyboardEvent) => {
		            if (e.key === "Enter" && !e.shiftKey) {
		              e.preventDefault()
		              finish()
		            }
		            if (e.key === "Escape") {
		              editSent = true
		              el.textContent = original
		              el.contentEditable = "false"
		              el.removeEventListener("blur", onBlur)
		              el.removeEventListener("keydown", onKeyDown)
		              try { (window as any).__REACT_GRAB__?.activate?.() } catch {}
		            }
		          }

		          el.addEventListener("blur", onBlur)
		          el.addEventListener("keydown", onKeyDown)
		        },
		      },
		      {
		        id: "caret-edit-color",
		        label: "Edit color",
		        enabled: (ctx: any) => {
		          const el = ctx.element
		          if (!el) return false
		          const source = resolveSourceFromFiber(el)
		          if (source && isInDynamicRange(source.filePath, source.lineNumber, source.columnNumber, "dynamic-tailwind-class")) return false
		          return true
		        },
		        onAction(ctx: any) {
		          const el = ctx.element
		          if (!el) return
		          const source = resolveElementSource(null, el)
		          const filePath = source?.filePath
		          if (!filePath) { logError("edit-color: no filePath"); return }
		          const lineNumber = source?.lineNumber || 0
		          log("edit-color action:", filePath, "line:", lineNumber)
		          openColorPopover(el, filePath, lineNumber)
		        },
		      },
		      {
		        id: "caret-replace-image",
		        label: "Replace image",
		        enabled: (ctx: any) => {
		          if (ctx.element?.tagName !== "IMG") return false
		          const source = resolveSourceFromFiber(ctx.element)
		          if (source && isInDynamicRange(source.filePath, source.lineNumber, source.columnNumber, "dynamic-image-src")) return false
		          return true
		        },
		        onAction(ctx: any) {
		          const el = ctx.element
		          if (!el) return
		          const source = resolveElementSource(null, el)
		          const filePath = source?.filePath
		          if (!filePath) { logError("replace-image: no filePath"); return }
		          const lineNumber = source?.lineNumber || 0
		          log("replace-image action:", filePath, "line:", lineNumber)

		          const input = document.createElement("input")
		          input.type = "file"
		          input.accept = "image/*"

		          const rg = (window as any).__REACT_GRAB__
		          if (rg) rg.deactivate()

		          input.addEventListener("change", () => {
		            const file = input.files?.[0]
		            if (!file) {
		              if (rg) rg.activate()
		              return
		            }
		            const reader = new FileReader()
		            reader.onload = () => {
		              sentInlineEditHere = true
		              bridge.send({
		                type: "inline-edit",
		                payload: {
		                  editType: "image",
		                  filePath,
		                  lineNumber,
		                  oldValue: "",
		                  newValue: file.name,
		                  imageData: reader.result as string,
		                  caretId: el.getAttribute("data-caret-id") || "",
		                },
		              })
		              if (rg) rg.activate()
		            }
		            reader.readAsDataURL(file)
		          })

		          input.click()
		        },
		      },
		    ],
		  })

		  log("caret plugin registered")
		}

		initPlugin().catch((err) => {
		  console.error("[caret-grab] initPlugin failed:", err)
		  bridge.send({ type: "log", payload: { level: "error", message: "initPlugin failed: " + String(err) } })
		})
	`
}
