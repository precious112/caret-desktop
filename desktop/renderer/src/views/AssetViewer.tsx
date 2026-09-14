/**
 * One asset, large, where the canvas was.
 *
 * The canvas is a native WebContentsView layered *above* this document, so this
 * overlay is invisible while the canvas shows — App hides the canvas for as
 * long as a tag is being viewed and restores it on close, the same mechanism
 * every full-window surface uses. It fills only the canvas's own column: the
 * chat sidebar is a sibling flex item, so the conversation that opened the
 * viewer stays usable beside it, and clicking another tag swaps the content in
 * place rather than stacking viewers.
 */
import { X } from "lucide-react"
import { useEffect, useState } from "react"

import type { AssetEntryWire, ProjectState } from "../../../shared/ipc"
import { invoke, on } from "../ipc"

export function AssetViewer({ project, tag, onClose }: { project: ProjectState; tag: string; onClose(): void }) {
	// `null` until the first list arrives, so a slow index reads as loading
	// rather than flashing "no such asset" at a tag that exists.
	const [assets, setAssets] = useState<AssetEntryWire[] | null>(null)

	useEffect(() => {
		const refresh = () => void invoke("assets:list", project.path).then((list) => setAssets(list ?? []))
		refresh()
		return on("assets:changed", (changed) => {
			if (changed === project.path) refresh()
		})
	}, [project.path])

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose()
		}
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [onClose])

	const asset = assets?.find((entry) => entry.tag === tag) ?? null

	// Same rule as the library's thumbnails: this chrome is not served by Vite,
	// so the index's `/caret-assets/…` path must be absolutised against the
	// design server or it 404s against the chrome's own origin.
	const absolute = (url: string) => (project.canvasUrl ? new URL(url, project.canvasUrl).toString() : null)

	return (
		<div className="absolute inset-0 z-40 flex flex-col bg-shell-bg" data-testid="asset-viewer">
			<header className="flex h-10 shrink-0 items-center gap-2 border-b border-shell-border px-4">
				<span className="font-mono text-[12px]" data-testid="asset-viewer-tag">
					@{tag}
				</span>
				{asset && (
					<span className="text-xs text-shell-muted">
						{asset.width && asset.height ? `${asset.width}×${asset.height}` : asset.kind}
					</span>
				)}
				<div className="flex-1" />
				<button
					className="flex size-7 shrink-0 items-center justify-center rounded-lg text-shell-muted transition-colors hover:bg-white/10 hover:text-shell-text"
					data-testid="asset-viewer-close"
					onClick={onClose}
					title="Close"
					type="button">
					<X size={13} />
				</button>
			</header>

			<div className="flex min-h-0 flex-1 items-center justify-center p-8">
				{assets === null ? null : asset === null ? (
					<p className="text-shell-muted">Nothing is tagged @{tag} any more.</p>
				) : (
					<Large absolute={absolute} asset={asset} />
				)}
			</div>

			{asset?.description && (
				<p className="shrink-0 border-t border-shell-border px-4 py-3 text-center text-[12px] leading-relaxed text-shell-muted">
					{asset.description}
				</p>
			)}
		</div>
	)
}

/**
 * The asset itself, by kind. Video shows its extracted poster when one exists —
 * a still is what "a closer look" means here — and falls back to the element a
 * decoded frame comes from when it does not. 3D keeps the labelled placeholder
 * for the same reason the library does: a still needs a renderer.
 */
function Large({ asset, absolute }: { asset: AssetEntryWire; absolute(url: string): string | null }) {
	const src = absolute(asset.kind === "video" && asset.posterUrl ? asset.posterUrl : asset.url)
	if (!src) return <span className="text-xs uppercase tracking-wide text-shell-muted">loading</span>

	if (asset.kind === "image" || asset.kind === "vector" || (asset.kind === "video" && asset.posterUrl)) {
		return <img alt={asset.alt || asset.tag} className="max-h-full max-w-full object-contain" src={src} />
	}
	if (asset.kind === "video") {
		// A tenth of a second in, for the same reason the library skips frame zero:
		// plenty of video opens black, and a black frame answers nothing.
		return <video className="max-h-full max-w-full object-contain" muted playsInline preload="auto" src={`${src}#t=0.1`} />
	}
	return <span className="text-xs uppercase tracking-wide text-shell-muted">{asset.kind}</span>
}
