/**
 * The seam where hosted features will attach.
 *
 * Caret has no server today and the entire editor is free forever with no key
 * and no account; the only network traffic the app initiates on its own is
 * anonymous, opt-out telemetry (docs/telemetry.md). That commitment is the
 * product, not a phase — see the monetization boundary: the paid line is Share,
 * then team collaboration, then CI drift diffs, and every one of those
 * genuinely requires a server.
 *
 * This interface exists now so adding the first of them is wiring rather than
 * surgery, and — more importantly — so the *refusal* is written once, honestly,
 * in one place. Every hosted capability resolves to "not available" with a
 * reason rather than being absent, which is what stops a half-built hosted
 * feature leaking uncertainty into the UI.
 *
 * It is deliberately tiny. A larger speculative interface would encode guesses
 * about a product that does not exist yet.
 */

export interface Account {
	id: string
	email: string
	displayName: string
}

export type ServiceAvailability = { available: true } | { available: false; reason: string }

export interface CaretServices {
	/** Whether hosted features can be reached at all. */
	availability(): ServiceAvailability
	/** The signed-in account, or null. Always null in the local-only build. */
	currentAccount(): Account | null
	/** Begins a sign-in flow. Rejects when hosted features are unavailable. */
	signIn(): Promise<Account>
	signOut(): Promise<void>
}

const LOCAL_ONLY_REASON =
	"Caret is running entirely on your machine. Sharing, team collaboration and CI drift diffs are hosted features that don't exist yet — everything in the editor works without an account and always will. The only thing Caret ever sends is anonymous usage data, which you can switch off in one click."

/**
 * The only implementation that ships today. It refuses, and says why.
 */
export class LocalOnlyServices implements CaretServices {
	availability(): ServiceAvailability {
		return { available: false, reason: LOCAL_ONLY_REASON }
	}

	currentAccount(): Account | null {
		return null
	}

	async signIn(): Promise<Account> {
		throw new Error(LOCAL_ONLY_REASON)
	}

	async signOut(): Promise<void> {
		// Nothing to sign out of.
	}
}

let current: CaretServices = new LocalOnlyServices()

export function registerServices(services: CaretServices): void {
	current = services
}

export function services(): CaretServices {
	return current
}
