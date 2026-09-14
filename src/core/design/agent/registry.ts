/**
 * Which backends exist, and one instance of each.
 *
 * There is one, and `backend.ts` records why the other three were removed. The
 * registry survives the cull because the *number* of backends is not what it is
 * for: instances are cached per process rather than per project, because an
 * adapter owns a server process, and a second open project must not start a
 * second copy of it.
 */
import type { AvailabilityReport, BackendId, CodingBackend } from "./backend"
import { OpencodeBackend } from "./opencode"

/** The order the setup screen offers them in. */
export const BACKEND_IDS: BackendId[] = ["opencode"]

const instances = new Map<BackendId, CodingBackend>()

export function getBackend(id: BackendId): CodingBackend {
	let backend = instances.get(id)
	if (!backend) {
		backend = construct(id)
		instances.set(id, backend)
	}
	return backend
}

function construct(id: BackendId): CodingBackend {
	switch (id) {
		case "opencode":
			return new OpencodeBackend()
	}
}

/**
 * Availability of every backend, for the setup screen.
 *
 * Probed in parallel and never allowed to throw: an adapter whose server
 * misbehaves must not blank the whole screen, so a failure becomes that row's
 * own "not ready" reason.
 */
export async function probeBackends(): Promise<AvailabilityReport[]> {
	return Promise.all(
		BACKEND_IDS.map(async (id) => {
			const backend = getBackend(id)
			try {
				return await backend.availability()
			} catch (err) {
				return {
					id,
					displayName: backend.displayName,
					providerName: backend.providerName,
					installed: false,
					authenticated: false,
					ready: false,
					detail: err instanceof Error ? err.message : String(err),
				}
			}
		}),
	)
}

/** Shuts every constructed backend down. Called when the app quits. */
export async function disposeBackends(): Promise<void> {
	await Promise.allSettled([...instances.values()].map((backend) => backend.dispose?.()))
	instances.clear()
}
