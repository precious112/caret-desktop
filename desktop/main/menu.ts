/**
 * The application menu.
 *
 * Everything here is reachable from the UI too — the menu exists for keyboard
 * shortcuts and for the platform conventions users expect from a real desktop
 * app, not as the only route to anything.
 */
import { app, dialog, Menu, type MenuItemConstructorOptions, shell } from "electron"

import { rollbackSync } from "../../src/core/design"
import { getPrefs } from "./prefs"
import type { WindowManager } from "./window-manager"

const isMac = process.platform === "darwin"

/**
 * The manager the menu was built against, so it can be rebuilt without one.
 *
 * The recents submenu is a snapshot of `prefs.recentProjects` taken when the
 * template is constructed, and the template was constructed exactly once at
 * startup. On a fresh install that snapshot is empty, so "Open Recent" said
 * "No Recent Projects" forever — no matter how many projects were opened — and
 * the only in-app route to another project was a menu that could not see any.
 */
let built: WindowManager | null = null

/** Rebuilds the menu so "Open Recent" reflects what is actually recent. */
export function refreshMenu(): void {
	if (built) buildMenu(built)
}

export function buildMenu(windows: WindowManager): void {
	built = windows
	const template: MenuItemConstructorOptions[] = [
		...(isMac ? [{ role: "appMenu" as const }] : []),
		{
			label: "File",
			submenu: [
				{
					label: "Open Project…",
					accelerator: "CmdOrCtrl+O",
					click: async () => {
						const result = await dialog.showOpenDialog({
							title: "Open a project",
							properties: ["openDirectory", "createDirectory"],
							buttonLabel: "Open",
						})
						if (!result.canceled && result.filePaths[0]) {
							await windows.open(result.filePaths[0])
						}
					},
				},
				{
					label: "Open Recent",
					submenu: buildRecentsSubmenu(windows),
				},
				{ type: "separator" },
				{
					label: "Close Project",
					accelerator: "CmdOrCtrl+W",
					click: () => {
						const focused = windows.list()[0]
						if (focused) void windows.close(focused.projectPath)
					},
				},
				...(isMac ? [] : [{ type: "separator" as const }, { role: "quit" as const }]),
			],
		},
		{ role: "editMenu" },
		{
			label: "Design",
			submenu: [
				{
					label: "Sync Design → App",
					accelerator: "CmdOrCtrl+Shift+S",
					click: () => {
						void windows.list()[0]?.requestSync()
					},
				},
				{
					label: "Undo Last Sync",
					click: async () => {
						const focused = windows.list()[0]
						if (!focused) return
						const result = await rollbackSync(focused.projectPath)
						await dialog.showMessageBox({ type: "info", message: result.message, buttons: ["OK"] })
					},
				},
			],
		},
		{
			label: "View",
			submenu: [
				{ role: "reload" },
				{ role: "forceReload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{ role: "windowMenu" },
		{
			role: "help",
			submenu: [
				{
					label: "Caret Documentation",
					click: () => void shell.openExternal("https://github.com/precious112/caret#readme"),
				},
				{
					label: "Report an Issue",
					click: () => void shell.openExternal("https://github.com/precious112/caret/issues/new"),
				},
				{
					label: "Show Logs Folder",
					click: () => void shell.openPath(app.getPath("logs")),
				},
			],
		},
	]

	Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function buildRecentsSubmenu(windows: WindowManager): MenuItemConstructorOptions[] {
	const recents = getPrefs().recentProjects
	if (recents.length === 0) {
		return [{ label: "No Recent Projects", enabled: false }]
	}
	return recents.map((projectPath) => ({
		label: projectPath,
		click: () => void windows.open(projectPath),
	}))
}
