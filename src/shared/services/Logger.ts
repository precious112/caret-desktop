/**
 * Process-wide logging for Caret's non-UI code.
 *
 * Static rather than injected because it is called from everywhere, including
 * places with no obvious owner to thread a logger through: codemods, file
 * watchers, spawned-tool wrappers. Output goes to registered subscribers rather
 * than straight to the console, so the desktop host can route it into its own
 * log file and the test suite can capture it.
 *
 * A logger must never be the reason something fails, so every path here
 * swallows its own errors.
 */
type Subscriber = (line: string) => void

type Level = "ERROR" | "WARN" | "INFO" | "LOG" | "DEBUG" | "TRACE"

/** Extra arguments are dropped below this bar unless IS_DEV is set. */
const ALWAYS_DETAILED: ReadonlySet<Level> = new Set<Level>(["ERROR", "WARN"])

export class Logger {
	static #subscribers = new Set<Subscriber>()

	/** Receive every line. Safe to call more than once. */
	static subscribe(subscriber: Subscriber): void {
		Logger.#subscribers.add(subscriber)
	}

	static error(message: string, ...args: unknown[]): void {
		Logger.#emit("ERROR", message, args)
	}
	static warn(message: string, ...args: unknown[]): void {
		Logger.#emit("WARN", message, args)
	}
	static info(message: string, ...args: unknown[]): void {
		Logger.#emit("INFO", message, args)
	}
	static log(message: string, ...args: unknown[]): void {
		Logger.#emit("LOG", message, args)
	}
	static debug(message: string, ...args: unknown[]): void {
		Logger.#emit("DEBUG", message, args)
	}
	static trace(message: string, ...args: unknown[]): void {
		Logger.#emit("TRACE", message, args)
	}

	/**
	 * Renders one argument for the log line.
	 *
	 * An Error gets its stack: JSON.stringify turns an Error into "{}", which
	 * once reduced a whole certification run's evidence to the string
	 * "uncaught exception:" with nothing after it.
	 */
	static #render(arg: unknown): string {
		if (arg instanceof Error) return arg.stack ?? String(arg)
		if (typeof arg === "string") return arg
		try {
			return JSON.stringify(arg) ?? String(arg)
		} catch {
			return String(arg)
		}
	}

	static #emit(level: Level, message: string, args: unknown[]): void {
		try {
			// ERROR and WARN always carry their arguments. They were once
			// verbose-only, which meant a production build logged the label and
			// threw away the cause.
			const detailed = args.length > 0 && (process.env.IS_DEV === "true" || ALWAYS_DETAILED.has(level))
			const detail = detailed ? ` ${args.map(Logger.#render).join(" ")}` : ""
			const line = `${level} ${message}${detail}`.trimEnd()
			for (const subscriber of Logger.#subscribers) {
				try {
					subscriber(line)
				} catch {
					// A broken subscriber must not silence the others.
				}
			}
		} catch {
			// Logging is never worth throwing over.
		}
	}
}
