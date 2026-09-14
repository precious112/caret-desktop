import { useCallback } from "react"
import { Badge } from "@/components/ui/badge"
import { VIBE_TAGS } from "../data-steps"
import type { FoundationTokensDraft } from "../TokenWizard"

type Props = {
	tokens: FoundationTokensDraft
	onChange: (tokens: FoundationTokensDraft) => void
}

export function VibeStep({ tokens, onChange }: Props) {
	const toggleTag = useCallback(
		(tag: string) => {
			const current = tokens.vibe.tags
			const next = current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag]
			onChange({ ...tokens, vibe: { ...tokens.vibe, tags: next } })
		},
		[tokens, onChange],
	)

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-2">
				<label className="text-sm font-medium text-foreground">Description</label>
				<textarea
					className="w-full min-h-[80px] rounded-md border border-input bg-input-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-y"
					onChange={(e) => onChange({ ...tokens, vibe: { ...tokens.vibe, description: e.target.value } })}
					placeholder="Describe the feel of your design... e.g. 'Clean and modern with generous whitespace, friendly but professional'"
					value={tokens.vibe.description}
				/>
			</div>

			<div className="flex flex-col gap-2">
				<label className="text-sm font-medium text-foreground">Tags</label>
				<div className="flex flex-wrap gap-2">
					{VIBE_TAGS.map((tag) => (
						<Badge
							className="cursor-pointer select-none"
							key={tag}
							onClick={() => toggleTag(tag)}
							variant={tokens.vibe.tags.includes(tag) ? "default" : "outline"}>
							{tag}
						</Badge>
					))}
				</div>
			</div>
		</div>
	)
}
