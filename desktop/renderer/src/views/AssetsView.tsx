/**
 * The asset library.
 *
 * Two jobs, and the second is the one that matters. Getting files *in* is
 * ordinary (drop, or a native picker). Getting them **described** is the part
 * that makes `@tag` work: an agent placing an image needs to know it is dark and
 * wide with room top-left, and no amount of metadata about byte counts supplies
 * that. So the description field is the loudest thing on each row, and an
 * undescribed asset says so rather than looking finished.
 */
import { useCallback, useEffect, useRef, useState } from "react"

import type { AssetEntryWire, GeneratedProvenanceWire, ProjectState } from "../../../shared/ipc"
import { invoke, on, pathForFile } from "../ipc"
import { cn } from "../lib/utils"
import { GenerateAsset } from "./GenerateAsset"

export function AssetsView({ project, onClose }: { project: ProjectState; onClose(): void }) {
	const [assets, setAssets] = useState<AssetEntryWire[]>([])
	const [dragging, setDragging] = useState(false)
	const [problems, setProblems] = useState<Array<{ file: string; reason: string }>>([])
	const [busy, setBusy] = useState(false)
	const [generating, setGenerating] = useState(false)

	const refresh = useCallback(async () => {
		setAssets((await invoke("assets:list", project.path)) ?? [])
	}, [project.path])

	useEffect(() => {
		void refresh()
	}, [refresh])

	// Assets can arrive from an agent or from Finder, not only from this surface,
	// so the list follows the index rather than only its own writes.
	useEffect(
		() =>
			on("assets:changed", (changed) => {
				if (changed === project.path) void refresh()
			}),
		[project.path, refresh],
	)

	const add = useCallback(
		async (paths: string[]) => {
			if (paths.length === 0) return
			setBusy(true)
			try {
				const result = await invoke("assets:add", project.path, paths)
				setProblems(result?.rejected ?? [])
				await refresh()
			} finally {
				setBusy(false)
			}
		},
		[project.path, refresh],
	)

	/**
	 * A drop is two different operations depending on where it came from.
	 *
	 * From Finder, the file exists on disk and main copies it — cheap at any
	 * size. From a browser, a mail client or a preview pane there is no path at
	 * all, only bytes; that used to be read off the removed `File.path` and
	 * silently produced nothing. Each file takes whichever route it has.
	 */
	const onDrop = useCallback(
		async (event: React.DragEvent) => {
			event.preventDefault()
			setDragging(false)

			const dropped = [...event.dataTransfer.files]
			if (dropped.length === 0) return

			const paths: string[] = []
			const pathless: File[] = []
			for (const file of dropped) {
				const filePath = pathForFile(file)
				if (filePath) paths.push(filePath)
				else pathless.push(file)
			}

			setBusy(true)
			try {
				const problems: Array<{ file: string; reason: string }> = []
				if (paths.length > 0) {
					problems.push(...((await invoke("assets:add", project.path, paths))?.rejected ?? []))
				}
				if (pathless.length > 0) {
					const encoded = await Promise.all(
						pathless.map(async (file) => ({
							name: file.name,
							base64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
						})),
					)
					problems.push(...((await invoke("assets:addBytes", project.path, encoded))?.rejected ?? []))
				}
				setProblems(problems)
				await refresh()
			} finally {
				setBusy(false)
			}
		},
		[project.path, refresh],
	)

	const undescribed = assets.filter((asset) => !asset.description).length

	return (
		<div
			className="relative flex flex-1 flex-col overflow-hidden bg-shell-bg"
			data-testid="assets-view"
			onDragLeave={() => setDragging(false)}
			onDragOver={(event) => {
				event.preventDefault()
				setDragging(true)
			}}
			onDrop={onDrop}>
			<header className="flex items-center justify-between border-b border-shell-border px-8 py-4">
				<div>
					<h1 className="text-lg font-semibold">Assets</h1>
					<p className="text-sm text-shell-muted">
						{assets.length === 0
							? "Images, vectors, video and 3D models your agent can use by name."
							: `${assets.length} asset${assets.length === 1 ? "" : "s"}${undescribed > 0 ? ` · ${undescribed} still undescribed` : ""}`}
					</p>
				</div>
				<div className="flex gap-2">
					<button
						className="rounded-md border border-shell-border px-3 py-1.5 text-sm disabled:opacity-50"
						data-testid="assets-generate"
						disabled={busy}
						onClick={() => setGenerating(true)}
						type="button">
						Generate
					</button>
					<button
						className="rounded-md bg-caret-accent px-3 py-1.5 text-sm text-white disabled:opacity-50"
						data-testid="assets-add"
						disabled={busy}
						onClick={async () => add((await invoke("assets:pickFiles")) ?? [])}
						type="button">
						Add files
					</button>
					<button className="rounded-md border border-shell-border px-3 py-1.5 text-sm" onClick={onClose} type="button">
						Done
					</button>
				</div>
			</header>

			{problems.length > 0 && (
				<div className="border-b border-shell-border bg-amber-500/10 px-8 py-3 text-sm">
					{problems.map((problem) => (
						<p key={problem.file}>
							<span className="font-medium">{problem.file}</span> — {problem.reason}
						</p>
					))}
				</div>
			)}

			<div className={cn("flex-1 overflow-y-auto px-8 py-6", dragging && "bg-caret-accent/5")}>
				{assets.length === 0 ? (
					<div className="mx-auto mt-16 max-w-md text-center text-shell-muted">
						<p className="text-sm">Drop files here, or use Add files.</p>
						<p className="mt-2 text-xs">
							Everything you add is copied into <code>.caret/assets/</code> and versioned with the design, so it
							travels with the project.
						</p>
					</div>
				) : (
					<ul className="mx-auto flex max-w-3xl flex-col gap-3">
						{assets.map((asset) => (
							<AssetRow
								asset={asset}
								canvasUrl={project.canvasUrl}
								key={asset.tag}
								onChanged={refresh}
								projectPath={project.path}
							/>
						))}
					</ul>
				)}
			</div>

			{generating && (
				<GenerateAsset
					onClose={async () => {
						setGenerating(false)
						// Photographs generated and not chosen are held in main so a pick
						// hands back the exact picture. Closing is when they stop being
						// candidates, and holding megabytes of unwanted images is not free.
						await invoke("generate:discard", project.path)
						// The watcher fires too, but not before this returns — refreshing
						// here is what makes the new asset visible the instant the panel
						// closes rather than a beat later.
						await refresh()
					}}
					project={project}
				/>
			)}
		</div>
	)
}

function AssetRow({
	asset,
	projectPath,
	canvasUrl,
	onChanged,
}: {
	asset: AssetEntryWire
	projectPath: string
	canvasUrl: string | null
	onChanged(): void | Promise<void>
}) {
	const [tag, setTag] = useState(asset.tag)
	const [description, setDescription] = useState(asset.description)
	const [alt, setAlt] = useState(asset.alt)
	const [error, setError] = useState<string | null>(null)
	const [showProvenance, setShowProvenance] = useState(false)

	// The index is the source of truth: an agent describing this asset while the
	// row is open should not be overwritten by stale local state.
	const dirty = useRef(false)
	useEffect(() => {
		if (dirty.current) return
		setTag(asset.tag)
		setDescription(asset.description)
		setAlt(asset.alt)
	}, [asset.tag, asset.description, asset.alt])

	const commitTag = async () => {
		dirty.current = false
		if (tag === asset.tag) return
		const result = await invoke("assets:retag", projectPath, asset.tag, tag)
		if (result?.ok) {
			setError(null)
			await onChanged()
		} else {
			setError(result?.error ?? "Could not rename.")
			setTag(asset.tag)
		}
	}

	const commitText = async () => {
		dirty.current = false
		if (description === asset.description && alt === asset.alt) return
		await invoke("assets:describe", projectPath, asset.tag, { alt, description })
		await onChanged()
	}

	return (
		<li className="flex gap-4 rounded-lg border border-shell-border p-3" data-testid="asset-row">
			<Thumbnail asset={asset} canvasUrl={canvasUrl} onChanged={onChanged} projectPath={projectPath} />

			<div className="flex min-w-0 flex-1 flex-col gap-2">
				<div className="flex items-center gap-2">
					<span className="text-shell-muted">@</span>
					<input
						className="min-w-0 flex-1 bg-transparent font-mono text-sm outline-none"
						data-testid="asset-tag"
						onBlur={commitTag}
						onChange={(event) => {
							dirty.current = true
							setTag(event.target.value)
						}}
						onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
						value={tag}
					/>
					<span className="shrink-0 text-xs text-shell-muted">
						{asset.width && asset.height ? `${asset.width}×${asset.height}` : asset.kind}
						{" · "}
						{formatBytes(asset.bytes)}
					</span>
					{asset.generated && (
						<button
							className={cn(
								"shrink-0 rounded border px-1.5 py-0.5 text-xs",
								showProvenance ? "border-caret-accent text-caret-accent" : "border-shell-border text-shell-muted",
							)}
							data-testid="asset-generated-chip"
							onClick={() => setShowProvenance((open) => !open)}
							title="How this asset was made"
							type="button">
							generated
						</button>
					)}
					<button
						className="shrink-0 text-xs text-shell-muted hover:text-red-400"
						onClick={async () => {
							await invoke("assets:remove", projectPath, asset.tag)
							await onChanged()
						}}
						type="button">
						Remove
					</button>
				</div>

				<input
					className={cn(
						"w-full rounded border bg-transparent px-2 py-1 text-sm outline-none",
						description ? "border-shell-border" : "border-amber-500/40",
					)}
					data-testid="asset-description"
					onBlur={commitText}
					onChange={(event) => {
						dirty.current = true
						setDescription(event.target.value)
					}}
					placeholder="What does it look like? e.g. wide, dark, empty space top-left"
					value={description}
				/>

				<input
					className="w-full rounded border border-shell-border bg-transparent px-2 py-1 text-xs outline-none"
					data-testid="asset-alt"
					onBlur={commitText}
					onChange={(event) => {
						dirty.current = true
						setAlt(event.target.value)
					}}
					placeholder="Alt text"
					value={alt}
				/>

				{error && <p className="text-xs text-red-400">{error}</p>}

				{showProvenance && asset.generated && <ProvenancePanel provenance={asset.generated} />}
			</div>
		</li>
	)
}

/**
 * The full provenance record, readable.
 *
 * Everything `index.json` knows about how the asset was made — lane, producer,
 * recipe, the answers given, what it cost, what post-processing did, and the
 * resolved request itself. The chip alone said "generated" and made reading the
 * rest mean opening a JSON file, which is not what "complete and honest"
 * provenance was supposed to mean.
 */
function ProvenancePanel({ provenance }: { provenance: GeneratedProvenanceWire }) {
	const rows: Array<[string, string]> = [["Lane", laneLabel(provenance.lane)]]
	rows.push([provenance.lane === "generator" ? "Generator" : "Model", provenance.producer])
	if (provenance.recipeId) rows.push(["Recipe", provenance.recipeId])
	for (const [question, answer] of Object.entries(provenance.answers ?? {})) {
		rows.push([`Answered · ${question}`, answer])
	}
	if (provenance.cost) {
		const { amount, unit, round, note } = provenance.cost
		const roundText = round ? ` (the round of ${round.calls} options: ${round.amount.toLocaleString()} ${unit})` : ""
		rows.push(["Cost", `${amount.toLocaleString()} ${unit}${roundText}${note ? ` — ${note}` : ""}`])
	} else if (provenance.lane === "generator") {
		rows.push(["Cost", "nothing — computed locally, no model involved"])
	} else {
		rows.push(["Cost", "not recorded"])
	}
	if (provenance.postProcessed) {
		const { from, to } = provenance.postProcessed
		rows.push([
			"Post-processing",
			`${formatBytes(from.bytes)} ${from.mime} → ${formatBytes(to.bytes)} ${to.mime}, ${to.width}×${to.height}`,
		])
	}

	return (
		<dl className="rounded border border-shell-border p-2 text-xs" data-testid="asset-provenance">
			{rows.map(([label, value]) => (
				<div className="flex gap-2 py-0.5" key={label}>
					<dt className="w-36 shrink-0 text-shell-muted">{label}</dt>
					<dd className="min-w-0 flex-1 break-words">{value}</dd>
				</div>
			))}
			{provenance.resolved && (
				<div className="flex gap-2 py-0.5">
					<dt className="w-36 shrink-0 text-shell-muted">Resolved request</dt>
					<dd className="min-w-0 flex-1">
						{/* The exact thing that produced the file — the field somebody reads
						    months later. Scrolls rather than truncates: a truncated prompt
						    hides precisely the constraints the record exists to keep. */}
						<pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] text-shell-muted">
							{prettyResolved(provenance.resolved)}
						</pre>
					</dd>
				</div>
			)}
		</dl>
	)
}

/** The lane, in the user's words rather than the enum's. */
function laneLabel(lane: string): string {
	const labels: Record<string, string> = {
		raster: "photograph — image model",
		generator: "vector — generated by code",
		authored: "mark — model-authored SVG",
		iconset: "icon set",
		model3d: "3D — image to model",
	}
	return labels[lane] ?? lane
}

/** JSON pretty-printed when it is JSON; the prompt verbatim when it is prose. */
function prettyResolved(resolved: string): string {
	try {
		return JSON.stringify(JSON.parse(resolved), null, 2)
	} catch {
		return resolved
	}
}

/**
 * What an asset looks like, by kind.
 *
 * Images and vectors show themselves. Video shows a **real frame**: the browser
 * has to decode one to display the element anyway, so the same frame is grabbed
 * to a canvas and stored as the asset's poster — which is what lets an agent
 * asking `get_asset` about a video receive a look at it rather than a sentence
 * about it. No ffmpeg on the user's machine, and nothing pretended at.
 *
 * 3D models still get a labelled placeholder. A still needs a renderer, and
 * adding a WebGL dependency to the chrome for a 112×80 thumbnail is not a
 * trade worth making yet.
 *
 * The src is absolute against the design server. This chrome is not served by
 * Vite, so the `/caret-assets/…` path the index records would resolve against
 * the chrome's own origin and silently 404.
 */
function Thumbnail({
	asset,
	canvasUrl,
	projectPath,
	onChanged,
}: {
	asset: AssetEntryWire
	canvasUrl: string | null
	projectPath: string
	onChanged(): void | Promise<void>
}) {
	const absolute = (url: string) => (canvasUrl ? new URL(url, canvasUrl).toString() : null)
	const src = absolute(asset.url)
	const box =
		"flex h-20 w-28 shrink-0 items-center justify-center overflow-hidden rounded border border-shell-border bg-black/20"

	if (asset.kind === "image" || asset.kind === "vector") {
		return (
			<div className={box}>
				{src ? (
					<img alt={asset.alt || asset.tag} className="max-h-full max-w-full object-contain" src={src} />
				) : (
					<span className="text-xs uppercase tracking-wide text-shell-muted">loading</span>
				)}
			</div>
		)
	}

	if (asset.kind === "video" && src) {
		return (
			<div className={box}>
				<video
					className="max-h-full max-w-full object-contain"
					data-testid="asset-video"
					muted
					// Metadata alone is not enough to paint: the frame has to be decoded,
					// which is also what makes it capturable.
					onLoadedData={async (event) => {
						if (asset.posterUrl) return
						const video = event.currentTarget
						const canvas = document.createElement("canvas")
						canvas.width = video.videoWidth
						canvas.height = video.videoHeight
						if (!canvas.width || !canvas.height) return
						const context = canvas.getContext("2d")
						if (!context) return
						context.drawImage(video, 0, 0)
						try {
							await invoke("assets:setPoster", projectPath, asset.tag, canvas.toDataURL("image/png"))
							await onChanged()
						} catch {
							// A poster is an enhancement. Failing to store one must not
							// take down the row it belongs to.
						}
					}}
					playsInline
					preload="auto"
					// A tenth of a second in, not zero: plenty of video opens on a black
					// or blank frame, and a black poster is no more use than none.
					src={`${src}#t=0.1`}
				/>
			</div>
		)
	}

	return (
		<div className={box}>
			<span className="text-xs uppercase tracking-wide text-shell-muted">{asset.kind}</span>
		</div>
	)
}

/** Chunked because `String.fromCharCode(...bytes)` blows the argument limit. */
function bytesToBase64(bytes: Uint8Array): string {
	let binary = ""
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
	}
	return btoa(binary)
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
