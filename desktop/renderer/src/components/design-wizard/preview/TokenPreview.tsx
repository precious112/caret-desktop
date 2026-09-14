import { useMemo } from "react"
import type { FoundationTokensDraft } from "../TokenWizard"
import { tokensToCssVars } from "./tokensToCss"

type Props = {
	tokens: FoundationTokensDraft
}

export function TokenPreview({ tokens }: Props) {
	const cssVars = useMemo(() => tokensToCssVars(tokens), [tokens])

	const brandColor = tokens.color.brand.scale?.["500"] || tokens.color.brand.seed
	const brandLight = tokens.color.brand.scale?.["100"] || "#e0e7ff"
	const brandDark = tokens.color.brand.scale?.["700"] || "#1d4ed8"
	const radiusMd = tokens.radius.scale[2] ?? 4
	const radiusLg = tokens.radius.scale[3] ?? 8

	return (
		<div
			className="border border-input rounded-md p-4 bg-white"
			style={
				{
					...cssVars,
					fontFamily: `${tokens.typography.fontFamily}, ${tokens.typography.fallback}`,
				} as React.CSSProperties
			}>
			<div className="flex flex-col gap-3">
				{/* Buttons */}
				<div className="flex gap-2 flex-wrap">
					<button
						className="px-3 py-1.5 text-xs text-white font-medium"
						style={{
							backgroundColor: brandColor,
							borderRadius: `${radiusMd}px`,
						}}>
						Primary Button
					</button>
					<button
						className="px-3 py-1.5 text-xs font-medium border"
						style={{
							color: brandColor,
							borderColor: brandColor,
							borderRadius: `${radiusMd}px`,
						}}>
						Secondary
					</button>
					{tokens.color.secondary && (
						<button
							className="px-3 py-1.5 text-xs text-white font-medium"
							style={{
								backgroundColor: tokens.color.secondary.seed,
								borderRadius: `${radiusMd}px`,
							}}>
							Supporting
						</button>
					)}
					{tokens.color.accent && (
						<span className="px-2 py-1.5 text-xs font-medium self-center" style={{ color: tokens.color.accent.seed }}>
							Accent link →
						</span>
					)}
				</div>

				{/* Card */}
				<div
					className="border p-3"
					style={{
						borderColor: "#e5e7eb",
						borderRadius: `${radiusLg}px`,
					}}>
					<h3 className="font-semibold text-gray-900 mb-1" style={{ fontSize: cssVars["--font-size-lg"] }}>
						Card Heading
					</h3>
					<p className="text-gray-600" style={{ fontSize: cssVars["--font-size-sm"] }}>
						Body text demonstrates your typography scale and font choice across different sizes.
					</p>
				</div>

				{/* Input */}
				<div
					className="border px-3 py-1.5 text-gray-400"
					style={{
						borderColor: "#d1d5db",
						borderRadius: `${radiusMd}px`,
						fontSize: cssVars["--font-size-base"],
					}}>
					Input placeholder...
				</div>

				{/* Badges */}
				<div className="flex gap-1.5 flex-wrap">
					<span
						className="px-2 py-0.5 text-[10px] font-medium text-white"
						style={{
							backgroundColor: tokens.color.semantic.success,
							borderRadius: `${radiusMd}px`,
						}}>
						Success
					</span>
					<span
						className="px-2 py-0.5 text-[10px] font-medium text-white"
						style={{
							backgroundColor: tokens.color.semantic.warning,
							borderRadius: `${radiusMd}px`,
						}}>
						Warning
					</span>
					<span
						className="px-2 py-0.5 text-[10px] font-medium text-white"
						style={{
							backgroundColor: tokens.color.semantic.error,
							borderRadius: `${radiusMd}px`,
						}}>
						Error
					</span>
					<span
						className="px-2 py-0.5 text-[10px] font-medium text-white"
						style={{
							backgroundColor: tokens.color.semantic.info,
							borderRadius: `${radiusMd}px`,
						}}>
						Info
					</span>
				</div>

				{/* Typography scale */}
				<div className="flex flex-col gap-0.5 pt-1 border-t border-gray-100">
					{(["xs", "sm", "base", "lg", "xl"] as const).map((size) => (
						<span className="text-gray-700" key={size} style={{ fontSize: cssVars[`--font-size-${size}`] }}>
							{size}
						</span>
					))}
				</div>
			</div>
		</div>
	)
}
