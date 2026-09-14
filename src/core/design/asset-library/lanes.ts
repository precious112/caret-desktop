/**
 * Which lanes this build can actually run.
 *
 * Its own module rather than a constant in the barrel, because both the barrel
 * and the interview need it and the barrel already imports the interview — a
 * constant there would be a cycle, and the kind that resolves to `undefined` at
 * import time rather than failing loudly.
 */
import type { RecipeLane } from "./types"

/**
 * Lanes that need no account, and therefore always work.
 *
 * The default everywhere. A caller holding credentials passes a wider set;
 * nothing has to be configured for the surface to be useful, which is the whole
 * point of the four-lane split.
 */
export const FREE_LANES: ReadonlySet<RecipeLane> = new Set<RecipeLane>(["generator"])

/** `FREE_LANES` plus the raster lane, for a caller that has a key or ADC. */
export function lanesWithRaster(rasterAvailable: boolean): ReadonlySet<RecipeLane> {
	return rasterAvailable ? new Set<RecipeLane>([...FREE_LANES, "raster"]) : FREE_LANES
}
