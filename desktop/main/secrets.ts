/**
 * Credentials, kept out of everything that gets shared.
 *
 * §11's monetization boundary in its most literal form: **the key is the
 * user's, and it never enters the design layer.** `.caret/` is committed and
 * travels with the project, so a credential there is a credential in somebody's
 * public repository — and `preferences.json` is plaintext on disk, which is
 * where `googleFontsApiKey` lives and is exactly the standard this one is not
 * held to.
 *
 * So: Electron's `safeStorage`, which encrypts against a key held in the OS
 * keychain (Keychain on macOS, libsecret/kwallet on Linux, DPAPI on Windows).
 * The ciphertext lands in preferences; the key material never leaves the OS.
 *
 * **Where encryption is unavailable, storing is refused rather than downgraded.**
 * A Linux box with no keyring would otherwise get a plaintext API key written to
 * disk by a function whose entire purpose is not doing that, and the user would
 * have no way to know.
 */
import { safeStorage } from "electron"

import { Logger } from "../../src/shared/services/Logger"
import { getPrefs, setPref } from "./prefs"

/** Named so a second credential can land here without a schema change. */
export type SecretName = "geminiApiKey" | "tripoApiKey"

export interface SecretStatus {
	/** Whether the OS can encrypt at all. False means storing is refused. */
	available: boolean
	/** Whether a value is stored. The value itself never crosses to the renderer. */
	present: boolean
	/** Why storing is unavailable, when it is. */
	reason?: string
}

const UNAVAILABLE =
	"This machine has no OS keychain available, so Caret will not store an API key — writing it to disk in plain text is not a trade it makes on your behalf. Set GEMINI_API_KEY in the environment instead."

export function secretStatus(name: SecretName): SecretStatus {
	const available = isAvailable()
	return {
		available,
		present: Boolean(getPrefs().secrets?.[name]),
		...(available ? {} : { reason: UNAVAILABLE }),
	}
}

/** Stores a secret, or refuses with a reason. An empty value clears it. */
export async function setSecret(name: SecretName, value: string): Promise<{ ok: true } | { ok: false; error: string }> {
	const trimmed = value.trim()
	if (!trimmed) {
		await clearSecret(name)
		return { ok: true }
	}
	if (!isAvailable()) return { ok: false, error: UNAVAILABLE }

	try {
		const secrets = { ...(getPrefs().secrets ?? {}) }
		secrets[name] = safeStorage.encryptString(trimmed).toString("base64")
		await setPref("secrets", secrets)
		return { ok: true }
	} catch (err) {
		Logger.warn(`[secrets] could not store ${name}: ${err}`)
		return { ok: false, error: err instanceof Error ? err.message : String(err) }
	}
}

/**
 * The stored secret, or empty.
 *
 * Main-process only, and never returned over IPC — the renderer is told
 * *whether* a key is set, never what it is. A key that can be read back into a
 * web context is a key that a compromised renderer can exfiltrate, and there is
 * no feature that needs it there.
 */
export function getSecret(name: SecretName): string {
	const stored = getPrefs().secrets?.[name]
	if (!stored || !isAvailable()) return ""
	try {
		return safeStorage.decryptString(Buffer.from(stored, "base64"))
	} catch (err) {
		// A keychain entry that no longer decrypts — a restored machine, a new OS
		// user — is not recoverable and not the user's fault. Empty, with a log.
		Logger.warn(`[secrets] ${name} could not be decrypted: ${err}`)
		return ""
	}
}

export async function clearSecret(name: SecretName): Promise<void> {
	const secrets = { ...(getPrefs().secrets ?? {}) }
	if (!(name in secrets)) return
	delete secrets[name]
	await setPref("secrets", secrets)
}

/**
 * Guarded because `safeStorage` throws if touched before `app.ready`, and prefs
 * are read during startup.
 */
function isAvailable(): boolean {
	try {
		return safeStorage.isEncryptionAvailable()
	} catch {
		return false
	}
}
