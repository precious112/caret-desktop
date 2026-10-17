# Changelog

## 0.3.0 (2026-10-17)

### Added
- Generate an asset: images land on a branching board. Changing a take grows new takes from it, joined by a line; nothing is overwritten, and several takes can be saved.
- Three kinds of prompt help for images: Polish it, Ask me first (skippable questions and an editable brief), or Use my words.
- The Experiment canvas is a branching board: the current page is the first box, and any take, or the page itself, can be branched again with chips, subtle or strong changes, and your own words.
- Skills tab: six hand-picked design skills, pinned and fingerprint-checked, one per project.
- Libraries tab: browse and install component and reference libraries (shadcn, Aceternity, Lazyweb, 21st.dev, Gummble), on or off per project.
- "Your coding tools" in the Backend tab finds Claude Code, Codex, Cursor and OpenCode and connects each to Caret with one click.

### Improved
- The AI interview was rebuilt: an opening screen of statements you can correct one by one, questions in a fixed order ("Question 3 of 8"), never a topic twice, and So far always matching your answers.
- A value Caret can't save is refused on screen with the reason, instead of being saved and changed later.
- The interview steers away from overused AI defaults (stock Tailwind blue and purple, cream and terracotta, Inter and friends) unless you choose them.
- Libraries reach the AI through Caret's own connection, so the chat and connected coding tools see the same ones, and keys never leave Caret.
- Selecting an element opens its properties in a sidebar beside the page, and the rest of the page pauses until you are done.
- Quick AI answers (interview turns, image briefs, checks) use a lean agent: far fewer tokens, and a provider refusal is shown at once with the provider's words.

### Fixed
- Caret's backend no longer breaks when you have OpenCode 2.x installed yourself. It keeps its own data, and a backend that fails to start says so instead of "needs sign-in".
- Editing text on an animated page could crash it with "Too many re-renders".
- Entrance animations were stuck invisible on focused pages.
- Design checks reported fading-in text as failing contrast.
- The healer could break tab-indented pages.
- An interview could hang for minutes on a question Caret never showed.
- Reopening Caret after an interview error lost your place; answers are now kept.
- Two experiment branches started together could share take numbers.
- A second image round with the same words overwrote the first.

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
