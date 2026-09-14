/**
 * Types the main process shares with the renderer.
 *
 * The design-core message types are re-exported here so main code has one place
 * to import from. The renderer deliberately cannot reach these — it uses the
 * structural mirrors in `desktop/shared/ipc.ts` instead, so that a renderer
 * import of main-process code is a compile error rather than a convention.
 */
export type { DesignInboundMessage, DesignOutboundMessage } from "../../src/core/design"

/** One viewport-height slice of a page capture. */
export interface ScreenshotFrame {
	dataUrl: string
	/** CSS-pixel scroll offset this frame was captured at. */
	top: number
	/** CSS-pixel height — always the viewport height; the last frame may overlap the one above. */
	height: number
}

/**
 * A full-page capture, delivered as viewport-height frames rather than one
 * tall image: providers downscale any image to a ~1500px long edge, so a
 * single 5000px-tall capture reaches the model with its text illegible, while
 * per-frame slices arrive at full resolution. Long pages page through `part`.
 *
 * Failures are a stated reason, deliberately not `string | null`. The only
 * consumer is an agent, and a bare null forces the caller to invent a cause —
 * which is how `get_screenshot` came to answer "is the canvas running?" for
 * every possible failure, including the ones where it plainly was.
 */
export type ScreenshotResult =
	| {
			ok: true
			/** This part's frames, in top-to-bottom page order. */
			frames: ScreenshotFrame[]
			/** The page's full scroll height in CSS pixels. */
			pageHeight: number
			/** Total frames across all parts. */
			totalFrames: number
			/** 1-based index (within totalFrames) of frames[0]. */
			firstFrame: number
			/** How many parts the whole page spans. */
			parts: number
			/**
			 * Set only for measured failures — an image that completed with zero
			 * pixels (404/decode error). Without it, a page with a broken asset
			 * screenshots as clean evidence that the asset "isn't showing".
			 * Never speculation: no "still loading" guesses, which misfire on
			 * lazy content that is not meant to load.
			 */
			warning?: string
	  }
	| { ok: false; reason: string }
export type {
	AgentClientConfig,
	NotificationLevel,
	NotificationRequest,
	ProjectState,
	ProjectSummary,
} from "../shared/ipc"
