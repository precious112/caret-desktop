/**
 * Components' host half: consent, installs, and the auto-supply loop.
 *
 * Components come from shadcn-style registries and 21st.dev (see
 * `registry-install.ts`). Two roads lead here: an agent called
 * `install_component`; or a page imports `../../components/catalog/<registry>/<item>` that is not
 * installed yet (the healer routes every page write here), and Caret makes the
 * import true. Consent is per library per project, asked once with real
 * buttons, in the chat.
 */
import * as fs from "fs/promises"
import * as path from "path"

import { hostFor, planSupply, readCatalogLock } from "../../src/core/design"
import { REGISTRIES } from "../../src/core/design/catalog/registries"
import {
	folderOf,
	type InstallOutcome,
	installComponentRef,
	parseComponentRef,
} from "../../src/core/design/catalog/registry-install"
import { Logger } from "../../src/shared/services/Logger"
import { capture } from "./analytics"
import { askUser, type InterviewPrompt } from "./interview"
import { getPrefs, setPref } from "./prefs"
import { getSecret } from "./secrets"

export interface CatalogServiceOptions {
	projectPath: string
	/** Called after anything installed, so the rules index regenerates. */
	onInstalled?(): void
	/**
	 * Delivers a consent prompt to the chrome, chat-placed.
	 *
	 * Consent used to go through `hostFor().notify` — a toast in the chrome's
	 * DOM, bottom-right. Field failure, 2026-09-02: the canvas is a NATIVE view
	 * layered over that DOM, so during an agent build turn — the one activity
	 * that raises this consent — the card rendered somewhere physically
	 * invisible, and the user watched `install_component` "hang" for 22 minutes
	 * on a question nobody could see. Blocking asks belong on the chat's ask
	 * surface, which replaces the composer and shows "Waiting for you" — the
	 * exact rule the interview and generate_asset consents already follow.
	 */
	sendPrompt?(prompt: InterviewPrompt): void
}

/** How a consent question names a library and says what installing does. */
interface ConsentText {
	name: string
	hint: string
}

/** What happens on install, in every consent question. */
const WHAT_INSTALL_DOES =
	"Caret downloads its source into .caret/components/catalog/ and adds the npm packages it needs to .caret/package.json."

export class CatalogService {
	/** Libraries declined this session — asked once, not per file save. */
	private declinedThisSession = new Set<string>()
	/** Install failures already reported, keyed page::ref, so a save loop does not repeat them. */
	private failureNotified = new Set<string>()
	/**
	 * The one in-flight consent prompt per library. An agent turn writes several
	 * pages in quick succession and each write's supply pass asks independently —
	 * without this, one turn stacked the SAME question four times, and the user
	 * answered a wall of identical cards one by one.
	 */
	private pendingConsent = new Map<string, Promise<boolean>>()

	constructor(private readonly options: CatalogServiceOptions) {}

	private consentKey(libraryId: string): string {
		return `${this.options.projectPath}::${libraryId}`
	}

	private hasConsent(libraryId: string, about: ConsentText): Promise<boolean> {
		const pending = this.pendingConsent.get(libraryId)
		if (pending) return pending
		const ask = this.askConsent(libraryId, about).finally(() => this.pendingConsent.delete(libraryId))
		this.pendingConsent.set(libraryId, ask)
		return ask
	}

	private async askConsent(libraryId: string, library: ConsentText): Promise<boolean> {
		if (getPrefs().catalogAllowed.includes(this.consentKey(libraryId))) return true
		if (this.declinedThisSession.has(libraryId)) return false

		// Chat-placed, like every blocking ask (see `sendPrompt` above). The
		// notify toast stays only as the no-chrome fallback so a headless host
		// still gets an answerable question instead of a silent hang.
		const choice = this.options.sendPrompt
			? await askUser(this.options.sendPrompt, {
					kind: "question",
					place: "chat",
					question: `Install ${library.name} into this project?`,
					hint: library.hint,
					choices: ["Allow for this project", "Just this once", "Don't install"],
				})
			: await hostFor(this.options.projectPath).notify("info", `${library.hint} Install it into .caret?`, [
					"Allow for this project",
					"Just this once",
				])
		if (choice === "Allow for this project") {
			await setPref("catalogAllowed", [...new Set([...getPrefs().catalogAllowed, this.consentKey(libraryId)])])
			return true
		}
		if (choice === "Just this once") return true
		this.declinedThisSession.add(libraryId)
		return false
	}

	/**
	 * Installs one component, consent first. `why` says, in the consent
	 * question, what asked for it.
	 */
	async installRef(ref: string, why: string, initiator: "agent" | "auto"): Promise<InstallOutcome> {
		const parsed = parseComponentRef(ref)
		if (!parsed)
			return {
				ok: false,
				ref,
				reason: `"${ref}" is not a component Caret can install: use "@registry/name" or "21st:<id>"`,
			}
		const libraryId = parsed.kind === "registry" ? folderOf(parsed.registry) : "21st"
		const name = parsed.kind === "registry" ? parsed.registry : "21st.dev"
		const library = libraryProp(ref)
		capture("catalog_install_requested", { initiator, library })
		if (!(await this.hasConsent(libraryId, { name, hint: `${why} ${WHAT_INSTALL_DOES}` }))) {
			capture("catalog_install_denied", { initiator, library })
			return { ok: false, ref, reason: `the user has not approved installing from ${name} into this project` }
		}
		const result = await installComponentRef(this.options.projectPath, ref, {
			twentyfirstKey: getSecret("twentyfirstApiKey") || undefined,
		})
		if (result.ok) capture("catalog_install_completed", { initiator, library })
		if (result.ok && !result.alreadyInstalled) this.options.onInstalled?.()
		return result
	}

	/** The MCP tool's road. */
	install(ref: string): Promise<InstallOutcome> {
		return this.installRef(ref, `An agent asked for ${ref}.`, "agent")
	}

	/**
	 * The auto-supply pass for one page file. Called by the healer after any
	 * page write settles.
	 */
	async ensureSuppliedFor(pageFile: string): Promise<void> {
		let source: string
		try {
			source = await fs.readFile(pageFile, "utf-8")
		} catch {
			return
		}

		const lock = await readCatalogLock(this.options.projectPath)
		const plan = planSupply(source, lock)
		const page = path.basename(path.dirname(pageFile))
		for (const ref of plan.install) {
			const result = await this.installRef(ref, `The page "${page}" imports ${ref}.`, "auto")
			if (result.ok && !result.alreadyInstalled) Logger.info(`[catalog] auto-supplied ${ref} for ${page}`)
			if (!result.ok && !this.failureNotified.has(`${pageFile}::${ref}`)) {
				this.failureNotified.add(`${pageFile}::${ref}`)
				void hostFor(this.options.projectPath).notify("warn", `Couldn't install ${ref}: ${result.reason}`)
			}
		}
	}
}

/** A library name for telemetry: a known registry or 21st.dev, never free text. */
function libraryProp(ref: string): string {
	if (ref.startsWith("21st:")) return "21st"
	const registry = ref.split("/")[0]
	return REGISTRIES[registry] ? registry.replace(/^@/, "") : "other"
}
