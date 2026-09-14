/**
 * Two small primitives the adapters share.
 *
 * Both exist because backend SDKs push (callbacks, event emitters) while
 * {@link BackendSession.send} pulls (an async iterable). Bridging the two
 * inline deadlocks: a permission callback cannot resolve until the caller reads
 * the event, and the caller cannot read it until the producing loop yields.
 */

export interface Deferred<T> {
	promise: Promise<T>
	resolve(value: T): void
	reject(error: unknown): void
}

export function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

/**
 * An unbounded queue that is also an async iterable.
 *
 * Unbounded on purpose: the producer is a model's own output rate, and dropping
 * or back-pressuring a token stream to protect memory would corrupt the
 * transcript to save a few kilobytes.
 */
export class EventQueue<T> implements AsyncIterable<T> {
	private items: T[] = []
	private waiting: Array<(result: IteratorResult<T>) => void> = []
	private closed = false

	push(item: T): void {
		if (this.closed) return
		const waiter = this.waiting.shift()
		if (waiter) {
			waiter({ value: item, done: false })
			return
		}
		this.items.push(item)
	}

	close(): void {
		if (this.closed) return
		this.closed = true
		for (const waiter of this.waiting) waiter({ value: undefined as never, done: true })
		this.waiting = []
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: () => {
				const item = this.items.shift()
				if (item !== undefined) return Promise.resolve({ value: item, done: false })
				if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
				return new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve))
			},
		}
	}
}
