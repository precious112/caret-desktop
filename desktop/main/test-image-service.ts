/**
 * The test image service: a stand-in for Google's image API, for development
 * builds only.
 *
 * `CARET_TEST_IMAGE_SERVICE` names the address of a server speaking the same
 * API (scripts/fake-image-service.ts). Every image call then goes there
 * instead of to Google, through exactly the same code, so the generate screen
 * can be tested end to end without spending money. A packaged Caret ignores it.
 *
 * It also shortens the spacing between calls, which exists for Google's
 * per-minute quota and would otherwise make every test wait six seconds a take.
 */
import { app } from "electron"

import { configureRasterPacing } from "../../src/core/design/asset-library/raster/gemini"
import { Logger } from "../../src/shared/services/Logger"

let announced = false

export function testImageService(env: NodeJS.ProcessEnv = process.env, isPackaged = app.isPackaged): string | null {
	if (isPackaged) return null
	const url = env.CARET_TEST_IMAGE_SERVICE?.trim()
	if (!url) return null
	if (!announced) {
		announced = true
		configureRasterPacing({ minSpacingMs: 150, backoffMs: [300, 600] })
		Logger.info(`[generate] TEST IMAGE SERVICE at ${url}: no image call reaches Google`)
	}
	return url
}
