/**
 * Typed access to the preload bridge.
 *
 * Everything the renderer can do to the outside world goes through here, so
 * there is exactly one place to look when asking what the UI is allowed to touch.
 */
import type { CaretBridge, IpcEventChannel, IpcEvents, IpcRequestChannel, IpcRequests } from "../../shared/ipc"

declare global {
	interface Window {
		caret: CaretBridge
	}
}

export function invoke<C extends IpcRequestChannel>(
	channel: C,
	...args: Parameters<IpcRequests[C]>
): Promise<Awaited<ReturnType<IpcRequests[C]>>> {
	return window.caret.invoke(channel, ...args)
}

export function on<C extends IpcEventChannel>(channel: C, listener: IpcEvents[C]): () => void {
	return window.caret.on(channel, listener)
}

export const platform = window.caret.platform

/** The disk path behind a dropped file. "" when the browser has none to give. */
export function pathForFile(file: File): string {
	return window.caret.pathForFile?.(file) ?? ""
}
