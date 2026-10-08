# Changelog

## 0.2.0 (2026-10-08)

### Added
- Setup steps for new projects: a setup indicator in the top bar, a step counter, and setup guidance on the empty canvas and Assets tab.
- Existing apps are detected when a project opens.
- "Use what my app already has": reads your app's colours, fonts, spacing and corners from its code, and shows each with the file it came from.
- Import your app's screens as design pages, with a shared layout, live progress, and a "from your app" label on each imported page.
- Connect a model directly from the interview, including a one-click free model.
- MCP tools `get_import_worklist` and `write_design_file`, and `importedFrom` on `create_page`.

### Improved
- New projects describe what they are building and choose AI or by hand on one screen.
- Opening a project switches the current window instead of opening a new one.
- Error reports include where in Caret an error happened and its error code. Paths to your files are still never sent.

### Fixed
- Switching projects could leave the old window open beside the new one.
- `get_screenshot` could hang when design checks were rendering the same page.
- Imported pages could be treated as changed by the next sync and written back into the app.
- Opening another tab before setup sent you back to Foundation.
- The Open Recent menu missed a project until it finished loading.

### Removed
- The interview's "needs a coding backend" dead end. You now connect a model in place.
