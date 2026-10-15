/**
 * Pieces the Skills and Libraries tabs share: the full-window frame, the
 * Browse / Installed switch, and a catalog card.
 */
import type { ReactNode } from "react"

import { cn } from "../lib/utils"

export function CatalogFrame({
	testId,
	title,
	subtitle,
	strip,
	onClose,
	children,
}: {
	testId: string
	title: string
	subtitle: string
	/** One line: what this project uses, and the way to the coding tools. */
	strip: ReactNode
	onClose(): void
	children: ReactNode
}) {
	return (
		<div className="relative flex flex-1 flex-col overflow-hidden bg-shell-bg" data-testid={testId}>
			<header className="flex items-start justify-between gap-6 border-b border-shell-border px-8 py-4">
				<div className="min-w-0">
					<h1 className="text-lg font-semibold">{title}</h1>
					<p className="max-w-2xl text-sm text-shell-muted">{subtitle}</p>
				</div>
				<button
					className="shrink-0 rounded-md border border-shell-border px-3 py-1.5 text-sm"
					onClick={onClose}
					type="button">
					Done
				</button>
			</header>
			<div className="flex-1 overflow-y-auto px-8 py-6">
				<div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-shell-border px-4 py-2.5 text-[12.5px] text-shell-muted">
					{strip}
				</div>
				{children}
			</div>
		</div>
	)
}

export function CatalogTabs<T extends string>({
	value,
	options,
	onChange,
}: {
	value: T
	options: Array<{ value: T; label: string }>
	onChange(value: T): void
}) {
	return (
		<div className="mb-5 flex gap-1.5" role="tablist">
			{options.map((option) => (
				<button
					aria-selected={value === option.value}
					className={cn(
						"rounded-full border px-3.5 py-1 text-[12.5px] transition-colors",
						value === option.value
							? "border-shell-text bg-shell-text text-shell-bg"
							: "border-shell-border text-shell-muted hover:text-shell-text",
					)}
					data-testid={`catalog-tab-${option.value}`}
					key={option.value}
					onClick={() => onChange(option.value)}
					role="tab"
					type="button">
					{option.label}
				</button>
			))}
		</div>
	)
}

export function CatalogCard({
	testId,
	id,
	by,
	title,
	text,
	tags,
	action,
	error,
}: {
	testId: string
	id: string
	by?: string
	title: string
	text: string
	tags: string[]
	action: ReactNode
	error?: string | null
}) {
	return (
		<div
			className="flex flex-col gap-2 rounded-xl border border-shell-border bg-shell-panel p-4"
			data-id={id}
			data-testid={testId}>
			{by && <p className="text-[11.5px] text-shell-muted">{by}</p>}
			<h3 className="font-medium">{title}</h3>
			<p className="text-[12.5px] leading-relaxed text-shell-muted">{text}</p>
			<div className="flex flex-wrap gap-1.5">
				{tags.map((tag) => (
					<span
						className={cn(
							"rounded-full border px-2 py-px text-[10.5px]",
							/^Paid/.test(tag)
								? "border-amber-500/40 text-amber-300"
								: /^Free/.test(tag)
									? "border-emerald-500/40 text-emerald-300"
									: "border-shell-border text-shell-muted",
						)}
						key={tag}>
						{tag}
					</span>
				))}
			</div>
			{error && <p className="text-[11.5px] text-red-400">{error}</p>}
			<div className="mt-auto flex justify-end pt-1">{action}</div>
		</div>
	)
}

export const BUTTON = "rounded-lg bg-caret-accent px-3 py-1.5 text-[12.5px] text-white disabled:opacity-50"
export const QUIET_BUTTON = "rounded-lg border border-shell-border px-2.5 py-1 text-[12px] hover:bg-white/5 disabled:opacity-50"
export const DONE_BADGE = "rounded-lg border border-emerald-500/40 px-3 py-1.5 text-[12.5px] text-emerald-300"
