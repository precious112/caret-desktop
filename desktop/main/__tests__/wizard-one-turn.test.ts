import { strict as assert } from "assert"

import type { WizardStateWire } from "../../shared/ipc"
import { oneTurnAtATime } from "../token-wizard"

/**
 * React's StrictMode mounts the interview twice in development; unguarded, the
 * start ran two model turns and the later answer replaced the question on
 * screen (five options became three). One turn per project at a time.
 */
describe("the interview runs one model turn per project at a time", () => {
	it("gives a second request the first one's result instead of starting another turn", async () => {
		let turns = 0
		let release: (state: WizardStateWire) => void = () => {}
		const run = () => {
			turns += 1
			return new Promise<WizardStateWire>((resolve) => {
				release = resolve
			})
		}
		const first = oneTurnAtATime("/p", run)
		const second = oneTurnAtATime("/p", run)
		release({ phase: "describe", description: "" })
		assert.equal(await first, await second)
		assert.equal(turns, 1)
	})

	it("starts a new turn once the last one has settled, and keeps projects apart", async () => {
		let turns = 0
		const run = async () => {
			turns += 1
			return { phase: "describe", description: "" } as WizardStateWire
		}
		await oneTurnAtATime("/a", run)
		await oneTurnAtATime("/a", run)
		await Promise.all([oneTurnAtATime("/b", run), oneTurnAtATime("/c", run)])
		assert.equal(turns, 4)
	})

	it("lets a failed turn be retried", async () => {
		await assert.rejects(oneTurnAtATime("/f", () => Promise.reject(new Error("provider down"))))
		const state = await oneTurnAtATime("/f", async () => ({ phase: "describe", description: "again" }) as WizardStateWire)
		assert.equal((state as { description: string }).description, "again")
	})
})
