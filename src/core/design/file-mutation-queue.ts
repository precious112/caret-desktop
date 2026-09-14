import * as fs from "fs/promises"

const queues = new Map<string, Promise<unknown>>()

/**
 * Runs `fn` exclusively for the given key: calls with the same key are queued
 * behind each other instead of racing. Used to serialize read-modify-write
 * operations on files — unserialized concurrent writes have corrupted design
 * files (flows) in the past.
 */
export function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const prev = queues.get(key) ?? Promise.resolve()
	const next = prev.then(fn, fn)
	const guard = next.catch(() => {})
	queues.set(key, guard)
	guard.then(() => {
		if (queues.get(key) === guard) queues.delete(key)
	})
	return next
}

/**
 * Write via temp file + rename so readers (e.g. the design-mode Vite server's
 * middleware and file watcher) can never observe a half-written file.
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
	const tmp = `${filePath}.${process.pid}.${Date.now().toString(36)}.tmp`
	await fs.writeFile(tmp, content)
	await fs.rename(tmp, filePath)
}
