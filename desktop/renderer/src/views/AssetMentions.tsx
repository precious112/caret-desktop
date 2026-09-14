/**
 * `@tag` autocomplete for the chat composer.
 *
 * The same feature as the canvas picker and deliberately not the same code: the
 * canvas one is generated into the user's project, where it has to survive a
 * shadow root and a third-party overlay, while this one is an ordinary React
 * component in Caret's own window. What they do share is `desktop/shared/mentions`,
 * so both agree on what a mention is and where it starts.
 *
 * Selection is on **mousedown**, before focus can move — a click that first
 * blurred the textarea would close the list it was aimed at.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { AssetEntryWire, ProjectState } from "../../../shared/ipc"
import { applyMention, mentionQueryAt, rankMentions } from "../../../shared/mentions"
import { invoke, on } from "../ipc"
import { cn } from "../lib/utils"

interface Args {
	project: ProjectState
	draft: string
	setDraft(value: string): void
	inputRef: React.RefObject<HTMLTextAreaElement | null>
}

export interface AssetMentions {
	open: boolean
	matches: AssetEntryWire[]
	highlighted: number
	/** Call first from the composer's own key handler; true means consumed. */
	handleKeyDown(event: React.KeyboardEvent): boolean
	choose(asset: AssetEntryWire): void
	setHighlighted(index: number): void
	/** Types the `@` and opens the list, for the composer's asset button. */
	begin(): void
	canvasUrl: string | null
}

export function useAssetMentions({ project, draft, setDraft, inputRef }: Args): AssetMentions {
	const [assets, setAssets] = useState<AssetEntryWire[]>([])
	const [anchor, setAnchor] = useState<{ query: string; start: number } | null>(null)
	const [highlighted, setHighlighted] = useState(0)
	// Set when we rewrite the draft, so the caret can be restored after React has
	// re-rendered with the new value.
	const pendingCaret = useRef<number | null>(null)

	const refresh = useCallback(async () => {
		setAssets((await invoke("assets:list", project.path)) ?? [])
	}, [project.path])

	useEffect(() => {
		void refresh()
		// Assets arrive from the library, from an agent, or from Finder. A list that
		// only refreshed on mount would offer a tag that no longer exists.
		return on("assets:changed", (changed) => {
			if (changed === project.path) void refresh()
		})
	}, [project.path, refresh])

	// The query is read from the caret, not from the end of the draft: someone
	// editing the middle of a sentence gets the same picker.
	useEffect(() => {
		const input = inputRef.current
		if (!input) return
		const caret = input.selectionStart ?? draft.length
		setAnchor(mentionQueryAt(draft, caret))
		setHighlighted(0)
	}, [draft, inputRef])

	useEffect(() => {
		if (pendingCaret.current === null) return
		const input = inputRef.current
		const caret = pendingCaret.current
		pendingCaret.current = null
		input?.focus()
		input?.setSelectionRange(caret, caret)
	}, [draft, inputRef])

	const matches = useMemo(() => (anchor ? rankMentions(assets, anchor.query) : []), [assets, anchor])

	const choose = useCallback(
		(asset: AssetEntryWire) => {
			const input = inputRef.current
			if (!anchor || !input) return
			const caret = input.selectionStart ?? draft.length
			const next = applyMention(draft, caret, anchor.start, asset.tag)
			pendingCaret.current = next.caret
			setAnchor(null)
			setDraft(next.value)
		},
		[anchor, draft, inputRef, setDraft],
	)

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent): boolean => {
			if (!anchor || matches.length === 0) return false
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault()
				setHighlighted((current) => (current + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length)
				return true
			}
			if (event.key === "Enter" || event.key === "Tab") {
				// Consumed before the composer's own Enter, or choosing an asset would
				// also send the half-written message.
				event.preventDefault()
				choose(matches[highlighted])
				return true
			}
			if (event.key === "Escape") {
				event.preventDefault()
				setAnchor(null)
				return true
			}
			return false
		},
		[anchor, matches, highlighted, choose],
	)

	const begin = useCallback(() => {
		const needsSpace = draft.length > 0 && !draft.endsWith(" ") && !draft.endsWith("@")
		pendingCaret.current = draft.length + (needsSpace ? 2 : 1)
		setDraft(draft.endsWith("@") ? draft : `${draft}${needsSpace ? " " : ""}@`)
	}, [draft, setDraft])

	return {
		open: anchor !== null,
		matches,
		highlighted,
		handleKeyDown,
		choose,
		setHighlighted,
		begin,
		canvasUrl: project.canvasUrl,
	}
}

/**
 * The list itself, above the composer.
 *
 * Every row leads with what the asset looks like — the thumbnail, then the
 * description. The tag is the smaller half of the row on purpose: a name the
 * user chose months ago is not what they recognise it by.
 */
export function AssetMentionList({ mentions }: { mentions: AssetMentions }) {
	if (!mentions.open) return null

	return (
		<div
			className="absolute right-0 bottom-full left-0 z-50 mb-1.5 max-h-64 overflow-y-auto rounded-xl border border-shell-border bg-shell-bg p-1 shadow-[0_12px_32px_rgba(0,0,0,0.45)]"
			data-testid="asset-mentions">
			{mentions.matches.length === 0 ? (
				<p className="px-3 py-2.5 text-xs text-shell-muted">No asset matches that. Add some under Assets.</p>
			) : (
				mentions.matches.map((asset, index) => (
					<button
						className={cn(
							"flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left",
							index === mentions.highlighted && "bg-caret-accent/15",
						)}
						data-asset-mention={asset.tag}
						key={asset.tag}
						onMouseDown={(event) => {
							// Before focus can leave the textarea.
							event.preventDefault()
							mentions.choose(asset)
						}}
						onMouseEnter={() => mentions.setHighlighted(index)}
						type="button">
						<span className="flex h-8 w-11 shrink-0 items-center justify-center overflow-hidden rounded bg-black/30">
							{(asset.kind === "image" || asset.kind === "vector") && mentions.canvasUrl ? (
								<img
									alt=""
									className="max-h-full max-w-full object-contain"
									src={new URL(asset.posterUrl ?? asset.url, mentions.canvasUrl).toString()}
								/>
							) : (
								<span className="text-[9px] tracking-wide text-shell-muted">
									{asset.kind === "video" ? "VID" : "3D"}
								</span>
							)}
						</span>
						<span className="min-w-0 flex-1">
							<span className="block truncate text-xs text-shell-muted">
								{asset.description ||
									(asset.width && asset.height ? `${asset.width}×${asset.height}` : asset.kind)}
							</span>
							<span className="block truncate font-mono text-[11px]">@{asset.tag}</span>
						</span>
					</button>
				))
			)}
		</div>
	)
}
