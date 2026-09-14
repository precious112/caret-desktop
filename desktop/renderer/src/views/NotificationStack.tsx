/**
 * How the design core talks to the user.
 *
 * Not native dialogs: almost everything the core reports is a soft signal
 * ("design changes detected — sync them?") that should be ignorable, and a modal
 * that steals focus and blocks the canvas turns every one of those into an
 * interruption. Notifications with actions stay until answered, because main is
 * awaiting the answer; informational ones dismiss themselves.
 */

import { AlertTriangle, Info, XCircle } from "lucide-react"
import { useEffect, useState } from "react"

import type { NotificationRequest } from "../../../shared/ipc"
import { invoke, on } from "../ipc"
import { cn } from "../lib/utils"

const AUTO_DISMISS_MS = 6000

export function NotificationStack({ rightInset = 16 }: { rightInset?: number }) {
	const [items, setItems] = useState<NotificationRequest[]>([])

	useEffect(
		() =>
			on("notification:show", (request) => {
				setItems((current) => [...current, request])

				// Only self-dismiss when there is nothing to answer. Dismissing a
				// prompt main is waiting on would leave that promise unresolved.
				if (request.actions.length === 0) {
					setTimeout(() => {
						setItems((current) => current.filter((item) => item.id !== request.id))
					}, AUTO_DISMISS_MS)
				}
			}),
		[],
	)

	const respond = (request: NotificationRequest, action: string | null) => {
		void invoke("notification:respond", request.id, action)
		setItems((current) => current.filter((item) => item.id !== request.id))
	}

	if (items.length === 0) return null

	return (
		// `right` is a prop, not a constant: fixed bottom-right is also exactly
		// where the chat sidebar lives, and a stack of prompts blanketing the
		// conversation transcript was the field complaint. The host shifts the
		// stack left of whatever it would otherwise cover.
		<div
			className="pointer-events-none fixed bottom-4 z-50 flex w-[380px] flex-col gap-2"
			data-testid="notification-stack"
			style={{ right: rightInset }}>
			{items.map((item) => (
				<div
					className={cn(
						"fade-in pointer-events-auto rounded-xl border bg-shell-panel/95 p-3 shadow-lg backdrop-blur",
						item.level === "error" && "border-red-500/40",
						item.level === "warn" && "border-amber-500/40",
						item.level === "info" && "border-shell-border",
					)}
					key={item.id}>
					<div className="flex gap-2.5">
						<Icon level={item.level} />
						<p className="flex-1 leading-relaxed">{item.message}</p>
					</div>

					{item.actions.length > 0 && (
						<div className="mt-2.5 flex items-center justify-end gap-1.5">
							<button
								className="rounded-lg px-2.5 py-1 text-shell-muted transition-colors hover:bg-white/5"
								onClick={() => respond(item, null)}
								type="button">
								Not now
							</button>
							{/* One primary — the first action is the caller's recommended
							    answer. A row of identical filled buttons has no answer. */}
							{item.actions.map((action, index) => (
								<button
									className={cn(
										"rounded-lg px-2.5 py-1 transition-colors",
										index === 0
											? "bg-caret-accent font-medium text-white hover:bg-caret-accent-hover"
											: "text-shell-text hover:bg-white/10",
									)}
									key={action}
									onClick={() => respond(item, action)}
									type="button">
									{action}
								</button>
							))}
						</div>
					)}
				</div>
			))}
		</div>
	)
}

function Icon({ level }: { level: NotificationRequest["level"] }) {
	const props = { size: 15, className: "mt-0.5 shrink-0" } as const
	if (level === "error") return <XCircle {...props} color="#f87171" />
	if (level === "warn") return <AlertTriangle {...props} color="#fbbf24" />
	return <Info {...props} color="#8b93a7" />
}
