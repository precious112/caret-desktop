/**
 * How the design core reports product events without knowing about telemetry.
 *
 * Same shape as Logger.subscribe: the core emits, whoever hosts it decides
 * what listening means — the Electron main process forwards to analytics, the
 * certification harness and unit tests hear silence. No analytics client, no
 * electron, no network anywhere near this file; that is the point.
 *
 * Event names and properties must obey the contract in docs/telemetry.md:
 * enums, counts, durations, booleans. Never a path, a prompt, or content.
 */

export type DesignEventListener = (event: string, props: Record<string, unknown>) => void

const listeners = new Set<DesignEventListener>()

export function subscribeDesignEvents(listener: DesignEventListener): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

export function emitDesignEvent(event: string, props: Record<string, unknown> = {}): void {
	for (const listener of listeners) {
		try {
			listener(event, props)
		} catch {
			// A listener's failure is not the emitter's problem.
		}
	}
}
