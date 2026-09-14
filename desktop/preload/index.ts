/**
 * Preload for the app-chrome renderer.
 *
 * Exposes exactly the channels declared in `desktop/shared/ipc.ts` and nothing
 * else — no `ipcRenderer` object, no Node globals. `contextIsolation` stays on,
 * so the renderer can only reach main through this surface.
 */
import { contextBridge, ipcRenderer, webUtils } from "electron"

import type { CaretBridge, IpcEventChannel, IpcRequestChannel } from "../shared/ipc"

/**
 * The allowlists, written as **exhaustive maps** rather than arrays.
 *
 * An allowlist, because the renderer is where a compromised dependency lands
 * first and main can touch the filesystem and spawn processes. A map keyed by
 * the channel union, because an array literal cannot be checked for
 * completeness: a channel added to `IpcEvents` and forgotten here used to
 * compile, ship, and then **blank the window** — `on()` throws, the throw
 * happens inside a component effect, and React unmounts the whole tree. Now the
 * same omission is a type error in `npm run check-types`.
 *
 * Set a channel to `false` to deliberately withhold it from the renderer.
 */
const REQUEST_CHANNELS: Record<IpcRequestChannel, boolean> = {
	"project:pickFolder": true,
	"project:open": true,
	"project:close": true,
	"project:recents": true,
	"project:forgetRecent": true,
	"project:state": true,
	"tokens:read": true,
	"tokens:write": true,
	"tokens:generateScale": true,
	"tokens:blastRadius": true,
	"fonts:search": true,
	"pages:list": true,
	"assets:list": true,
	"assets:add": true,
	"assets:addBytes": true,
	"assets:retag": true,
	"assets:describe": true,
	"assets:remove": true,
	"assets:setPoster": true,
	"assets:pickFiles": true,

	"secrets:status": true,
	"secrets:set": true,
	"secrets:clear": true,

	"generate:discard": true,
	"generate:mark": true,
	"generate:markTargets": true,
	"generate:markTargetRefine": true,
	"generate:markAccept": true,
	"generate:model3d": true,
	"generate:model3dAccept": true,
	"generate:shader": true,
	"generate:shaderAccept": true,
	"generate:shaderRefine": true,
	"generate:taskModels": true,
	"generate:setTaskModel": true,
	"generate:questions": true,
	"generate:clarify": true,
	"generate:refineBrief": true,
	"generate:takes": true,
	"generate:acceptTake": true,
	"generate:refineTake": true,
	"generate:recipes": true,
	"generate:variants": true,
	"generate:accept": true,
	"sync:now": true,
	"sync:rollback": true,
	"sync:markSynced": true,
	"agent:clientConfigs": true,
	"agent:state": true,
	"agent:send": true,
	"chat:pickImages": true,
	"agent:abort": true,
	"agent:permission": true,
	"agent:setMode": true,
	"agent:discardPlan": true,
	"agent:reset": true,
	"agent:backends": true,
	"agent:selectBackend": true,
	"agent:models": true,
	"agent:providerDoors": true,
	"agent:probeModel": true,
	"agent:connectProvider": true,
	"agent:completeOauth": true,
	"agent:oauthStatus": true,
	"agent:disconnectProvider": true,
	"agent:sessions": true,
	"agent:replay": true,
	"agent:deleteSession": true,
	"prefs:get": true,
	"prefs:set": true,
	"analytics:event": true,
	"canvas:message": true,
	"canvas:setBounds": true,
	"canvas:setVisible": true,
	"notification:respond": true,
	"interview:respond": true,
	"interview:library": true,
	"interview:pending": true,
	"wizard:resume": true,
	"wizard:start": true,
	"wizard:answer": true,
	"wizard:finishNow": true,
	"wizard:retry": true,
	"wizard:back": true,
	"wizard:commit": true,
	"wizard:abandon": true,
}

const EVENT_CHANNELS: Record<IpcEventChannel, boolean> = {
	"project:stateChanged": true,
	"canvas:message": true,
	"notification:show": true,
	"interview:prompt": true,
	"wizard:progress": true,
	"assets:changed": true,
	"explore:open-changed": true,
	"agent:state": true,
	"generate:progress": true,
	log: true,
}

const bridge: CaretBridge = {
	invoke(channel, ...args) {
		if (!REQUEST_CHANNELS[channel]) {
			return Promise.reject(new Error(`Unknown IPC channel: ${channel}`))
		}
		return ipcRenderer.invoke(channel, ...args) as any
	},

	on(channel, listener) {
		if (!EVENT_CHANNELS[channel]) {
			throw new Error(`Unknown IPC event channel: ${channel}`)
		}
		const wrapped = (_event: unknown, ...args: unknown[]) => (listener as (...a: unknown[]) => void)(...args)
		ipcRenderer.on(channel, wrapped)
		return () => {
			ipcRenderer.off(channel, wrapped)
		}
	},

	platform: process.platform,

	// The only main-world object this bridge accepts, and it never leaves the
	// preload: a dropped File goes in, a path comes out. Electron 32 removed
	// `File.path`, so without this a drop resolves to nothing and the library
	// silently ignores the files — the worst shape of failure for a surface whose
	// whole job is getting files in.
	pathForFile(file: File) {
		try {
			return webUtils.getPathForFile(file)
		} catch {
			return ""
		}
	},
}

contextBridge.exposeInMainWorld("caret", bridge)
